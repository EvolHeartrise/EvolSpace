// Minimal WidgetContext for node tests: real three.js, stub text (no troika),
// in-memory channels, recorded emits/publishes/events/interactives.

import * as THREE from 'three';
import type { ChannelValue, InteractionEvent, Theme, UiKit, WidgetContext, WidgetDefinition, WidgetInstance } from '@evolspace/protocol';

export const TEST_THEME: Theme = {
  background: '#0e131b', surface: '#1a2230', border: '#3b475a', text: '#e9eef5', textDim: '#8d99ab',
  accent: '#4cc3ff', accent2: '#ffb547', positive: '#45d49b', negative: '#ff5d6c',
  palette: ['#4cc3ff', '#ffb547', '#45d49b', '#ff6f91', '#a98bff', '#f2dc5d', '#4fd9d4', '#ff8a5b'],
  diverging: ['#3f8cff', '#d5d9e0', '#ff4d5e'],
  sequential: ['#1d2f5c', '#22488a', '#2366b0', '#2a88c9', '#3caed6', '#66cdd5', '#9fe2c9', '#d5f1bf', '#fff8d6'],
};

export type StubText = THREE.Mesh & { set(text: string): void; text: string };

export function makeUi(): UiKit & { texts: StubText[] } {
  const texts: StubText[] = [];
  return {
    texts,
    text(content: string) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), new THREE.MeshBasicMaterial()) as unknown as StubText;
      m.text = content;
      m.set = (s: string) => { m.text = s; };
      texts.push(m);
      return m;
    },
    panel(w: number, h: number) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial());
      m.name = 'panel';
      return m;
    },
    material(color: string) {
      return new THREE.MeshBasicMaterial({ color });
    },
    color() {
      return new THREE.Color(1, 1, 1);
    },
  };
}

export interface FakeCtx {
  ctx: WidgetContext;
  root: THREE.Group;
  /** Server-side channel values (what `subscribe` would see). */
  channels: Map<string, ChannelValue>;
  /** Push a value as if it arrived from the server. */
  push(name: string, value: ChannelValue): void;
  emitted: Array<{ port: string; value: unknown }>;
  published: Array<{ name: string; value: unknown }>;
  events: Array<{ name: string; data: unknown }>;
  errors: string[];
  interactives: Set<THREE.Object3D>;
  inputs: Map<string, unknown>;
  subscribers(name: string): number;
  ui: ReturnType<typeof makeUi>;
}

export function makeCtx(props: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): FakeCtx {
  const channels = new Map<string, ChannelValue>();
  const listeners = new Map<string, Set<(v: ChannelValue) => void>>();
  const emitted: FakeCtx['emitted'] = [];
  const published: FakeCtx['published'] = [];
  const events: FakeCtx['events'] = [];
  const errors: string[] = [];
  const interactives = new Set<THREE.Object3D>();
  const inputs = new Map<string, unknown>();
  const root = new THREE.Group();
  const ui = makeUi();
  const push = (name: string, value: ChannelValue) => {
    channels.set(name, value);
    for (const cb of [...(listeners.get(name) ?? [])]) cb(value);
  };
  const ctx: WidgetContext = {
    THREE,
    root,
    entityId: 'e-test',
    props: { ...defaults, ...props },
    theme: TEST_THEME,
    ui,
    channels: {
      get: (n) => channels.get(n),
      subscribe(n, cb) {
        let s = listeners.get(n);
        if (!s) listeners.set(n, (s = new Set()));
        s.add(cb);
        if (channels.has(n)) cb(channels.get(n));
        return () => { s!.delete(cb); };
      },
      publish(n, v) {
        published.push({ name: n, value: v });
        push(n, v);
      },
    },
    emit: (port, value) => { emitted.push({ port, value }); },
    input: (port) => inputs.get(port),
    setProps: (patch) => { Object.assign(ctx.props, patch); },
    interactive: (o) => { interactives.add(o); },
    spawnChild: () => { throw new Error('not supported in tests'); },
    event: (name, data) => { events.push({ name, data }); },
    askAgent: () => {},
    log: () => {},
    error: (m) => { errors.push(m); },
    isMirror: false,
    user: { head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} },
  };
  return {
    ctx, root, channels, push, emitted, published, events, errors, interactives, inputs, ui,
    subscribers: (n) => listeners.get(n)?.size ?? 0,
  };
}

/** Props defaults from a widget definition (what the host would apply). */
export function propDefaults(def: WidgetDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(def.props ?? {})) if (spec.default !== undefined) out[k] = structuredClone(spec.default);
  return out;
}

export function interaction(handler: string, phase: InteractionEvent['phase'], localPoint: [number, number, number], objectName?: string, hand: 'left' | 'right' = 'right'): InteractionEvent {
  const e: InteractionEvent = {
    handler, phase, hand, localPoint, point: localPoint,
    pointer: { position: localPoint, rotation: [0, 0, 0, 1] },
  };
  if (objectName) e.objectName = objectName;
  return e;
}

/** Run one frame. */
export function tick(inst: WidgetInstance, t = 0.5): void {
  inst.update?.(1 / 72, t);
}
