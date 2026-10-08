// derivePose: turn a recording (feature samples of the user holding a pose)
// into an editable PoseDef.
//
// Strategy: a feature is a useful condition when the user held it steady
// (low std relative to the feature's natural scale) AND it says something about
// the pose (shape features always; contact pinches; clearly-oriented palm /
// thumb directions; unusual spreads). Each chosen feature becomes
// mean ± sigma·std, widened to a per-feature minimum (one recording session
// under-estimates day-to-day variation), clamped to the natural range, with
// bounds at the edge of the range dropped (so "fully curled" reads as
// `min` only), then rounded outward to human-friendly steps.

import type { FeatureCondition, HandFeatures, Handedness, PoseDef } from '@evolspace/protocol';
import { FEATURE_NAMES, featureInfo } from './features.ts';

export interface DerivePoseOptions {
  id: string;
  hand: Handedness | 'either';
  description?: string;
  /** Range half-width in standard deviations. Default 2.5. */
  sigma?: number;
  /** Max std / scale for a feature to count as "held steady". Default 0.12. */
  maxRelStd?: number;
  /** Consider palm.up / palm.towardHead / thumb.up when strongly oriented. Default true. */
  orientation?: boolean;
  /** Features to always turn into conditions (if present in the samples). */
  include?: string[];
  /** Features never to use. */
  exclude?: string[];
  /** Debounce for the derived pose. Default 80 ms. */
  enterMs?: number;
}

interface Policy {
  /** Minimum half-width of the derived range. */
  minHalf: number;
  /** Rounding step (bounds round outward). */
  step: number;
}

function policy(feature: string): Policy {
  if (feature.startsWith('curl.')) return { minHalf: 0.15, step: 0.05 };
  if (feature.startsWith('pinch.')) return { minHalf: 0.012, step: 0.005 };
  if (feature.startsWith('spread.')) return { minHalf: 5, step: 1 };
  if (feature === 'thumb.out') return { minHalf: 0.15, step: 0.05 };
  if (feature === 'hands.distance' || feature === 'wrist.height') return { minHalf: 0.08, step: 0.01 };
  return { minHalf: 0.35, step: 0.05 }; // direction cosines
}

const ORIENTATION = new Set(['palm.up', 'palm.towardHead', 'thumb.up']);
const NEVER_BY_DEFAULT = new Set(['palm.forward', 'point.forward', 'wrist.height', 'hands.distance', 'spread.thumb-index']);
const SPREAD_FINGERS: Record<string, [string, string]> = {
  'spread.index-middle': ['index', 'middle'],
  'spread.middle-ring': ['middle', 'ring'],
  'spread.ring-pinky': ['ring', 'pinky'],
};

export interface FeatureStats {
  mean: number;
  std: number;
}

/** Per-feature mean / population std over the samples (features missing in >10% of samples are skipped). */
export function featureStats(samples: HandFeatures[]): Record<string, FeatureStats> {
  const sums = new Map<string, { n: number; s: number; s2: number }>();
  for (const sample of samples) {
    for (const [k, v] of Object.entries(sample)) {
      if (!Number.isFinite(v)) continue;
      const a = sums.get(k) ?? { n: 0, s: 0, s2: 0 };
      a.n++;
      a.s += v;
      a.s2 += v * v;
      sums.set(k, a);
    }
  }
  const out: Record<string, FeatureStats> = {};
  for (const [k, a] of sums) {
    if (a.n < Math.max(1, samples.length * 0.9)) continue;
    const mean = a.s / a.n;
    const std = Math.sqrt(Math.max(0, a.s2 / a.n - mean * mean));
    out[k] = { mean, std };
  }
  return out;
}

const roundTo = (x: number, step: number, mode: 'floor' | 'ceil' | 'round'): number => {
  const q = x / step;
  // Tolerate float noise so 0.7999999 doesn't floor to 0.75.
  const r = mode === 'floor' ? Math.floor(q + 1e-6) : mode === 'ceil' ? Math.ceil(q - 1e-6) : Math.round(q);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number((r * step).toFixed(decimals));
};

/** Build one condition from stats, or null if both bounds fall off the natural range. */
function rangeCondition(feature: string, st: FeatureStats, sigma: number): FeatureCondition | null {
  const info = featureInfo(feature);
  const { minHalf, step } = policy(feature);
  const half = Math.max(sigma * st.std, minHalf);
  const [rMin, rMax] = info.range;
  // Bounds this close to the end of the natural range add nothing but brittleness: drop them.
  const edge = Number.isFinite(rMax - rMin) ? 0.08 * (rMax - rMin) : 0;
  let lo: number | undefined = st.mean - half;
  let hi: number | undefined = st.mean + half;
  if (feature.startsWith('pinch.')) {
    lo = undefined; // a contact pinch is "at most this far apart"
    hi = Math.max(hi, 0.02);
  }
  if (lo !== undefined && lo <= rMin + edge) lo = undefined;
  if (hi !== undefined && hi >= rMax - edge) hi = undefined;
  if (lo === undefined && hi === undefined) return null;
  const c: FeatureCondition = { feature };
  if (lo !== undefined) c.min = roundTo(lo, step, 'floor');
  if (hi !== undefined) c.max = roundTo(hi, step, 'ceil');
  return c;
}

/** Order conditions for readability: canonical feature order (curls thumb→pinky, pinches, …), unknown last. */
const rank = (f: string) => {
  const i = FEATURE_NAMES.indexOf(f);
  return i < 0 ? FEATURE_NAMES.length : i;
};

export function derivePose(samples: HandFeatures[], opts: DerivePoseOptions): PoseDef {
  if (samples.length === 0) throw new Error('derivePose: no samples');
  const sigma = opts.sigma ?? 2.5;
  const maxRelStd = opts.maxRelStd ?? 0.12;
  const useOrientation = opts.orientation ?? true;
  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const stats = featureStats(samples);
  const mean = (f: string) => stats[f]?.mean;

  const steady = (f: string) => stats[f].std / featureInfo(f).scale <= maxRelStd;
  const wanted = (f: string): boolean => {
    if (exclude.has(f)) return false;
    if (include.has(f)) return true;
    if (NEVER_BY_DEFAULT.has(f) || !steady(f)) return false;
    const m = stats[f].mean;
    if (f.startsWith('curl.') || f === 'thumb.out') return true;
    if (f.startsWith('pinch.')) return m <= 0.04; // thumb touching this finger
    if (f in SPREAD_FINGERS) {
      // Spread is only meaningful between extended fingers, and only notable when unusual.
      const [a, b] = SPREAD_FINGERS[f];
      return (mean(`curl.${a}`) ?? 1) <= 0.35 && (mean(`curl.${b}`) ?? 1) <= 0.35 && (m < 4 || m > 20);
    }
    if (ORIENTATION.has(f)) {
      if (!useOrientation || Math.abs(m) < 0.75) return false;
      // The thumb's direction only means something when the thumb is extended.
      if (f === 'thumb.up') return (mean('curl.thumb') ?? 1) <= 0.4 && (mean('thumb.out') ?? 0) >= 0.8;
      return true;
    }
    return false;
  };

  let conditions: FeatureCondition[] = [];
  for (const f of Object.keys(stats)) {
    if (!wanted(f)) continue;
    const c = rangeCondition(f, stats[f], sigma);
    if (c) conditions.push(c);
  }
  if (conditions.length === 0) {
    // Nothing was steady: fall back to the finger curls, however loose.
    for (const f of ['curl.index', 'curl.middle', 'curl.ring', 'curl.pinky']) {
      if (!stats[f] || exclude.has(f)) continue;
      const c = rangeCondition(f, stats[f], sigma);
      if (c) conditions.push(c);
    }
  }
  conditions = conditions.sort((a, b) => rank(a.feature) - rank(b.feature) || a.feature.localeCompare(b.feature));

  const roundedStats: Record<string, FeatureStats> = {};
  for (const f of Object.keys(stats).sort()) {
    roundedStats[f] = { mean: Number(stats[f].mean.toFixed(4)), std: Number(stats[f].std.toFixed(4)) };
  }

  return {
    id: opts.id,
    description: opts.description ?? `Recorded pose '${opts.id}' (${samples.length} samples).`,
    hand: opts.hand,
    conditions,
    enterMs: opts.enterMs ?? 80,
    exitSlack: 0.15,
    source: 'recorded',
    stats: roundedStats,
  };
}
