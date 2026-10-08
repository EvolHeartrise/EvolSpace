// Pose → synthetic hand solver for the Hands workbench. A `SimShape` is the
// compact, slider-editable description of a simulated hand (per-finger curl,
// pinch finger, thumb, orientation relative to a placement frame); `synthShape`
// turns it into a HandFrame at a placement, and `solvePose` finds a shape whose
// features satisfy a PoseDef's conditions (seeded from the condition ranges'
// midpoints, searched over thumb variants + orientations, refined by
// coordinate descent, verified with computeFeatures + matchesPose).
// Pure (no DOM / three.js): unit-tested in node.

import type { Finger, HandFeatures, HandFrame, Handedness, PoseDef, Quat, Vec3 } from '@evolspace/protocol';
import {
  HAND_SHAPES, computeFeatures, contactPoint, featureInfo, math, matchesPose, poseAppliesTo, rayAnchor, synthHand, wristRotation,
  type SynthHandSpec,
} from '@evolspace/input';

export type LongFinger = 'index' | 'middle' | 'ring' | 'pinky';
export const SIM_FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const LONG: readonly LongFinger[] = ['index', 'middle', 'ring', 'pinky'];

/**
 * Hand orientation relative to the placement frame (−Z forward, +Y up, +X right):
 * `<fingers>-<palm>`; `in`/`out` = toward / away from the body midline (mirrored per hand).
 */
export const ORIENTS = {
  'fwd-down': { label: 'fingers fwd · palm down', fingers: 'fwd', palm: 'down' },
  'fwd-up': { label: 'fingers fwd · palm up', fingers: 'fwd', palm: 'up' },
  'fwd-in': { label: 'fingers fwd · palm in (thumb up)', fingers: 'fwd', palm: 'in' },
  'fwd-out': { label: 'fingers fwd · palm out', fingers: 'fwd', palm: 'out' },
  'up-fwd': { label: 'fingers up · palm fwd (stop)', fingers: 'up', palm: 'fwd' },
  'up-back': { label: 'fingers up · palm to face', fingers: 'up', palm: 'back' },
  'up-in': { label: 'fingers up · palm in', fingers: 'up', palm: 'in' },
  'in-down': { label: 'fingers in · palm down', fingers: 'in', palm: 'down' },
  'in-back': { label: 'fingers in · palm to body', fingers: 'in', palm: 'back' },
  'in-up': { label: 'fingers in · palm up', fingers: 'in', palm: 'up' },
} as const;
export type OrientId = keyof typeof ORIENTS;
export const ORIENT_IDS = Object.keys(ORIENTS) as OrientId[];

export interface SimShape {
  /** 0..1 per finger. The pinched finger's curl and (when pinching / wrapping) the thumb's are chosen by synthHand. */
  curl: Record<Finger, number>;
  pinch: LongFinger | null;
  /** Thumb-tip ↔ finger-tip distance while pinching (m). */
  pinchGap: number;
  /** Thumb abduction (deg, 0 = alongside the index, 90 = straight out). */
  thumbSpread: number;
  thumb: 'free' | 'wrap';
  /** Degrees between adjacent long fingers. */
  spread: number;
  orient: OrientId;
}

export const RELAXED_SHAPE: SimShape = {
  curl: { thumb: 0.15, index: 0.12, middle: 0.22, ring: 0.28, pinky: 0.32 },
  pinch: null, pinchGap: 0.01, thumbSpread: 25, thumb: 'free', spread: 6, orient: 'fwd-down',
};

export function cloneShape(s: SimShape): SimShape {
  return { ...s, curl: { ...s.curl } };
}

/** SynthHandSpec (no placement) for a shape. */
export function shapeSpec(s: SimShape, hand: Handedness): SynthHandSpec {
  const curl: Partial<Record<Finger, number>> = {};
  for (const f of SIM_FINGERS) {
    if (f === s.pinch) continue; // synthHand picks a reachable pinch curl
    if (f === 'thumb' && (s.pinch || s.thumb === 'wrap')) continue;
    curl[f] = s.curl[f];
  }
  return {
    hand, curl, spread: s.spread, thumbSpread: s.thumbSpread,
    ...(s.pinch ? { pinch: s.pinch, pinchGap: s.pinchGap } : {}),
    ...(!s.pinch && s.thumb === 'wrap' ? { thumb: 'wrap' as const } : {}),
  };
}

const AXIS: Record<string, Vec3> = { fwd: [0, 0, -1], back: [0, 0, 1], up: [0, 1, 0], down: [0, -1, 0] };
function dirOf(name: string, hand: Handedness): Vec3 {
  if (name === 'in') return hand === 'right' ? [-1, 0, 0] : [1, 0, 0];
  if (name === 'out') return hand === 'right' ? [1, 0, 0] : [-1, 0, 0];
  return AXIS[name];
}

/** Wrist rotation for an orientation, composed onto a placement frame `base`. */
export function orientRotation(orient: OrientId, hand: Handedness, base: Quat = [0, 0, 0, 1]): Quat {
  const o = ORIENTS[orient] ?? ORIENTS['fwd-down'];
  return math.qNormalize(math.qMul(base, wristRotation(dirOf(o.fingers, hand), dirOf(o.palm, hand))));
}

export type PlaceBy = 'wrist' | 'anchor' | 'contact';

export interface Placement {
  /** Placement frame (space coords): orientations are relative to it. */
  base: Quat;
  /** Where the `by` point of the hand goes (space coords). */
  at: Vec3;
  by: PlaceBy;
}

/** Copy of a frame translated by `d` (positions only). */
export function translateHand(f: HandFrame, d: Vec3): HandFrame {
  const joints = f.joints.slice();
  for (let o = 0; o < joints.length; o += 7) {
    joints[o] += d[0]; joints[o + 1] += d[1]; joints[o + 2] += d[2];
  }
  return { hand: f.hand, joints, radii: f.radii.slice() };
}

/** Synthesize a shape at a placement. */
export function synthShape(s: SimShape, hand: Handedness, place: Placement): HandFrame {
  const rotation = orientRotation(s.orient, hand, place.base);
  const f0 = synthHand({ ...shapeSpec(s, hand), position: [0, 0, 0], rotation });
  const p = place.by === 'wrist' ? [f0.joints[0], f0.joints[1], f0.joints[2]] as Vec3 : place.by === 'anchor' ? rayAnchor(f0) : contactPoint(f0);
  return translateHand(f0, [place.at[0] - p[0], place.at[1] - p[1], place.at[2] - p[2]]);
}

// ------------------------------------------------------------------ canonical context

export const CANON_HEAD: { position: Vec3; rotation: Quat } = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };
/** Default hand position relative to the head (camera placement), right hand; x mirrored for the left. */
export const CANON_OFFSET: Vec3 = [0.16, -0.24, -0.42];

export function canonPlacement(hand: Handedness, head = CANON_HEAD): Placement {
  const off: Vec3 = [hand === 'right' ? CANON_OFFSET[0] : -CANON_OFFSET[0], CANON_OFFSET[1], CANON_OFFSET[2]];
  return { base: math.yawOnly(head.rotation), at: math.add(head.position, math.qRotate(head.rotation, off)), by: 'anchor' };
}

// ------------------------------------------------------------------ scoring

export interface ShapeScore {
  /** Σ normalized condition violations (0 = all hold). */
  violation: number;
  /** Smallest normalized distance to a bound (> 0 inside). */
  slack: number;
}

export function scoreFeatures(pose: PoseDef, f: HandFeatures): ShapeScore {
  let violation = 0;
  let slack = Infinity;
  for (const c of pose.conditions) {
    const v = f[c.feature];
    const sc = featureInfo(c.feature).scale || 1;
    if (v === undefined || !Number.isFinite(v)) { violation += 10; slack = Math.min(slack, -10); continue; }
    if (c.min !== undefined) { const d = (v - c.min) / sc; if (d < 0) violation -= d; slack = Math.min(slack, d); }
    if (c.max !== undefined) { const d = (c.max - v) / sc; if (d < 0) violation -= d; slack = Math.min(slack, d); }
  }
  return { violation, slack: slack === Infinity ? 1 : slack };
}

/** Midpoint of a condition's range (one-sided ranges are closed with the feature's natural range). */
export function conditionTarget(c: { feature: string; min?: number; max?: number }): number {
  const r = featureInfo(c.feature).range;
  const lo = c.min ?? (Number.isFinite(r[0]) ? r[0] : (c.max ?? 0) - 1);
  const hi = c.max ?? (Number.isFinite(r[1]) ? r[1] : (c.min ?? 0) + 1);
  return (lo + hi) / 2;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Shape seeded from a pose's condition midpoints (relaxed defaults elsewhere). */
export function seedShape(pose: PoseDef): SimShape {
  const s = cloneShape(RELAXED_SHAPE);
  for (const c of pose.conditions) {
    const [kind, name] = c.feature.split('.');
    const t = conditionTarget(c);
    if (kind === 'curl' && name in s.curl) s.curl[name as Finger] = clamp01(t);
    else if (kind === 'pinch' && c.max !== undefined && c.max <= 0.05 && !s.pinch && LONG.includes(name as LongFinger)) {
      s.pinch = name as LongFinger;
      s.pinchGap = Math.min(0.02, Math.max(0.004, t));
    } else if (c.feature === 'thumb.out') {
      if (c.max !== undefined && c.max <= 0.85) s.thumb = 'wrap';
      if (c.min !== undefined && c.min >= 0.9) s.thumbSpread = 75;
    } else if (kind === 'spread' && name !== 'thumb-index') s.spread = Math.max(0, Math.min(30, t));
  }
  // A pinch-only pose: let the other fingers relax naturally.
  return s;
}

function shapeFromPreset(name: string): SimShape {
  const p = HAND_SHAPES[name];
  const s = cloneShape(RELAXED_SHAPE);
  for (const f of SIM_FINGERS) if (p.curl?.[f] !== undefined) s.curl[f] = p.curl[f]!;
  const pinch = Array.isArray(p.pinch) ? p.pinch[0] : p.pinch;
  s.pinch = (pinch as LongFinger | undefined) ?? null;
  s.thumbSpread = p.thumbSpread ?? 30;
  s.thumb = p.thumb ?? 'free';
  s.spread = p.spread ?? 8;
  return s;
}

export interface SolveOptions {
  head?: { position: Vec3; rotation: Quat };
  place?: Placement;
  /** Other poses: matching fewer of them is preferred (tie-breaker). */
  poses?: PoseDef[];
  /** Orientations to try (default all). */
  orients?: OrientId[];
}

export interface SolveResult {
  shape: SimShape;
  ok: boolean;
  violation: number;
  slack: number;
  features: HandFeatures;
  /** Other poses the solved hand also matches. */
  alsoMatches: string[];
}

/** Features of a shape in a context (head + placement). */
export function shapeFeatures(s: SimShape, hand: Handedness, head: { position: Vec3; rotation: Quat }, place: Placement): HandFeatures {
  return computeFeatures(synthShape(s, hand, place), head);
}

/**
 * Find a SimShape whose synthetic hand satisfies `pose` on `hand` (in the
 * canonical context unless `head`/`place` are given).
 */
export function solvePose(pose: PoseDef, hand: Handedness, opts: SolveOptions = {}): SolveResult {
  const head = opts.head ?? CANON_HEAD;
  const place = opts.place ?? canonPlacement(hand, head);
  const others = (opts.poses ?? []).filter((p) => p.id !== pose.id && poseAppliesTo(p, hand));
  const evalShape = (s: SimShape) => {
    const f = shapeFeatures(s, hand, head, place);
    const sc = scoreFeatures(pose, f);
    let extra = 0;
    for (const o of others) if (matchesPose(o, f)) extra++;
    // Lower is better: violations dominate, then margin inside the ranges, then exclusivity.
    const cost = sc.violation * 100 - Math.min(sc.slack, 0.12) + extra * 0.03;
    return { cost, f, sc };
  };

  // Shape candidates: the condition seed and its thumb variants, plus the stock shapes.
  const seed = seedShape(pose);
  const shapes: SimShape[] = [seed];
  const variant = (fn: (s: SimShape) => void) => { const s = cloneShape(seed); fn(s); shapes.push(s); };
  if (!seed.pinch) {
    variant((s) => { s.thumb = 'wrap'; s.thumbSpread = 10; });
    for (const ts of [10, 40, 75, 90]) variant((s) => { s.thumb = 'free'; s.thumbSpread = ts; });
  }
  for (const name of Object.keys(HAND_SHAPES)) shapes.push(shapeFromPreset(name));

  const orients = opts.orients ?? ORIENT_IDS;
  let best: { s: SimShape; cost: number } | null = null;
  for (const base of shapes) {
    for (const o of orients) {
      const s = cloneShape(base);
      s.orient = o;
      const { cost } = evalShape(s);
      if (!best || cost < best.cost) best = { s, cost };
    }
  }

  // Coordinate descent on the continuous parameters.
  let cur = best!;
  type Param = { get: (s: SimShape) => number; set: (s: SimShape, v: number) => void; lo: number; hi: number; step: number };
  const params: Param[] = [];
  for (const f of SIM_FINGERS) params.push({ get: (s) => s.curl[f], set: (s, v) => { s.curl[f] = v; }, lo: 0, hi: 1, step: 0.1 });
  params.push({ get: (s) => s.thumbSpread, set: (s, v) => { s.thumbSpread = v; }, lo: -10, hi: 95, step: 15 });
  params.push({ get: (s) => s.pinchGap, set: (s, v) => { s.pinchGap = v; }, lo: 0.003, hi: 0.03, step: 0.004 });
  params.push({ get: (s) => s.spread, set: (s, v) => { s.spread = v; }, lo: 0, hi: 25, step: 4 });
  for (const k of [1, 0.5, 0.25]) {
    let improved = true;
    for (let pass = 0; pass < 4 && improved; pass++) {
      improved = false;
      for (const p of params) {
        for (const sign of [1, -1]) {
          const s = cloneShape(cur.s);
          const v = Math.min(p.hi, Math.max(p.lo, p.get(s) + sign * p.step * k));
          if (v === p.get(s)) continue;
          p.set(s, v);
          const { cost } = evalShape(s);
          if (cost < cur.cost - 1e-6) { cur = { s, cost }; improved = true; }
        }
      }
    }
  }
  let shape = roundShape(cur.s);
  let fin = evalShape(shape);
  if (!matchesPose(pose, fin.f)) { shape = cur.s; fin = evalShape(shape); }
  const alsoMatches = others.filter((o) => matchesPose(o, fin.f)).map((o) => o.id);
  return { shape, ok: matchesPose(pose, fin.f), violation: fin.sc.violation, slack: fin.sc.slack, features: fin.f, alsoMatches };
}

function roundShape(s: SimShape): SimShape {
  const r = (v: number, k: number) => Math.round(v / k) * k;
  const out = cloneShape(s);
  for (const f of SIM_FINGERS) out.curl[f] = Number(r(s.curl[f], 0.005).toFixed(3));
  out.thumbSpread = Number(r(s.thumbSpread, 0.5).toFixed(1));
  out.pinchGap = Number(r(s.pinchGap, 0.0005).toFixed(4));
  out.spread = Number(r(s.spread, 0.5).toFixed(1));
  return out;
}
