// Compact value formatting for debug panels (numbers, tensors, JSON).

import { isTensor } from '@evolspace/protocol';

export function fmtNum(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return n.toExponential(2);
  return String(Number(n.toFixed(digits)));
}

/** One-line summary of any channel/port value. */
export function fmtValue(v: unknown, max = 80): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v.length > max ? `${v.slice(0, max)}…` : v);
  if (isTensor(v)) return `${v.dtype}[${v.shape.join('×')}]`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${(v as unknown as { length?: number }).length ?? '?'})`;
  if (Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === 'number')) return `[${v.map((x) => fmtNum(x, 3)).join(', ')}]`;
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number, n = 2) => String(x).padStart(n, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Stable palette index for a string (widget ids → colors). */
export function hashIndex(s: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

export function prettyJson(v: unknown): string {
  try { return JSON.stringify(v, (_k, x) => (isTensor(x) ? `<${x.dtype}[${x.shape.join('×')}]>` : x), 2) ?? 'undefined'; } catch { return String(v); }
}
