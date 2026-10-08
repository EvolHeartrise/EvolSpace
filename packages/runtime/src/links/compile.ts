// Link transform expressions: a pure JS expression of `x`, compiled once with
// `new Function` and cached by source text. Compile and runtime errors are
// captured, never thrown into the dataflow.

export type TransformFn = (x: unknown) => unknown;

export interface CompiledTransform {
  fn: TransformFn | null;
  error: string | null;
}

const cache = new Map<string, CompiledTransform>();
const MAX_CACHE = 1024;

export function compileTransform(expr: string): CompiledTransform {
  const src = expr.trim();
  let c = cache.get(src);
  if (c) return c;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('x', `"use strict"; return (${src}\n);`) as TransformFn;
    c = { fn, error: null };
  } catch (err) {
    c = { fn: null, error: `transform "${src}" does not compile: ${(err as Error).message}` };
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(src, c);
  return c;
}
