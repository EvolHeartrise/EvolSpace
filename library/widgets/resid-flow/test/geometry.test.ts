import { describe, expect, it } from 'vitest';
import { makeTensor } from '@evolspace/protocol';
import { InterpData, displayToken, formatValue, toF32 } from '../data.ts';
import { buildArcs, buildLayout, buildTicks, buildTrajectories, layerY, rayLayer, rayStack, resolvePoint, type LayoutOptions } from '../layout.ts';
import { computeNodeColors, NA_GRAY, type ColorSpec } from '../colors.ts';
import { generateSample } from '../demo-data.ts';

const OPTS: LayoutOptions = { width: 0.6, spacing: 0.08, normalize: 'global', depthJitter: 0 };
const SPEC: ColorSpec = {
  palette: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  sequential: [[0, 0, 0], [1, 1, 1]],
  diverging: [[0, 0, 1], [0.5, 0.5, 0.5], [1, 0, 0]],
};

/** L1 × T grid with proj[l, t] = (t, l, 0) scaled; optional mask. */
function grid(L1: number, T: number, mask?: (l: number, t: number) => boolean): InterpData {
  const d = new InterpData();
  const p = new Float32Array(L1 * T * 3);
  const m = new Uint8Array(L1 * T);
  for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) {
    const i = l * T + t;
    p[i * 3] = t - T / 2; p[i * 3 + 1] = Math.sin(t + l); p[i * 3 + 2] = 0.1 * l;
    m[i] = !mask || mask(l, t) ? 1 : 0;
  }
  d.set('resid.proj', makeTensor('f32', [L1, T, 3], p));
  if (mask) d.set('resid.mask', makeTensor('u8', [L1, T], m));
  return d;
}

describe('data', () => {
  it('normalizes tensors of any dtype and nested JSON', () => {
    const f16 = toF32(makeTensor('f16', [2], new Uint16Array([0x3c00, 0xc000])))!; // 1, -2
    expect(Array.from(f16.data)).toEqual([1, -2]);
    const u8 = toF32(makeTensor('u8', [3], new Uint8Array([0, 1, 255])))!;
    expect(Array.from(u8.data)).toEqual([0, 1, 255]);
    const nested = toF32([[1, 2, 3], [4, 5, 6]])!;
    expect(nested.shape).toEqual([2, 3]);
    expect(nested.data[5]).toBe(6);
    expect(toF32([[1, 2], [3]])).toBeNull();
    expect(toF32({ a: 1 })).toBeNull();
    const f32 = new Float32Array([1, 2]);
    expect(toF32(makeTensor('f32', [2], f32))!.data.buffer).toBe(f32.buffer); // no copy
  });

  it('validates shapes against proj regardless of arrival order', () => {
    const d = new InterpData();
    d.set('resid.norm', makeTensor('f32', [3, 4], new Float32Array(12)));
    expect(d.norm).toBeNull(); // nothing to validate against yet
    expect(d.status('resid.norm')).toBe('ok');
    expect(d.status('resid.proj')).toBe('missing');
    d.set('resid.proj', makeTensor('f32', [3, 4, 3], new Float32Array(36)));
    expect(d.norm).not.toBeNull();
    // New sample with a different T: stale norm becomes a shape mismatch until replaced.
    d.set('resid.proj', makeTensor('f32', [3, 5, 3], new Float32Array(45)));
    expect(d.norm).toBeNull();
    expect(d.status('resid.norm')).toBe('shape');
    d.set('resid.norm', makeTensor('f32', [3, 5], new Float32Array(15)));
    expect(d.status('resid.norm')).toBe('ok');
    d.set('resid.delta', makeTensor('f32', [2, 2, 5], new Float32Array(20)));
    expect(d.delta).not.toBeNull();
    d.set('attn', makeTensor('f32', [2, 1, 5, 4], new Float32Array(40)));
    expect(d.attn).toBeNull();
    expect(d.status('attn')).toBe('shape');
    d.set('meta', 'garbage');
    expect(d.status('meta')).toBe('invalid');
  });

  it('labels default sensibly without meta', () => {
    const d = grid(3, 2);
    expect(d.layerLabel(0)).toBe('embed');
    expect(d.layerLabel(2)).toBe('b1');
    expect(d.tokenLabel(1)).toBe('#1');
    d.set('meta', { layers: ['E', 'X', 'Y'], tokens: [{ label: ' a', group: 'g1' }, { label: 'b' }] });
    expect(d.layerLabel(2)).toBe('Y');
    expect(d.tokenGroup(0)).toBe('g1');
    expect(d.groups()).toEqual(['g1']);
  });

  it('formats tokens and values', () => {
    expect(displayToken(' Paris')).toBe('·Paris');
    expect(displayToken('\n')).toBe('⏎');
    expect(displayToken('a'.repeat(40), 10)).toHaveLength(10);
    expect(formatValue(0.12345)).toBe('0.123');
    expect(formatValue(123.4)).toBe('123');
  });
});

describe('layout', () => {
  it('places one node per existing residual, centered stack', () => {
    const d = grid(11, 29);
    const L = buildLayout(d, OPTS)!;
    expect(L.nodeCount).toBe(11 * 29);
    expect(layerY(L, 0)).toBeCloseTo(-0.4);
    expect(layerY(L, 10)).toBeCloseTo(0.4);
    for (let k = 0; k < L.nodeCount; k++) {
      const i = L.nodeLayer[k] * L.T + L.nodeToken[k];
      expect(Math.abs(L.pos[i * 3])).toBeLessThanOrEqual(0.3 * 1.15 + 1e-6);
      expect(Math.abs(L.pos[i * 3 + 2])).toBeLessThanOrEqual(0.3 * 1.15 + 1e-6);
      expect(L.pos[i * 3 + 1]).toBeCloseTo(layerY(L, L.nodeLayer[k]));
    }
  });

  it('omits masked positions and splits trajectories at gaps', () => {
    // token 0: all; token 1: layers 0-2 only (ends); token 2: gap at layer 2; token 3: never.
    const mask = (l: number, t: number) => (t === 0 ? true : t === 1 ? l <= 2 : t === 2 ? l !== 2 : false);
    const d = grid(5, 4, mask);
    const L = buildLayout(d, OPTS)!;
    expect(L.nodeCount).toBe(5 + 3 + 4);
    const S = 4;
    const tr = buildTrajectories(L, new Float32Array(5 * 4 * 3).fill(0.5), S);
    // strips: t0 [0..4], t1 [0..2], t2 [0..1] + [3..4]
    expect(tr.strips).toBe(4);
    const samples = (4 * S + 1) + (2 * S + 1) + (S + 1) + (S + 1);
    expect(tr.vertexCount).toBe(samples * 2);
    expect(tr.indexCount).toBe((samples - 4) * 6);
    // Curves pass through the nodes.
    const i = 4 * 4 + 0; // last node of token 0
    const lastV = (4 * S + 1) * 2 - 1;
    expect(tr.position[lastV * 3]).toBeCloseTo(L.pos[i * 3], 5);
    expect(tr.position[lastV * 3 + 1]).toBeCloseTo(L.pos[i * 3 + 1], 5);
  });

  it('applies the token filter and reuses buffers', () => {
    const d = grid(4, 6);
    d.set('meta', { tokens: Array.from({ length: 6 }, (_, t) => ({ label: `t${t}`, group: t % 2 ? 'odd' : 'even' })) });
    const a = buildLayout(d, { ...OPTS, tokenVisible: (t) => d.tokenGroup(t) === 'odd' })!;
    expect(a.nodeCount).toBe(4 * 3);
    const b = buildLayout(d, OPTS, a)!;
    expect(b.nodeCount).toBe(24);
    expect(b.pos).toBe(a.pos);
  });

  it('builds ticks at the node a block produced and arcs to attended keys', () => {
    const s = generateSample(0, { layers: 10, heads: 4 });
    const d = new InterpData();
    d.set('resid.proj', s.proj); d.set('resid.mask', s.mask); d.set('resid.delta', s.delta); d.set('attn', s.attn);
    const L = buildLayout(d, OPTS)!;
    const ticks = buildTicks(L, d.delta!);
    expect(ticks.count).toBe(2 * 10 * 29);
    expect(ticks.info[3]).toBe(1); // block 0 → layer 1
    const row = new Float32Array(29);
    row[3] = 0.5; row[7] = 0.3; row[10] = 0.01; row[28] = 0.9; // self ignored
    const keys: number[] = [];
    const arcs = buildArcs(L, 5, 28, row, { topK: 8, minWeight: 0.02, samples: 10, color: [1, 1, 1] }, undefined, keys);
    expect(keys).toEqual([3, 7]);
    expect(arcs.strips).toBe(2);
    expect(arcs.vertexCount).toBe(2 * 11 * 2);
  });

  it('resolves picks to tokens and layers', () => {
    const d = grid(5, 4);
    const L = buildLayout(d, OPTS)!;
    const i = 2 * 4 + 1; // layer 2, token 1
    const node = [L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]];
    expect(resolvePoint(L, node, 0.02)).toEqual({ kind: 'token', token: 1, layer: 2 });
    expect(resolvePoint(L, [0.29, layerY(L, 3) + 0.004, -0.29], 0.001)).toEqual({ kind: 'layer', layer: 3 });
    expect(resolvePoint(L, [2, 0, 0], 0.02)).toBeNull();
    // Ray straight down onto the node from above.
    const hit = rayLayer(L, 2, node[0], 1, node[2], 0, -1, 0, 0.02)!;
    expect(hit.token).toBe(1);
    // Ray hitting the plane away from nodes.
    const plane = rayLayer(L, 2, 0.29, 1, 0.29, 0, -1, 0, 0.001)!;
    expect(plane.token).toBe(-1);
    expect(plane.y).toBeCloseTo(layerY(L, 2));
    expect(rayLayer(L, 2, 0, 1, 0, 0, 1, 0, 0.02)).toBeNull(); // pointing away
  });

  it('colors by group, position, norm and probe', () => {
    const s = generateSample(0, { layers: 3, heads: 2 });
    const d = new InterpData();
    d.set('resid.proj', s.proj); d.set('meta', s.meta); d.set('resid.norm', s.norm);
    const L = buildLayout(d, OPTS)!;
    const g = computeNodeColors(d, L, 'group', SPEC);
    expect(Array.from(g.subarray(0, 3))).toEqual([1, 0, 0]); // first group → palette[0]
    const p = computeNodeColors(d, L, 'probe', SPEC); // no probe → falls back to group
    expect(Array.from(p.subarray(0, 3))).toEqual([1, 0, 0]);
    d.set('probe', s.probes.is_location);
    const q = computeNodeColors(d, L, 'probe', SPEC);
    expect(q.length).toBeGreaterThanOrEqual(L.L1 * L.T * 3);
    const n = computeNodeColors(d, L, 'norm', SPEC);
    expect(Number.isFinite(n[0])).toBe(true);
  });
});

describe('stack picking (rayStack)', () => {
  it('angled rays reach interior nodes through nearer plane footprints', () => {
    const d = grid(11, 6);
    const L = buildLayout(d, OPTS)!;
    const l = 3, t = 2, i = l * L.T + t;
    const node = [L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2]];
    // From the front, above the stack top, looking down at the node: the ray crosses the
    // footprints of several higher planes before it reaches the node.
    const o = [node[0], layerY(L, 10) + 0.3, 0.45];
    let dx = node[0] - o[0], dy = node[1] - o[1], dz = node[2] - o[2];
    const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n;
    const out = { distance: 0, x: 0, y: 0, z: 0, token: -1, layer: -1 };
    expect(rayStack(L, o[0], o[1], o[2], dx, dy, dz, 0.006, 0.018, 0.02, out)).not.toBeNull();
    expect(out).toMatchObject({ token: t, layer: l });
    expect(out.distance).toBeCloseTo(n, 5);
    // A per-layer pick of a higher plane would have hit first: that is what rayStack prevents.
    let shadowed = 0;
    for (let k = l + 1; k < L.L1; k++) {
      const h = rayLayer(L, k, o[0], o[1], o[2], dx, dy, dz, 0.018);
      if (h && h.distance < n) shadowed++;
    }
    expect(shadowed).toBeGreaterThan(0);
  });

  it('prefers the front node the ray passes through, then the closest within the radius', () => {
    const d = grid(3, 4);
    const L = buildLayout(d, OPTS)!;
    // Horizontal ray along -z exactly through node (1, 0) and (1, 1)'s neighborhood.
    const i = 1 * L.T + 0;
    const out = { distance: 0, x: 0, y: 0, z: 0, token: -1, layer: -1 };
    rayStack(L, L.pos[i * 3], L.pos[i * 3 + 1], 2, 0, 0, -1, 0.006, 0.018, 0.02, out);
    expect(out).toMatchObject({ token: 0, layer: 1 });
    // Slightly off (1 cm): still the closest node within the forgiving radius.
    rayStack(L, L.pos[i * 3] + 0.01, L.pos[i * 3 + 1], 2, 0, 0, -1, 0.006, 0.018, 0.02, out);
    expect(out).toMatchObject({ token: 0, layer: 1 });
  });

  it('falls back to the first plane crossed, and misses outside the footprint', () => {
    const d = grid(5, 4);
    const L = buildLayout(d, OPTS)!;
    const out = { distance: 0, x: 0, y: 0, z: 0, token: -1, layer: -1 };
    // Straight down at a corner far from nodes: the top plane is crossed first.
    expect(rayStack(L, 0.29, 1, -0.29, 0, -1, 0, 0.006, 0.001, 0.02, out)).not.toBeNull();
    expect(out).toMatchObject({ token: -1, layer: 4 });
    expect(out.y).toBeCloseTo(layerY(L, 4));
    // Straight up from below: the bottom plane.
    rayStack(L, 0.29, -1, -0.29, 0, 1, 0, 0.006, 0.001, 0.02, out);
    expect(out.layer).toBe(0);
    expect(rayStack(L, 2, 1, 0, 0, -1, 0, 0.006, 0.018, 0.02, out)).toBeNull();
  });
});

describe('probe colors', () => {
  it('uses a fixed [-1, 1] diverging scale; NaN (n/a) is neutral gray; beyond ±1 saturates', () => {
    const d = grid(2, 4);
    const p = new Float32Array([NaN, 0, 1, -1, 0.5, -0.5, 3, -7]);
    d.set('probe', makeTensor('f32', [2, 4], p));
    const L = buildLayout(d, OPTS)!;
    const c = computeNodeColors(d, L, 'probe', SPEC);
    const rgb = (k: number) => Array.from(c.subarray(k * 3, k * 3 + 3));
    expect(rgb(0)).toEqual([NA_GRAY, NA_GRAY, NA_GRAY].map((v) => Math.fround(v))); // n/a
    expect(rgb(1)).toEqual([0.5, 0.5, 0.5]); // 0 = undecided → neutral
    expect(rgb(2)).toEqual([1, 0, 0]); // +1 → high end
    expect(rgb(3)).toEqual([0, 0, 1]); // −1 → low end (a real score now, not a sentinel)
    expect(rgb(4)).toEqual([0.75, 0.25, 0.25]); // not rescaled by the data's extent
    expect(rgb(5)).toEqual([0.25, 0.25, 0.75]);
    expect(rgb(6)).toEqual([1, 0, 0]); // saturates
    expect(rgb(7)).toEqual([0, 0, 1]);
  });

  it('a probe with only small scores stays pale (fixed scale, no percentile stretch)', () => {
    const d = grid(2, 3);
    d.set('probe', makeTensor('f32', [2, 3], new Float32Array([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])));
    const L = buildLayout(d, OPTS)!;
    const c = computeNodeColors(d, L, 'probe', SPEC);
    expect(c[0]).toBeCloseTo(0.55, 5);
  });
});
