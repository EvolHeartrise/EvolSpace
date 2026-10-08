// Structural equality for JSON-ish values (props, transforms, link refs).
// Typed arrays compare element-wise. Not intended for cyclic structures.

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    // NaN === NaN for our purposes (a NaN prop should not trigger endless updates).
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false;
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  if (Array.isArray(b) || ArrayBuffer.isView(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Element-wise numeric comparison with tolerance (transform echo matching). */
export function nearlyEqualArrays(a: readonly number[], b: readonly number[], eps = 1e-6): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

/** Deep clone for JSON-ish values (structuredClone is not available everywhere we run). */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v; // tensors/typed arrays are shared, never mutated by us
  if (Array.isArray(v)) return v.map(cloneJson) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) out[k] = cloneJson((v as Record<string, unknown>)[k]);
  return out as T;
}
