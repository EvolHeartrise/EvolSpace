// Interp data store for resid-flow: normalizes the channel values of the
// "Interp data contract" (ARCHITECTURE.md) into Float32 tensors, validates
// their shapes against P.resid.proj, and tracks what changed so the view only
// rebuilds what it must. Pure TS: no three.js, no DOM.
//
// Data may arrive in any order and shapes may change between samples (e.g. a
// new sample with a different token count). Every non-proj tensor is checked
// against proj's [L+1, T]; a mismatching tensor is kept but reported as
// 'shape' and ignored until a consistent set is present again.

export interface InterpToken {
  label: string;
  group?: string;
}

export interface InterpMeta {
  model?: string;
  /** Short display name (preferred over `model` for the header). */
  short_name?: string;
  checkpoint?: string;
  /** L+1 labels: "embed", "b0".."b{L-1}". */
  layers?: string[];
  /** T tokens. */
  tokens?: InterpToken[];
  d_model?: number;
  sample?: { index: number; total: number; label?: string };
  lens?: { kind: string; description?: string };
  /** How P.resid.proj was made; `normalized`: residuals were scaled to unit norm before projecting. */
  proj?: { normalized?: boolean };
}

export interface LensReadout {
  layer: number;
  token: number;
  title: string;
  /** `value` is NaN where the producer sent null / a non-number (shown as '—'). */
  items: Array<{ label: string; value: number }>;
}

/** A normalized row-major tensor. */
export interface F32Tensor {
  shape: number[];
  data: Float32Array;
}

/** Channel suffixes (after the prefix) this widget consumes. */
export const DATA_KEYS = ['meta', 'resid.proj', 'resid.norm', 'resid.delta', 'resid.mask', 'attn', 'lens.readout'] as const;
export type DataKey = (typeof DATA_KEYS)[number] | 'probe';

/** What a channel update invalidated. */
export interface Dirty {
  /** Node positions / trajectories / colors. */
  geometry: boolean;
  /** Delta ticks. */
  delta: boolean;
  /** Attention arcs. */
  attn: boolean;
  /** Readout panel. */
  readout: boolean;
  /** Header / labels / status. */
  labels: boolean;
}

export const cleanDirty = (): Dirty => ({ geometry: false, delta: false, attn: false, readout: false, labels: false });
export const allDirty = (): Dirty => ({ geometry: true, delta: true, attn: true, readout: true, labels: true });

export type ChannelStatus = 'ok' | 'missing' | 'shape' | 'invalid';

// ---------------------------------------------------------------- tensor helpers

function isTensorValue(v: unknown): v is { $tensor: true; dtype: string; shape: number[]; data: ArrayLike<number> } {
  return typeof v === 'object' && v !== null && (v as { $tensor?: unknown }).$tensor === true;
}

/** IEEE half → float. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Infer the shape of a (rectangular) nested JSON array. */
function nestedShape(v: unknown): number[] | null {
  const shape: number[] = [];
  let cur: unknown = v;
  while (Array.isArray(cur)) {
    shape.push(cur.length);
    if (cur.length === 0) break;
    cur = cur[0];
  }
  return shape.length ? shape : null;
}

/**
 * Normalize a channel value into a Float32 tensor. Accepts TensorValues of any
 * dtype (f32 is used without copying, f16 halves are decoded) and rectangular
 * nested JSON number arrays. Returns null for anything else.
 */
export function toF32(v: unknown): F32Tensor | null {
  if (isTensorValue(v)) {
    const shape = Array.isArray(v.shape) ? v.shape.map((d) => Math.max(0, Math.floor(Number(d)) || 0)) : [];
    const n = shape.reduce((a, b) => a * b, 1);
    const src = v.data;
    if (!src || src.length < n) return null;
    if (v.dtype === 'f32' && src instanceof Float32Array) return { shape, data: src.length === n ? src : src.subarray(0, n) };
    const out = new Float32Array(n);
    if (v.dtype === 'f16') for (let i = 0; i < n; i++) out[i] = halfToFloat(src[i]);
    else for (let i = 0; i < n; i++) out[i] = src[i];
    return { shape, data: out };
  }
  const shape = nestedShape(v);
  if (!shape) return null;
  const n = shape.reduce((a, b) => a * b, 1);
  const out = new Float32Array(n);
  let k = 0;
  const walk = (x: unknown, depth: number): boolean => {
    if (depth === shape.length) {
      out[k++] = typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : NaN;
      return true;
    }
    if (!Array.isArray(x) || x.length !== shape[depth]) return false;
    for (const y of x) if (!walk(y, depth + 1)) return false;
    return true;
  };
  return walk(v, 0) && k === n ? { shape, data: out } : null;
}

function sameShape(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asMeta(v: unknown): InterpMeta | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const out: InterpMeta = {};
  if (typeof m.model === 'string') out.model = m.model;
  if (typeof m.short_name === 'string' && m.short_name.trim()) out.short_name = m.short_name.trim();
  if (typeof m.checkpoint === 'string') out.checkpoint = m.checkpoint;
  if (Array.isArray(m.layers)) out.layers = m.layers.map((x) => String(x));
  if (Array.isArray(m.tokens)) {
    out.tokens = m.tokens.map((t) => {
      if (typeof t === 'string') return { label: t };
      const o = (t ?? {}) as Record<string, unknown>;
      const tok: InterpToken = { label: String(o.label ?? '') };
      if (o.group !== undefined && o.group !== null) tok.group = String(o.group);
      return tok;
    });
  }
  if (typeof m.d_model === 'number') out.d_model = m.d_model;
  if (m.sample && typeof m.sample === 'object') {
    const s = m.sample as Record<string, unknown>;
    out.sample = { index: Number(s.index) || 0, total: Number(s.total) || 0 };
    if (s.label !== undefined) out.sample.label = String(s.label);
  }
  if (m.lens && typeof m.lens === 'object') {
    const l = m.lens as Record<string, unknown>;
    out.lens = { kind: String(l.kind ?? '') };
    if (l.description !== undefined) out.lens.description = String(l.description);
  }
  if (m.proj && typeof m.proj === 'object' && !Array.isArray(m.proj)) {
    const pr = m.proj as Record<string, unknown>;
    out.proj = { normalized: pr.normalized === true };
  }
  return out;
}

function asReadout(v: unknown): LensReadout | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  // null / missing / non-numeric values stay as rows (NaN → '—'): the producer listed them on purpose.
  const items = Array.isArray(r.items)
    ? r.items
        .filter((it) => it !== null && typeof it === 'object')
        .map((it) => {
          const o = it as Record<string, unknown>;
          const v = typeof o.value === 'number' ? o.value : typeof o.value === 'string' && o.value.trim() !== '' ? Number(o.value) : NaN;
          return { label: String(o.label ?? ''), value: Number.isFinite(v) ? v : NaN };
        })
    : [];
  return {
    layer: Number.isFinite(Number(r.layer)) ? Number(r.layer) : -1,
    token: Number.isFinite(Number(r.token)) ? Number(r.token) : -1,
    title: String(r.title ?? ''),
    items,
  };
}

// ---------------------------------------------------------------- store

/**
 * Latest interp data. Raw (unvalidated) tensors are kept so that a later proj
 * with a matching shape makes them valid again without a re-publish.
 */
export class InterpData {
  meta: InterpMeta | null = null;
  readout: LensReadout | null = null;
  private raw: Partial<Record<DataKey, F32Tensor | null>> = {};
  private invalid = new Set<DataKey>();
  /** Bumped on every accepted update (debugging/tests). */
  revision = 0;

  /** Forget everything (prefix change). */
  clear(): void {
    this.meta = null;
    this.readout = null;
    this.raw = {};
    this.invalid.clear();
    this.revision++;
  }

  /**
   * Store a channel value under its contract key and report what it invalidated.
   * `undefined`/`null` clears the channel.
   */
  set(key: DataKey, value: unknown): Dirty {
    const d = cleanDirty();
    this.revision++;
    this.invalid.delete(key);
    if (key === 'meta') {
      this.meta = value == null ? null : asMeta(value);
      if (value != null && !this.meta) this.invalid.add(key);
      d.labels = true;
      d.geometry = true; // token groups → colors, filter
      d.readout = true;
      return d;
    }
    if (key === 'lens.readout') {
      this.readout = value == null ? null : asReadout(value);
      if (value != null && !this.readout) this.invalid.add(key);
      d.readout = true;
      return d;
    }
    const prevShape = this.raw[key]?.shape;
    const t = value == null ? null : toF32(value);
    if (value != null && !t) this.invalid.add(key);
    this.raw[key] = t;
    switch (key) {
      case 'resid.proj': {
        // A new T / L means every dependent tensor must be re-validated.
        const shapeChanged = !t || !prevShape || !sameShape(prevShape, t.shape);
        d.geometry = true;
        d.delta = true; // ticks sit on nodes
        d.attn = true;
        d.labels = true;
        d.readout = shapeChanged;
        break;
      }
      case 'resid.norm':
      case 'resid.mask':
      case 'probe':
        d.geometry = true;
        d.delta = true; // ticks are placed on nodes
        d.attn = true;
        d.labels = true;
        break;
      case 'resid.delta':
        d.delta = true;
        d.labels = true;
        break;
      case 'attn':
        d.attn = true;
        d.labels = true;
        break;
    }
    return d;
  }

  // ------------------------------------------------------------ validated accessors

  /** [L+1, T, C≥2] or null. */
  get proj(): F32Tensor | null {
    const p = this.raw['resid.proj'];
    if (!p || p.shape.length !== 3 || p.shape[0] < 1 || p.shape[1] < 1 || p.shape[2] < 2) return null;
    return p;
  }

  /** Number of residual layers (L+1), 0 without proj. */
  get L1(): number {
    return this.proj?.shape[0] ?? 0;
  }

  /** Number of tokens, 0 without proj. */
  get T(): number {
    return this.proj?.shape[1] ?? 0;
  }

  /** Number of heads in P.attn (0 if absent/invalid). */
  get heads(): number {
    return this.attn?.shape[1] ?? 0;
  }

  private checked(key: DataKey, expect: (L1: number, T: number, s: number[]) => boolean): F32Tensor | null {
    const t = this.raw[key];
    const p = this.proj;
    if (!t || !p) return null;
    return expect(p.shape[0], p.shape[1], t.shape) ? t : null;
  }

  get norm(): F32Tensor | null {
    return this.checked('resid.norm', (L1, T, s) => sameShape(s, [L1, T]));
  }

  get mask(): F32Tensor | null {
    return this.checked('resid.mask', (L1, T, s) => sameShape(s, [L1, T]));
  }

  get probe(): F32Tensor | null {
    return this.checked('probe', (L1, T, s) => sameShape(s, [L1, T]));
  }

  get delta(): F32Tensor | null {
    return this.checked('resid.delta', (L1, T, s) => L1 > 1 && sameShape(s, [L1 - 1, 2, T]));
  }

  get attn(): F32Tensor | null {
    return this.checked('attn', (L1, T, s) => L1 > 1 && s.length === 4 && s[0] === L1 - 1 && s[1] >= 1 && s[2] === T && s[3] === T);
  }

  /** Status of each consumed channel (for the waiting panel / status line). */
  status(key: DataKey): ChannelStatus {
    if (this.invalid.has(key)) return 'invalid';
    switch (key) {
      case 'meta':
        return this.meta ? 'ok' : 'missing';
      case 'lens.readout':
        return this.readout ? 'ok' : 'missing';
      case 'resid.proj':
        return this.raw[key] ? (this.proj ? 'ok' : 'shape') : 'missing';
      default: {
        if (!this.raw[key]) return 'missing';
        const v = key === 'resid.norm' ? this.norm
          : key === 'resid.mask' ? this.mask
          : key === 'resid.delta' ? this.delta
          : key === 'attn' ? this.attn
          : this.probe;
        // Without proj nothing can be validated yet; report it as present.
        return v || !this.proj ? 'ok' : 'shape';
      }
    }
  }

  /** Shape of the raw value on a channel (for status messages). */
  rawShape(key: DataKey): number[] | undefined {
    return this.raw[key]?.shape;
  }

  /** True if residual (l, t) exists: mask (if any) is set and the projection is finite. */
  exists(l: number, t: number): boolean {
    const p = this.proj;
    if (!p) return false;
    const T = p.shape[1];
    const C = p.shape[2];
    const m = this.mask;
    if (m && !(m.data[l * T + t] > 0.5)) return false;
    const o = (l * T + t) * C;
    return Number.isFinite(p.data[o]) && Number.isFinite(p.data[o + 1]);
  }

  /** Display label of layer l (meta.layers or the contract's default naming). */
  layerLabel(l: number): string {
    const ls = this.meta?.layers;
    if (ls && ls.length === this.L1 && ls[l] !== undefined) return ls[l];
    return l === 0 ? 'embed' : `b${l - 1}`;
  }

  /** Raw token label (meta.tokens or "#t"). */
  tokenLabel(t: number): string {
    const ts = this.meta?.tokens;
    if (ts && ts.length === this.T && ts[t]) return ts[t].label;
    return `#${t}`;
  }

  /** Token group, if meta matches the current T. */
  tokenGroup(t: number): string | undefined {
    const ts = this.meta?.tokens;
    return ts && ts.length === this.T ? ts[t]?.group : undefined;
  }

  /** Distinct groups in order of first appearance (stable palette assignment). */
  groups(): string[] {
    const out: string[] = [];
    const ts = this.meta?.tokens;
    if (!ts || ts.length !== this.T) return out;
    for (const t of ts) if (t.group !== undefined && !out.includes(t.group)) out.push(t.group);
    return out;
  }
}

/** Make a token label legible: visible leading/trailing spaces, escaped newlines, bounded length. */
export function displayToken(s: string, max = 16): string {
  let out = s.replace(/\r?\n/g, '⏎').replace(/\t/g, '⇥');
  const lead = out.length - out.trimStart().length;
  const trail = out.length - out.trimEnd().length;
  if (out.trim() === '') out = '·'.repeat(Math.max(1, out.length));
  else out = '·'.repeat(lead) + out.trim() + '·'.repeat(trail);
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

/**
 * Shorten `s` to at most `max` characters, cutting at a word boundary (space,
 * path separator, '·', '_', '-', '(') when one is reasonably close, with an ellipsis.
 */
export function fitText(s: string, max: number): string {
  const str = s.replace(/\s+/g, ' ').trim();
  if (max < 2) return str.slice(0, Math.max(0, max));
  if (str.length <= max) return str;
  const hard = str.slice(0, max - 1);
  let cut = -1;
  for (let i = hard.length; i >= Math.floor(max * 0.55); i--) {
    const c = str[i];
    if (c === ' ' || c === '/' || c === '\\' || c === '·' || c === '_' || c === '-' || c === '(' || c === ',') { cut = i; break; }
  }
  const head = (cut > 0 ? str.slice(0, cut) : hard).replace(/[\s·/\\_\-(,]+$/, '');
  return (head || hard) + '…';
}

/** Compact number formatting for readouts and status lines; non-finite (n/a) → '—'. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a < 1e-9) return '0';
  if (a >= 1000) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  if (a >= 0.001) return v.toFixed(3);
  return v.toExponential(1);
}
