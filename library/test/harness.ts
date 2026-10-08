// Fake WidgetContext harness for testing library widgets in Node.
//
// Real three.js; a stub UiKit (text = plain Mesh with the troika fields the
// widgets touch, panels = PlaneGeometry meshes, cached shared materials); an
// in-memory channel bus; and recorders for everything a widget can do to the
// outside world (emit, setProps, publish, event, askAgent, spawnChild, error).
//
//   const h = await mount(slider, { min: 0, max: 10, value: 3 });
//   h.input('value', 7);          // like a linked input
//   h.drag('knob', [0,0,0], [0.05,0,0]);  // pinch-drag an interactive part
//   h.frame();                    // update() + text sync
//   h.lastEmit('value');
//   h.dispose();                  // asserts nothing is called after dispose
//
// The host semantics mirrored here (packages/runtime/src/widgets/*):
//   - props get spec defaults (enum → first option) before create/onProps
//   - ctx.setProps assigns into ctx.props first (no onProps echo)
//   - onProps(live, prev) if implemented, else dispose + re-create
//   - inputs received before/between instances are replayed after create

import * as THREE from 'three';
import type {
  ChannelValue,
  InteractionEvent,
  Theme,
  Transform,
  UserView,
  WidgetContext,
  WidgetDefinition,
  WidgetInstance,
} from '@evolspace/protocol';

export const TEST_THEME: Theme = {
  background: '#0e131b',
  surface: '#1a2230',
  border: '#3b475a',
  text: '#e9eef5',
  textDim: '#8d99ab',
  accent: '#4cc3ff',
  accent2: '#ffb547',
  positive: '#45d49b',
  negative: '#ff5d6c',
  palette: ['#4cc3ff', '#ffb547', '#45d49b', '#ff6f91', '#a98bff', '#f2dc5d', '#4fd9d4', '#ff8a5b', '#9ad85a', '#e48ad6'],
  diverging: ['#3f8cff', '#d5d9e0', '#ff4d5e'],
  sequential: ['#1d2f5c', '#22488a', '#2366b0', '#2a88c9', '#3caed6', '#66cdd5', '#9fe2c9', '#d5f1bf', '#fff8d6'],
};

/** Stand-in for troika Text: same fields the widgets read/write; sync() estimates bounds. */
export class FakeText extends THREE.Mesh {
  text = '';
  font = 'sans';
  fontSize = 0.03;
  color: unknown = null;
  maxWidth = Infinity;
  anchorX: string | number = 'center';
  anchorY: string | number = 'middle';
  colorRanges: Record<number, number> | null = null;
  disposed = false;
  dirty = true;
  textRenderInfo: { blockBounds: [number, number, number, number] } | null = null;

  /** Counts troika-style per-frame preparation (troika does real work in onBeforeRender; widgets must not clobber it). */
  prepared = 0;

  onBeforeRender(..._args: unknown[]): void {
    this.prepared++;
  }

  set(s: string): void {
    const str = s == null ? '' : String(s);
    if (str === this.text) return;
    this.text = str;
    this.dirty = true;
  }

  sync(): void {
    this.dirty = false;
    const adv = (this.font === 'mono' ? 0.6 : 0.55) * this.fontSize;
    const lines = this.text.split('\n');
    const perLine = Number.isFinite(this.maxWidth) ? Math.max(1, Math.floor(this.maxWidth / adv)) : Infinity;
    let n = 0;
    let w = 0;
    for (const l of lines) {
      n += perLine === Infinity ? 1 : Math.max(1, Math.ceil(l.length / perLine));
      w = Math.max(w, Math.min(l.length, perLine) * adv);
    }
    const h = n * this.fontSize * 1.25;
    const x0 = this.anchorX === 'left' ? 0 : this.anchorX === 'right' ? -w : -w / 2;
    const y1 = this.anchorY === 'top' ? 0 : this.anchorY === 'bottom' ? h : h / 2;
    this.textRenderInfo = { blockBounds: [x0, y1 - h, x0 + w, y1] };
  }

  dispose(): void {
    this.disposed = true;
    this.geometry.dispose();
  }
}

export interface Recorded {
  emits: Array<{ port: string; value: unknown }>;
  setProps: Array<Record<string, unknown>>;
  published: Array<{ channel: string; value: unknown }>;
  events: Array<{ name: string; data?: unknown }>;
  asks: string[];
  errors: Array<{ message: string; detail?: unknown }>;
  logs: unknown[][];
  children: Array<{ widget: string; props?: Record<string, unknown>; transform?: Partial<Transform>; name?: string; id: string }>;
  /** Calls made through a ctx after its instance was disposed (should stay empty). */
  afterDispose: string[];
}

export interface MountOptions {
  isMirror?: boolean;
  /** Channel values present before create (subscribe fires immediately with them). */
  channels?: Record<string, ChannelValue>;
  user?: UserView;
}

const shared = <T extends { userData: Record<string, unknown> }>(x: T): T => {
  x.userData.evolShared = true;
  return x;
};

/** Apply PropSpec defaults (clone) like the runtime's resolveProps (without coercion warnings). */
export function resolveDefaults(def: WidgetDefinition, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [k, spec] of Object.entries(def.props ?? {})) {
    if (out[k] !== undefined) continue;
    if (spec.default !== undefined) out[k] = structuredClone(spec.default);
    else if (spec.type === 'enum' && spec.options?.length) out[k] = spec.options[0];
  }
  return out;
}

export class Harness {
  readonly root = new THREE.Group();
  readonly rec: Recorded = { emits: [], setProps: [], published: [], events: [], asks: [], errors: [], logs: [], children: [] , afterDispose: [] };
  readonly texts: FakeText[] = [];
  readonly interactives = new Set<THREE.Object3D>();
  readonly channelValues = new Map<string, ChannelValue>();
  private subs = new Map<string, Set<(v: ChannelValue) => void>>();
  instance: WidgetInstance | null = null;
  ctx!: WidgetContext;
  props: Record<string, unknown> = {};
  private inputs = new Map<string, unknown>();
  private alive = false;
  private materials = new Map<string, THREE.Material>();
  private childSeq = 0;
  t = 0;
  creates = 0;
  /** Optional observer for emits (e.g. to route values over simulated links). */
  onEmit: ((port: string, value: unknown) => void) | null = null;
  /** Optional observer for channel publishes. */
  onPublish: ((channel: string, value: unknown) => void) | null = null;

  constructor(readonly def: WidgetDefinition, private opts: MountOptions = {}) {
    for (const [k, v] of Object.entries(opts.channels ?? {})) this.channelValues.set(k, v);
  }

  // ---------------------------------------------------------------- lifecycle

  async create(rawProps: Record<string, unknown>): Promise<this> {
    this.props = resolveDefaults(this.def, rawProps);
    this.alive = true;
    this.ctx = this.makeContext();
    this.creates++;
    this.instance = (await this.def.create(this.ctx)) ?? {};
    for (const [port, v] of this.inputs) this.instance.onInput?.(port, v);
    this.syncTexts();
    return this;
  }

  /** Prop patch as if it came from the server (agent/scene update). */
  async setProps(patch: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = { ...this.props, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete merged[k];
    const next = resolveDefaults(this.def, merged);
    const inst = this.instance;
    if (inst?.onProps) {
      const prev = { ...this.props };
      const live = this.props;
      for (const k of Object.keys(live)) if (!(k in next)) delete live[k];
      Object.assign(live, next);
      inst.onProps(live, prev);
      this.syncTexts();
    } else {
      this.teardown();
      await this.create(next);
    }
  }

  input(port: string, value: unknown): void {
    this.inputs.set(port, value);
    this.instance?.onInput?.(port, value);
    this.syncTexts();
  }

  /** Run n frames of update() (dt seconds each) and sync texts like the host's per-frame flush. */
  frame(n = 1, dt = 1 / 72): void {
    for (let i = 0; i < n; i++) {
      this.t += dt;
      this.instance?.update?.(dt, this.t);
      this.syncTexts();
    }
  }

  /** Server pushes a channel value. */
  publish(channel: string, value: ChannelValue): void {
    this.channelValues.set(channel, value);
    for (const cb of [...(this.subs.get(channel) ?? [])]) cb(value);
    this.syncTexts();
  }

  subscriberCount(channel?: string): number {
    if (channel) return this.subs.get(channel)?.size ?? 0;
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    const inst = this.instance;
    this.instance = null;
    inst?.dispose?.();
    this.alive = false;
    this.subs.clear();
    this.interactives.clear();
    for (const c of [...this.root.children]) c.removeFromParent();
  }

  // ---------------------------------------------------------------- interaction

  /** True if o is attached under root and visible all the way up. */
  live(o: THREE.Object3D): boolean {
    for (let c: THREE.Object3D | null = o; c; c = c.parent) {
      if (!c.visible) return false;
      if (c === this.root) return true;
    }
    return false;
  }

  /** Live interactive parts (stale registrations from rebuilt subtrees are skipped). */
  liveParts(): THREE.Object3D[] {
    return [...this.interactives].filter((o) => this.live(o));
  }

  part(name: string): THREE.Object3D {
    for (const o of this.liveParts()) {
      let found: THREE.Object3D | undefined;
      o.traverse((c) => { if (!found && (c.name || c.uuid) === name) found = c; });
      if ((o.name || o.uuid) === name) return o;
      if (found) return found;
    }
    throw new Error(`no interactive part named '${name}' (have: ${[...this.interactives].map((o) => o.name || o.uuid).join(', ')})`);
  }

  /** Position of a part in ctx.root coordinates. */
  partPosition(name: string): [number, number, number] {
    const o = this.part(name);
    this.root.updateWorldMatrix(true, true);
    const v = new THREE.Vector3();
    o.getWorldPosition(v);
    this.root.worldToLocal(v);
    return [v.x, v.y, v.z];
  }

  interact(e: Partial<InteractionEvent> & Pick<InteractionEvent, 'handler' | 'phase'>): void {
    const lp = e.localPoint ?? [0, 0, 0];
    const full: InteractionEvent = {
      hand: 'right',
      point: lp,
      localPoint: lp,
      pointer: { position: lp, rotation: [0, 0, 0, 1] },
      ...e,
    };
    this.instance?.onInteraction?.(full);
    this.syncTexts();
  }

  /** Full press (start + end) on a named part, at its position. */
  press(part: string, handler = 'press', hand: 'left' | 'right' = 'right'): void {
    const p = this.partPosition(part);
    this.interact({ handler, phase: 'start', objectName: part, localPoint: p, hand });
    this.interact({ handler, phase: 'end', objectName: part, localPoint: p, hand });
  }

  /** Drag a part from its position by `delta` (in ctx.root coordinates) in `steps` moves. */
  drag(part: string, delta: [number, number, number], opts: { handler?: string; steps?: number; end?: boolean; from?: [number, number, number] } = {}): void {
    const handler = opts.handler ?? 'drag';
    const p0 = opts.from ?? this.partPosition(part);
    const steps = opts.steps ?? 4;
    this.interact({ handler, phase: 'start', objectName: part, localPoint: p0 });
    let p = p0;
    for (let i = 1; i <= steps; i++) {
      p = [p0[0] + (delta[0] * i) / steps, p0[1] + (delta[1] * i) / steps, p0[2] + (delta[2] * i) / steps];
      this.interact({ handler, phase: 'move', objectName: part, localPoint: p });
    }
    if (opts.end !== false) this.interact({ handler, phase: 'end', objectName: part, localPoint: p });
  }

  // ---------------------------------------------------------------- queries

  emitsOn(port: string): unknown[] {
    return this.rec.emits.filter((e) => e.port === port).map((e) => e.value);
  }

  lastEmit(port: string): unknown {
    const all = this.emitsOn(port);
    return all[all.length - 1];
  }

  /** Visible text strings under root (effective visibility). */
  visibleTexts(): string[] {
    const out: string[] = [];
    this.root.traverseVisible((o) => {
      if (o instanceof FakeText && o.text) out.push(o.text);
    });
    return out;
  }

  /** Whether any visible text contains `s`. */
  hasText(s: string | RegExp): boolean {
    return this.visibleTexts().some((t) => (typeof s === 'string' ? t.includes(s) : s.test(t)));
  }

  /** World-space bounds of the visible content (texts use their estimated block bounds). */
  bounds(): THREE.Box3 {
    this.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    this.root.traverseVisible((o) => {
      if (o instanceof FakeText) {
        const bb = o.textRenderInfo?.blockBounds;
        if (!bb) return;
        const b = new THREE.Box3(new THREE.Vector3(bb[0], bb[1], 0), new THREE.Vector3(bb[2], bb[3], 0)).applyMatrix4(o.matrixWorld);
        box.union(b);
        return;
      }
      const m = o as THREE.Mesh;
      if (m.geometry && (m as THREE.Mesh).isMesh) {
        if ((m.material as THREE.Material)?.visible === false) return;
        const inst = o as THREE.InstancedMesh;
        if (inst.isInstancedMesh) {
          inst.computeBoundingBox();
          if (inst.boundingBox) box.union(inst.boundingBox.clone().applyMatrix4(o.matrixWorld));
          return;
        }
        m.geometry.computeBoundingBox();
        if (m.geometry.boundingBox) box.union(m.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    return box;
  }

  /** Count meshes (incl. lines/points) under root, a rough draw-call proxy. */
  drawables(): number {
    let n = 0;
    this.root.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if ((m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) && (m.material as THREE.Material)?.visible !== false) n++;
    });
    return n;
  }

  syncTexts(): void {
    for (const t of this.texts) if (t.dirty && !t.disposed) t.sync();
  }

  // ---------------------------------------------------------------- context

  private makeContext(): WidgetContext {
    const T = THREE;
    const self = this;
    const guard = (what: string): boolean => {
      if (!self.alive) self.rec.afterDispose.push(what);
      return self.alive;
    };
    const user: UserView = this.opts.user ?? {
      head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] },
      hands: {},
    };
    const theme = TEST_THEME;
    const ctx: WidgetContext = {
      THREE: T,
      root: this.root,
      entityId: 'test-entity',
      props: this.props,
      theme,
      ui: {
        text(content, opts = {}) {
          const t = new FakeText(new T.PlaneGeometry(0, 0), self.material(theme.text));
          t.text = content ?? '';
          t.fontSize = opts.size ?? 0.03;
          t.color = opts.color ?? theme.text;
          if (opts.maxWidth !== undefined) t.maxWidth = opts.maxWidth;
          t.anchorX = opts.anchorX ?? 'center';
          t.anchorY = opts.anchorY ?? 'middle';
          t.font = opts.font ?? 'sans';
          self.texts.push(t);
          return t as unknown as THREE.Mesh & { set(text: string): void };
        },
        panel(width, height, opts = {}) {
          const mat = self.material(opts.color ?? theme.background, opts.opacity ?? 0.86);
          const m = new T.Mesh(shared(new T.PlaneGeometry(width, height)), mat);
          m.name = 'panel';
          m.renderOrder = -1;
          return m;
        },
        material(color, opts = {}) {
          return self.material(color, opts.opacity ?? 1, opts.doubleSide);
        },
        color(ramp, t) {
          return rampColor(theme, ramp, t);
        },
      },
      channels: {
        get: (name) => self.channelValues.get(name),
        subscribe(name, cb) {
          if (!guard('channels.subscribe')) return () => {};
          let set = self.subs.get(name);
          if (!set) self.subs.set(name, (set = new Set()));
          const fn = (v: ChannelValue) => cb(v);
          set.add(fn);
          if (self.channelValues.has(name)) cb(self.channelValues.get(name));
          return () => { self.subs.get(name)?.delete(fn); };
        },
        publish(name, value) {
          if (!guard('channels.publish')) return;
          self.rec.published.push({ channel: name, value });
          self.channelValues.set(name, value);
          self.onPublish?.(name, value);
        },
      },
      emit(port, value) {
        if (!guard(`emit(${port})`)) return;
        self.rec.emits.push({ port, value });
        self.onEmit?.(port, value);
      },
      input: (port) => (self.inputs.has(port) ? self.inputs.get(port) : self.def.inputs?.[port]?.default),
      setProps(patch) {
        if (!guard('setProps')) return;
        Object.assign(self.props, patch);
        self.rec.setProps.push({ ...patch });
      },
      interactive(obj) {
        if (!guard('interactive')) return;
        self.interactives.add(obj);
      },
      spawnChild(widget, props, transform, name) {
        const id = `${widget}-${++self.childSeq}`;
        if (guard('spawnChild')) self.rec.children.push({ widget, props, transform, name, id });
        return {
          entityId: id,
          setProps() {},
          setTransform() {},
          remove() {},
        };
      },
      event(name, data) {
        if (guard(`event(${name})`)) self.rec.events.push({ name, data });
      },
      askAgent(text) {
        if (guard('askAgent')) self.rec.asks.push(text);
      },
      log(...args) {
        self.rec.logs.push(args);
      },
      error(message, detail) {
        self.rec.errors.push({ message, detail });
      },
      isMirror: !!this.opts.isMirror,
      user,
    };
    return ctx;
  }

  private material(color: string, opacity = 1, doubleSide = false): THREE.Material {
    const key = `${color}|${opacity}|${doubleSide}`;
    let m = this.materials.get(key);
    if (!m) {
      m = shared(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide }));
      this.materials.set(key, m);
    }
    return m;
  }
}

function rampColor(theme: Theme, ramp: 'sequential' | 'diverging' | 'palette', t: number): THREE.Color {
  if (!Number.isFinite(t)) t = 0;
  if (ramp === 'palette') {
    const p = theme.palette;
    const idx = Number.isInteger(t) ? t : Math.floor(Math.min(Math.max(t, 0), 0.999999) * p.length);
    return new THREE.Color(p[((idx % p.length) + p.length) % p.length]);
  }
  if (ramp === 'diverging') {
    const [lo, mid, hi] = theme.diverging;
    const x = Math.min(1, Math.max(-1, t));
    return x < 0 ? new THREE.Color(mid).lerp(new THREE.Color(lo), -x) : new THREE.Color(mid).lerp(new THREE.Color(hi), x);
  }
  const s = theme.sequential;
  const x = Math.min(1, Math.max(0, t)) * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(x));
  return new THREE.Color(s[i]).lerp(new THREE.Color(s[i + 1]), x - i);
}

/** Create a harness and mount the widget with the given props. */
export async function mount(def: WidgetDefinition, props: Record<string, unknown> = {}, opts: MountOptions = {}): Promise<Harness> {
  const h = new Harness(def, opts);
  await h.create(props);
  return h;
}

/** Build a TensorValue for tests. */
export function tensor(dtype: 'f32' | 'u8' | 'i32' | 'f16', shape: number[], data: ArrayLike<number>) {
  const C = { f32: Float32Array, u8: Uint8Array, i32: Int32Array, f16: Uint16Array }[dtype];
  return { $tensor: true as const, dtype, shape, data: C.from(data) };
}

/** Instance i's matrix in the mesh's parent space (instance matrix composed with the mesh transform). */
export function instanceMatrix(mesh: THREE.InstancedMesh, i: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  mesh.updateMatrix();
  return m.premultiply(mesh.matrix);
}

/**
 * Bounds as the runtime's framing measures them (Picker.subtreeBounds, used for
 * screenshots): each visible object's geometry.boundingBox × matrixWorld, with
 * InstancedMesh instances NOT expanded. (The picker's own hit box now uses
 * InstancedMesh.boundingBox; FittedInstances keeps both measures tight.)
 */
export function pickerBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const out = new THREE.Box3();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g?.attributes?.position && !(o instanceof FakeText)) {
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox && !g.boundingBox.isEmpty()) out.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
    o.children.forEach(visit);
  };
  visit(root);
  return out;
}
