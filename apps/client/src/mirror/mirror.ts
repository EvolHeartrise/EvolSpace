// The mirror renderer: renders the live space (and a local "studio" for single
// widgets) on demand into PNG data URLs. Runs inside headless Chromium driven
// by apps/server/src/mirror, but also works in a normal browser tab
// (open /?role=mirror and call window.__evolMirror.capture(...) in devtools).
import * as THREE from 'three';
import type { ClientMessage, HandFrame, Handedness, ScreenshotRequest, UserPose, UserView, Vec3, WidgetManifest } from '@evolspace/protocol';
import { applyPlacement, explicitCamera, frameBox, userCamera, type CameraPlacement } from './framing.ts';
import { isStructural, SceneIndex } from './scene-index.ts';
import { pendingTextSyncs, settle, type SettleReport } from './settle.ts';
import { StudioStage } from './studio.ts';
import { LabelLayer, type HandVisualLike, type LabelSpec } from './overlays.ts';
import { parseBackground, type BackgroundSpec } from './background.ts';
import type { NetClient } from '@evolspace/runtime';
import { createGhostHand, createNet, createRuntime, passivePort, type RuntimeLike } from './runtime-adapter.ts';

/** Default backdrop for the live space when the runtime sets no scene.background. */
export const SPACE_BACKGROUND = '#1b1f26';
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;
const READY_TIMEOUT_MS = 20_000;
/** Per-capture bound on waiting for the initial state; below the server's capture timeout (20 s). */
const CAPTURE_READY_TIMEOUT_MS = 8_000;
const DEFAULT_ENTITY_DIRECTION = new THREE.Vector3(0, 0.3, 1);
const DEFAULT_WIDGET_DIRECTION = new THREE.Vector3(0.3, 0.25, 1);
/** Max wait for the server's latest scene version to arrive over the WS before capturing anyway. */
const SYNC_WAIT_MS = 3000;
/** Timeout for the pre-capture freshness requests (/api/scene/summary, /api/widgets). */
const SYNC_FETCH_MS = 1500;

/**
 * User view used when no headset pose is available: standing at the space
 * origin, looking down -Z. Head-anchored entities then sit at a stable place
 * instead of following the screenshot camera (which the runtime would
 * otherwise derive the head from), where they would block every view.
 */
export const DEFAULT_USER_VIEW: UserView = Object.freeze({
  head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] },
  hands: {},
}) as UserView;

/** Error text the server recognizes to restart the browser (see apps/server/src/mirror). */
export const CONTEXT_LOST_ERROR = 'mirror: WebGL context lost';
/** Prefix of the error when the page never got its initial state (the server restarts the browser). */
export const NOT_READY_ERROR = 'mirror: not ready';

export interface CaptureOptions {
  /** Reject if the widget reports an error while rendering (thumbnails). Default false. */
  failOnWidgetError?: boolean;
}

export interface MirrorInfo {
  gl: { renderer: string; vendor: string; software: boolean };
  contextLost: boolean;
  connected: boolean;
  sceneVersion: number;
  entities: number;
  widgets: string[];
  captures: number;
  lastSettle?: SettleReport;
}

export interface EvolMirrorApi {
  ready: Promise<void>;
  capture(req: ScreenshotRequest, userPose: UserPose | null, opts?: CaptureOptions): Promise<string>;
  info(): MirrorInfo;
}

interface RenderContext {
  kind: 'space' | 'studio';
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  runtime: RuntimeLike;
}

interface ReportedError {
  at: number;
  message: string;
  entity?: string;
  widget?: string;
}

export class MirrorRenderer implements EvolMirrorApi {
  readonly ready: Promise<void>;
  /** Resolves once the first snapshot + catalog arrived (never rejects). */
  private readonly loaded: Promise<void>;
  readonly renderer: THREE.WebGLRenderer;
  private readonly net: NetClient;
  private readonly space: RenderContext;
  private readonly studioStage = new StudioStage();
  private readonly studio: RenderContext;
  private readonly index = new SceneIndex();
  private readonly catalog = new Map<string, { error?: string }>();
  private catalogReceived = false;
  private snapshotReceived = false;
  private lastActivity = 0;
  private readonly errors: ReportedError[] = [];
  private readonly labels = new LabelLayer();
  private readonly hands = new Map<Handedness, { object: THREE.Object3D; visual: HandVisualLike }>();
  private lock: Promise<unknown> = Promise.resolve();
  private capturing = false;
  private captures = 0;
  private studioSeq = 0;
  private lastFrame = performance.now();
  private lastSettle?: SettleReport;
  private updateErrorLogged = false;
  /** User view fed to both runtimes every frame (the runtime expires a pose after 1 s). */
  private userView: UserView = DEFAULT_USER_VIEW;
  private handFrames: Partial<Record<Handedness, HandFrame | undefined>> = {};

  constructor(opts: { wsUrl: string; container?: HTMLElement }) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // toDataURL after render
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(DEFAULT_WIDTH, DEFAULT_HEIGHT, false);
    this.renderer.domElement.id = 'evol-mirror-canvas';
    (opts.container ?? document.body).appendChild(this.renderer.domElement);

    this.net = createNet(opts.wsUrl);
    // Both runtimes talk through passive ports: side effects (scene edits,
    // publishes, events) are dropped, errors are observed so captures can
    // wait for / flag them.
    const observe = (m: ClientMessage): void => this.observeOutgoing(m);
    const spacePort = passivePort(this.net, observe);
    const studioPort = passivePort(this.net, observe);

    // Both runtimes are constructed synchronously right after the NetClient so
    // that neither misses the initial catalog / gesture messages.
    const spaceScene = new THREE.Scene();
    spaceScene.name = 'mirror-space';
    const spaceCamera = new THREE.PerspectiveCamera(60, 4 / 3, 0.02, 500);
    this.space = {
      kind: 'space',
      scene: spaceScene,
      camera: spaceCamera,
      runtime: createRuntime({ scene: spaceScene, net: spacePort, renderer: this.renderer, camera: spaceCamera, sceneFromNet: true }),
    };
    const studioCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.studio = {
      kind: 'studio',
      scene: this.studioStage.scene,
      camera: studioCamera,
      runtime: createRuntime({ scene: this.studioStage.scene, net: studioPort, renderer: this.renderer, camera: studioCamera, sceneFromNet: false }),
    };

    let markReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => { markReady = resolve; });
    const checkReady = (): void => { if (this.snapshotReceived && this.catalogReceived) markReady(); };
    const touch = (): void => { this.lastActivity = performance.now(); };
    this.net.on('scene.snapshot', (m) => { this.index.applySnapshot(m.scene); this.snapshotReceived = true; touch(); checkReady(); });
    this.net.on('scene.patch', (m) => {
      this.index.applyPatch(m.version, m.ops);
      // Transform-only updates (an entity being dragged streams ~10/s) need no
      // settling; waiting for them to stop would stall captures mid-gesture.
      if (isStructural(m.ops)) touch();
    });
    this.net.on('widgets.catalog', (m) => {
      this.catalog.clear();
      for (const w of m.widgets) this.catalog.set(w.id, { error: w.error });
      this.catalogReceived = true;
      touch();
      checkReady();
    });
    this.net.on('widgets.updated', (m) => { this.catalog.set(m.widget.id, { error: m.widget.error }); touch(); });

    this.loaded = readyPromise;
    // Bounded view for the server's startup. Captures wait on `loaded` with their
    // own bound, so a late snapshot never leaves the page permanently unusable.
    this.ready = this.waitLoaded(READY_TIMEOUT_MS);
    this.ready.catch(() => {}); // surfaced via the server's await; avoid unhandled rejection noise

    // Keep runtimes ticking at a low rate between captures (links, channel
    // values, lazy anchors) without rendering.
    setInterval(() => { if (!this.capturing) this.tick(); }, 100);
  }

  info(): MirrorInfo {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return {
      gl: {
        renderer,
        vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
        software: /swiftshader|llvmpipe|software/i.test(renderer),
      },
      contextLost: gl.isContextLost(),
      connected: this.net.connected,
      sceneVersion: this.index.version,
      entities: this.index.entities.size,
      widgets: [...this.catalog.keys()].sort(),
      captures: this.captures,
      lastSettle: this.lastSettle,
    };
  }

  /** Serialized: concurrent calls run one after another. */
  capture(req: ScreenshotRequest, userPose: UserPose | null, opts: CaptureOptions = {}): Promise<string> {
    const run = this.lock.then(() => this.waitLoaded(CAPTURE_READY_TIMEOUT_MS)).then(() => this.captureNow(req, userPose, opts));
    this.lock = run.catch(() => {});
    return run;
  }

  /** `loaded`, bounded by `ms`. The error text is recognized by the server (restart). */
  private waitLoaded(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const missing = [!this.snapshotReceived && 'scene.snapshot', !this.catalogReceived && 'widgets.catalog'].filter(Boolean).join(' + ');
        reject(new Error(`${NOT_READY_ERROR} after ${ms} ms (no ${missing} from the server; connected=${this.net.connected})`));
      }, ms);
    });
    return Promise.race([this.loaded, timeout]).finally(() => clearTimeout(timer));
  }

  // ------------------------------------------------------------------ capture

  private async captureNow(req: ScreenshotRequest, pose: UserPose | null, opts: CaptureOptions): Promise<string> {
    const view = req.view;
    if (!view || typeof view !== 'object') throw new Error('mirror: request has no view');
    if (view.kind === 'user' && !pose) throw new Error("mirror: no user pose — the 'user' view needs a connected headset");
    const width = clampSize(req.width ?? DEFAULT_WIDTH);
    const height = clampSize(req.height ?? DEFAULT_HEIGHT);
    const aspect = width / height;
    const background = parseBackground(req.background);
    // Ghost hands belong to the space; the studio has no user in it.
    const showHands = (req.hands ?? view.kind === 'user') && view.kind !== 'widget';
    this.assertContext();

    this.capturing = true;
    const ctx = view.kind === 'widget' ? this.studio : this.space;
    const since = performance.now();
    const cleanup: Array<() => void> = [];
    try {
      this.renderer.setSize(width, height, false);
      this.setUserPose(pose);
      // Lazy head-follow panels jump to where they sit in front of this head
      // pose instead of gliding there during the capture.
      this.space.runtime.snapFollowers();
      await this.syncWithServer();

      let subjectId: string | null = null;
      if (view.kind === 'widget') {
        if (this.catalogReceived && !this.catalog.has(view.widget)) {
          const known = [...this.catalog.keys()].sort().join(', ') || '(none)';
          throw new Error(`mirror: unknown widget "${view.widget}" (known: ${known})`);
        }
        subjectId = this.spawnStudioSubject(view.widget, view.props ?? {});
        cleanup.push(() => this.clearStudio());
      }

      if (view.kind === 'entity' && this.snapshotReceived && !this.index.has(view.entity) && !this.space.runtime.entityObject(view.entity)) {
        throw new Error(`mirror: unknown entity "${view.entity}"`);
      }

      // Preliminary camera so per-frame work during settling sees a sane view.
      if (view.kind === 'user') applyPlacement(ctx.camera, userCamera(pose!), aspect);
      if (view.kind === 'camera') applyPlacement(ctx.camera, explicitCamera(view, null), aspect);

      this.lastSettle = await settle({
        roots: [ctx.runtime.root],
        step: () => this.frame(ctx),
        runtimeIdle: () => ctx.runtime.whenIdle(),
        lastActivity: () => this.lastActivity,
        isLoaded: () => (subjectId ? this.isLoaded(ctx, [subjectId], since) : this.spaceLoaded(since)),
      });
      if (this.lastSettle.timedOut) {
        console.warn(`mirror: scene did not settle within budget (${this.lastSettle.pending} pending); capturing anyway`);
      }

      if (subjectId && opts.failOnWidgetError) {
        const widget = (view as { widget: string }).widget;
        // Errors for our subject, or entity-less errors about this widget type (e.g. bundle import failures).
        const failed = this.studio.runtime.loadError(subjectId);
        if (failed) throw new Error(`mirror: widget "${widget}" failed: ${failed}`);
        const err = this.errorsSince(since).find((e) => e.entity === subjectId || (!e.entity && e.widget === widget));
        if (err) throw new Error(`mirror: widget "${widget}" reported an error while rendering: ${err.message}`);
      }

      // Final camera, from settled geometry.
      const placement = this.placeCamera(ctx, view, subjectId, aspect, pose);
      applyPlacement(ctx.camera, placement, aspect);

      if (ctx.kind === 'studio') {
        const box = subjectId ? this.boundsOf(ctx, subjectId) : new THREE.Box3();
        this.studioStage.layout(box, placement.position.distanceTo(box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())), background.mode !== 'transparent');
      }

      if (showHands && pose) cleanup.push(this.addHands(ctx.scene, pose));
      if (req.labels) cleanup.push(this.addLabels(ctx, subjectId, view.kind === 'widget' ? view.widget : undefined, height));
      cleanup.push(this.applyBackground(ctx, background));

      // Two frames: the first lets anything that reacts to the final camera
      // (troika, billboards, LOD) update; the second is what we capture.
      this.frame(ctx);
      await pendingTextsSettled(ctx.scene);
      this.frame(ctx);
      // A lost context renders nothing; fail loudly so the server restarts the browser.
      this.assertContext();
      const url = this.renderer.domElement.toDataURL('image/png');
      this.captures++;
      return url;
    } finally {
      for (const c of cleanup.reverse()) {
        try { c(); } catch (e) { console.error('mirror: cleanup failed', e); }
      }
      this.capturing = false;
    }
  }

  private placeCamera(
    ctx: RenderContext,
    view: ScreenshotRequest['view'],
    subjectId: string | null,
    aspect: number,
    pose: UserPose | null,
  ): CameraPlacement {
    switch (view.kind) {
      case 'user':
        return userCamera(pose!); // checked non-null at the top of captureNow
      case 'camera': {
        const content = new THREE.Box3().setFromObject(ctx.runtime.root);
        return explicitCamera(view, content.isEmpty() ? null : content.getCenter(new THREE.Vector3()));
      }
      case 'entity': {
        const obj = ctx.runtime.entityObject(view.entity);
        if (!obj && !this.index.has(view.entity)) throw new Error(`mirror: unknown entity "${view.entity}"`);
        const box = this.boundsOf(ctx, view.entity);
        const dir = view.direction ? new THREE.Vector3(...view.direction) : defaultDirection(obj, DEFAULT_ENTITY_DIRECTION);
        return frameBox(box, dir, { aspect, padding: view.padding });
      }
      case 'widget': {
        const box = this.boundsOf(ctx, subjectId!);
        const dir = view.direction ? new THREE.Vector3(...view.direction) : DEFAULT_WIDGET_DIRECTION.clone();
        return frameBox(box, dir, { aspect, padding: 0.12 });
      }
    }
  }

  /** World bounds of an entity subtree; a small box at its origin if it has no geometry. */
  private boundsOf(ctx: RenderContext, id: string): THREE.Box3 {
    let box = ctx.runtime.frameEntity(id);
    const obj = ctx.runtime.entityObject(id);
    // A widget with NaN geometry (e.g. a size prop that resolved to undefined)
    // poisons the whole box; recompute from the finite parts so we still frame it.
    if (box && !isFiniteBox(box) && obj) {
      console.warn(`mirror: entity ${id} has non-finite bounds (NaN geometry?); framing its finite parts`);
      box = finiteBounds(obj);
    }
    if (box && !box.isEmpty() && isFiniteBox(box)) return box;
    const p = obj ? obj.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    return new THREE.Box3().setFromCenterAndSize(p, new THREE.Vector3(0.2, 0.2, 0.2));
  }

  // ------------------------------------------------------------------ frames

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    try {
      for (const rt of [this.space.runtime, this.studio.runtime]) {
        rt.setUser(this.userView);
        rt.update(dt, now / 1000);
      }
    } catch (e) {
      if (!this.updateErrorLogged) console.error('mirror: runtime.update failed', e);
      this.updateErrorLogged = true;
    }
  }

  private frame(ctx: RenderContext): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    ctx.runtime.setUser(this.userView);
    ctx.runtime.update(dt, now / 1000);
    ctx.scene.updateMatrixWorld();
    this.renderer.render(ctx.scene, ctx.camera);
  }

  // ------------------------------------------------------------------ loading

  /** All (effectively visible) server entities have an object with something renderable, or reported an error. */
  private spaceLoaded(since: number): boolean {
    const ids: string[] = [];
    for (const e of this.index.entities.values()) if (this.index.isEffectivelyVisible(e.id)) ids.push(e.id);
    return this.isLoaded(this.space, ids, since);
  }

  /**
   * Every id's widget is created (or failed — the runtime then shows its
   * fallback). Entities the runtime has no widget record for yet count as
   * loaded once they have something renderable.
   */
  private isLoaded(ctx: RenderContext, ids: string[], since: number): boolean {
    const errored = new Set(this.errorsSince(since - 60_000).map((e) => e.entity).filter(Boolean));
    for (const id of ids) {
      const state = ctx.runtime.loadState(id);
      if (state === 'ready' || state === 'failed' || errored.has(id)) continue;
      if (state === 'loading') return false;
      const obj = ctx.runtime.entityObject(id);
      if (!obj || !hasRenderable(obj)) return false;
    }
    return true;
  }

  /** Every message a runtime tries to send passes here (before the passive filter). */
  private observeOutgoing(m: ClientMessage): void {
    // The runtime reports widget failures as client.error messages; remember
    // them so captures can wait for / flag them.
    if (m.type !== 'client.error') return;
    this.errors.push({ at: performance.now(), message: m.message, entity: m.entity, widget: m.widget });
    if (this.errors.length > 200) this.errors.splice(0, this.errors.length - 200);
  }

  private assertContext(): void {
    if (this.renderer.getContext().isContextLost()) throw new Error(CONTEXT_LOST_ERROR);
  }

  /** Head + hands for both runtimes: the capture's pose, or the default standing view. */
  private setUserPose(pose: UserPose | null): void {
    this.userView = pose ? toUserView(pose) : DEFAULT_USER_VIEW;
    this.handFrames = { left: pose?.hands?.left, right: pose?.hands?.right };
    for (const rt of [this.space.runtime, this.studio.runtime]) {
      rt.setUser(this.userView);
      rt.setHandFrames(this.handFrames);
    }
  }

  /**
   * Closes the race between "the agent changed something" and "the agent asks
   * for a screenshot": the WS messages carrying the change (scene.patch,
   * widgets.updated) may still be in flight when the capture starts. Asks the
   * server (same origin) for its current scene version and widget hashes, then
   * waits for the scene to catch up and applies newer manifests directly.
   * Best effort: if the API is unreachable we capture what we have.
   */
  private async syncWithServer(): Promise<void> {
    const base = this.net.httpBase;
    const [summary, manifests] = await Promise.all([
      fetchJson(new URL('api/scene/summary', base).toString()),
      fetchJson(new URL('api/widgets', base).toString()),
    ]);
    if (Array.isArray(manifests)) this.applyManifests(manifests as WidgetManifest[]);
    const version = (summary as { version?: unknown } | null)?.version;
    if (typeof version !== 'number' || !this.snapshotReceived || this.index.version >= version) return;
    const deadline = performance.now() + SYNC_WAIT_MS;
    while (this.index.version < version && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.index.version < version) {
      console.warn(`mirror: scene is behind the server (v${this.index.version} < v${version}) after ${SYNC_WAIT_MS} ms; capturing anyway`);
    }
  }

  /** Applies manifests whose bundle hash differs from what the runtimes use (as widgets.updated would). */
  private applyManifests(list: WidgetManifest[]): void {
    for (const m of list) {
      if (!m || typeof m.id !== 'string' || typeof m.hash !== 'string' || !m.hash) continue;
      this.catalog.set(m.id, { error: m.error });
      for (const rt of [this.space.runtime, this.studio.runtime]) {
        if (rt.manifestHash(m.id) !== m.hash) {
          rt.applyManifest(m);
          this.lastActivity = performance.now();
        }
      }
    }
  }

  private errorsSince(t: number): ReportedError[] {
    return this.errors.filter((e) => e.at >= t);
  }

  // ------------------------------------------------------------------ studio

  private spawnStudioSubject(widget: string, props: Record<string, unknown>): string {
    const id = `mirror-studio-${++this.studioSeq}`;
    this.studio.runtime.applySnapshot({
      version: this.studioSeq,
      workspace: '__mirror_studio',
      links: {},
      entities: {
        [id]: {
          id,
          parent: null,
          name: widget,
          widget,
          props,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          visible: true,
        },
      },
    });
    return id;
  }

  private clearStudio(): void {
    this.studio.runtime.applySnapshot({ version: ++this.studioSeq, workspace: '__mirror_studio', links: {}, entities: {} });
  }

  // ------------------------------------------------------------------ overlays

  private addHands(scene: THREE.Scene, pose: UserPose): () => void {
    const added: THREE.Object3D[] = [];
    for (const hand of ['left', 'right'] as const) {
      const frame: HandFrame | undefined = pose.hands?.[hand];
      if (!frame) continue;
      let h = this.hands.get(hand);
      if (!h) {
        h = createGhostHand(this.space.runtime.theme);
        this.hands.set(hand, h);
      }
      h.visual.update(frame);
      scene.add(h.object);
      added.push(h.object);
    }
    return () => { for (const o of added) o.removeFromParent(); };
  }

  private addLabels(ctx: RenderContext, subjectId: string | null, widget: string | undefined, viewportHeight: number): () => void {
    const specs: LabelSpec[] = [];
    if (ctx.kind === 'studio' && subjectId && widget) {
      const box = this.boundsOf(ctx, subjectId);
      specs.push({ title: widget, position: new THREE.Vector3(box.getCenter(new THREE.Vector3()).x, box.max.y, box.getCenter(new THREE.Vector3()).z) });
    } else {
      for (const e of this.index.entities.values()) {
        if (!this.index.isEffectivelyVisible(e.id) || !ctx.runtime.entityObject(e.id)) continue;
        const box = this.boundsOf(ctx, e.id);
        const c = box.getCenter(new THREE.Vector3());
        specs.push({ title: e.name ?? e.widget, lines: [`${e.widget} · ${e.id}`], position: new THREE.Vector3(c.x, box.max.y, c.z) });
      }
    }
    this.labels.set(specs);
    this.labels.fit(ctx.camera, viewportHeight);
    ctx.scene.add(this.labels.group);
    return () => {
      this.labels.group.removeFromParent();
      this.labels.clear();
    };
  }

  /** Applies the requested background; returns a function restoring the previous state. */
  private applyBackground(ctx: RenderContext, bg: BackgroundSpec): () => void {
    const prevBg = ctx.scene.background;
    const prevFog = ctx.scene.fog;
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    switch (bg.mode) {
      case 'scene':
        if (!ctx.scene.background) this.renderer.setClearColor(SPACE_BACKGROUND, 1);
        break;
      case 'transparent':
        ctx.scene.background = null;
        ctx.scene.fog = null;
        this.renderer.setClearColor(0x000000, 0);
        break;
      case 'color':
        if (bg.alpha >= 1) {
          ctx.scene.background = bg.color;
          if (ctx.scene.fog) (ctx.scene.fog as THREE.Fog).color = bg.color.clone();
        } else {
          ctx.scene.background = null;
          ctx.scene.fog = null;
          this.renderer.setClearColor(bg.color, bg.alpha);
        }
        break;
    }
    return () => {
      ctx.scene.background = prevBg;
      ctx.scene.fog = prevFog;
      this.renderer.setClearColor(prevClear, prevAlpha);
      if (ctx.kind === 'studio') this.studioStage.resetBackground();
    };
  }
}

// ------------------------------------------------------------------ helpers

/** GET JSON with a timeout; null on any failure (the caller treats freshness checks as best effort). */
async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SYNC_FETCH_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampSize(v: number): number {
  return Math.max(16, Math.min(4096, Math.round(Number.isFinite(v) ? v : DEFAULT_WIDTH)));
}

function hasRenderable(obj: THREE.Object3D): boolean {
  let found = false;
  obj.traverse((o) => {
    if (found) return;
    const r = o as THREE.Mesh & THREE.Line & THREE.Points & THREE.Sprite;
    if (r.isMesh || r.isLine || r.isPoints || r.isSprite) found = true;
  });
  return found;
}

function defaultDirection(obj: THREE.Object3D | undefined, local: THREE.Vector3): THREE.Vector3 {
  const dir = local.clone();
  if (obj) dir.applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
  return dir;
}

async function pendingTextsSettled(scene: THREE.Scene): Promise<void> {
  const waits = pendingTextSyncs([scene]);
  if (waits.length) await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 2000))]);
}

export function toUserView(pose: UserPose): UserView {
  const hands: UserView['hands'] = {};
  for (const hand of ['left', 'right'] as const) {
    const f = pose.hands?.[hand];
    if (f && f.joints.length >= 7) {
      const j = f.joints;
      hands[hand] = { position: [j[0], j[1], j[2]] as Vec3, rotation: [j[3], j[4], j[5], j[6]], tracked: true };
    } else {
      hands[hand] = { position: [0, 0, 0], rotation: [0, 0, 0, 1], tracked: false };
    }
  }
  return { head: pose.head, hands };
}

function isFiniteBox(b: THREE.Box3): boolean {
  return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite) || b.isEmpty();
}

/** World bounds of the renderables under `root`, skipping any whose own bounds are not finite. */
function finiteBounds(root: THREE.Object3D): THREE.Box3 {
  const out = new THREE.Box3();
  const part = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || !o.visible) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) return;
    part.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    if (isFiniteBox(part)) out.union(part);
  });
  return out;
}
