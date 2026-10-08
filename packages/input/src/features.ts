// Hand features: named scalars computed from one HandFrame (+ head pose, +
// optionally the other hand). Poses (library/poses/*.json) are conjunctions of
// ranges over these. Exact definitions live in packages/input/FEATURES.md —
// keep that document in sync with this file.

import type { HandFeatures, HandFrame, Quat, Vec3 } from '@evolspace/protocol';
import {
  DEG, FORWARD, UP, add, angleDeg, clamp, cross, distance, dot, normalize, qRotate, reject, scale, sub,
} from './math.ts';
import {
  FINGER_BASE, INDEX_PROXIMAL, LONG_FINGERS, MIDDLE_PROXIMAL, PINKY_PROXIMAL, THUMB_METACARPAL, THUMB_PROXIMAL,
  THUMB_DISTAL, THUMB_TIP, WRIST, jointPos, tipIndex,
} from './joints.ts';

export interface HeadPose {
  position: Vec3;
  rotation: Quat;
}

/**
 * Anatomical flexion ranges (degrees) used to normalize curl. A finger whose
 * MCP+PIP+DIP flexion sums to FINGER_CURL_SPAN_DEG reads curl = 1.
 */
export const FINGER_JOINT_MAX_DEG = { mcp: 90, pip: 110, dip: 70 } as const;
export const FINGER_CURL_SPAN_DEG = FINGER_JOINT_MAX_DEG.mcp + FINGER_JOINT_MAX_DEG.pip + FINGER_JOINT_MAX_DEG.dip; // 270
export const THUMB_JOINT_MAX_DEG = { mcp: 60, ip: 80 } as const;
export const THUMB_CURL_SPAN_DEG = THUMB_JOINT_MAX_DEG.mcp + THUMB_JOINT_MAX_DEG.ip; // 140

export interface FeatureInfo {
  /** Natural range of the feature (derivePose clamps to it). */
  range: [number, number];
  /** Characteristic span; hysteresis margin = exitSlack × scale. */
  scale: number;
  unit: string;
  description: string;
}

/** Metadata for every feature computeFeatures emits (by exact name or `prefix.*`). */
export const FEATURE_INFO: Readonly<Record<string, FeatureInfo>> = {
  'curl.*': { range: [0, 1], scale: 1, unit: '0..1', description: 'Finger flexion: 0 = straight, 1 = fully curled.' },
  'pinch.*': { range: [0, 0.25], scale: 0.1, unit: 'm', description: 'Thumb-tip to finger-tip distance.' },
  'spread.thumb-index': { range: [0, 120], scale: 60, unit: 'deg', description: 'Angle between thumb and index directions.' },
  'spread.*': { range: [0, 60], scale: 30, unit: 'deg', description: 'Abduction angle between adjacent fingers, in the palm plane.' },
  'palm.up': { range: [-1, 1], scale: 2, unit: 'cos', description: 'Palm normal · world up.' },
  'palm.towardHead': { range: [-1, 1], scale: 2, unit: 'cos', description: 'Palm normal · direction wrist→head.' },
  'palm.forward': { range: [-1, 1], scale: 2, unit: 'cos', description: 'Palm normal · head forward.' },
  'point.forward': { range: [-1, 1], scale: 2, unit: 'cos', description: 'Index direction · head forward.' },
  'thumb.up': { range: [-1, 1], scale: 2, unit: 'cos', description: 'Thumb direction · world up.' },
  'thumb.out': { range: [0, 1.5], scale: 1, unit: 'palm lengths', description: 'Thumb-tip to index-knuckle distance / palm length.' },
  'wrist.height': { range: [-1.5, 0.5], scale: 1, unit: 'm', description: 'Wrist height relative to the head.' },
  'hands.distance': { range: [0, 2], scale: 1, unit: 'm', description: 'Wrist-to-wrist distance (only when both hands are tracked).' },
};

const DEFAULT_INFO: FeatureInfo = { range: [-Infinity, Infinity], scale: 1, unit: '', description: 'Unknown feature.' };

/** Metadata for a feature name (exact match first, then `prefix.*`). Unknown names get scale 1, unbounded range. */
export function featureInfo(name: string): FeatureInfo {
  const exact = FEATURE_INFO[name];
  if (exact) return exact;
  const dot = name.indexOf('.');
  if (dot > 0) {
    const wild = FEATURE_INFO[name.slice(0, dot) + '.*'];
    if (wild) return wild;
  }
  return DEFAULT_INFO;
}

/** All feature names computeFeatures can emit (hands.distance only with two hands). */
export const FEATURE_NAMES: readonly string[] = [
  'curl.thumb', 'curl.index', 'curl.middle', 'curl.ring', 'curl.pinky',
  'pinch.index', 'pinch.middle', 'pinch.ring', 'pinch.pinky',
  'spread.thumb-index', 'spread.index-middle', 'spread.middle-ring', 'spread.ring-pinky',
  'palm.up', 'palm.towardHead', 'palm.forward', 'point.forward',
  'thumb.up', 'thumb.out', 'wrist.height', 'hands.distance',
];

/**
 * Hand-local reference axes derived from joint positions only (robust across
 * runtimes whose joint orientations differ). `normal` points OUT of the palm.
 */
export interface PalmBasis {
  wrist: Vec3;
  /** Unit palm normal, pointing out of the palm (WebXR wrist -Y). */
  normal: Vec3;
  /** Unit wrist → middle knuckle. */
  forward: Vec3;
  /** cross(forward, normal): axis about which positive finger flexion rotates. */
  lateral: Vec3;
  /** |middle knuckle − wrist|, meters (hand-size reference). */
  palmLength: number;
}

export function palmBasis(frame: HandFrame): PalmBasis {
  const wrist = jointPos(frame, WRIST);
  const idx = jointPos(frame, INDEX_PROXIMAL);
  const mid = jointPos(frame, MIDDLE_PROXIMAL);
  const pinky = jointPos(frame, PINKY_PROXIMAL);
  // For a right hand, (index knuckle − wrist) × (pinky knuckle − wrist) points out of
  // the palm; the left hand is mirrored, so flip it.
  const sign = frame.hand === 'right' ? 1 : -1;
  const normal = scale(normalize(cross(sub(idx, wrist), sub(pinky, wrist)), [0, -1, 0]), sign);
  const toMid = sub(mid, wrist);
  const forward = normalize(reject(toMid, normal));
  const lateral = normalize(cross(forward, normal));
  return { wrist, normal, forward, lateral, palmLength: Math.max(1e-4, distance(mid, wrist)) };
}

/**
 * Signed flexion (degrees) from bone direction u to bone direction v about axis
 * `a`, ignoring any sideways (abduction) component. Positive = toward the palm.
 */
export function flexionDeg(u: Readonly<Vec3>, v: Readonly<Vec3>, a: Readonly<Vec3>): number {
  const up = reject(u, a);
  const vp = reject(v, a);
  return Math.atan2(dot(cross(up, vp), a), dot(up, vp)) * DEG;
}

export interface FingerAngles {
  mcp: number;
  pip: number;
  dip: number;
}

/** Signed flexion angles (degrees) of a long finger's three joints. */
export function fingerAngles(frame: HandFrame, finger: (typeof LONG_FINGERS)[number], basis = palmBasis(frame)): FingerAngles {
  const b = FINGER_BASE[finger];
  const meta = jointPos(frame, b);
  const prox = jointPos(frame, b + 1);
  const inter = jointPos(frame, b + 2);
  const dist = jointPos(frame, b + 3);
  const tip = jointPos(frame, b + 4);
  const m = normalize(sub(prox, meta));
  const p = normalize(sub(inter, prox));
  const i = normalize(sub(dist, inter));
  const d = normalize(sub(tip, dist));
  // Flexion axis: perpendicular to the metacarpal within the palm plane. Using the
  // metacarpal (which never curls) keeps the axis well defined even in a fist.
  let a = cross(m, basis.normal);
  if (dot(a, basis.lateral) < 0 || Math.hypot(a[0], a[1], a[2]) < 0.2) a = basis.lateral;
  a = normalize(a);
  return { mcp: flexionDeg(m, p, a), pip: flexionDeg(p, i, a), dip: flexionDeg(i, d, a) };
}

/** Unsigned flexion angles (degrees) of the thumb's MCP and IP joints. */
export function thumbAngles(frame: HandFrame): { mcp: number; ip: number } {
  const meta = jointPos(frame, THUMB_METACARPAL);
  const prox = jointPos(frame, THUMB_PROXIMAL);
  const dist = jointPos(frame, THUMB_DISTAL);
  const tip = jointPos(frame, THUMB_TIP);
  const m = sub(prox, meta);
  const p = sub(dist, prox);
  const d = sub(tip, dist);
  return { mcp: angleDeg(m, p), ip: angleDeg(p, d) };
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Compute all features for one hand. `other` (the opposite hand) adds
 * `hands.distance`. Values are rounded to 4 decimals (well below tracking noise)
 * so logs and recordings stay readable.
 */
export function computeFeatures(frame: HandFrame, head: HeadPose, other?: HandFrame): HandFeatures {
  const f: HandFeatures = {};
  const basis = palmBasis(frame);
  const { normal, wrist, palmLength } = basis;

  // --- curls
  const th = thumbAngles(frame);
  f['curl.thumb'] = r4(clamp((Math.max(0, th.mcp) + Math.max(0, th.ip)) / THUMB_CURL_SPAN_DEG, 0, 1));
  for (const finger of LONG_FINGERS) {
    const a = fingerAngles(frame, finger, basis);
    const sum = Math.max(0, a.mcp) + Math.max(0, a.pip) + Math.max(0, a.dip);
    f[`curl.${finger}`] = r4(clamp(sum / FINGER_CURL_SPAN_DEG, 0, 1));
  }

  // --- pinches
  const thumbTip = jointPos(frame, THUMB_TIP);
  for (const finger of LONG_FINGERS) {
    f[`pinch.${finger}`] = r4(distance(thumbTip, jointPos(frame, tipIndex(finger))));
  }

  // --- spreads: proximal-phalanx directions projected into the palm plane
  const proxDir = (finger: (typeof LONG_FINGERS)[number]): Vec3 => {
    const b = FINGER_BASE[finger];
    return sub(jointPos(frame, b + 2), jointPos(frame, b + 1));
  };
  const dirs = LONG_FINGERS.map((fi) => reject(proxDir(fi), normal));
  f['spread.index-middle'] = r4(angleDeg(dirs[0], dirs[1]));
  f['spread.middle-ring'] = r4(angleDeg(dirs[1], dirs[2]));
  f['spread.ring-pinky'] = r4(angleDeg(dirs[2], dirs[3]));
  const thumbProx = jointPos(frame, THUMB_PROXIMAL);
  const thumbDir = normalize(sub(thumbTip, thumbProx));
  f['spread.thumb-index'] = r4(angleDeg(thumbDir, proxDir('index')));

  // --- orientation relative to world / head
  const headFwd = qRotate(head.rotation, FORWARD);
  const toHead = normalize(sub(head.position, wrist));
  const indexProx = jointPos(frame, INDEX_PROXIMAL);
  const indexDir = normalize(sub(jointPos(frame, tipIndex('index')), indexProx));
  f['palm.up'] = r4(dot(normal, UP));
  f['palm.towardHead'] = r4(dot(normal, toHead));
  f['palm.forward'] = r4(dot(normal, headFwd));
  f['point.forward'] = r4(dot(indexDir, headFwd));
  f['thumb.up'] = r4(dot(thumbDir, UP));
  f['thumb.out'] = r4(distance(thumbTip, indexProx) / palmLength);
  f['wrist.height'] = r4(wrist[1] - head.position[1]);

  if (other) f['hands.distance'] = r4(distance(wrist, jointPos(other, WRIST)));
  return f;
}

/** Midpoint between the palm's wrist and middle knuckle (handy for UI anchoring). */
export function palmCenter(frame: HandFrame): Vec3 {
  return scale(add(jointPos(frame, WRIST), jointPos(frame, MIDDLE_PROXIMAL)), 0.5);
}
