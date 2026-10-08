// SpaceRuntime: the browser-side EvolSpace scene runtime. Wires together
//   SceneMirror  (server scene state)  → Reconciler (three.js graph, anchors)
//   WidgetHost   (widget lifecycle)    ← LinkEngine (dataflow) ← ChannelHub (data bus)
//   SceneWriter  (outgoing widget edits), Picker + RuntimeInteractionHost (input)
//   SystemUi     (agent orb/panel, voice HUD, toasts, recording countdown)
// and subscribes itself to the NetClient. The client owns the XR session,
// the render loop, and positions `root` (the space origin).

import * as THREE from 'three';
import type {
  ClientRole,
  Entity,
  Handedness,
  HandFrame,
  InteractionSet,
  PoseDef,
  SceneOp,
  SceneState,
  Theme,
  UserView,
} from '@evolspace/protocol';
import { LocalCommands, type CommandPhase, type LocalCommandFn } from './commands/LocalCommands.ts';
import { ChannelHub } from './data/ChannelHub.ts';
import { Picker } from './interaction/Picker.ts';
import { PointerVisuals } from './interaction/PointerVisuals.ts';
import { RuntimeInteractionHost } from './interaction/RuntimeInteractionHost.ts';
import type { InteractionHost, PointerRays } from './interaction/types.ts';
import { LinkEngine } from './links/LinkEngine.ts';
import type { NetPort } from './net/types.ts';
import { Reconciler } from './scene/Reconciler.ts';
import { isEmptyDiff, SceneMirror, type SceneDiff } from './scene/SceneMirror.ts';
import { SceneWriter } from './scene/SceneWriter.ts';
import { SystemUi } from './system/SystemUi.ts';
import { createTheme, SYSTEM_STYLE } from './theme.ts';
import { BoundsOutline } from './ui/BoundsOutline.ts';
import { configureTroika, preloadFonts, troikaTextFactory } from './ui/troika.ts';
import { RuntimeUiKit, type TextFactory } from './ui/UiKit.ts';
import { now } from './util/rate.ts';
import { WidgetHost, type ModuleLoader } from './widgets/WidgetHost.ts';

export interface SpaceRuntimeOptions {
  scene: THREE.Scene;
  net: NetPort;
  role: ClientRole;
  isMirror?: boolean;
  renderer?: THREE.WebGLRenderer;
  camera: THREE.Camera;
  /** When false, scene snapshots/patches from the net are ignored (mirror studio scenes). Default true. */
  sceneFromNet?: boolean;
  theme?: Partial<Theme>;
  /** Text implementation (default troika). Pass `stubTextFactory` to run headless. */
  textFactory?: TextFactory;
  /** Where fonts are served (default /fonts/). */
  fontBase?: string;
  /** Widget module loader (default: dynamic import). */
  loadModule?: ModuleLoader;
  /** Base URL for widget bundles (default: the NetClient's HTTP origin, else the page). */
  widgetBaseUrl?: string;
  /** Show system UI (orb, panel, toasts…). Default: !isMirror. */
  systemUi?: boolean;
}

export interface GestureDefs {
  poses: PoseDef[];
  interactions: Record<string, InteractionSet>;
}

export class SpaceRuntime {
  /** Space-origin group; the client positions it (floor / spatial anchor). */
  readonly root = new THREE.Group();
  readonly system: SystemUi;
  readonly theme: Theme;
  readonly ui: RuntimeUiKit;
  readonly role: ClientRole;
  readonly isMirror: boolean;
  readonly sceneFromNet: boolean;
  /** Live user view (also what widgets see as ctx.user). */
  readonly user: UserView = { head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} };

  readonly mirror = new SceneMirror();
  readonly reconciler: Reconciler;
  readonly widgets: WidgetHost;
  readonly links: LinkEngine;
  readonly channels: ChannelHub;
  readonly commands: LocalCommands;
  readonly picker: Picker;
  readonly pointer: PointerVisuals;
  readonly writer: SceneWriter;

  private readonly net: NetPort;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private host: RuntimeInteractionHost;
  private selection: BoundsOutline;
  private _selected: string | null = null;
  private selectionListeners = new Set<(id: string | null) => void>();
  private gestureListeners = new Set<(g: GestureDefs) => void>();
  private _gestures: GestureDefs | null = null;
  private offs: Array<() => void> = [];
  private userSetAt = -Infinity;
  private headPos = new THREE.Vector3(0, 1.6, 0);
  private headQuat = new THREE.Quaternion();
  private rootInv = new THREE.Matrix4();

  constructor(opts: SpaceRuntimeOptions) {
    this.net = opts.net;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.role = opts.role;
    this.isMirror = opts.isMirror ?? opts.role === 'mirror';
    this.sceneFromNet = opts.sceneFromNet !== false;
    this.theme = createTheme(opts.theme);

    this.root.name = 'space-root';
    this.scene.add(this.root);

    let textFactory = opts.textFactory;
    if (!textFactory) {
      configureTroika(opts.fontBase);
      if (typeof window !== 'undefined') preloadFonts(opts.fontBase);
      textFactory = troikaTextFactory;
    }
    this.ui = new RuntimeUiKit(this.theme, { textFactory, fontBase: opts.fontBase });

    this.system = new SystemUi(this.ui, { enabled: opts.systemUi ?? !this.isMirror });
    this.root.add(this.system.group);

    this.commands = new LocalCommands((name, err) => this.reportError(`local command ${name} failed: ${(err as Error)?.message ?? err}`, err));

    this.channels = new ChannelHub(this.net, (ch, err) => this.reportError(`listener of channel ${ch} threw: ${(err as Error)?.message ?? err}`, err));

    // Scene edits only make sense against the server's scene; a local (mirror
    // studio) scene keeps them local.
    const scenePort = {
      send: (m: Parameters<NetPort['send']>[0]) => {
        if (m.type === 'scene.ops' && !this.sceneFromNet) return;
        this.net.send(m);
      },
    };
    this.writer = new SceneWriter(scenePort, (ops) => this.applyLocalOps(ops));

    this.links = new LinkEngine({
      deliverInput: (entity, port, value) => this.widgets.deliverInput(entity, port, value),
      publish: (channel, value) => this.channels.publish(channel, value),
      subscribe: (channel, cb) => this.channels.subscribe(channel, cb),
      reportError: (message, d) => this.reportError(message, undefined, d.entity),
    });

    this.widgets = new WidgetHost({
      ui: this.ui,
      theme: this.theme,
      net: this.net,
      channels: this.channels,
      links: this.links,
      writer: this.writer,
      mirror: this.mirror,
      user: this.user,
      isMirror: this.isMirror,
      loadModule: opts.loadModule,
      baseUrl: opts.widgetBaseUrl ?? this.net.httpBase,
      onError: (message) => this.system.toast(message, 'error'),
      onContentChanged: (id) => this.picker.invalidate(id),
    });

    this.reconciler = new Reconciler(this.root, this.mirror, {
      onAdded: (e, node) => this.widgets.onAdded(e, node),
      onRemoved: (id) => {
        this.widgets.onRemoved(id);
        this.picker.forget(id);
        this.host?.forget(id);
        this.writer.forget(id);
        if (this._selected === id) this.select(null);
      },
      onChanged: (e, change, node) => {
        this.widgets.onChanged(e, change, node);
        if (change.transform || change.props) this.picker.invalidate(e.id);
      },
      onWarning: (w) => console.warn('[scene]', w),
    });

    this.picker = new Picker(this.root, {
      entityIds: () => this.reconciler.nodes.keys(),
      nodeObject: (id) => this.reconciler.node(id)?.object,
      content: (id) => this.widgets.contentOf(id),
      interactives: (id) => this.widgets.interactivesOf(id),
      sizeHint: (id) => {
        const e = this.mirror.entity(id);
        return e ? this.widgets.manifest(e.widget)?.size : undefined;
      },
    });

    this.pointer = new PointerVisuals(this.theme);
    this.root.add(this.pointer.group);
    this.selection = new BoundsOutline(SYSTEM_STYLE.selection, 0.95, 0.014);
    this.root.add(this.selection.object);

    this.host = new RuntimeInteractionHost({
      root: this.root,
      mirror: this.mirror,
      reconciler: this.reconciler,
      picker: this.picker,
      widgets: this.widgets,
      net: scenePort,
      channels: this.channels,
      pointer: this.pointer,
      runLocalCommand: (n, a, p) => this.runLocalCommand(n, a, p),
    });

    this.registerBuiltinCommands();
    this.subscribeNet();
  }

  // ------------------------------------------------------------------ net wiring

  private subscribeNet(): void {
    const n = this.net;
    this.offs.push(
      n.on('scene.snapshot', (m) => {
        if (this.sceneFromNet) this.applySnapshot(m.scene);
      }),
      n.on('scene.patch', (m) => {
        if (!this.sceneFromNet) return;
        const ops = this.writer.filterIncoming(m.ops, (id) => this.mirror.entity(id));
        this.applyDiff(this.mirror.applyOps(ops, m.version));
      }),
      n.on('widgets.catalog', (m) => this.widgets.setCatalog(m.widgets)),
      n.on('widgets.updated', (m) => this.widgets.updateManifest(m.widget)),
      n.on('gestures.defs', (m) => {
        this._gestures = { poses: m.poses, interactions: m.interactions };
        for (const cb of [...this.gestureListeners]) {
          try { cb(this._gestures); } catch (err) { console.error('gestures listener threw', err); }
        }
      }),
      n.on('agent.status', (m) => this.system.setAgentStatus(m.status)),
      n.on('agent.message', (m) => this.system.addMessage(m.message)),
      n.on('voice.result', (m) => this.system.voiceResult(m)),
      n.on('pose.record', (m) => {
        if (!this.isMirror) this.system.recording.start(m);
      }),
      n.on('command', (m) => {
        if (!this.runLocalCommand(m.name, m.args, 'start')) {
          console.warn(`[runtime] server sent unknown client command '${m.name}'`);
        }
      }),
      n.onStatus((s) => this.system.setConnected(s.connected)),
    );
    this.system.setConnected(n.connected);
  }

  // ------------------------------------------------------------------ scene

  applySnapshot(scene: SceneState): void {
    this.applyDiff(this.mirror.applySnapshot(scene));
  }

  /** Apply ops (local scenes, tests). `version` enables stale-batch rejection. */
  applyPatch(ops: SceneOp[], version?: number): void {
    this.applyDiff(this.mirror.applyOps(ops, version));
  }

  private applyLocalOps(ops: SceneOp[]): void {
    this.applyDiff(this.mirror.applyOps(ops));
  }

  private applyDiff(diff: SceneDiff): void {
    if (isEmptyDiff(diff)) {
      for (const w of diff.warnings) console.warn('[scene]', w);
      return;
    }
    this.reconciler.apply(diff);
    if (diff.linksChanged) this.links.setLinks(this.mirror.state.links);
  }

  get sceneState(): SceneState {
    return this.mirror.state;
  }

  entity(id: string): Entity | undefined {
    return this.mirror.entity(id);
  }

  entityObject(id: string): THREE.Object3D | undefined {
    return this.reconciler.node(id)?.object;
  }

  /** World bounds of an entity subtree (mirror framing). */
  frameEntity(id: string): THREE.Box3 | null {
    this.picker.beginFrame();
    return this.picker.subtreeBounds(id, new THREE.Box3());
  }

  get gestures(): GestureDefs | null {
    return this._gestures;
  }

  onGestures(cb: (g: GestureDefs) => void): () => void {
    this.gestureListeners.add(cb);
    if (this._gestures) cb(this._gestures);
    return () => { this.gestureListeners.delete(cb); };
  }

  /** Resolves when all pending widget loads settled (tests, mirror screenshots). */
  whenIdle(): Promise<void> {
    return this.widgets.whenIdle();
  }

  // ------------------------------------------------------------------ user

  setUser(view: UserView): void {
    const h = this.user.head;
    copyInto(h.position, view.head.position);
    copyInto(h.rotation, view.head.rotation);
    for (const hand of ['left', 'right'] as Handedness[]) {
      const src = view.hands[hand];
      if (!src) {
        delete this.user.hands[hand];
        this.reconciler.anchors.setHandPose(hand, undefined);
        continue;
      }
      let dst = this.user.hands[hand];
      if (!dst) this.user.hands[hand] = dst = { position: [0, 0, 0], rotation: [0, 0, 0, 1], tracked: false };
      copyInto(dst.position, src.position);
      copyInto(dst.rotation, src.rotation);
      dst.tracked = src.tracked;
      this.reconciler.anchors.setHandPose(hand, dst);
    }
    this.userSetAt = now();
  }

  /** Full hand frames (space coords) for joint-anchored entities. */
  setHandFrames(frames: Partial<Record<Handedness, HandFrame | undefined>>): void {
    this.reconciler.anchors.setHandFrame('left', frames.left);
    this.reconciler.anchors.setHandFrame('right', frames.right);
  }

  /** Feed InteractionEngine.rays() each frame for ray/cursor visuals. */
  setPointerRays(rays: PointerRays): void {
    this.pointer.setRays(rays);
  }

  // ------------------------------------------------------------------ interaction & commands

  interactionHost(): InteractionHost {
    return this.host;
  }

  /** Returns false when the command is not handled locally (the client forwards it to the server). */
  runLocalCommand(name: string, args: Record<string, unknown> | undefined, phase: CommandPhase): boolean {
    return this.commands.run(name, args, phase);
  }

  /** Register a client-local command (voice.ptt, session.mode, origin.recalibrate, …). */
  registerLocalCommand(name: string, fn: LocalCommandFn): () => void {
    return this.commands.register(name, fn);
  }

  get selected(): string | null {
    return this._selected;
  }

  select(id: string | null): void {
    const next = id && this.mirror.entity(id) ? id : null;
    if (next === this._selected) return;
    this._selected = next;
    for (const cb of [...this.selectionListeners]) {
      try { cb(next); } catch (err) { console.error('selection listener threw', err); }
    }
  }

  onSelectionChange(cb: (id: string | null) => void): () => void {
    this.selectionListeners.add(cb);
    return () => { this.selectionListeners.delete(cb); };
  }

  private registerBuiltinCommands(): void {
    this.commands.register('select', (args, phase) => {
      if (phase !== 'start') return;
      if (args && typeof args.entity === 'string') return this.select(args.entity);
      if (args && args.entity === null) return this.select(null);
      const hand = args?.hand === 'left' || args?.hand === 'right' ? args.hand : null;
      const target = hand ? this.pointer.hoverOf(hand)?.entity ?? null : this.pointer.hoveredEntity();
      // Selecting the selected entity again toggles it off.
      this.select(target && target === this._selected ? null : target);
    });
    this.commands.register('agent.panel.toggle', (_a, phase) => {
      if (phase === 'start') this.system.togglePanel();
    });
    this.commands.register('agent.panel.scroll', (args, phase) => {
      if (phase === 'start') this.system.panel.scroll(typeof args?.delta === 'number' ? args.delta : 1);
    });
    this.commands.register('pose.record.cancel', (_a, phase) => {
      if (phase === 'start') this.system.recording.cancel();
    });
  }

  // ------------------------------------------------------------------ errors

  /** Report a runtime-level error (toast + server log). */
  reportError(message: string, err?: unknown, entity?: string): void {
    console.error(`[runtime] ${message}`, err ?? '');
    this.net.send({ type: 'client.error', message, stack: err instanceof Error ? err.stack : undefined, entity });
    this.system.toast(message, 'error');
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, t: number): void {
    const tMs = now();
    this.links.beginFrame();
    this.picker.beginFrame();
    this.updateHead(tMs);
    this.reconciler.anchors.setHead(this.user.head.position, this.user.head.rotation);
    this.reconciler.update(dt, this.headPos, this.headQuat, tMs);
    this.widgets.update(dt, t);
    this.writer.flush(tMs);
    this.host.flush(tMs);
    this.system.update(dt, this.headPos, this.headQuat);
    this.pointer.update(this.headPos, !this.isMirror);
    this.updateOutlines();
    this.ui.flush();
  }

  private updateHead(tMs: number): void {
    if (tMs - this.userSetAt > 1000) {
      // No user pose from the client (desktop / before XR starts): derive the
      // head from the camera, expressed in space coordinates.
      this.root.updateWorldMatrix(true, false);
      this.camera.updateWorldMatrix(true, false);
      this.rootInv.copy(this.root.matrixWorld).invert();
      _m.multiplyMatrices(this.rootInv, this.camera.matrixWorld).decompose(this.headPos, this.headQuat, _s);
      const p = this.user.head.position;
      const q = this.user.head.rotation;
      p[0] = this.headPos.x; p[1] = this.headPos.y; p[2] = this.headPos.z;
      q[0] = this.headQuat.x; q[1] = this.headQuat.y; q[2] = this.headQuat.z; q[3] = this.headQuat.w;
      return;
    }
    const h = this.user.head;
    this.headPos.set(h.position[0], h.position[1], h.position[2]);
    this.headQuat.set(h.rotation[0], h.rotation[1], h.rotation[2], h.rotation[3]);
  }

  private updateOutlines(): void {
    const hovered = this.isMirror ? null : this.pointer.hoveredEntity();
    const showHover = hovered && hovered !== this._selected;
    if (!showHover && !this._selected) {
      this.pointer.highlight.hide();
      this.selection.hide();
      return;
    }
    this.root.updateWorldMatrix(true, false);
    this.rootInv.copy(this.root.matrixWorld).invert();
    this.outline(this.pointer.highlight, showHover ? hovered : null);
    this.outline(this.selection, this._selected);
  }

  private outline(o: BoundsOutline, id: string | null): void {
    const node = id ? this.reconciler.node(id) : undefined;
    const box = node ? this.picker.localBounds(node.id) : null;
    if (!node || !box || !node.object.visible) {
      o.hide();
      return;
    }
    node.object.updateWorldMatrix(true, false);
    o.show(node.object, box, this.rootInv);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.widgets.dispose();
    this.links.dispose();
    this.channels.dispose();
    this.reconciler.clear();
    this.reconciler.anchors.dispose();
    this.system.dispose();
    this.pointer.dispose();
    this.selection.dispose();
    this.scene.remove(this.root);
  }
}

function copyInto(dst: number[], src: readonly number[]): void {
  for (let i = 0; i < dst.length && i < src.length; i++) dst[i] = src[i];
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
