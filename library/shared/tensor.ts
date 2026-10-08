// Tensor + array helpers for widgets.
//
// Data arrives on input ports / channels as either JSON (numbers, arrays,
// objects) or a TensorValue ({$tensor: true, dtype, shape, data}, row-major;
// f16 arrives as raw halves in a Uint16Array). These helpers normalize the
// common shapes widgets accept into Float32Arrays without copying when the
// input is already f32. Everything here is pure and allocation-conscious: pass
// an `out` buffer to reuse memory on hot paths.

import type { TensorValue } from '@evolspace/protocol';

export function isTensor(v: unknown): v is TensorValue {
  return typeof v === 'object' && v !== null && (v as { $tensor?: unknown }).$tensor === true;
}

export function numel(shape: readonly number[]): number {
  let n = 1;
  for (const d of shape) n *= d;
  return n;
}

/** Row-major strides for a shape. */
export function strides(shape: readonly number[]): number[] {
  const s = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= shape[i];
  }
  return s;
}

/** Flat offset of a multi-index (no bounds checks beyond returning -1 when out of range). */
export function offsetOf(shape: readonly number[], index: readonly number[]): number {
  let off = 0;
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    const k = index[i] ?? 0;
    if (k < 0 || k >= shape[i]) return -1;
    off += k * acc;
    acc *= shape[i];
  }
  return off;
}

/** Element of a tensor at a multi-index, as a JS number (f16 decoded). NaN if out of range. */
export function tensorAt(t: TensorValue, ...index: number[]): number {
  const off = offsetOf(t.shape, index);
  if (off < 0) return NaN;
  const raw = t.data[off];
  return t.dtype === 'f16' ? halfToFloat(raw) : raw;
}

/** Decode one IEEE-754 half (as a u16) to a float. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 5.960464477539063e-8; // 2^-24 (subnormal)
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * Math.pow(2, e - 15);
}

/**
 * Tensor data as Float32Array. f32 tensors return their own data (no copy)
 * unless `out` is given; other dtypes are converted (f16 decoded).
 */
export function toFloat32(t: TensorValue, out?: Float32Array): Float32Array {
  const n = t.data.length;
  if (t.dtype === 'f32' && !out) return t.data as Float32Array;
  const dst = out && out.length >= n ? out : new Float32Array(n);
  const src = t.data;
  if (t.dtype === 'f16') for (let i = 0; i < n; i++) dst[i] = halfToFloat(src[i]);
  else for (let i = 0; i < n; i++) dst[i] = src[i];
  return dst;
}

export interface Stats {
  /** Finite elements counted. */
  count: number;
  /** Non-finite elements (NaN/±Inf) skipped. */
  nonFinite: number;
  min: number;
  max: number;
  mean: number;
  std: number;
}

/** Summary statistics over the first `n` elements (default all), skipping non-finite values. */
export function stats(data: ArrayLike<number>, n = data.length): Stats {
  let count = 0;
  let bad = 0;
  let min = Infinity;
  let max = -Infinity;
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const x = data[i];
    if (!Number.isFinite(x)) { bad++; continue; }
    count++;
    if (x < min) min = x;
    if (x > max) max = x;
    // Welford: numerically stable single pass.
    const d = x - mean;
    mean += d / count;
    m2 += d * (x - mean);
  }
  if (!count) return { count: 0, nonFinite: bad, min: NaN, max: NaN, mean: NaN, std: NaN };
  return { count, nonFinite: bad, min, max, mean, std: Math.sqrt(m2 / count) };
}

/** Min/max over finite values (fast path of stats). Returns [NaN, NaN] when nothing is finite. */
export function extent(data: ArrayLike<number>, n = data.length, from = 0): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i < n; i++) {
    const x = data[i];
    if (x < min) min = x; // NaN comparisons are false → skipped
    if (x > max) max = x;
  }
  return min <= max && Number.isFinite(min) && Number.isFinite(max) ? [min, max] : [NaN, NaN];
}

/** Map data from [min, max] to [0, 1] into out (clamped; degenerate range → 0.5). */
export function normalize(data: ArrayLike<number>, min: number, max: number, out?: Float32Array): Float32Array {
  const n = data.length;
  const dst = out && out.length >= n ? out : new Float32Array(n);
  const d = max - min;
  for (let i = 0; i < n; i++) {
    const t = d > 0 ? (data[i] - min) / d : 0.5;
    dst[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return dst;
}

const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');
const isTypedArray = (v: unknown): v is ArrayLike<number> & ArrayBufferView =>
  ArrayBuffer.isView(v) && !(v instanceof DataView);

/** Coerce a scalar-ish value (number, boolean, numeric string, size-1 tensor/array) to a number; NaN otherwise. */
export function toScalar(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  if (isTensor(v)) return v.data.length ? (v.dtype === 'f16' ? halfToFloat(v.data[0]) : v.data[0]) : NaN;
  if (Array.isArray(v) && v.length === 1) return toScalar(v[0]);
  if (v && typeof v === 'object' && 'value' in v) return toScalar((v as { value: unknown }).value);
  return NaN;
}

/** Any 1-D-ish value (tensor of any rank, number[], typed array) → flat Float32Array; null if not numeric. */
export function asVector(v: unknown): Float32Array | null {
  if (isTensor(v)) return toFloat32(v);
  if (v instanceof Float32Array) return v;
  if (isTypedArray(v)) return Float32Array.from(v as ArrayLike<number>);
  if (isNumArray(v)) return Float32Array.from(v);
  if (Array.isArray(v) && v.every(isNumArray)) {
    // number[][] → flattened
    const n = (v as number[][]).reduce((a, r) => a + r.length, 0);
    const out = new Float32Array(n);
    let k = 0;
    for (const row of v as number[][]) for (const x of row) out[k++] = x;
    return out;
  }
  return null;
}

export interface Matrix {
  rows: number;
  cols: number;
  /** rows × cols, row-major. */
  data: Float32Array;
}

/**
 * A 2-D view of a value: tensor [R, C] (rank > 2 → the first [R, C] slice of
 * the last two dims; rank 1 → 1 × N), number[][] (ragged rows padded with NaN),
 * or number[] (1 × N). Null if not numeric.
 */
export function asMatrix(v: unknown): Matrix | null {
  if (isTensor(v)) {
    const s = v.shape;
    const data = toFloat32(v);
    if (s.length === 0) return { rows: 1, cols: 1, data };
    if (s.length === 1) return { rows: 1, cols: s[0], data };
    const rows = s[s.length - 2];
    const cols = s[s.length - 1];
    return { rows, cols, data: data.length === rows * cols ? data : data.subarray(0, rows * cols) };
  }
  if (Array.isArray(v) && v.length && v.every(isNumArray)) {
    const rows = v.length;
    const cols = Math.max(...(v as number[][]).map((r) => r.length));
    const data = new Float32Array(rows * cols).fill(NaN);
    (v as number[][]).forEach((r, i) => r.forEach((x, j) => (data[i * cols + j] = x)));
    return { rows, cols, data };
  }
  const vec = asVector(v);
  return vec ? { rows: 1, cols: vec.length, data: vec } : null;
}

/**
 * Point cloud: tensor [N, 3] / [N, 2] (z = 0) / flat [3N], or number[][] of
 * [x, y, z?] → {count, xyz: Float32Array(3N)}. Null if not convertible.
 */
export function asPoints(v: unknown): { count: number; xyz: Float32Array } | null {
  if (isTensor(v)) {
    const s = v.shape;
    const data = toFloat32(v);
    const dim = s.length >= 2 ? s[s.length - 1] : 3;
    if (dim === 3) return { count: Math.floor(data.length / 3), xyz: data.length % 3 ? data.subarray(0, data.length - (data.length % 3)) : data };
    if (dim === 2) {
      const n = Math.floor(data.length / 2);
      const xyz = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { xyz[i * 3] = data[i * 2]; xyz[i * 3 + 1] = data[i * 2 + 1]; }
      return { count: n, xyz };
    }
    return null;
  }
  if (Array.isArray(v) && v.every((p) => isNumArray(p) && (p.length === 2 || p.length === 3))) {
    const pts = v as number[][];
    const xyz = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => { xyz[i * 3] = p[0]; xyz[i * 3 + 1] = p[1]; xyz[i * 3 + 2] = p[2] ?? 0; });
    return { count: pts.length, xyz };
  }
  return null;
}

/**
 * Series for plots: number[] / tensor [N] → 1 series; number[][] / tensor
 * [S, N] → S series (rank > 2 tensors: leading dims flattened into series).
 */
export function asSeries(v: unknown): Float32Array[] | null {
  if (isTensor(v)) {
    const s = v.shape;
    const data = toFloat32(v);
    if (s.length <= 1) return [data];
    const n = s[s.length - 1];
    const count = n ? Math.floor(data.length / n) : 0;
    const out: Float32Array[] = [];
    for (let i = 0; i < count; i++) out.push(data.subarray(i * n, (i + 1) * n));
    return out;
  }
  if (isNumArray(v)) return [Float32Array.from(v)];
  if (isTypedArray(v)) return [Float32Array.from(v as ArrayLike<number>)];
  if (Array.isArray(v) && v.length && v.every(isNumArray)) return (v as number[][]).map((r) => Float32Array.from(r));
  return null;
}

/**
 * Labeled values for bar charts: {label, value}[] | Record<string, number> |
 * number[] | tensor (flattened). Labels are null when the input has none.
 */
export function asLabeled(v: unknown): { labels: string[] | null; values: Float32Array } | null {
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && 'value' in x)) {
    const items = v as Array<{ label?: unknown; name?: unknown; value: unknown }>;
    return {
      labels: items.map((x, i) => String(x.label ?? x.name ?? i)),
      values: Float32Array.from(items.map((x) => toScalar(x.value))),
    };
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && !isTensor(v) && !ArrayBuffer.isView(v)) {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'number');
    if (!entries.length) return null;
    return { labels: entries.map(([k]) => k), values: Float32Array.from(entries.map(([, x]) => x as number)) };
  }
  const vec = asVector(v);
  return vec ? { labels: null, values: vec } : null;
}

/** Short human description of a tensor: "f32[12, 3]". */
export function tensorSignature(t: TensorValue): string {
  return `${t.dtype}[${t.shape.join(', ')}]`;
}
