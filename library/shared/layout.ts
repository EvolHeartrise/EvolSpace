// Layout helpers: text size estimates, nice axis ticks, value snapping, simple stacking.
// Units are meters. Pure functions.

/** Average glyph advance in em (Inter ≈ 0.55, JetBrains Mono = 0.6). */
export const ADVANCE = { sans: 0.55, mono: 0.6 } as const;
export const LINE_HEIGHT = 1.25;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Estimated width of a single line of text (no wrapping). */
export function estimateTextWidth(text: string, size: number, font: 'sans' | 'mono' = 'sans'): number {
  return text.length * size * ADVANCE[font];
}

/**
 * Estimated block size of (possibly multi-line) text wrapped at maxWidth.
 * Used for layout before troika has measured the real glyphs (see text.ts).
 */
export function estimateTextBlock(
  text: string,
  size: number,
  maxWidth = Infinity,
  font: 'sans' | 'mono' = 'sans',
  lineHeight = LINE_HEIGHT,
): { width: number; height: number; lines: number } {
  const adv = size * ADVANCE[font];
  const perLine = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(1, Math.floor(maxWidth / adv)) : Infinity;
  let lines = 0;
  let widest = 0;
  for (const para of (text ?? '').split('\n')) {
    const n = para.length;
    lines += perLine === Infinity ? 1 : Math.max(1, Math.ceil(n / perLine));
    widest = Math.max(widest, Math.min(n, perLine) * adv);
  }
  lines = Math.max(1, lines);
  return { width: widest, height: lines * size * lineHeight, lines };
}

/** A "nice" number (1, 2, 5 × 10^k) near x; round=true picks the closest, else the ceiling. */
export function niceNum(x: number, round: boolean): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, e);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, e);
}

/**
 * Tick values covering [min, max] with ~maxTicks nice steps (values inside the
 * range only). Returns {ticks, step}. Degenerate ranges yield a single tick.
 */
export function niceTicks(min: number, max: number, maxTicks = 5): { ticks: number[]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [], step: 1 };
  if (min > max) [min, max] = [max, min];
  if (max - min < 1e-12) return { ticks: [min], step: 1 };
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, maxTicks - 1), true);
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9 && ticks.length < 50; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks, step };
}

/** Expand [min, max] to nice bounds (for autoscaling axes). Degenerate ranges get ±0.5 (or ±10%). */
export function niceRange(min: number, max: number, maxTicks = 5): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max - min < 1e-12) {
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.1 : 0.5;
    return [min - pad, max + pad];
  }
  const step = niceNum(niceNum(max - min, false) / Math.max(1, maxTicks - 1), true);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

/** Snap v to min + k·step (step ≤ 0 → no snapping), then clamp into [min, max]. */
export function snap(v: number, min: number, max: number, step: number): number {
  let x = clamp(v, Math.min(min, max), Math.max(min, max));
  if (step > 0) {
    x = min + Math.round((x - min) / step) * step;
    // Kill float noise: round to the step's decimal places.
    const decimals = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
    x = Number(x.toFixed(decimals));
    x = clamp(x, Math.min(min, max), Math.max(min, max));
  }
  return x;
}

/** Vertical stack: returns the y center of each item (top-down) given heights and a gap, starting at `top`. */
export function stackDown(heights: readonly number[], top: number, gap: number): number[] {
  const out: number[] = [];
  let y = top;
  for (const h of heights) {
    out.push(y - h / 2);
    y -= h + gap;
  }
  return out;
}
