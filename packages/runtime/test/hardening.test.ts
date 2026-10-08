// Regression tests for the runtime hardening pass: panel/grid commands, event
// ports (no stale replays), detached interactives, fresh bounds, the passive
// mirror, gesture cleanup, the floor grid and the NetClient heartbeat.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Link, WidgetDefinition, WidgetContext } from '@evolspace/protocol';
import { LinkEngine, type LinkTargets } from '../src/links/LinkEngine.ts';
import { NetClient } from '../src/net/NetClient.ts';
import { objectBox } from '../src/interaction/Picker.ts';
import { boxWidget, fakeTimers, flush, makeRuntime, manifest, MockWebSocket, type FakeTimers } from './helpers.ts';

const T = (x: number, y: number, z: number, s = 1) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [s, s, s] as [number, number, number] });
const port = (entity: string, p: string) => ({ kind: 'port' as const, entity, port: p });
const chan = (channel: string) => ({ kind: 'channel' as const, channel });
const L = (id: string, from: Link['from'], to: Link['to'], transform?: string): Link => ({ id, from, to, transform, enabled: true });

// ---------------------------------------------------------------- 1. agent.panel.toggle

describe('agent.panel.toggle', () => {
  it('honors args.visible (show/hide) and toggles only when it is absent', () => {
    const { rt } = makeRuntime();
    const panel = rt.system.panel;
    expect(panel.visible).toBe(false);
    rt.runLocalCommand('agent.panel.toggle', { visible: true }, 'start');
    expect(panel.visible).toBe(true);
    // "show the Claude panel" while it is already open must not hide it.
    rt.runLocalCommand('agent.panel.toggle', { visible: true }, 'start');
    expect(panel.visible).toBe(true);
    rt.runLocalCommand('agent.panel.toggle', { visible: false }, 'start');
    expect(panel.visible).toBe(false);
    rt.runLocalCommand('agent.panel.toggle', { visible: false }, 'start');
    expect(panel.visible).toBe(false);
    rt.runLocalCommand('agent.panel.toggle', undefined, 'start');
    expect(panel.visible).toBe(true);
    rt.runLocalCommand('agent.panel.toggle', {}, 'start');
    expect(panel.visible).toBe(false);
    // Non-boolean visible → plain toggle; 'end' does nothing.
    rt.runLocalCommand('agent.panel.toggle', { visible: 'yes' }, 'start');
    expect(panel.visible).toBe(true);
    rt.runLocalCommand('agent.panel.toggle', { visible: false }, 'end');
    expect(panel.visible).toBe(true);
  });

  it('works when the server sends it as a client command', () => {
    const { rt, ws } = makeRuntime();
    ws.serverSend({ type: 'command', name: 'agent.panel.toggle', args: { visible: true } });
    ws.serverSend({ type: 'command', name: 'agent.panel.toggle', args: { visible: true } });
    expect(rt.system.panel.visible).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. LinkEngine: event outputs are not replayed

function linkHarness(types: Record<string, string>) {
  const delivered: Array<[string, string, unknown, boolean]> = [];
  const targets: LinkTargets = {
    deliverInput: (e, p, v, info) => { delivered.push([e, p, v, !!info?.momentary]); },
    publish: () => {},
    subscribe: () => () => {},
    reportError: () => {},
    outputType: (e, p) => types[`${e}.${p}`] as never,
  };
  return { engine: new LinkEngine(targets), delivered };
}

describe('LinkEngine and event ports', () => {
  it('does not cache or replay event outputs when a link is created', () => {
    const h = linkHarness({ 'btn.press': 'event', 'sl.value': 'number' });
    h.engine.emit('btn', 'press', { t: 1 });
    h.engine.emit('sl', 'value', 0.7);
    h.engine.setLinks({
      a: L('a', port('btn', 'press'), port('x', 'reset')),
      b: L('b', port('sl', 'value'), port('x', 'level')),
    });
    // Only the value port's latest output is replayed into the new link.
    expect(h.delivered).toEqual([['x', 'level', 0.7, false]]);
    expect(h.engine.lastOutput('btn', 'press')).toBeUndefined();
    // Live presses still flow, flagged momentary.
    h.engine.emit('btn', 'press', { t: 2 });
    expect(h.delivered[1]).toEqual(['x', 'reset', { t: 2 }, true]);
    // A link created afterwards still gets nothing stale.
    h.engine.setLinks({
      a: L('a', port('btn', 'press'), port('x', 'reset')),
      b: L('b', port('sl', 'value'), port('x', 'level')),
      c: L('c', port('btn', 'press'), port('y', 'reset')),
    });
    expect(h.delivered.filter((d) => d[0] === 'y')).toHaveLength(0);
  });

  it('without type info, outputs keep the old latest-value replay', () => {
    const h = linkHarness({});
    h.engine.emit('a', 'out', 3);
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in')) });
    expect(h.delivered).toEqual([['b', 'in', 3, false]]);
  });
});

// ---------------------------------------------------------------- 3. WidgetHost: no replay of momentary inputs

function buttonWidget(out: { ctx?: WidgetContext }): WidgetDefinition {
  return {
    description: 'button',
    outputs: { press: { type: 'event' } },
    create(ctx) { out.ctx = ctx; return {}; },
  };
}

function recorderWidget(tag: string, log: string[]): WidgetDefinition {
  return {
    description: 'recorder',
    create() {
      log.push(`${tag}:create`);
      return { onInput: (p, v) => { log.push(`${tag}:${p}=${JSON.stringify(v)}`); } };
    },
  };
}

describe('WidgetHost input replay', () => {
  it('a re-create (hot reload) does not re-apply values that came from event outputs', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const btn: { ctx?: WidgetContext } = {};
    const log: string[] = [];
    widgets.set('button', buttonWidget(btn));
    widgets.set('slider', recorderWidget('v1', log));
    rt.widgets.setCatalog([
      manifest('button', { outputs: { press: { type: 'event' } } }),
      manifest('slider', { inputs: { value: { type: 'number' }, level: { type: 'number' } } }),
      manifest('src', { outputs: { out: { type: 'number' } } }),
    ]);
    widgets.set('src', { description: 'src', create(ctx) { ctx.emit('out', 0.25); return {}; } });
    rt.applyPatch([
      { op: 'add', entity: { id: 'reset', widget: 'button' } },
      { op: 'add', entity: { id: 'sl', widget: 'slider' } },
      { op: 'add', entity: { id: 'src', widget: 'src' } },
      { op: 'link.add', link: L('l1', port('reset', 'press'), port('sl', 'value'), '1') },
      { op: 'link.add', link: L('l2', port('src', 'out'), port('sl', 'level')) },
    ]);
    await rt.whenIdle();
    btn.ctx!.emit('press', true);
    expect(log).toContain('v1:value=1');
    // The slider moves on afterwards (its own state); a hot reload must not snap it back to 1.
    log.length = 0;
    widgets.set('slider', recorderWidget('v2', log));
    ws.serverSend({ type: 'widgets.updated', widget: manifest('slider', { hash: 'h2', url: '/widgets/slider.js?h=h2', inputs: { value: { type: 'number' }, level: { type: 'number' } } }) });
    await rt.whenIdle();
    expect(log).toEqual(['v2:create', 'v2:level=0.25']); // value inputs replay; the press does not
    expect(rt.widgets.inputValue('sl', 'value')).toBeUndefined();
  });

  it('inputs declared as event are not replayed either; events before ready are delivered once', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const log: string[] = [];
    widgets.set('t', recorderWidget('a', log));
    const m = manifest('t', { inputs: { fire: { type: 'event' }, x: { type: 'number' } } });
    rt.widgets.setCatalog([m]);
    rt.applyPatch([{ op: 'add', entity: { id: 'e', widget: 't' } }]);
    // Arrives while the bundle is still loading: delivered once after create.
    rt.widgets.deliverInput('e', 'fire', 'early');
    rt.widgets.deliverInput('e', 'x', 5);
    await rt.whenIdle();
    expect(log).toEqual(['a:create', 'a:x=5', 'a:fire="early"']);
    rt.widgets.deliverInput('e', 'fire', 'live');
    expect(log).toContain('a:fire="live"');
    log.length = 0;
    widgets.set('t', recorderWidget('b', log));
    ws.serverSend({ type: 'widgets.updated', widget: { ...m, hash: 'h2', url: '/widgets/t.js?h=h2' } });
    await rt.whenIdle();
    expect(log).toEqual(['b:create', 'b:x=5']);
  });
});

// ---------------------------------------------------------------- 4. detached interactives

describe('interactives detached by a rebuild', () => {
  it('touch skips them and the registry drops them', async () => {
    const { rt, widgets } = makeRuntime();
    let ctxRef: WidgetContext | undefined;
    let knob: THREE.Mesh | undefined;
    const build = (x: number) => {
      const T3 = ctxRef!.THREE;
      if (knob) ctxRef!.root.remove(knob); // rebuild without telling the host
      knob = new T3.Mesh(new T3.BoxGeometry(0.05, 0.05, 0.05), ctxRef!.ui.material('#ffffff'));
      knob.name = `knob@${x}`;
      knob.position.set(x, 0, 0);
      ctxRef!.root.add(knob);
      ctxRef!.interactive(knob);
    };
    widgets.set('kn', {
      description: 'knobs',
      create(ctx) {
        ctxRef = ctx;
        const frame = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.6, 0.1, 0.01), ctx.ui.material('#333333'));
        ctx.root.add(frame);
        build(-0.2);
        return { onInput: (_p, v) => build(v as number) };
      },
    });
    rt.widgets.setCatalog([manifest('kn')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'k', widget: 'kn', transform: T(0, 1, -1) } }]);
    await rt.whenIdle();
    rt.update(0.016, 0);
    const host = rt.interactionHost();
    const old = knob!;
    expect(host.touch([-0.2, 1, -1], 0.01)).toMatchObject({ entity: 'k', interactive: true, object: 'knob@-0.2' });
    rt.widgets.deliverInput('k', 'pos', 0.2);
    rt.update(0.016, 0.1);
    // Old knob position: only the frame is there now (no phantom interactive).
    expect(host.touch([-0.2, 1, -1], 0.01)).toMatchObject({ entity: 'k', interactive: false });
    expect(host.touch([0.2, 1, -1], 0.01)).toMatchObject({ entity: 'k', interactive: true, object: 'knob@0.2' });
    const reg = rt.widgets.interactivesOf('k')!;
    expect(reg.has(old)).toBe(false);
    expect(old.userData.evolInteractive).toBeUndefined();
    expect(reg.size).toBe(1);
  });

  it('an interactive registered before it is attached is kept until it shows up', async () => {
    const { rt, widgets } = makeRuntime();
    let ctxRef: WidgetContext | undefined;
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), new THREE.MeshBasicMaterial());
    knob.name = 'late';
    widgets.set('w', {
      description: 'w',
      create(ctx) {
        ctxRef = ctx;
        ctx.root.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.3, 0.3, 0.01), ctx.ui.material('#333333')));
        ctx.interactive(knob); // not attached yet
        return {};
      },
    });
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'w', widget: 'w', transform: T(0, 1, -1) } }]);
    await rt.whenIdle();
    rt.update(0.016, 0);
    const host = rt.interactionHost();
    expect(host.touch([0, 1, -1], 0.01)).toMatchObject({ interactive: false });
    expect(rt.widgets.interactivesOf('w')!.has(knob)).toBe(true);
    ctxRef!.root.add(knob);
    rt.picker.invalidate('w');
    rt.update(0.016, 0.1);
    expect(host.touch([0, 1, -1], 0.01)).toMatchObject({ interactive: true, object: 'late' });
  });

  it('registering many rebuilt parts does not grow the registry without bound', async () => {
    const { rt, widgets } = makeRuntime();
    let ctxRef: WidgetContext | undefined;
    widgets.set('w', { description: 'w', create(ctx) { ctxRef = ctx; return {}; } });
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'w', widget: 'w' } }]);
    await rt.whenIdle();
    let prev: THREE.Object3D | null = null;
    for (let i = 0; i < 500; i++) {
      if (prev) ctxRef!.root.remove(prev);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial());
      ctxRef!.root.add(m);
      ctxRef!.interactive(m);
      prev = m;
    }
    expect(rt.widgets.interactivesOf('w')!.size).toBeLessThan(64);
  });
});

// ---------------------------------------------------------------- 5. fresh bounds

describe('bounds for mirror framing', () => {
  it('frameEntity covers all instances of an InstancedMesh', async () => {
    const { rt, widgets } = makeRuntime();
    let im: THREE.InstancedMesh | undefined;
    widgets.set('inst', {
      description: 'instanced',
      create(ctx) {
        im = new ctx.THREE.InstancedMesh(new ctx.THREE.BoxGeometry(0.1, 0.1, 0.1), ctx.ui.material('#ffffff'), 2);
        im.setMatrixAt(0, new ctx.THREE.Matrix4().makeTranslation(-1, 0, 0));
        im.setMatrixAt(1, new ctx.THREE.Matrix4().makeTranslation(1, 0, 0));
        ctx.root.add(im);
        return {};
      },
    });
    rt.widgets.setCatalog([manifest('inst')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'i', widget: 'inst', transform: T(0, 1, -2) } }]);
    await rt.whenIdle();
    const b = rt.frameEntity('i')!;
    expect(b.min.x).toBeCloseTo(-1.05, 4);
    expect(b.max.x).toBeCloseTo(1.05, 4);
    // Instances move → the cached box follows (instanceMatrix version).
    im!.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
    im!.instanceMatrix.needsUpdate = true;
    expect(rt.frameEntity('i')!.max.x).toBeCloseTo(3.05, 4);
    // Fewer instances → smaller box.
    im!.count = 1;
    expect(rt.frameEntity('i')!.max.x).toBeCloseTo(-0.95, 4);
  });

  it('geometry bounds are recomputed when the position attribute changes', async () => {
    const { rt, widgets } = makeRuntime();
    let geom: THREE.BufferGeometry | undefined;
    widgets.set('pts', {
      description: 'points',
      create(ctx) {
        geom = new ctx.THREE.BufferGeometry();
        geom.setAttribute('position', new ctx.THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0.1, 0]), 3));
        ctx.root.add(new ctx.THREE.Points(geom, new ctx.THREE.PointsMaterial()));
        return {};
      },
    });
    rt.widgets.setCatalog([manifest('pts')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'p', widget: 'pts' } }]);
    await rt.whenIdle();
    expect(rt.frameEntity('p')!.max.x).toBeCloseTo(0.1, 5);
    const pos = geom!.attributes.position as THREE.BufferAttribute;
    pos.setX(1, 2);
    pos.needsUpdate = true;
    expect(rt.frameEntity('p')!.max.x).toBeCloseTo(2, 5);
    // The raycast bounding sphere is refreshed too.
    geom!.computeBoundingSphere();
    pos.setX(1, 5);
    pos.needsUpdate = true;
    objectBox(rt.entityObject('p')!.children[0].children[0]);
    expect(geom!.boundingSphere).toBeNull();
    // A replaced attribute counts as a change as well.
    geom!.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, -4, 0, 0]), 3));
    expect(rt.frameEntity('p')!.min.x).toBeCloseTo(-4, 5);
  });

  it('precise raycasts see geometry whose vertices moved', async () => {
    const { rt, widgets } = makeRuntime();
    let geom: THREE.BufferGeometry | undefined;
    widgets.set('tri', {
      description: 'tri',
      create(ctx) {
        geom = new ctx.THREE.BufferGeometry();
        geom.setAttribute('position', new ctx.THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]), 3));
        ctx.root.add(new ctx.THREE.Mesh(geom, new ctx.THREE.MeshBasicMaterial({ side: ctx.THREE.DoubleSide })));
        return {};
      },
    });
    rt.widgets.setCatalog([manifest('tri')]);
    rt.applyPatch([{ op: 'add', entity: { id: 't', widget: 'tri', transform: T(0, 1, -1) } }]);
    await rt.whenIdle();
    rt.update(0.016, 0);
    const host = rt.interactionHost();
    expect(host.raycast([0.05, 1.05, 0], [0, 0, -1])).not.toBeNull();
    geom!.computeBoundingSphere(); // three caches this for its raycast early-out
    const pos = geom!.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, 2, 0, 0); pos.setXYZ(1, 2.2, 0, 0); pos.setXYZ(2, 2, 0.2, 0);
    pos.needsUpdate = true;
    rt.picker.invalidate('t');
    rt.update(0.016, 0.1);
    const hit = host.raycast([2.05, 1.05, 0], [0, 0, -1]);
    expect(hit).toMatchObject({ entity: 't' });
    expect(hit!.distance).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------- 6. passive mirror

describe('mirror runtimes are passive', () => {
  it('widget side effects never reach the server; errors and logs do', async () => {
    const { rt, ws, widgets } = makeRuntime({ role: 'mirror' });
    let c: WidgetContext | undefined;
    widgets.set('w', {
      description: 'w',
      outputs: { out: { type: 'number' } },
      create(ctx) { c = ctx; ctx.root.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.2, 0.2, 0.2), ctx.ui.material('#fff'))); return {}; },
    });
    rt.widgets.setCatalog([manifest('w', { outputs: { out: { type: 'number' } } })]);
    rt.applyPatch([
      { op: 'add', entity: { id: 'a', widget: 'w', transform: T(0, 1, -1) } },
      { op: 'link.add', link: L('l', port('a', 'out'), chan('live.value')) },
    ]);
    await rt.whenIdle();
    const local: unknown[] = [];
    const off = rt.channels.subscribe('local.ch', (v) => local.push(v));
    await flush();
    ws.clearSent();
    c!.setProps({ size: 2 });
    c!.event('clicked', { n: 1 });
    c!.askAgent('help');
    c!.channels.publish('local.ch', 7);
    c!.emit('out', 0.5);
    c!.spawnChild('w', {});
    rt.channels.publish('t.tensor', { dtype: 'f32', shape: [1], data: new Float32Array([1]) } as never);
    const host = rt.interactionHost();
    host.publish('x', 1);
    host.poseEvent({ pose: 'pinch', hand: 'right', phase: 'start', t: 0 } as never);
    host.runCommand('undo', undefined, 'start');
    host.setEntityTransform('a', T(0, 2, -1), 'start');
    host.setEntityTransform('a', T(0, 2.1, -1), 'move');
    host.setEntityTransform('a', T(0, 2.2, -1), 'end');
    await new Promise((r) => setTimeout(r, 150));
    rt.update(0.016, 0.2);
    c!.log('hello from mirror');
    c!.error('boom');
    const types = new Set(ws.messages().map((m) => m.type));
    expect([...types].sort()).toEqual(['client.error', 'client.log']);
    expect(ws.sent.filter((s) => typeof s !== 'string')).toHaveLength(0); // no tensor frames
    // Local effects still happen: optimistic props, local channel listeners.
    expect(rt.entity('a')!.props.size).toBe(2);
    expect(local).toEqual([7]);
    off();
  });

  it('a non-mirror runtime still sends them', async () => {
    const { rt, ws, widgets } = makeRuntime();
    let c: WidgetContext | undefined;
    widgets.set('w', { description: 'w', create(ctx) { c = ctx; return {}; } });
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'a', widget: 'w' } }]);
    await rt.whenIdle();
    ws.clearSent();
    c!.event('clicked');
    c!.askAgent('help');
    c!.channels.publish('x', 1);
    const types = ws.messages().map((m) => m.type);
    expect(types).toEqual(['widget.event', 'agent.ask', 'channel.publish']);
  });
});

// ---------------------------------------------------------------- 7. gesture cleanup

describe('gesture state cleanup', () => {
  async function setup() {
    const r = makeRuntime();
    r.widgets.set('box', boxWidget(0.2));
    r.rt.widgets.setCatalog([manifest('box')]);
    r.rt.applyPatch([
      { op: 'add', entity: { id: 'p', widget: 'box', transform: T(0, 1, -1) } },
      { op: 'add', entity: { id: 'c', widget: 'box', parent: 'p', transform: T(0, 0.3, 0) } },
    ]);
    await r.rt.whenIdle();
    r.rt.update(0.016, 0);
    return { ...r, host: r.rt.interactionHost() as ReturnType<typeof r.rt.interactionHost> & { activeGestures(): string[] } };
  }

  it('removing an entity mid-gesture drops its gesture entry at once (also for removed children)', async () => {
    const { rt, host } = await setup();
    host.setEntityTransform('c', T(0, 1.3, -1), 'start');
    host.setEntityTransform('p', T(0, 1, -1), 'start');
    host.setEntityTransform('p', T(0, 1.1, -1), 'move');
    expect(host.activeGestures().sort()).toEqual(['c', 'p']);
    rt.applyPatch([{ op: 'remove', id: 'p' }]); // cascades to the child
    expect(host.activeGestures()).toEqual([]);
    expect(rt.picker.localBounds('p')).toBeNull();
  });

  it('an entity locked mid-gesture ends the gesture: no more ops, preview dropped', async () => {
    const { rt, ws, host } = await setup();
    host.setEntityTransform('p', T(0, 1, -1), 'start');
    host.setEntityTransform('p', T(0, 1.2, -1), 'move'); // leading edge → sent
    host.setEntityTransform('p', T(0, 1.4, -1), 'move'); // pending
    expect(rt.reconciler.hasPreview('p')).toBe(true);
    rt.applyPatch([{ op: 'update', id: 'p', patch: { locked: true } }]);
    ws.clearSent();
    await new Promise((r) => setTimeout(r, 120));
    rt.update(0.016, 0.3);
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
    expect(host.activeGestures()).toEqual([]);
    expect(rt.reconciler.hasPreview('p')).toBe(false);
    expect(rt.entityObject('p')!.position.y).toBeCloseTo(1, 5);
    host.setEntityTransform('p', T(0, 1.5, -1), 'end');
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 8. floor grid

describe('floor grid', () => {
  it('is one unlit, non-pickable draw call, on by default, toggled by setEnvironment / grid.toggle', () => {
    const { rt, scene } = makeRuntime();
    const g = rt.floorGrid;
    expect(g).toBeInstanceOf(THREE.LineSegments);
    expect(g.children).toHaveLength(0);
    expect(g.material).toBeInstanceOf(THREE.LineBasicMaterial); // unlit
    expect((g.material as THREE.Material).depthWrite).toBe(false);
    expect(g.parent).toBe(scene); // not under root: never part of root bounds
    expect(g.visible).toBe(true);
    const hits: THREE.Intersection[] = [];
    g.raycast(new THREE.Raycaster(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)), hits);
    expect(hits).toHaveLength(0);
    rt.setEnvironment({ grid: false });
    expect(g.visible).toBe(false);
    expect(rt.environment).toEqual({ grid: false });
    expect(rt.runLocalCommand('grid.toggle', { visible: true }, 'start')).toBe(true);
    expect(g.visible).toBe(true);
    rt.runLocalCommand('grid.toggle', { visible: true }, 'start');
    expect(g.visible).toBe(true);
    rt.runLocalCommand('grid.toggle', undefined, 'start');
    expect(g.visible).toBe(false);
  });

  it('spans 10 m, fades out toward the edge and marks the origin', () => {
    const { rt } = makeRuntime();
    const geom = rt.floorGrid.geometry;
    geom.computeBoundingBox();
    expect(geom.boundingBox!.min.x).toBeCloseTo(-5, 5);
    expect(geom.boundingBox!.max.z).toBeCloseTo(5, 5);
    expect(geom.boundingBox!.max.y).toBeCloseTo(0, 5);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const col = geom.attributes.color as THREE.BufferAttribute;
    expect(col.itemSize).toBe(4);
    let edgeMax = 0;
    let centerMax = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      if (r >= 5) edgeMax = Math.max(edgeMax, col.getW(i));
      if (r < 1) centerMax = Math.max(centerMax, col.getW(i));
    }
    expect(edgeMax).toBe(0);
    expect(centerMax).toBeGreaterThan(0.15);
  });

  it('follows the space origin, defaults off for local (studio) scenes, disposes', () => {
    const { rt } = makeRuntime();
    rt.root.position.set(1, 0.5, -2);
    rt.root.rotation.y = Math.PI / 2;
    rt.update(0.016, 0);
    rt.floorGrid.updateMatrixWorld();
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(rt.floorGrid.matrixWorld);
    const q = new THREE.Vector3(1, 0, 0).applyMatrix4(rt.root.matrixWorld);
    expect(p.distanceTo(q)).toBeLessThan(1e-6);
    const studio = makeRuntime({ sceneFromNet: false });
    expect(studio.rt.floorGrid.visible).toBe(false);
    expect(makeRuntime({ sceneFromNet: false, grid: true }).rt.floorGrid.visible).toBe(true);
    rt.dispose();
    expect(rt.floorGrid.parent).toBeNull();
  });
});

// ---------------------------------------------------------------- 9. heartbeat

function hbNet(heartbeat: ConstructorParameters<typeof NetClient>[2] extends infer O ? O extends { heartbeat?: infer H } ? H : never : never = {}) {
  MockWebSocket.reset();
  const timers = fakeTimers();
  let clock = 1_000_000;
  const net = new NetClient('ws://127.0.0.1:9999/ws', 'xr', { WebSocketImpl: MockWebSocket, timers, log: () => {}, now: () => clock, heartbeat });
  const ws = MockWebSocket.last();
  ws.open();
  ws.serverSend({ type: 'hello', clientId: 'c1', serverVersion: 'test', primary: true });
  ws.clearSent();
  const advance = (ms: number) => { clock += ms; };
  return { net, ws, timers, advance };
}

/** Run due heartbeat ticks only (leaves reconnect timers alone). */
function tick(timers: FakeTimers): void {
  const due = timers.pending.filter((p) => p.fn.name === 'tick');
  timers.pending = timers.pending.filter((p) => p.fn.name !== 'tick');
  for (const p of due) p.fn();
}

const pings = (ws: MockWebSocket) => ws.messagesOf('command').filter((m) => m.name === 'ping');

describe('NetClient heartbeat', () => {
  it('probes after inbound silence; any inbound message counts as liveness', () => {
    const { ws, timers, advance } = hbNet();
    advance(5_000); tick(timers);
    expect(pings(ws)).toHaveLength(0);
    advance(5_000); tick(timers);
    expect(pings(ws)).toHaveLength(1);
    advance(2_500); tick(timers);
    expect(pings(ws)).toHaveLength(1); // at most one probe per probeMs
    ws.serverSend({ type: 'agent.status', status: { state: 'idle', since: 0 } });
    advance(9_000); tick(timers);
    expect(pings(ws)).toHaveLength(1);
    advance(1_000); tick(timers);
    expect(pings(ws)).toHaveLength(2);
  });

  it('a server that never answers probes is not dropped for being quiet', () => {
    const { net, ws, timers, advance } = hbNet();
    for (let i = 0; i < 40; i++) { advance(2_500); tick(timers); }
    expect(net.connected).toBe(true);
    expect(MockWebSocket.last()).toBe(ws);
  });

  it('once the server answers probes (pong), silence forces a reconnect', () => {
    const { net, ws, timers, advance } = hbNet();
    const seen: string[] = [];
    net.on('command', (m) => seen.push(m.name));
    ws.serverSend({ type: 'command', name: 'pong' });
    expect(seen).toEqual([]); // swallowed
    advance(20_000); tick(timers);
    expect(net.connected).toBe(true);
    advance(10_000); tick(timers);
    expect(net.connected).toBe(false);
    expect(ws.readyState).toBe(3);
    expect(timers.pending.filter((p) => p.fn.name !== 'tick')).toHaveLength(1); // the reconnect
    timers.runAll();
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(net.connected).toBe(true);
  });

  it('a send buffer that stays backed up without inbound traffic forces a reconnect', () => {
    const { net, ws, timers, advance } = hbNet({ stallMs: 10_000 });
    Object.assign(ws, { bufferedAmount: 50_000 });
    advance(2_500); tick(timers);
    advance(5_000); tick(timers);
    expect(net.connected).toBe(true);
    advance(6_000); tick(timers);
    expect(net.connected).toBe(false);
  });

  it('a draining buffer is not a stall', () => {
    const { net, ws, timers, advance } = hbNet({ stallMs: 10_000 });
    let b = 500_000;
    for (let i = 0; i < 20; i++) {
      Object.assign(ws, { bufferedAmount: (b -= 10_000) });
      advance(2_500); tick(timers);
    }
    expect(net.connected).toBe(true);
  });

  it("an older server's unknown-command error is swallowed and stops the probes", () => {
    const { net, ws, timers, advance } = hbNet();
    const msgs: string[] = [];
    net.on('agent.message', (m) => msgs.push(m.message.text));
    advance(10_000); tick(timers);
    expect(pings(ws)).toHaveLength(1);
    ws.serverSend({ type: 'agent.message', message: { id: 'e', text: "Command 'ping' failed: unknown command 'ping' (available: undo)", kind: 'error', ts: Date.now() } });
    expect(msgs).toEqual([]);
    advance(20_000); tick(timers);
    advance(20_000); tick(timers);
    expect(pings(ws)).toHaveLength(1);
    // Other errors still get through.
    ws.serverSend({ type: 'agent.message', message: { id: 'f', text: "Command 'undo' failed: nothing", kind: 'error', ts: Date.now() } });
    expect(msgs).toHaveLength(1);
  });

  it('stops with the socket and can be disabled', () => {
    const { net, timers } = hbNet();
    net.close();
    expect(timers.pending).toHaveLength(0);
    const off = hbNet(false);
    expect(off.timers.pending).toHaveLength(0);
  });
});
