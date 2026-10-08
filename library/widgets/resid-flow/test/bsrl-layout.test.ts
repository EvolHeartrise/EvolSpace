// Regression tests from a real BeatSaberRL screenshot (data/shot-resid*.png):
// a long model string with a checkpoint path, an embed layer whose residuals
// barely differ (collapsed to a dot under one global scale), residual norms
// growing ~4x with depth, a masked top layer, signed probe scores, and a
// readout with long descriptive labels, values > 1, nulls and tiny negatives.

import { describe, expect, it } from 'vitest';
import { makeTensor } from '@evolspace/protocol';
import type { WidgetContext } from '@evolspace/protocol';
import def from '../widget.ts';
import type { ResidFlow, ResidProps } from '../controller.ts';
import { AUTO_MIN_FILL, buildLayout, layerY, type Layout, type LayoutOptions } from '../layout.ts';
import { fitText, formatValue, InterpData } from '../data.ts';
import { READOUT_OVERHANG, READOUT_X } from '../view.ts';
import { readoutLabel } from '../readout.ts';
import { makeCtx, propDefaults, type FakeCtx, type StubText } from './fake-ctx.ts';

const L1 = 11;
const T = 29;
const MODEL = 'BeatSaberRL NotePolicy bend7_cd1000/leaf_from_upd06000 upd 7000 (10L d192 h4)';
const CHECKPOINT = 'C:\\Users\\Flee\\beat-arena-volume-backup\\bend7\\runs\\bend7_cd1000\\leaf_from_upd06000.pt';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Per-layer stats like the cached BSRL capture: embed std 0.02 around (-0.38, -0.08), later layers 0.25..1.5. */
function bsrl(seed = 1) {
  const r = rng(seed);
  const proj = new Float32Array(L1 * T * 3);
  const norm = new Float32Array(L1 * T);
  const mask = new Uint8Array(L1 * T);
  const probe = new Float32Array(L1 * T);
  for (let l = 0; l < L1; l++) {
    const spreadX = l === 0 ? 0.02 : 0.25;
    const spreadZ = l === 0 ? 0.035 : 0.03 + 0.05 * l;
    const cx = l === 0 ? -0.38 : 0.05;
    const cz = l === 0 ? -0.08 : 0.06 + 0.015 * l;
    for (let t = 0; t < T; t++) {
      const i = l * T + t;
      const on = l < L1 - 1 || t < 5;
      mask[i] = on ? 1 : 0;
      proj[i * 3] = cx + (r() * 2 - 1) * spreadX * 1.7;
      proj[i * 3 + 1] = cz + (r() * 2 - 1) * spreadZ * 1.7;
      proj[i * 3 + 2] = (r() * 2 - 1) * 0.1;
      norm[i] = 178 * (1 + 0.3 * l);
      probe[i] = t % 7 === 0 ? NaN : Math.tanh((l / (L1 - 1)) * 3 - 1) * (t % 2 ? 1 : -1);
    }
  }
  return {
    meta: {
      model: MODEL,
      checkpoint: CHECKPOINT,
      layers: ['embed', ...Array.from({ length: L1 - 1 }, (_, b) => `b${b}`)],
      tokens: Array.from({ length: T }, (_, t) => ({ label: t < 5 ? `saber ${t % 2 ? 'R' : 'L'} #${t}` : `note ${t}`, group: t < 5 ? 'saber' : 'note' })),
      d_model: 192,
      sample: { index: 0, total: 2048, label: '#0: 24 entities · next red dot 0.42s' },
      lens: { kind: 'linear decode', description: 'joint targets' },
    },
    proj: makeTensor('f32', [L1, T, 3], proj),
    norm: makeTensor('f32', [L1, T], norm),
    mask: makeTensor('u8', [L1, T], mask),
    probe: makeTensor('f32', [L1, T], probe),
  };
}

const READOUT_ITEMS = [
  { label: 'arm_pitch -full (H 0.15)', value: 0.797 },
  { label: 'arm_yaw coast (H 0.15)', value: 0.966 },
  { label: 'wrist_bend +1/4 (H 0.42)', value: 0.592 },
  { label: 'argmax agrees with final', value: 1 },
  { label: 'KL(final || this layer)', value: -4.0e-14 },
  { label: 'critic value (normalized)', value: 2.5 },
  { label: 'entropy (nats)', value: null },
  { label: 'margin', value: 1.25 },
];

async function create(props: Record<string, unknown> = {}): Promise<{ f: FakeCtx; w: ResidFlow }> {
  const f = makeCtx(props, propDefaults(def));
  const w = (await def.create(f.ctx as WidgetContext<ResidProps>)) as ResidFlow;
  return { f, w };
}

function push(f: FakeCtx, s: ReturnType<typeof bsrl>, metaPatch: Record<string, unknown> = {}): void {
  f.push('interp.meta', { ...s.meta, ...metaPatch });
  f.push('interp.resid.proj', s.proj);
  f.push('interp.resid.norm', s.norm);
  f.push('interp.resid.mask', s.mask);
  f.push('interp.lens.readout', { layer: L1 - 1, token: 0, title: 'linear decode @ b9 · saber L -> joints', items: READOUT_ITEMS });
}

/** Settle the lens animation. */
function settle(w: ResidFlow): void {
  for (let i = 0; i < 4; i++) w.update!(5, i);
}

/** Max distance of layer l's nodes from their centroid (x/z, max-axis). */
function extent(L: Layout, l: number): number {
  let sx = 0, sz = 0, c = 0;
  for (let t = 0; t < L.T; t++) {
    const i = l * L.T + t;
    if (L.nodeOf[i] < 0) continue;
    sx += L.pos[i * 3]; sz += L.pos[i * 3 + 2]; c++;
  }
  const mx = sx / c, mz = sz / c;
  let m = 0;
  for (let t = 0; t < L.T; t++) {
    const i = l * L.T + t;
    if (L.nodeOf[i] < 0) continue;
    m = Math.max(m, Math.abs(L.pos[i * 3] - mx), Math.abs(L.pos[i * 3 + 2] - mz));
  }
  return m;
}

function layoutOf(mode: LayoutOptions['normalize']): Layout {
  const s = bsrl();
  const d = new InterpData();
  d.set('resid.proj', s.proj);
  d.set('resid.mask', s.mask);
  return buildLayout(d, { width: 0.6, spacing: 0.08, normalize: mode, depthJitter: 0 })!;
}

const fitR = 0.6 / 2 * 0.9;

describe('normalization modes', () => {
  it("'global' collapses the embed layer to a dot (the screenshot bug)", () => {
    const L = layoutOf('global');
    expect(extent(L, 0)).toBeLessThan(0.03); // ±3 cm of a 60 cm plane: one blob
    expect(Array.from(L.gain.subarray(0, L1))).toEqual(Array(L1).fill(1));
  });

  it("'auto' magnifies collapsed layers about their centroid, keeps the others (and the centroid drift) global", () => {
    const G = layoutOf('global');
    const A = layoutOf('auto');
    // embed now spreads over at least AUTO_MIN_FILL of the fit radius (98th percentile ≈ max here).
    expect(extent(A, 0)).toBeGreaterThan(AUTO_MIN_FILL * fitR * 0.9);
    expect(A.gain[0]).toBeGreaterThan(3);
    // Wide layers are untouched.
    for (let l = 3; l < L1 - 1; l++) {
      expect(A.gain[l]).toBe(1);
      for (let t = 0; t < T; t++) expect(A.pos[(l * T + t) * 3]).toBeCloseTo(G.pos[(l * T + t) * 3], 6);
    }
    // embed's centroid stays where the global scale puts it (left of center).
    const cx = (L: Layout) => { let s = 0; for (let t = 0; t < T; t++) s += L.pos[t * 3]; return s / T; };
    expect(cx(A)).toBeCloseTo(cx(G), 4);
    expect(cx(A)).toBeLessThan(-0.05);
    // Every node exists and stays on its plane.
    expect(A.nodeCount).toBe(10 * T + 5);
    for (let k = 0; k < A.nodeCount; k++) {
      const i = A.nodeLayer[k] * T + A.nodeToken[k];
      expect(Math.abs(A.pos[i * 3])).toBeLessThanOrEqual(0.3 * 1.15 + 1e-6);
      expect(Math.abs(A.pos[i * 3 + 2])).toBeLessThanOrEqual(0.3 * 1.15 + 1e-6);
    }
  });

  it("'per-layer' (and the legacy 'layer') fill every plane, centered", () => {
    const P = layoutOf('per-layer');
    const O = layoutOf('layer');
    expect(Array.from(P.pos.subarray(0, L1 * T * 3))).toEqual(Array.from(O.pos.subarray(0, L1 * T * 3)));
    for (let l = 0; l < L1; l++) expect(extent(P, l)).toBeGreaterThan(fitR * 0.85);
    expect(P.gain[0]).toBeGreaterThan(P.gain[5]);
  });
});

describe('resid-flow with BeatSaberRL-like data', () => {
  const texts = (f: FakeCtx) => f.ui.texts.filter((t) => t.visible).map((t) => t.text);
  const view = (w: ResidFlow) => w.view as unknown as { header: StubText; subheader: StubText; status: StubText; headerWidth(): number };

  it("defaults to 'auto': embed and b0 have visible, spread nodes; magnified layers are labelled", async () => {
    const { f, w } = await create();
    push(f, bsrl());
    settle(w);
    const L = w.debug().layout!;
    expect(def.props!.normalize.default).toBe('auto');
    for (const l of [0, 1]) {
      let n = 0;
      for (let t = 0; t < T; t++) if (L.nodeOf[l * T + t] >= 0) n++;
      expect(n).toBe(T);
      expect(extent(L, l)).toBeGreaterThan(0.1);
    }
    expect(texts(f).some((t) => /^embed ×\d/.test(t))).toBe(true);
    expect(texts(f)).toContain('b5');
    expect(f.errors).toEqual([]);
  });

  it('header: short_name preferred; a long model string is cut at a word boundary; no checkpoint path', async () => {
    const { f, w } = await create();
    push(f, bsrl());
    settle(w);
    const v = view(w);
    const title = v.header.text;
    expect(title.endsWith('…')).toBe(true);
    expect(MODEL.startsWith(title.slice(0, -1))).toBe(true);
    expect(/[\s/_(]$/.test(title.slice(0, -1))).toBe(false); // no dangling separator
    // Estimated width (conservative 0.6 em advance) stays left of the readout column.
    expect(title.length * 0.024 * 0.6).toBeLessThanOrEqual(v.headerWidth() + 1e-9);
    expect(v.subheader.text.length * 0.014 * 0.6).toBeLessThanOrEqual(v.headerWidth() + 1e-9);
    expect(texts(f).some((t) => t.includes('beat-arena') || t.includes('.pt'))).toBe(false);

    f.push('interp.meta', { ...bsrl().meta, short_name: 'BSRL bend7 leaf06000 u7000' });
    settle(w);
    expect(v.header.text).toBe('BSRL bend7 leaf06000 u7000');
  });

  it('readout: full descriptive labels, bars scaled by max |value|, null as —', async () => {
    const { f, w } = await create();
    push(f, bsrl());
    settle(w);
    const r = w.view.readout;
    const labels = f.ui.texts.find((t) => t.text.startsWith('arm_pitch'))!.text.split('\n');
    expect(labels[0]).toBe('arm_pitch -full (H 0.15)');
    expect(labels[5]).toBe('critic value (normalized)');
    const values = f.ui.texts.find((t) => t.text.startsWith('0.797'))!.text.split('\n');
    expect(values[4]).toBe('0'); // -4e-14
    expect(values[5]).toBe('2.50');
    expect(values[6]).toBe('—');
    const full = r.barOf(5).length;
    expect(r.barOf(7).length).toBeCloseTo(full / 2, 6); // 1.25 vs max 2.5
    expect(r.barOf(3).length).toBeCloseTo(full * 0.4, 6);
    expect(r.barOf(6).visible).toBe(false); // null
    // Bars start right of the label column and end before the value column.
    expect(r.barOf(0).x).toBeGreaterThan(0.014 + 25 * (0.6 * 0.0145));
    expect(r.barOf(5).x + full).toBeLessThan(r.width - 0.014 - 0.06);
    expect(r.width).toBeLessThanOrEqual(0.52);
  });

  it('nothing overlaps: readout vs header at every lens layer', async () => {
    const { f, w } = await create();
    push(f, bsrl());
    settle(w);
    const v = view(w);
    const L = w.debug().layout!;
    const headerBottom = v.subheader.position.y - 0.014 * 1.3;
    const headerRight = -L.width / 2 + v.headerWidth();
    for (let l = 0; l < L1; l++) {
      w.onInput('layer', l);
      settle(w);
      const r = w.view.readout;
      const cy = w.view.lens.position.y + r.group.position.y;
      const top = cy + r.height / 2;
      const bottom = cy - r.height / 2;
      expect(top, `layer ${l}`).toBeLessThan(headerBottom);
      expect(top).toBeLessThanOrEqual(layerY(L, L1 - 1) + READOUT_OVERHANG + 1e-9);
      expect(bottom).toBeGreaterThanOrEqual(layerY(L, 0) - READOUT_OVERHANG - 1e-9);
      // The lens plane stays within the panel's height (the panel tracks the lens).
      expect(layerY(L, l)).toBeGreaterThanOrEqual(bottom - 1e-9);
      expect(layerY(L, l)).toBeLessThanOrEqual(top + 1e-9);
      // Horizontally the header ends before the readout column starts.
      expect(headerRight).toBeLessThan(L.width / 2 + READOUT_X);
    }
  });

  it('colors by signed probe scores with NaN as n/a, without errors', async () => {
    const { f, w } = await create({ colorBy: 'probe', probe: 'arm_pitch' });
    const s = bsrl();
    push(f, s);
    f.push('interp.probe.arm_pitch', s.probe);
    settle(w);
    expect(w.debug().status).toMatchObject({ 'resid.proj': 'ok' });
    expect(texts(f).some((t) => t.includes("probe 'arm_pitch'"))).toBe(false);
    expect(f.errors).toEqual([]);
  });
});

describe('text fitting helpers', () => {
  it('fitText cuts at word boundaries with an ellipsis', () => {
    expect(fitText('short', 10)).toBe('short');
    expect(fitText('arm_pitch -full (H 0.15) extra words', 20)).toBe('arm_pitch -full (H…');
    expect(fitText('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
    expect(fitText(MODEL, 49).length).toBeLessThanOrEqual(49);
    expect(fitText('a  b\n c', 10)).toBe('a b c');
  });

  it('readoutLabel keeps token whitespace visible and cuts long labels at words', () => {
    expect(readoutLabel(' Paris')).toBe('·Paris');
    expect(readoutLabel('a very long descriptive readout label that goes on')).toBe('a very long descriptive…');
  });

  it('formatValue: n/a and float dust', () => {
    expect(formatValue(Number.NaN)).toBe('—');
    expect(formatValue(-4e-14)).toBe('0');
    expect(formatValue(2.5)).toBe('2.50');
  });
});
