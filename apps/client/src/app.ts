// EvolClient: wires renderer, network, runtime, interaction engine, XR
// session/origin/hands, desktop controls, push-to-talk, pose recording, pose
// streaming, perf overlay, page UI and test hooks into one frame loop.
//
// Coordinate frames (see math/space.ts): three.js world = XR reference space
// (local-floor). runtime.root is placed at the space origin every frame;
// everything sent to the engine/server (head, hands, rays) is in SPACE coords.

import * as THREE from 'three';
import type { HandFrame, Handedness, UserPose, UserView, ClientRole } from '@evolspace/protocol';
import type { ClientConfig, ClientSettings } from './config.ts';
import { SettingsStore } from './config.ts';
import { CommandRouter, type CommandArgs, type CommandPhase } from './commands.ts';
import {
  createNet, createRuntime, createEngine, routeHostCommands, createHandVisual, input,
  type NetClient, type RuntimePort, type EnginePort, type InteractionHost, type HandVisualPort,
} from './integration.ts';
import { composePose, fovFromProjection, transformDirection, jointPose, clonePose, type Pose } from './math/space.ts';
import { XrSessionManager, type XrMode } from './xr/session.ts';
import { SpaceOrigin } from './xr/origin.ts';
import { XrHandReader } from './xr/hands.ts';
import { installEmulation } from './xr/emulate.ts';
import { DesktopControls } from './desktop/controls.ts';
import { SimHands } from './sim/sim.ts';
import { MicCapture } from './audio/mic.ts';
import { PushToTalk } from './audio/ptt.ts';
import { PoseRecorder } from './pose/recorder.ts';
import { buildUserPose, voiceContextOf, RateGate, type PoseInputs } from './user/pose-stream.ts';
import { PerfOverlay } from './perf/overlay.ts';
import { LandingUi } from './ui/landing.ts';
import { Hud } from './ui/hud.ts';

type Hands = Partial<Record<Handedness, HandFrame>>;

export class EvolClient {
  readonly settings = new SettingsStore();
  renderer!: THREE.WebGLRenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  net!: NetClient;
  runtime!: RuntimePort;
  engine!: EnginePort;
  host!: InteractionHost;
  router!: CommandRouter;
  xr!: XrSessionManager;
  readonly origin = new SpaceOrigin(undefined, (l, m) => this.log(l, m));
  readonly sim = new SimHands((spec) => input.synthHand(spec), (f) => input.pinchPoint(f));
  desktop: DesktopControls | null = null;
  mic!: MicCapture;
  ptt!: PushToTalk;
  recorder!: PoseRecorder;
  perf!: PerfOverlay;
  page: LandingUi | null = null;
  hud!: Hud;
  emulation: string | undefined;
  /** True once start() finished wiring everything (hooks/state are safe to use). */
  started = false;

  /** Latest per-frame state (space coords) — read by hooks, PTT context, recorder. */
  headWorld: Pose = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };
  head: Pose = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };
  hands: Hands = {};
  fov: { fov: number; aspect: number } | undefined;
  lastPose: UserPose | null = null;

  private readonly realHands: Hands = {};
  private readonly handReader = new XrHandReader();
  private readonly handVisuals: Partial<Record<Handedness, HandVisualPort>> = {};
  private readonly poseGate = new RateGate(30);
  private lastT = 0;
  private sceneBackground: THREE.Scene['background'] = null;
  private micAutoWarm = false;
  /** Desktop camera FOV (three.js overwrites camera.fov with the XR one while presenting). */
  private desktopFov = 70;

  constructor(readonly cfg: ClientConfig) {}

  get role(): ClientRole {
    return this.cfg.role;
  }

  get mode(): UserPose['mode'] {
    return this.xr?.mode ?? 'inline';
  }

  async start(container: HTMLElement): Promise<void> {
    if (this.cfg.emulate) {
      const emu = await installEmulation({ device: this.cfg.emulate, devui: this.cfg.devui, sem: this.cfg.sem });
      this.emulation = emu.description;
    }

    this.initRenderer(container);
    this.initNetAndRuntime();
    this.initXr();
    this.initInput();
    this.initVoiceAndRecording();
    this.initCommands();
    this.initPageUi();

    await this.xr.detect();
    this.micAutoWarm = this.role === 'xr' && (this.xr.supported.vr || this.xr.supported.ar) && !this.cfg.emulate;
    if (this.micAutoWarm) {
      // First gesture anywhere warms the mic up so the first PTT is instant.
      const warm = () => { void this.ptt.warmup(); };
      window.addEventListener('pointerdown', warm, { once: true, capture: true });
    }
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
    this.started = true;
    if (this.cfg.autoEnter) void this.enterXr(this.cfg.autoEnter);
  }

  // ------------------------------------------------------------------ setup

  private initRenderer(container: HTMLElement): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.id = 'evol-canvas';
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b0f15');
    this.camera = new THREE.PerspectiveCamera(this.desktopFov, window.innerWidth / window.innerHeight, 0.02, 300);
    this.camera.position.set(0, 1.6, 1.6);
    this.scene.add(this.camera); // children (perf overlay) render head-locked

    window.addEventListener('resize', () => {
      if (this.xr?.active) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private initNetAndRuntime(): void {
    const ua = navigator.userAgent;
    const isHeadset = /OculusBrowser|Quest|Pico|Vision/i.test(ua) && !this.cfg.emulate;
    this.net = createNet(this.cfg.wsUrl, this.role, {
      userAgent: ua,
      capabilities: ['hands', 'voice', 'pose.record', ...(this.cfg.emulate ? ['emulated'] : [])],
      wantPrimary: this.role === 'xr' && isHeadset,
    });
    this.runtime = createRuntime({ scene: this.scene, net: this.net, role: this.role, renderer: this.renderer, camera: this.camera });
    this.router = new CommandRouter(this.runtime, (m) => this.net.send(m));
    this.host = routeHostCommands(this.runtime.interactionHost(), (name, args, phase) => { this.router.run(name, args, phase); });
    this.engine = createEngine(this.host);
    this.net.on('gestures.defs', (m) => {
      this.engine.setPoses(m.poses);
      this.engine.setInteractions(m.interactions);
    });
    // Audio and voice.* are not queued while offline: abandon an utterance in flight.
    this.net.onStatus((s) => {
      if (!s.connected && this.ptt?.active) this.ptt.abort('Connection to the EvolSpace server lost — utterance discarded');
    });
    // Waking the headset / returning to the tab: skip the reconnect backoff.
    const wake = () => { if (document.visibilityState === 'visible') this.net.reconnectNow(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    // Server-pushed {type:'command'} is dispatched by the runtime into its local
    // registry, where the CommandRouter registered the client commands.
  }

  private initXr(): void {
    const s = this.settings.value;
    this.xr = new XrSessionManager(this.renderer, {
      onStart: (session, mode) => {
        this.cancelInteractions();
        this.origin.onSessionStart(session);
        this.settings.set({ lastMode: mode });
        if (this.desktop) this.desktop.enabled = false;
        this.sceneBackground = this.scene.background;
        if (mode === 'ar') this.scene.background = null;
        this.renderer.setClearAlpha(mode === 'ar' ? 0 : 1);
        this.hud?.toast(`Entered ${mode.toUpperCase()}`);
      },
      onEnd: () => {
        // Grabs / held commands (e.g. push-to-talk) must not outlive the hands that drove them.
        this.cancelInteractions();
        this.origin.onSessionEnd();
        for (const k of Object.keys(this.realHands) as Handedness[]) delete this.realHands[k];
        this.scene.background = this.sceneBackground ?? new THREE.Color('#0b0f15');
        this.renderer.setClearAlpha(1);
        // Continue on the desktop from where the head was.
        this.camera.position.set(...this.headWorld.position);
        this.camera.quaternion.set(...this.headWorld.rotation);
        this.camera.fov = this.desktopFov;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        if (this.desktop) { this.desktop.enabled = true; this.desktop.syncFromCamera(); }
      },
      onPending: (mode) => { if (mode) this.hud?.toast(`Pinch or click to switch to ${mode.toUpperCase()}`); },
      log: (l, m) => this.log(l, m),
    }, {
      frameRate: this.cfg.frameRate,
      framebufferScale: this.cfg.framebufferScale ?? (s.highRes ? 1.3 : 1.0),
      foveation: this.cfg.foveation,
    });
  }

  private initInput(): void {
    // Hand visuals (space coords → children of the space root).
    for (const h of ['left', 'right'] as const) {
      try {
        const v = createHandVisual(this.runtime);
        v.object.name = `evol.hand.${h}`;
        this.runtime.root.add(v.object);
        this.handVisuals[h] = v;
      } catch (e) {
        this.log('warn', `hand visual unavailable: ${(e as Error).message}`);
      }
    }
    this.desktop = new DesktopControls(this.renderer.domElement, this.camera, {
      input,
      origin: () => this.origin.pose,
      raycast: (o, d) => this.host.raycast(o, d),
      runCommand: (name, args, phase) => { this.router.run(name, args, phase); },
      ptt: (phase) => this.router.run('voice.ptt', undefined, phase),
      key: (code) => {
        if (code === 'KeyP') this.router.run('perf.toggle', undefined, 'start');
        if (code === 'KeyH') this.page?.toggleCollapsed();
      },
    });
    this.perf = new PerfOverlay(this.renderer);
    this.camera.add(this.perf.object);
    this.perf.visible = this.cfg.perf || this.settings.value.perfOverlay;
  }

  private initVoiceAndRecording(): void {
    this.mic = new MicCapture();
    this.ptt = new PushToTalk({
      net: this.net,
      mic: this.mic,
      context: () => voiceContextOf(this.buildPose()),
      level: (v) => this.hud.level(v),
      connected: () => this.net.connected,
      ui: (state, detail) => {
        this.hud.voice(state, detail);
        if (state === 'error') this.net.send({ type: 'client.log', level: 'warn', message: `push-to-talk: ${detail ?? 'error'}` });
      },
    });
    // Reload / navigation mid-utterance: discard it on the server now (instead of
    // its stale timeout) and stop the mic.
    window.addEventListener('pagehide', () => {
      if (this.ptt.active) this.ptt.abort('page closed');
      this.mic.release();
    });
    this.recorder = new PoseRecorder({
      frames: () => ({ hands: this.hands, head: this.head }),
      features: input.computeFeatures,
      send: (m) => this.net.send(m),
      ui: (e) => this.hud.recording(e),
    });
    // The runtime receives pose.record and runs the in-world countdown
    // (RecordingUi); we sample exactly during its 'recording' phase.
    this.runtime.system.recording.onPhase((phase, req) => {
      if (phase === 'recording') this.recorder.startSampling(req);
      else if (phase === 'done') this.recorder.complete(req.requestId);
      else if (phase === 'cancelled') this.recorder.cancel();
    });
  }

  private initCommands(): void {
    const r = this.router;
    r.register('voice.ptt', (_a, phase) => this.ptt.handle(phase));
    r.register('session.mode', (args, phase) => {
      if (phase !== 'start') return;
      const mode = String(args?.mode ?? 'toggle');
      if (mode === 'exit' || mode === 'inline' || mode === 'desktop') void this.xr.exit();
      else if (mode === 'vr' || mode === 'ar' || mode === 'toggle') void this.xr.switchTo(mode);
      else this.hud.toast(`session.mode: unknown mode '${mode}'`, 'warn');
    });
    r.register('origin.recalibrate', (_a, phase) => {
      if (phase !== 'start') return;
      this.origin.recalibrate(this.headWorld);
      this.hud.toast('Space re-centered at your feet');
    });
    r.register('perf.toggle', (args, phase) => {
      if (phase !== 'start') return;
      const v = typeof args?.visible === 'boolean' ? args.visible : !this.perf.visible;
      this.perf.visible = v;
      this.settings.set({ perfOverlay: v });
      this.page?.syncSettings(this.settings.value);
    });
    r.register('hands.toggle', (args, phase) => {
      if (phase !== 'start') return;
      const key: keyof ClientSettings = this.xr.mode === 'ar' ? 'handsInAr' : 'handsInVr';
      const v = typeof args?.visible === 'boolean' ? args.visible : !this.settings.value[key];
      this.settings.set({ [key]: v } as Partial<ClientSettings>);
      this.page?.syncSettings(this.settings.value);
    });
    r.register('reload', (_a, phase) => { if (phase === 'start') location.reload(); });
  }

  private initPageUi(): void {
    this.hud = new Hud(this.runtime.system, null);
    if (this.role === 'mirror') return;
    this.page = new LandingUi({
      enter: (mode) => { void this.enterXr(mode); },
      exit: () => { void this.xr.exit(); },
      enableMic: () => { void this.ptt.warmup().then((ok) => { if (!ok) this.hud.toast(this.mic.error ?? 'Microphone unavailable', 'error'); }); },
      recalibrate: () => this.router.run('origin.recalibrate', undefined, 'start'),
      setSetting: (k, v) => {
        this.settings.set({ [k]: v } as Partial<ClientSettings>);
        if (k === 'perfOverlay') this.perf.visible = Boolean(v);
        if (k === 'highRes') this.xr.setQuality({ framebufferScale: v ? 1.3 : 1.0 });
      },
    }, this.settings.value, { showXrButtons: this.role === 'xr' });
    this.hud = new Hud(this.runtime.system, this.page);
    const refresh = () => this.page?.render({
      net: this.net.connected ? 'connected' : this.net.status.attempt > 1 ? 'offline' : 'connecting',
      primary: this.net.primary,
      clientId: this.net.clientId,
      role: this.role,
      xr: this.xr.supported,
      inXr: this.xr.mode,
      pendingMode: this.xr.pendingMode,
      mic: this.mic.state,
      micError: this.mic.error,
      emulation: this.emulation,
      origin: this.origin.status,
      listening: this.hud.listening,
    });
    refresh();
    setInterval(refresh, 250);
    this.net.onStatus(refresh);
  }

  /** Enter XR from a user gesture (button) or autoenter. */
  async enterXr(mode: XrMode): Promise<boolean> {
    const p = this.xr.enter(mode); // requestSession is issued synchronously inside the gesture
    if (this.role === 'xr' && this.mic.state === 'cold') void this.ptt.warmup();
    return p;
  }

  // ------------------------------------------------------------------ frame loop

  private frame(tMs: number, xrFrame?: XRFrame): void {
    // Clamp: long stalls (tab hidden) and time-base changes (window rAF ↔ XR rAF)
    // must not produce huge or negative steps.
    const raw = (tMs - this.lastT) / 1000;
    const dt = this.lastT && raw > 0 ? Math.min(0.1, raw) : 1 / 60;
    this.lastT = tMs;

    if (xrFrame && this.xr.active) this.readXr(xrFrame);
    else this.readDesktop(dt);

    // Place the space root at the origin (anchors may move it slightly each frame).
    const root = this.runtime.root;
    root.position.fromArray(this.origin.pose.position);
    root.quaternion.fromArray(this.origin.pose.rotation);

    composePose(this.origin.inverse, this.headWorld, this.head); // head in space coords (in place)
    const simHands = this.sim.get();
    this.hands = simHands ?? this.realHands;

    try {
      this.engine.update(this.hands, this.head, tMs);
    } catch (e) {
      this.reportError('interaction engine update failed', e);
    }
    this.runtime.setUser(this.userView());
    this.runtime.setHandFrames(this.hands);
    try { this.runtime.setPointerRays(this.engine.rays()); } catch { /* engine not ready */ }
    this.updateHandVisuals(simHands !== null);
    this.recorder.tick(tMs);

    // Only the primary xr client's pose is used by the server (it ignores the rest).
    if (this.role === 'xr' && this.net.connected && this.net.primary && this.poseGate.due(tMs)) {
      this.lastPose = this.buildPose();
      this.net.send({ type: 'user.pose', pose: this.lastPose });
    }

    try {
      this.runtime.update(dt, tMs / 1000);
    } catch (e) {
      // Keep rendering: a throwing update must not freeze the view (worst in XR).
      this.reportError('runtime update failed', e);
    }
    if (this.xr.mode === 'ar' && this.scene.background) this.scene.background = null; // keep passthrough visible
    this.renderer.render(this.scene, this.camera);
    this.perf.frame(tMs);
  }

  private readXr(frame: XRFrame): void {
    const ref = this.renderer.xr.getReferenceSpace();
    if (!ref) return;
    const viewer = frame.getViewerPose(ref);
    if (viewer) {
      setPose(this.headWorld, viewer.transform.position, viewer.transform.orientation);
      const view = viewer.views[0];
      if (view) this.fov = fovFromProjection(view.projectionMatrix, this.fov);
    }
    this.origin.update(frame, ref, viewer ? this.headWorld : null);
    this.handReader.read(frame, ref, this.origin.inverse, this.realHands);
  }

  private readDesktop(dt: number): void {
    this.desktop?.update(dt);
    setPose(this.headWorld, this.camera.position, this.camera.quaternion);
    this.fov ??= { fov: 0, aspect: 1 };
    this.fov.fov = this.camera.fov;
    this.fov.aspect = this.camera.aspect;
    const right = this.desktop?.hand() ?? null;
    if (right) this.realHands.right = right; else delete this.realHands.right;
    delete this.realHands.left;
  }

  private userView(): UserView {
    const hands: UserView['hands'] = {};
    for (const h of ['left', 'right'] as const) {
      const f = this.hands[h];
      if (f) {
        const w = jointPose(f, 0);
        hands[h] = { position: w.position, rotation: w.rotation, tracked: true };
      }
    }
    return { head: clonePose(this.head), hands };
  }

  private updateHandVisuals(sim: boolean): void {
    const s = this.settings.value;
    const mode = this.xr.mode;
    const show = sim || mode === null ? true : mode === 'ar' ? s.handsInAr : s.handsInVr;
    for (const h of ['left', 'right'] as const) {
      const v = this.handVisuals[h];
      if (!v) continue;
      const f = show ? this.hands[h] : undefined;
      v.object.visible = !!f;
      v.update(f);
    }
  }

  /** UserPose from the current frame state (space coords). */
  buildPose(): UserPose {
    const fwd: [number, number, number] = [0, 0, 0];
    transformDirection(this.head, [0, 0, -1], fwd);
    let gaze: PoseInputs['gaze'] = null;
    try { gaze = this.host.raycast(this.head.position, fwd); } catch { /* scene not ready */ }
    let rays: PoseInputs['rays'] = {};
    try { rays = this.engine.rays(); } catch { /* engine not ready */ }
    return buildUserPose({
      t: Date.now(),
      mode: this.mode,
      head: this.head,
      fov: this.fov?.fov,
      aspect: this.fov?.aspect,
      hands: this.hands,
      rays,
      gaze,
      selected: this.runtime.selected,
    });
  }

  /** End every running binding session (grab, held command) — e.g. on XR session start/end. */
  private cancelInteractions(): void {
    try { this.engine?.cancelAll(); } catch (e) { this.reportError('interaction cancel failed', e); }
  }

  // ------------------------------------------------------------------ hooks / diagnostics

  /** Run a command through the client router (test hook / devtools). */
  command(name: string, args?: CommandArgs, phase: CommandPhase = 'start'): string {
    return this.router.run(name, args, phase);
  }

  state(): Record<string, unknown> {
    return {
      role: this.role,
      connected: this.net.connected,
      ready: this.net.status.ready,
      clientId: this.net.clientId,
      primary: this.net.primary,
      mode: this.mode,
      xrSupported: this.xr.supported,
      pendingMode: this.xr.pendingMode,
      emulation: this.emulation ?? null,
      origin: { status: this.origin.status, pose: clonePose(this.origin.pose) },
      head: clonePose(this.head),
      hands: { left: !!this.hands.left, right: !!this.hands.right },
      simActive: this.sim.active,
      selected: this.runtime.selected,
      ptt: { active: this.ptt.active, utterance: this.ptt.currentUtterance, framesSent: this.ptt.framesSent },
      mic: { state: this.mic.state, error: this.mic.error ?? null },
      recorderBusy: this.recorder.busy,
      perf: { visible: this.perf.visible, ...this.perf.snapshot },
      commands: this.router.log.slice(-10),
      rays: summarizeRays(this.engine),
      sessions: this.engine.activeSessions(),
      activePoses: { left: this.engine.activePoses('left'), right: this.engine.activePoses('right') },
    };
  }

  private reportError(message: string, e: unknown): void {
    const err = e as Error;
    // Throttle (console + server): one report per message per 5 s — these can fire every frame.
    const now = performance.now();
    const last = this.errorTimes.get(message) ?? -Infinity;
    if (now - last < 5000) return;
    this.errorTimes.set(message, now);
    console.error(`[evol] ${message}`, e);
    this.net.send({ type: 'client.error', message: `${message}: ${err?.message ?? String(e)}`, stack: err?.stack });
  }
  private readonly errorTimes = new Map<string, number>();

  log(level: 'info' | 'warn' | 'error', message: string): void {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[evol] ${message}`);
    if (level !== 'info') this.net?.send({ type: 'client.log', level, message });
    if (level !== 'info') this.hud?.toast(message, level);
  }
}

/** Copy an {x,y,z} position + {x,y,z,w} orientation into a Pose in place (no allocation). */
function setPose(out: Pose, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): void {
  out.position[0] = p.x; out.position[1] = p.y; out.position[2] = p.z;
  out.rotation[0] = q.x; out.rotation[1] = q.y; out.rotation[2] = q.z; out.rotation[3] = q.w;
}

function summarizeRays(engine: EnginePort): Record<string, unknown> {
  try {
    const r = engine.rays();
    const out: Record<string, unknown> = {};
    for (const h of ['left', 'right'] as const) {
      const ray = r[h];
      if (ray) out[h] = { hit: ray.hit ? { entity: ray.hit.entity, distance: ray.hit.distance } : null };
    }
    return out;
  } catch {
    return {};
  }
}

