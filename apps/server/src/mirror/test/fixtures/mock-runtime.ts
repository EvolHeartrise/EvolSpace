// Minimal stand-in for @evolspace/runtime, used only when the mirror tests run
// with EVOL_MIRROR_MOCK_RUNTIME=1 (e.g. while the real runtime is unavailable
// or to isolate mirror bugs from runtime bugs). Implements just the surface the
// mirror uses: NetClient (the real one), SpaceRuntime (snapshot → widgets via
// dynamic import, update, entityObject, frameEntity, applySnapshot, setUser)
// and createHandVisual.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import type { ClientRole, Entity, HandFrame, SceneState, UserView, WidgetDefinition, WidgetInstance, WidgetManifest } from '@evolspace/protocol';
import { NetClient } from '../../../../../../packages/runtime/src/net/NetClient.ts';

export { NetClient };

export const DEFAULT_THEME = { text: '#ffffff', textDim: '#9aa4b2', accent: '#4aa3ff' };

interface Live {
  entity: Entity;
  group: THREE.Group;
  instance?: WidgetInstance;
  status: 'loading' | 'ready' | 'error' | 'missing';
  error: string | null;
}

export class SpaceRuntime {
  readonly root = new THREE.Group();
  readonly system = new THREE.Group();
  readonly theme = DEFAULT_THEME;
  private readonly pending = new Set<Promise<unknown>>();
  readonly widgets = {
    record: (id: string) => {
      const l = this.live.get(id);
      return l ? { status: l.status, error: l.error, widgetId: l.entity.widget } : undefined;
    },
    manifest: (id: string) => this.manifests.get(id),
    updateManifest: (m: WidgetManifest) => {
      this.manifests.set(m.id, m);
      for (const [id, l] of [...this.live]) {
        if (l.entity.widget !== m.id) continue;
        l.instance?.dispose?.();
        l.group.removeFromParent();
        this.live.delete(id);
        this.spawn(l.entity);
      }
    },
  };
  /** No anchors/lazy followers in the mock. */
  readonly reconciler = { nodes: new Map<string, { follower: { snap(): void } | null }>() };
  private readonly net: Pick<NetClient, 'on' | 'send'>;
  private readonly manifests = new Map<string, WidgetManifest>();
  private readonly live = new Map<string, Live>();
  private user: UserView = { head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} };

  constructor(opts: { scene: THREE.Scene; net: Pick<NetClient, 'on' | 'send'>; role: ClientRole; isMirror?: boolean; sceneFromNet?: boolean }) {
    this.net = opts.net;
    opts.scene.add(this.root);
    this.net.on('widgets.catalog', (m) => { for (const w of m.widgets) this.manifests.set(w.id, w); });
    if (opts.sceneFromNet !== false) this.net.on('scene.snapshot', (m) => this.applySnapshot(m.scene));
  }

  applySnapshot(scene: SceneState): void {
    for (const [id, l] of this.live) {
      if (!scene.entities[id]) {
        l.instance?.dispose?.();
        l.group.removeFromParent();
        this.live.delete(id);
      }
    }
    for (const e of Object.values(scene.entities)) if (!this.live.has(e.id)) this.spawn(e);
  }

  private spawn(e: Entity): void {
    const group = new THREE.Group();
    group.position.set(...e.transform.position);
    group.quaternion.set(...e.transform.rotation);
    group.scale.set(...e.transform.scale);
    group.visible = e.visible;
    this.root.add(group);
    const l: Live = { entity: e, group, status: 'loading', error: null };
    this.live.set(e.id, l);
    const m = this.manifests.get(e.widget);
    if (!m) return this.fail(l, `unknown widget ${e.widget}`);
    const p = import(/* @vite-ignore */ m.url)
      .then(async (mod: { default: WidgetDefinition }) => {
        if (this.live.get(e.id) !== l) return;
        const defaults = Object.fromEntries(Object.entries(mod.default.props ?? {}).map(([k, s]) => [k, s.default]));
        const ctx = {
          THREE,
          root: group,
          entityId: e.id,
          props: { ...defaults, ...e.props },
          theme: DEFAULT_THEME,
          ui: {
            text: (content: string, o: { size?: number; anchorX?: string; anchorY?: string } = {}) => {
              const t = new Text();
              Object.assign(t, { text: content, fontSize: o.size ?? 0.03, anchorX: o.anchorX ?? 'center', anchorY: o.anchorY ?? 'middle', color: 0xffffff, font: '/fonts/Inter-Regular.ttf' });
              t.sync();
              return Object.assign(t, { set: (s: string) => { t.text = s; t.sync(); } });
            },
          },
          isMirror: true,
          user: this.user,
        };
        l.instance = await mod.default.create(ctx as never);
        l.status = 'ready';
      })
      .catch((err: Error) => this.fail(l, err.message));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private fail(l: Live, message: string): void {
    l.status = 'error';
    l.error = message;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.2, 0.2, 0.2)), new THREE.LineBasicMaterial({ color: 0xff4040 }));
    l.group.add(box);
    this.net.send({ type: 'client.error', message, entity: l.entity.id, widget: l.entity.widget });
  }

  update(dt: number, t: number): void {
    for (const l of this.live.values()) l.instance?.update?.(dt, t);
  }

  setUser(view: UserView): void {
    this.user = view;
  }

  setHandFrames(_frames: Partial<Record<'left' | 'right', HandFrame | undefined>>): void { /* no hand anchors in the mock */ }

  entityObject(id: string): THREE.Object3D | undefined {
    return this.live.get(id)?.group;
  }

  frameEntity(id: string): THREE.Box3 | null {
    const g = this.live.get(id)?.group;
    return g ? new THREE.Box3().setFromObject(g) : null;
  }
}

export function createHandVisual(_theme: unknown, _opts?: unknown): { object: THREE.Object3D; update(f: HandFrame | undefined): void } {
  const g = new THREE.Group() as THREE.Group & { update(f: HandFrame | undefined): void };
  const spheres = Array.from({ length: 25 }, () => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd0a0 }));
    g.add(s);
    return s;
  });
  g.update = (f) => {
    g.visible = !!f;
    if (!f) return;
    spheres.forEach((s, i) => {
      s.position.set(f.joints[i * 7], f.joints[i * 7 + 1], f.joints[i * 7 + 2]);
      s.scale.setScalar(f.radii[i] ?? 0.008);
    });
  };
  return { object: g, update: (f) => g.update(f) };
}
