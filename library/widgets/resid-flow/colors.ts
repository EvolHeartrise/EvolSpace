// Node coloring for resid-flow (pure; colors are linear RGB triples converted
// from the theme by the view via ctx.THREE.Color so they match three's color
// management).

import type { InterpData } from './data.ts';
import { ensureF32, quantile, type Layout } from './layout.ts';

export type RGB = [number, number, number];

export interface ColorSpec {
  palette: RGB[];
  sequential: RGB[];
  diverging: [RGB, RGB, RGB];
}

export type ColorBy = 'group' | 'position' | 'norm' | 'probe';

/** Piecewise-linear sample of a ramp at t ∈ [0, 1], written into out[o..o+2]. */
export function sampleRamp(stops: readonly RGB[], t: number, out: Float32Array, o: number): void {
  if (!stops.length) { out[o] = out[o + 1] = out[o + 2] = 1; return; }
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  if (i < 0) { out[o] = stops[0][0]; out[o + 1] = stops[0][1]; out[o + 2] = stops[0][2]; return; }
  const f = x - i, a = stops[i], b = stops[i + 1];
  out[o] = a[0] + (b[0] - a[0]) * f;
  out[o + 1] = a[1] + (b[1] - a[1]) * f;
  out[o + 2] = a[2] + (b[2] - a[2]) * f;
}

/** Diverging ramp at v ∈ [-1, 1]. */
function sampleDiverging(d: readonly [RGB, RGB, RGB], v: number, out: Float32Array, o: number): void {
  sampleRamp(d, (Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)) + 1) / 2, out, o);
}

/** Palette index of each token (by group, in order of first appearance); -1 = no group. */
export function groupIndices(data: InterpData): Int32Array {
  const T = data.T;
  const out = new Int32Array(T).fill(-1);
  const groups = data.groups();
  for (let t = 0; t < T; t++) {
    const g = data.tokenGroup(t);
    if (g !== undefined) out[t] = groups.indexOf(g);
  }
  return out;
}

/**
 * Color per (l, t) → [L1 × T × 3] linear RGB.
 *  group    — categorical palette by token group (falls back to 'position' without groups)
 *  position — sequential ramp over token index (upper 75% of the ramp: the dark end vanishes on glass)
 *  norm     — sequential ramp over normalized residual norm
 *  probe    — diverging ramp over the probe score; falls back to group. Two score conventions:
 *             probabilities (all values in [0, 1], -1 = not applicable — what python/evolinterp
 *             publishes): 0.5 = neutral, n/a = gray; otherwise signed scores with the
 *             98th-percentile |score| as full color.
 */
export function computeNodeColors(data: InterpData, L: Layout, mode: ColorBy, spec: ColorSpec, prev?: Float32Array): Float32Array {
  const { L1, T } = L;
  const out = ensureF32(prev, L1 * T * 3);
  const probe = mode === 'probe' ? data.probe : null;
  let effective: ColorBy = mode === 'probe' && !probe ? 'group' : mode;
  const gi = groupIndices(data);
  if (effective === 'group' && !gi.some((g) => g >= 0)) effective = 'position';

  let pScale = 1;
  let prob = false;
  if (effective === 'probe' && probe) prob = isProbability(probe.data);
  if (effective === 'probe' && probe && !prob) {
    const s = new Float32Array(probe.data.length);
    let m = 0;
    for (let i = 0; i < probe.data.length; i++) if (Number.isFinite(probe.data[i])) s[m++] = Math.abs(probe.data[i]);
    pScale = quantile(s, m, 0.98) || 1;
  }

  for (let l = 0; l < L1; l++) for (let t = 0; t < T; t++) {
    const i = l * T + t, o = i * 3;
    switch (effective) {
      case 'group': {
        const g = gi[t];
        if (g >= 0 && spec.palette.length) {
          const c = spec.palette[g % spec.palette.length];
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
        } else {
          // Ungrouped tokens in a grouped sequence: neutral gray.
          out[o] = out[o + 1] = out[o + 2] = 0.35;
        }
        break;
      }
      case 'position':
        sampleRamp(spec.sequential, 0.25 + 0.75 * (T > 1 ? t / (T - 1) : 1), out, o);
        break;
      case 'norm':
        sampleRamp(spec.sequential, 0.2 + 0.8 * L.normN[i], out, o);
        break;
      case 'probe': {
        const v = probe!.data[i];
        if (!Number.isFinite(v) || (prob && v < 0)) out[o] = out[o + 1] = out[o + 2] = 0.35; // n/a
        else sampleDiverging(spec.diverging, prob ? 2 * v - 1 : v / pScale, out, o);
        break;
      }
    }
  }
  return out;
}

/** True if scores look like probabilities: every finite value in [0, 1] or a negative n/a sentinel, at least one in [0, 1]. */
export function isProbability(v: Float32Array): boolean {
  let any = false;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) continue;
    if (x >= 0 && x <= 1) any = true;
    else if (x !== -1) return false;
  }
  return any;
}
