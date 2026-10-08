import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeTensor } from '@evolspace/protocol';
import def from '../widget.ts';
import type { ResidFlow, ResidProps } from '../controller.ts';
import type { WidgetContext } from '@evolspace/protocol';
import { HANDLE_NAME } from '../view.ts';
import { layerY } from '../layout.ts';
import { generateReadout, generateSample, lastRealToken, type DemoSample } from '../demo-data.ts';
import { interaction, makeCtx, propDefaults, tick, type FakeCtx } from './fake-ctx.ts';

async function create(props: Record<string, unknown> = {}): Promise<{ f: FakeCtx; w: ResidFlow }> {
  const f = makeCtx(props, propDefaults(def));
  const w = (await def.create(f.ctx as WidgetContext<ResidProps>)) as ResidFlow;
  return { f, w };
}

function pushSample(f: FakeCtx, s: DemoSample, prefix = 'interp', order?: string[]): void {
  const all: Record<string, unknown> = {
    meta: s.meta, 'resid.proj': s.proj, 'resid.norm': s.norm, 'resid.delta': s.delta, 'resid.mask': s.mask, attn: s.attn,
  };
  for (const k of order ?? Object.keys(all)) f.push(`${prefix}.${k}`, all[k]);
}

function nodePoint(w: ResidFlow, layer: number, token: number): [number, number, number] {
  const L = w.debug().layout!;
  const i = layer * L.T + token;
  return [L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]];
}

describe('resid-flow widget', () => {
  it('exposes a sane definition (ports, props, bindings)', () => {
    expect(Object.keys(def.inputs!)).toEqual(['layer', 'token', 'sample']);
    expect(Object.keys(def.outputs!)).toEqual(['layer', 'token']);
    expect(def.props!.prefix.default).toBe('interp');
    expect(def.interactions![0].action).toEqual({ type: 'widget', handler: 'pick' });
  });

  it('shows a waiting state without data and never throws on missing channels', async () => {
    const { f, w } = await create();
    tick(w);
    const d = w.debug();
    expect(d.view.waiting).toBe(true);
    expect(d.view.nodes).toBe(0);
    expect(d.status['resid.proj']).toBe('missing');
    const waitingText = f.ui.texts.find((t) => t.text.includes('waiting for data'));
    expect(waitingText?.text).toContain('interp.resid.proj');
    // Interactions and inputs before data are ignored gracefully.
    w.onInteraction(interaction('pick', 'start', [0, 0, 0]));
    w.onInput('layer', 3);
    tick(w);
    // Optional channels alone still wait for proj.
    f.push('interp.resid.norm', makeTensor('f32', [2, 2], new Float32Array(4)));
    f.push('interp.meta', { model: 'm' });
    tick(w);
    expect(w.debug().view.waiting).toBe(true);
    expect(f.errors).toEqual([]);
  });

  it('builds geometry with the expected node counts (data in any order)', async () => {
    const { f, w } = await create();
    const s = generateSample(0, { layers: 10, heads: 4 }); // T=29, L+1=11
    pushSample(f, s, 'interp', ['attn', 'resid.delta', 'meta', 'resid.norm', 'resid.proj', 'resid.mask']);
    tick(w);
    const d = w.debug();
    expect(d.view.waiting).toBe(false);
    expect(d.view.nodes).toBe(29 * 11);
    expect(d.view.ticks).toBe(2 * 10 * 29);
    expect(d.view.slabs).toBe(11);
    expect(d.view.ribbonIndices).toBeGreaterThan(0);
    // Default selection: last layer, last real token; arcs from that token.
    expect(d.layer).toBe(10);
    expect(d.token).toBe(28);
    expect(d.view.arcIndices).toBeGreaterThan(0);
    expect(d.arcKeys.length).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
    // Draw calls stay small: count renderable objects.
    let drawables = 0;
    f.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && o.visible && (m.material as THREE.Material)?.visible !== false) drawables++;
    });
    expect(drawables).toBeLessThan(45);
  });

  it('omits masked positions (padded sample)', async () => {
    const { f, w } = await create();
    const s = generateSample(1, { layers: 10, heads: 4 }); // 20 real tokens padded to 29
    pushSample(f, s);
    tick(w);
    expect(w.debug().view.nodes).toBe(20 * 11);
    expect(w.debug().token).toBe(lastRealToken(s));
  });

  it('rebuilds on shape change, and tolerates temporarily inconsistent channels', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    expect(w.debug().view.nodes).toBe(29 * 11);
    const long = generateSample(2, { layers: 10, heads: 4 }); // T=35
    // Only proj arrives first: norm/mask/delta/attn are stale (T=29) and must be ignored.
    f.push('interp.resid.proj', long.proj);
    tick(w);
    let d = w.debug();
    expect(d.view.nodes).toBe(35 * 11);
    expect(d.status['resid.norm']).toBe('shape');
    expect(d.view.ticks).toBe(0);
    pushSample(f, long);
    tick(w);
    d = w.debug();
    expect(d.view.nodes).toBe(35 * 11);
    expect(d.view.ticks).toBe(2 * 10 * 35);
    expect(d.status['resid.norm']).toBe('ok');
    // Fewer layers.
    const shallow = generateSample(0, { layers: 4, heads: 2 });
    pushSample(f, shallow);
    tick(w);
    d = w.debug();
    expect(d.view.nodes).toBe(29 * 5);
    expect(d.view.slabs).toBe(5);
    expect(d.layer).toBe(4);
    expect(f.errors).toEqual([]);
  });

  it('pinching a layer frame selects the layer: emits + publishes', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    const L = w.debug().layout!;
    // A point on plane 3 far from any node (corner).
    w.onInteraction(interaction('pick', 'start', [0.299, layerY(L, 3), -0.299], 'layer:3'));
    expect(w.debug().layer).toBe(3);
    expect(f.emitted).toContainEqual({ port: 'layer', value: 3 });
    expect(f.published).toContainEqual({ name: 'interp.ctl.layer', value: 3 });
    expect(f.events.at(-1)?.name).toBe('select');
    w.onInteraction(interaction('pick', 'end', [0.299, layerY(L, 3), -0.299], 'layer:3'));
  });

  it('pinching a node selects the token (and its layer)', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    w.onInteraction(interaction('press', 'start', nodePoint(w, 6, 12), 'layer:6'));
    const d = w.debug();
    expect(d.token).toBe(12);
    expect(d.layer).toBe(6);
    expect(f.emitted).toContainEqual({ port: 'token', value: 12 });
    expect(f.published).toContainEqual({ name: 'interp.ctl.token', value: 12 });
    expect(f.published).toContainEqual({ name: 'interp.ctl.layer', value: 6 });
    // With pickNodeSetsLayer off, only the token changes.
    const b = await create({ pickNodeSetsLayer: false });
    pushSample(b.f, generateSample(0, { layers: 10, heads: 4 }));
    tick(b.w);
    b.w.onInteraction(interaction('pick', 'start', nodePoint(b.w, 2, 5)));
    expect(b.w.debug().token).toBe(5);
    expect(b.w.debug().layer).toBe(10);
  });

  it('dragging the lens handle scrubs layers', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    const L = w.debug().layout!;
    const y0 = layerY(L, 10);
    w.onInteraction(interaction('pick', 'start', [0.335, y0, 0], HANDLE_NAME));
    w.onInteraction(interaction('pick', 'move', [0.335, y0 - L.spacing * 2.1, 0], HANDLE_NAME));
    expect(w.debug().layer).toBe(8);
    // Moves of the other hand are ignored.
    w.onInteraction(interaction('pick', 'move', [0.335, y0 - L.spacing * 6, 0], HANDLE_NAME, 'left'));
    expect(w.debug().layer).toBe(8);
    w.onInteraction(interaction('pick', 'move', [0.335, y0 - L.spacing * 50, 0], HANDLE_NAME));
    expect(w.debug().layer).toBe(0); // clamped
    w.onInteraction(interaction('pick', 'end', [0.335, 0, 0], HANDLE_NAME));
    const layers = f.emitted.filter((e) => e.port === 'layer').map((e) => e.value);
    expect(layers).toEqual([8, 0]);
    expect(f.published.filter((p) => p.name === 'interp.ctl.layer').at(-1)?.value).toBe(0);
    tick(w);
  });

  it('hover feedback resolves tokens, layers and the handle without emitting', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    const before = f.emitted.length;
    w.onInteraction(interaction('hover', 'start', nodePoint(w, 4, 2), 'layer:4'));
    const hoverText = f.ui.texts.find((t) => t.visible && t.text.includes('#2'));
    expect(hoverText).toBeTruthy();
    w.onInteraction(interaction('hover', 'move', [0.335, 0, 0], HANDLE_NAME));
    w.onInteraction(interaction('hover', 'end', [0, 0, 0]));
    expect(f.emitted.length).toBe(before);
  });

  it('follows inputs and ctl channels; channel changes are re-emitted', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    w.onInput('layer', 4);
    expect(w.debug().layer).toBe(4);
    expect(f.published.find((p) => p.name === 'interp.ctl.layer')).toBeUndefined(); // inputs don't publish
    f.push('interp.ctl.layer', 7);
    expect(w.debug().layer).toBe(7);
    expect(f.emitted).toContainEqual({ port: 'layer', value: 7 });
    f.push('interp.ctl.token', 3);
    expect(w.debug().token).toBe(3);
    w.onInput('layer', 99); // clamps
    expect(w.debug().layer).toBe(10);
    w.onInput('sample', 5);
    w.onInput('sample', 5);
    expect(f.published.filter((p) => p.name === 'interp.ctl.sample')).toEqual([{ name: 'interp.ctl.sample', value: 5 }]);
    tick(w);
  });

  it('adopts the producer readout selection and marks stale readouts', async () => {
    const { f, w } = await create();
    const s = generateSample(0, { layers: 10, heads: 4 });
    pushSample(f, s);
    f.push('interp.lens.readout', generateReadout(s, 5, 9));
    tick(w);
    expect(w.debug().layer).toBe(5);
    expect(w.debug().token).toBe(9);
    expect(f.ui.texts.some((t) => t.text.includes('logit lens'))).toBe(true);
    w.onInput('layer', 6);
    tick(w);
    expect(f.ui.texts.some((t) => t.text === 'updating…')).toBe(true);
    // A later readout doesn't override an explicit selection.
    f.push('interp.lens.readout', generateReadout(s, 2, 2));
    expect(w.debug().layer).toBe(6);
  });

  it('re-subscribes on prefix change and supports probes/filters', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    expect(f.subscribers('interp.resid.proj')).toBe(1);
    const prev = { ...f.ctx.props };
    f.ctx.props.prefix = 'other';
    w.onProps(f.ctx.props, prev);
    tick(w);
    expect(f.subscribers('interp.resid.proj')).toBe(0);
    expect(f.subscribers('other.resid.proj')).toBe(1);
    expect(w.debug().view.waiting).toBe(true);
    const s = generateSample(0, { layers: 10, heads: 4 });
    pushSample(f, s, 'other');
    f.push('other.probe.is_location', s.probes.is_location);
    const p2 = { ...f.ctx.props };
    Object.assign(f.ctx.props, { colorBy: 'probe', probe: 'is_location', tokenFilter: ['location', 'entity'] });
    w.onProps(f.ctx.props, p2);
    tick(w);
    expect(f.subscribers('other.probe.is_location')).toBe(1);
    const visible = s.meta.tokens.filter((t) => t.group === 'location' || t.group === 'entity').length;
    expect(w.debug().view.nodes).toBe(visible * 11);
    const p3 = { ...f.ctx.props };
    Object.assign(f.ctx.props, { showDelta: false, showAttn: false, tokenFilter: 'location' });
    w.onProps(f.ctx.props, p3);
    tick(w);
    expect(w.debug().view.ticks).toBe(0);
    expect(w.debug().view.arcIndices).toBe(0);
    expect(f.errors).toEqual([]);
  });

  it('registers interactive proxies and handles, and disposes cleanly', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    const names = [...f.interactives].map((o) => o.name);
    expect(names).toContain(HANDLE_NAME);
    expect(names.filter((n) => n.startsWith('layer:')).length).toBe(11);
    // The slab proxy raycast hits a node from the front.
    f.root.updateMatrixWorld(true);
    const [x, y, z] = nodePoint(w, 3, 4);
    const rc = new THREE.Raycaster(new THREE.Vector3(x, y, z + 1), new THREE.Vector3(0, 0, -1));
    const hits: THREE.Intersection[] = [];
    for (const o of f.interactives) if (o.name === 'layer:3') o.raycast(rc, hits);
    expect(hits.length).toBe(1);
    expect(hits[0].point.x).toBeCloseTo(x, 5);
    w.dispose();
    expect(f.subscribers('interp.resid.proj')).toBe(0);
  });

  it('handles nested-JSON tensors and NaN projections', async () => {
    const { f, w } = await create();
    const proj = [[[0, 0, 0], [1, 1, 0]], [[0.5, 0.2, 0], [NaN, 0, 0]]];
    f.push('interp.resid.proj', proj);
    tick(w);
    expect(w.debug().view.nodes).toBe(3);
    expect(f.errors).toEqual([]);
  });
});

describe('resid-flow at scale', () => {
  it('builds T=256 × L=32 quickly with bounded vertex counts, and idle frames are cheap', async () => {
    const L1 = 33, T = 256;
    const proj = new Float32Array(L1 * T * 3);
    const norm = new Float32Array(L1 * T);
    for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) {
      const i = l * T + t;
      proj[i * 3] = Math.cos(t * 0.37 + l * 0.11) * (1 + l * 0.05);
      proj[i * 3 + 1] = Math.sin(t * 0.21 - l * 0.07);
      proj[i * 3 + 2] = Math.sin(t + l);
      norm[i] = 1 + l * 0.2 + (t % 7);
    }
    const { f, w } = await create();
    const t0 = performance.now();
    f.push('interp.resid.proj', makeTensor('f32', [L1, T, 3], proj));
    f.push('interp.resid.norm', makeTensor('f32', [L1, T], norm));
    f.push('interp.resid.delta', makeTensor('f32', [L1 - 1, 2, T], new Float32Array((L1 - 1) * 2 * T).fill(1)));
    tick(w);
    const buildMs = performance.now() - t0;
    const d = w.debug();
    expect(d.view.nodes).toBe(L1 * T);
    // ≤ ~40k center-line samples → ≤ ~80k ribbon vertices.
    expect(d.view.ribbonIndices / 6).toBeLessThan(90000);
    expect(buildMs).toBeLessThan(1500);
    // Idle frames do no rebuild work.
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) w.update!(1 / 90, i / 90);
    expect((performance.now() - t1) / 200).toBeLessThan(1);
  });
});

describe('resid-flow picking & feedback (hardening)', () => {
  it('an angled ray over all layer proxies hits the interior node, on its own layer only', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    f.root.position.set(0.2, 1.3, -1); // entity transform: the proxies work in world space
    f.root.updateMatrixWorld(true);
    const [x, y, z] = nodePoint(w, 3, 7);
    const target = new THREE.Vector3(x, y, z).applyMatrix4(f.root.matrixWorld);
    const eye = new THREE.Vector3(target.x, 1.75, target.z + 0.5); // standing user, looking down into the stack
    const rc = new THREE.Raycaster(eye, target.clone().sub(eye).normalize());
    const hits: THREE.Intersection[] = [];
    for (const o of f.interactives) if (o.name.startsWith('layer:')) o.raycast(rc, hits);
    expect(hits.map((h) => h.object.name)).toEqual(['layer:3']);
    expect(hits[0].point.distanceTo(target)).toBeLessThan(1e-5);
    // The event the input engine would deliver resolves to that token.
    const local = f.root.worldToLocal(hits[0].point.clone());
    w.onInteraction(interaction('pick', 'start', [local.x, local.y, local.z], 'layer:3'));
    expect(w.debug()).toMatchObject({ token: 7, layer: 3 });
  });

  it('floating labels never occlude nodes for the picker', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    w.onInteraction(interaction('hover', 'start', nodePoint(w, 4, 2), 'layer:4'));
    const hover = f.ui.texts.find((t) => t.visible && t.text.includes('#2 '))!;
    expect(hover).toBeTruthy();
    const hits: THREE.Intersection[] = [];
    f.root.updateMatrixWorld(true);
    hover.raycast(new THREE.Raycaster(new THREE.Vector3(hover.position.x, hover.position.y, 1), new THREE.Vector3(0, 0, -1)), hits);
    expect(hits).toEqual([]);
  });

  it('drops the hover tooltip when the geometry is rebuilt', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    tick(w);
    w.onInteraction(interaction('hover', 'start', nodePoint(w, 4, 2), 'layer:4'));
    const label = () => f.ui.texts.find((t) => t.visible && / · b3$/.test(t.text));
    expect(label()).toBeTruthy();
    pushSample(f, generateSample(2, { layers: 10, heads: 4 })); // new sample, new positions
    tick(w);
    expect(label()).toBeUndefined();
    // The next hover move re-resolves against the new layout.
    w.onInteraction(interaction('hover', 'move', nodePoint(w, 4, 2), 'layer:4'));
    expect(label()).toBeTruthy();
  });

  it('widens the readout label column for descriptive labels', async () => {
    const { f, w } = await create();
    pushSample(f, generateSample(0, { layers: 10, heads: 4 }));
    f.push('interp.lens.readout', { layer: 10, token: 28, title: 't', items: [{ label: 'agrees with final CLS answer', value: 1 }, { label: 'x', value: 0.5 }] });
    tick(w);
    expect(w.view.readout.width).toBeGreaterThan(0.32);
    expect(f.ui.texts.some((t) => t.text.startsWith('agrees with final CL'))).toBe(true);
    f.push('interp.lens.readout', { layer: 10, token: 28, title: 't', items: [{ label: ' Paris', value: 0.7 }] });
    tick(w);
    expect(w.view.readout.width).toBeCloseTo(0.32, 6);
  });
});

describe('resid-flow subscriptions', () => {
  it('fetches P.attn only while arcs are shown, without churning other subscriptions', async () => {
    const { f, w } = await create();
    const s = generateSample(0, { layers: 10, heads: 4 });
    pushSample(f, s);
    tick(w);
    expect(w.debug().view.arcIndices).toBeGreaterThan(0);
    let unsubs = 0;
    const orig = f.ctx.channels.subscribe;
    f.ctx.channels.subscribe = (n, cb) => { const off = orig(n, cb); return () => { unsubs++; off(); }; };
    const set = (patch: Record<string, unknown>) => {
      const prev = { ...f.ctx.props };
      Object.assign(f.ctx.props, patch);
      w.onProps(f.ctx.props, prev);
      tick(w);
    };
    set({ showAttn: false });
    expect(f.subscribers('interp.attn')).toBe(0);
    expect(f.subscribers('interp.resid.proj')).toBe(1);
    expect(w.debug().status.attn).toBe('missing');
    expect(f.ui.texts.some((t) => t.text.includes('no attn'))).toBe(false); // not reported as missing when off
    set({ showAttn: true });
    expect(f.subscribers('interp.attn')).toBe(1);
    expect(w.debug().view.arcIndices).toBeGreaterThan(0);
    // Switching probes swaps exactly that subscription.
    f.push('interp.probe.a', s.probes.is_location);
    f.push('interp.probe.b', makeTensor('f32', [11, 5], new Float32Array(55))); // wrong T
    set({ colorBy: 'probe', probe: 'a' });
    expect(w.debug().view.nodes).toBe(29 * 11);
    expect(f.subscribers('interp.probe.a')).toBe(1);
    set({ probe: 'b' });
    expect(f.subscribers('interp.probe.a')).toBe(0);
    expect(f.subscribers('interp.probe.b')).toBe(1);
    expect(f.ui.texts.some((t) => t.text.includes("probe 'b': shape"))).toBe(true);
    expect(f.subscribers('interp.resid.proj')).toBe(1);
    expect(f.subscribers('interp.ctl.layer')).toBe(1);
    expect(f.errors).toEqual([]);
    expect(unsubs).toBe(1 /* probe.a */ + 0);
  });
});
