// The only module that touches @evolspace/runtime. The rest of the mirror
// codes against the narrow interfaces below, so runtime API drift is
// contained here.
import * as THREE from 'three';
import { NetClient, SpaceRuntime, createHandVisual, DEFAULT_THEME, type NetPort } from '@evolspace/runtime';
import type { ClientMessage, ServerMessage, SceneState, Theme, UserView, HandFrame, Handedness, WidgetManifest } from '@evolspace/protocol';
import { FallbackHandVisual, type HandVisualLike } from './overlays.ts';

export interface NetLike {
  readonly connected: boolean;
  send(m: ClientMessage): void;
  on<T extends ServerMessage['type']>(type: T, cb: (m: Extract<ServerMessage, { type: T }>) => void): () => void;
}

/** Load state of one entity's widget, as far as the mirror cares. */
export type EntityLoadState = 'loading' | 'ready' | 'failed' | 'unknown';

export interface RuntimeLike {
  readonly root: THREE.Group;
  readonly theme: Theme;
  update(dt: number, t: number): void;
  setUser(view: UserView): void;
  /** Full hand frames for joint-anchored entities (undefined = untracked). */
  setHandFrames(frames: Partial<Record<Handedness, HandFrame | undefined>>): void;
  /** Make lazy head-follow anchors jump to the current head on the next update (no glide). */
  snapFollowers(): void;
  entityObject(id: string): THREE.Object3D | undefined;
  frameEntity(id: string): THREE.Box3 | null;
  applySnapshot(scene: SceneState): void;
  /** Resolves when no widget imports/creates are pending. */
  whenIdle(): Promise<unknown>;
  /** Widget lifecycle state of an entity ('unknown' if the runtime has no record of it). */
  loadState(id: string): EntityLoadState;
  /** Last widget error for an entity, if its widget failed/missing. */
  loadError(id: string): string | null;
  /** Bundle hash of the manifest the runtime currently uses for `widget` (undefined if unknown). */
  manifestHash(widget: string): string | undefined;
  /** Apply a (newer) manifest as if a widgets.updated message had arrived. */
  applyManifest(m: WidgetManifest): void;
}

export function createNet(url: string): NetClient & NetLike {
  return new NetClient(url, 'mirror');
}

export { passivePort, PASSIVE_ALLOWED } from './passive.ts';

export function createRuntime(opts: {
  scene: THREE.Scene;
  net: NetPort;
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  sceneFromNet: boolean;
}): RuntimeLike {
  const rt = new SpaceRuntime({
    scene: opts.scene,
    net: opts.net,
    role: 'mirror',
    isMirror: true,
    renderer: opts.renderer,
    camera: opts.camera,
    sceneFromNet: opts.sceneFromNet,
    systemUi: false, // orb/panels/HUD are for the headset user, not for screenshots
  });
  return {
    root: rt.root,
    theme: rt.theme,
    update: (dt, t) => rt.update(dt, t),
    setUser: (v) => rt.setUser(v),
    setHandFrames: (f) => rt.setHandFrames(f),
    snapFollowers: () => {
      for (const node of rt.reconciler.nodes.values()) node.follower?.snap();
    },
    entityObject: (id) => rt.entityObject(id),
    frameEntity: (id) => rt.frameEntity(id),
    applySnapshot: (s) => rt.applySnapshot(s),
    whenIdle: () => rt.whenIdle(),
    loadState: (id) => {
      const rec = rt.widgets.record(id);
      if (!rec) return 'unknown';
      switch (rec.status) {
        case 'ready': return 'ready';
        case 'error':
        case 'missing': return 'failed';
        default: return 'loading';
      }
    },
    loadError: (id) => {
      const rec = rt.widgets.record(id);
      if (!rec) return null;
      if (rec.status === 'missing') return rec.error ?? `widget '${rec.widgetId}' is not in the catalog`;
      return rec.status === 'error' ? (rec.error ?? 'widget failed') : null;
    },
    manifestHash: (widget) => rt.widgets.manifest(widget)?.hash,
    applyManifest: (m) => rt.widgets.updateManifest(m),
  };
}

/** The runtime's hand visual (same look as in VR) at reduced opacity; falls back to a simple skeleton. */
export function createGhostHand(theme: Theme = DEFAULT_THEME): { object: THREE.Object3D; visual: HandVisualLike } {
  try {
    const v = createHandVisual(theme, { opacity: 0.6 });
    return { object: v.object, visual: { update: (f: HandFrame | undefined) => v.update(f) } };
  } catch (e) {
    console.warn('mirror: createHandVisual failed, using fallback hands', e);
    const fb = new FallbackHandVisual();
    return { object: fb, visual: fb };
  }
}
