// Compact, context-cheap renderings of EvolSpace data for tool outputs.
import type { TensorValue, Vec3, Quat } from '@evolspace/protocol';

/** Round to `digits` decimals and drop trailing zeros ("1.20" → "1.2", "-0" → "0"). */
export function num(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return String(x);
  const r = Number(x.toFixed(digits));
  return Object.is(r, -0) ? '0' : String(r);
}

export function vec(v: readonly number[] | undefined, digits = 2): string {
  if (!v) return '?';
  return `(${v.map((x) => num(x, digits)).join(', ')})`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${num(n / 1024, 1)}KB`;
  return `${num(n / (1024 * 1024), 1)}MB`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 1) return 'now';
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/** JSON with floats rounded to 4 decimals (no whitespace). */
export function compactJson(value: unknown, digits = 4): string {
  const out = JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(digits)) : v));
  return out ?? 'undefined';
}

/**
 * Shrink a JSON value for display: long arrays keep their head with a count,
 * long strings are cut, deep nesting is collapsed. Never mutates the input.
 */
export function elide(value: unknown, opts: { maxArray?: number; maxString?: number; maxDepth?: number } = {}, depth = 0): unknown {
  const maxArray = opts.maxArray ?? 8;
  const maxString = opts.maxString ?? 160;
  const maxDepth = opts.maxDepth ?? 4;
  if (typeof value === 'string') return value.length > maxString ? truncate(value, maxString) : value;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[…${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, maxArray).map((v) => elide(v, opts, depth + 1));
    if (value.length > maxArray) head.push(`…(+${value.length - maxArray})`);
    return head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = elide(v, opts, depth + 1);
  return out;
}

/** `{a:1, b:"x"}`-style one-liner for props (keys unquoted, values JSON). */
export function inlineProps(props: Record<string, unknown> | undefined, maxChars = 200): string {
  if (!props) return '';
  const parts = Object.entries(props).map(([k, v]) => `${k}:${compactJson(elide(v, { maxArray: 4, maxString: 60, maxDepth: 2 }))}`);
  if (!parts.length) return '';
  return truncate(`{${parts.join(', ')}}`, maxChars);
}

// ---------------------------------------------------------------- math

export function eulerDegToQuat(deg: readonly number[]): Quat {
  // three.js Euler order 'XYZ' (its default), angles in degrees.
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Accepts [x,y,z] Euler degrees or an [x,y,z,w] quaternion. */
export function toQuat(r: readonly number[]): Quat {
  if (r.length === 4) return [r[0]!, r[1]!, r[2]!, r[3]!];
  return eulerDegToQuat(r);
}

/** Rotate vector v by quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** Quaternion for a rotation of `yaw` radians about +Y. */
export function yawQuat(yaw: number): Quat {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

// ---------------------------------------------------------------- tensors

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export interface TensorStats {
  dtype: string;
  shape: number[];
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  nonFinite: number;
  preview: number[];
}

export function tensorStats(t: TensorValue, previewN = 12): TensorStats {
  const n = t.data.length;
  const at = t.dtype === 'f16' ? (i: number) => halfToFloat(t.data[i] as number) : (i: number) => t.data[i] as number;
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, finite = 0, nonFinite = 0;
  for (let i = 0; i < n; i++) {
    const v = at(i);
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    finite++;
  }
  const mean = finite ? sum / finite : NaN;
  const variance = finite ? Math.max(0, sumSq / finite - mean * mean) : NaN;
  const preview: number[] = [];
  for (let i = 0; i < Math.min(previewN, n); i++) preview.push(at(i));
  return { dtype: t.dtype, shape: t.shape, count: n, min: finite ? min : NaN, max: finite ? max : NaN, mean, std: Math.sqrt(variance), nonFinite, preview };
}

export function formatTensor(t: TensorValue, previewN = 12): string {
  const s = tensorStats(t, previewN);
  const lines = [
    `tensor ${s.dtype}[${s.shape.join(',')}] (${s.count} values)`,
    `min=${num(s.min, 4)} max=${num(s.max, 4)} mean=${num(s.mean, 4)} std=${num(s.std, 4)}` + (s.nonFinite ? ` nonFinite=${s.nonFinite}` : ''),
  ];
  if (s.preview.length) lines.push(`first ${s.preview.length}: [${s.preview.map((v) => num(v, 4)).join(', ')}${s.count > s.preview.length ? ', …' : ''}]`);
  return lines.join('\n');
}
