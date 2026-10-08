// Pure helpers of the Channels panel: value classification, tensor statistics,
// 2-D slicing / downsampling, color ramps and sparkline envelopes. No DOM.

import { isTensor, type TensorValue } from '@evolspace/protocol';

// ------------------------------------------------------------------ value kinds

export type ValueKind = 'none' | 'null' | 'number' | 'boolean' | 'string' | 'tensor' | 'numarray' | 'array' | 'object';

export function valueKind(v: unknown): ValueKind {
  if (v === undefined) return 'none';
  if (v === null) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (isTensor(v)) return 'tensor';
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => typeof x === 'number') ? 'numarray' : 'array';
  return 'object';
}

export function fmtShape(shape: readonly number[]): string {
  return shape.length ? shape.join('×') : 'scalar';
}

/** dtype[shape] — the compact tensor label used everywhere in the dashboard. */
export function tensorLabel(t: Pick<TensorValue, 'dtype' | 'shape'>): string {
  return `${t.dtype}[${fmtShape(t.shape)}]`;
}

// ------------------------------------------------------------------ numbers

/** IEEE 754 half (raw u16) → number. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Element i of a tensor as a JS number (f16 decoded). */
export function tensorAt(t: TensorValue, i: number): number {
  const x = t.data[i];
  return t.dtype === 'f16' ? halfToFloat(x) : x;
}

/** The tensor's elements as a Float32Array (decodes f16; copies other types). */
export function tensorFloats(t: TensorValue): Float32Array {
  if (t.dtype === 'f32') return t.data as Float32Array;
  const n = t.data.length;
  const out = new Float32Array(n);
  if (t.dtype === 'f16') for (let i = 0; i < n; i++) out[i] = halfToFloat(t.data[i]);
  else for (let i = 0; i < n; i++) out[i] = t.data[i];
  return out;
}

export interface Stats {
  count: number;
  /** Finite values only. */
  finite: number;
  nan: number;
  inf: number;
  min: number;
  max: number;
  mean: number;
  std: number;
}

/** min/max/mean/std over the finite values, plus NaN / ±Inf counts. */
export function stats(values: ArrayLike<number>): Stats {
  let n = 0, nan = 0, inf = 0, min = Infinity, max = -Infinity, mean = 0, m2 = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (Number.isNaN(x)) { nan++; continue; }
    if (!Number.isFinite(x)) { inf++; continue; }
    n++;
    if (x < min) min = x;
    if (x > max) max = x;
    const d = x - mean; // Welford
    mean += d / n;
    m2 += d * (x - mean);
  }
  return {
    count: values.length, finite: n, nan, inf,
    min: n ? min : NaN, max: n ? max : NaN, mean: n ? mean : NaN, std: n ? Math.sqrt(m2 / n) : NaN,
  };
}

export function tensorStats(t: TensorValue): Stats {
  return stats(tensorFloats(t));
}

// ------------------------------------------------------------------ slicing

export interface Grid {
  rows: number;
  cols: number;
  /** Row-major rows×cols. */
  values: Float32Array;
}

/**
 * A 2-D view of a tensor: rank ≤ 1 → one row; rank 2 → itself; rank ≥ 3 →
 * the last two axes at the given leading indices (clamped; missing = 0).
 */
export function slice2d(t: TensorValue, lead: readonly number[] = []): Grid {
  const sh = t.shape;
  const f = tensorFloats(t);
  if (sh.length <= 1) return { rows: 1, cols: sh[0] ?? f.length, values: f.subarray(0, sh[0] ?? f.length) };
  const rows = sh[sh.length - 2], cols = sh[sh.length - 1];
  let off = 0, stride = rows * cols;
  for (let a = sh.length - 3; a >= 0; a--) {
    const i = Math.max(0, Math.min(sh[a] - 1, Math.floor(lead[a] ?? 0)));
    off += i * stride;
    stride *= sh[a];
  }
  return { rows, cols, values: f.subarray(off, off + rows * cols) };
}

/** Block-mean downsample so neither side exceeds `max` (NaNs ignored; all-NaN block → NaN). */
export function downsample(g: Grid, max = 512): Grid {
  const fr = Math.ceil(g.rows / max), fc = Math.ceil(g.cols / max);
  if (fr <= 1 && fc <= 1) return g;
  const rows = Math.ceil(g.rows / fr), cols = Math.ceil(g.cols / fc);
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0, n = 0;
      for (let rr = r * fr; rr < Math.min(g.rows, (r + 1) * fr); rr++) {
        for (let cc = c * fc; cc < Math.min(g.cols, (c + 1) * fc); cc++) {
          const x = g.values[rr * g.cols + cc];
          if (Number.isFinite(x)) { s += x; n++; }
        }
      }
      out[r * cols + c] = n ? s / n : NaN;
    }
  }
  return { rows, cols, values: out };
}

// ------------------------------------------------------------------ colors

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}

/** Piecewise-linear ramp through `stops` at t∈[0,1]. */
export function rampAt(stops: readonly RGB[], t: number): RGB {
  if (!stops.length) return [128, 128, 128];
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  if (i < 0) return stops[0];
  const k = x - i, a = stops[i], b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

export interface ColorScale {
  diverging: boolean;
  /** Value range mapped onto the ramp (diverging: symmetric ±abs). */
  lo: number;
  hi: number;
}

/** Diverging (centered on 0) when the data has both signs; sequential otherwise. */
export function colorScale(s: Pick<Stats, 'min' | 'max'>, force?: 'diverging' | 'sequential'): ColorScale {
  const min = Number.isFinite(s.min) ? s.min : 0, max = Number.isFinite(s.max) ? s.max : 0;
  const diverging = force ? force === 'diverging' : min < 0 && max > 0;
  if (diverging) {
    const a = Math.max(Math.abs(min), Math.abs(max)) || 1;
    return { diverging, lo: -a, hi: a };
  }
  return { diverging, lo: min, hi: max === min ? min + 1 : max };
}

export const NAN_RGB: RGB = [255, 0, 255];

/** RGBA pixels (rows×cols) of a grid. NaN/Inf cells are magenta. */
export function heatmapPixels(g: Grid, scale: ColorScale, ramp: readonly RGB[]): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(g.rows * g.cols * 4);
  const span = scale.hi - scale.lo || 1;
  // 256-entry LUT: no per-cell interpolation.
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const c = rampAt(ramp, i / 255); lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2]; }
  for (let i = 0; i < g.values.length; i++) {
    const x = g.values[i];
    const o = i * 4;
    if (!Number.isFinite(x)) { px[o] = NAN_RGB[0]; px[o + 1] = NAN_RGB[1]; px[o + 2] = NAN_RGB[2]; px[o + 3] = 255; continue; }
    const k = Math.max(0, Math.min(255, Math.round(((x - scale.lo) / span) * 255))) * 3;
    px[o] = lut[k]; px[o + 1] = lut[k + 1]; px[o + 2] = lut[k + 2]; px[o + 3] = 255;
  }
  return px;
}

// ------------------------------------------------------------------ sparklines

/**
 * Min/max envelope per output column (so spikes survive downsampling): returns
 * `buckets` pairs [lo, hi] over the finite values (NaN pair = empty bucket).
 */
export function envelope(values: ArrayLike<number>, buckets: number): Float32Array {
  const n = values.length;
  const b = Math.max(1, Math.min(buckets, n));
  const out = new Float32Array(b * 2).fill(NaN);
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    const k = Math.min(b - 1, Math.floor((i * b) / n));
    const lo = out[k * 2], hi = out[k * 2 + 1];
    if (Number.isNaN(lo) || x < lo) out[k * 2] = x;
    if (Number.isNaN(hi) || x > hi) out[k * 2 + 1] = x;
  }
  return out;
}

/** SVG/canvas-friendly polyline points of a series scaled into w×h (y down), with padding. */
export function sparkPoints(values: ArrayLike<number>, w: number, h: number, range?: { lo: number; hi: number }, pad = 2): Array<[number, number]> {
  const n = values.length;
  if (!n) return [];
  let lo = range?.lo ?? Infinity, hi = range?.hi ?? -Infinity;
  if (!range) for (let i = 0; i < n; i++) { const x = values[i]; if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } }
  if (!Number.isFinite(lo)) return [];
  if (hi === lo) { hi += 0.5; lo -= 0.5; }
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    const px = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
    const py = pad + (1 - (x - lo) / (hi - lo)) * (h - 2 * pad);
    pts.push([px, py]);
  }
  return pts;
}

/** A sensible slider range for a number with no declared bounds. */
export function guessRange(v: number, seen: { min: number; max: number } | null = null): { min: number; max: number; step: number } {
  let lo = Math.min(0, v, seen?.min ?? 0), hi = Math.max(v, seen?.max ?? v);
  if (lo >= 0 && hi <= 1) { lo = 0; hi = 1; }
  else {
    const mag = 10 ** Math.ceil(Math.log10(Math.max(Math.abs(lo), Math.abs(hi), 1e-9)));
    lo = lo < 0 ? -mag : 0;
    hi = hi > 0 ? mag : 0;
    if (hi === lo) hi = lo + 1;
  }
  const step = Number.isInteger(v) && hi - lo >= 10 ? 1 : (hi - lo) / 200;
  return { min: lo, max: hi, step };
}
