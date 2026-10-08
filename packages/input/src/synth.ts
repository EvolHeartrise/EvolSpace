// Synthetic hands: anatomically plausible 25-joint HandFrames from a compact
// spec (wrist pose, per-finger curl, spread, pinch targets). Used by tests, the
// desktop simulator and the mirror's ghost hands. The construction is the
// exact inverse of computeFeatures' definitions, so the features computed from
// a synthetic hand match the requested curls/spread/pinches (see FEATURES.md).
//
// Joint orientation convention (WebXR Hand Input, "XRJointSpace"): for every
// joint, -Z points along the bone that starts at that joint, toward the
// fingertip (the tip joint reuses its incoming bone's direction), and -Y points
// out of the palm, perpendicular to the skin (so +Y is the back of the hand /
// nail side). X = Y × Z. Both hands follow the same rule (no mirroring of the
// axes), so the thumb lies on local -X for a right hand and +X for a left hand.
// With an identity wrist rotation the palm faces down (-Y) and the fingers
// point forward (-Z).

import type { Finger, HandFrame, Handedness, Quat, Vec3 } from '@evolspace/protocol';
import {
  RAD, add, addScaled, clamp, cross, distance, length, normalize, qFromAxisAngle, qFromBasis, qFromUnitVectors,
  qMul, qNormalize, qRotate, reject, scale, sub,
} from './math.ts';
import { FINGER_JOINT_MAX_DEG, THUMB_JOINT_MAX_DEG } from './features.ts';
import { FINGER_BASE, JOINT_COUNT, JOINT_STRIDE, LONG_FINGERS, type LongFinger } from './joints.ts';

export interface SynthHandSpec {
  hand: Handedness;
  /** Wrist joint position in space coordinates. Default [0.15, 1.2, -0.35] (mirrored x for left). */
  position?: Vec3;
  /** Wrist joint orientation (WebXR convention, see top of file). Default identity: palm down, fingers -Z. */
  rotation?: Quat;
  /** Per-finger curl 0..1 (same scale as the curl.* features). Default 0.05 (open, relaxed). */
  curl?: Partial<Record<Finger, number>>;
  /** Angle in degrees between adjacent long fingers (spread.* features). Default 8. */
  spread?: number;
  /** Radial abduction of the thumb metacarpal, degrees (0 = alongside the index, 90 = straight out sideways). Default 30. */
  thumbSpread?: number;
  /**
   * Finger(s) whose tip the thumb tip touches. The thumb is placed by IK so that
   * pinch.<finger> ≈ pinchGap; curl.thumb then follows from the IK and the
   * requested curl.thumb is ignored. Pinched fingers without an explicit curl
   * get a natural pinch curl.
   */
  pinch?: Exclude<Finger, 'thumb'> | Exclude<Finger, 'thumb'>[];
  /** Thumb-tip to finger-tip distance for pinches, meters. Default 0.01 (pads touching). */
  pinchGap?: number;
  /**
   * 'free' (default): thumb pose from thumbSpread + curl.thumb.
   * 'wrap': thumb rests across the curled index/middle fingers like in a real fist
   * (curl.thumb ignored). Ignored when `pinch` is set.
   */
  thumb?: 'free' | 'wrap';
  /** Uniform hand size factor (1 ≈ adult hand, palm length 9.5 cm). Default 1. */
  size?: number;
  /** Joint radius scale. Default = size. */
  radiusScale?: number;
}

// ---------------------------------------------------------------- right-hand model (hand-local, size 1)

interface FingerModel {
  /** Metacarpal joint (base of the metacarpal bone, near the wrist). */
  base: Vec3;
  /** Proximal joint = knuckle (MCP). */
  knuckle: Vec3;
  /** Proximal, intermediate, distal phalanx lengths. */
  bones: [number, number, number];
}

const FINGER_MODEL: Record<LongFinger, FingerModel> = {
  index: { base: [-0.012, 0.0, -0.022], knuckle: [-0.024, 0.0, -0.092], bones: [0.041, 0.024, 0.022] },
  middle: { base: [0.0, 0.0, -0.022], knuckle: [0.0, 0.0, -0.095], bones: [0.045, 0.028, 0.024] },
  ring: { base: [0.011, 0.0, -0.021], knuckle: [0.019, -0.002, -0.088], bones: [0.042, 0.027, 0.023] },
  pinky: { base: [0.02, -0.002, -0.02], knuckle: [0.036, -0.006, -0.076], bones: [0.033, 0.02, 0.02] },
};
const THUMB_CMC: Vec3 = [-0.03, -0.012, -0.028];
const THUMB_BONES: [number, number, number] = [0.044, 0.033, 0.026];
/** Thumb metacarpal direction when fully adducted (alongside the index metacarpal). */
const THUMB_DIR_ADDUCTED = normalize([-0.15, -0.25, -0.95]);
/** Direction the thumb abducts toward (radially out, slightly palmar). */
const THUMB_DIR_RADIAL = normalize(reject(normalize([-1, -0.15, -0.1]), THUMB_DIR_ADDUCTED));
/** Direction the thumb tip moves when the thumb flexes (toward the palm / pinky side). */
const THUMB_FLEX_REF = normalize([0.7, -0.7, 0]);
/** IP flexion per unit MCP flexion (keeps curl.thumb = (mcp+ip)/140 linear in one parameter). */
const THUMB_IP_RATIO = THUMB_JOINT_MAX_DEG.ip / THUMB_JOINT_MAX_DEG.mcp;
/** Default curl of a finger that the thumb pinches (when the spec doesn't say). */
const PINCH_CURL: Record<LongFinger, number> = { index: 0.42, middle: 0.48, ring: 0.55, pinky: 0.6 };

const JOINT_RADII = [
  0.02, // wrist
  0.019, 0.0125, 0.0105, 0.009, // thumb
  0.021, 0.0115, 0.0095, 0.0085, 0.0075, // index
  0.021, 0.0115, 0.0095, 0.0085, 0.0075, // middle
  0.02, 0.011, 0.009, 0.008, 0.007, // ring
  0.018, 0.0095, 0.008, 0.0075, 0.0065, // pinky
];

const Y_AXIS: Vec3 = [0, 1, 0];
const X_AXIS: Vec3 = [1, 0, 0];
const NEG_Z: Vec3 = [0, 0, -1];

/** Frame whose -Z is `dir` and whose +Y is as close as possible to `upRef`. */
function boneFrame(dir: Vec3, upRef: Vec3): Quat {
  const z = scale(normalize(dir), -1);
  let y = reject(upRef, z);
  if (length(y) < 1e-6) y = reject(X_AXIS, z);
  y = normalize(y);
  const x = cross(y, z);
  return qFromBasis(x, y, z);
}

/** Rotation about the bone frame's local X that flexes -Z toward -Y (palm side) by `deg`. */
const flex = (deg: number): Quat => qFromAxisAngle(X_AXIS, -deg * RAD);

interface Chain {
  positions: Vec3[];
  rotations: Quat[];
}

function buildFinger(finger: LongFinger, curl: number, yawDeg: number, s: number): Chain {
  const m = FINGER_MODEL[finger];
  const base = scale(m.base, s);
  const knuckle = scale(m.knuckle, s);
  const metaRot = boneFrame(sub(knuckle, base), Y_AXIS);
  // Abduction at the MCP so the proximal phalanx's in-palm heading is `yawDeg`
  // (positive = toward the thumb), regardless of the metacarpal's own fan angle.
  const metaDir = normalize(sub(knuckle, base));
  const fanDeg = Math.atan2(-metaDir[0], -metaDir[2]) / RAD;
  const abd = qFromAxisAngle(Y_AXIS, (yawDeg - fanDeg) * RAD);
  const c = clamp(curl, 0, 1);
  const proxRot = qMul(qMul(metaRot, abd), flex(c * FINGER_JOINT_MAX_DEG.mcp));
  const interRot = qMul(proxRot, flex(c * FINGER_JOINT_MAX_DEG.pip));
  const distRot = qMul(interRot, flex(c * FINGER_JOINT_MAX_DEG.dip));
  const [l1, l2, l3] = m.bones.map((b) => b * s);
  const inter = addScaled(knuckle, qRotate(proxRot, NEG_Z), l1);
  const dist = addScaled(inter, qRotate(interRot, NEG_Z), l2);
  const tip = addScaled(dist, qRotate(distRot, NEG_Z), l3);
  return {
    positions: [base, knuckle, inter, dist, tip],
    rotations: [metaRot, proxRot, interRot, distRot, distRot],
  };
}

/** Default (un-IK'd) thumb metacarpal frame for a given radial abduction. */
function thumbBaseFrame(spreadDeg: number): Quat {
  const a = clamp(spreadDeg, -20, 100) * RAD;
  const dir = normalize(add(scale(THUMB_DIR_ADDUCTED, Math.cos(a)), scale(THUMB_DIR_RADIAL, Math.sin(a))));
  // Thumb nail (+Y) faces away from the direction the thumb flexes toward.
  return boneFrame(dir, scale(THUMB_FLEX_REF, -1));
}

/** Thumb tip relative to the CMC joint, in the thumb metacarpal's local frame, for MCP flexion `mcpDeg`. */
function thumbTipLocal(mcpDeg: number, s: number): Vec3 {
  const [l1, l2, l3] = THUMB_BONES.map((b) => b * s);
  const a1 = mcpDeg * RAD;
  const a2 = mcpDeg * (1 + THUMB_IP_RATIO) * RAD;
  return [0, -(l2 * Math.sin(a1) + l3 * Math.sin(a2)), -(l1 + l2 * Math.cos(a1) + l3 * Math.cos(a2))];
}

function buildThumb(metaRot: Quat, mcpDeg: number, s: number): Chain {
  const cmc = scale(THUMB_CMC, s);
  const proxRot = qMul(metaRot, flex(mcpDeg));
  const distRot = qMul(proxRot, flex(mcpDeg * THUMB_IP_RATIO));
  const [l1, l2, l3] = THUMB_BONES.map((b) => b * s);
  const prox = addScaled(cmc, qRotate(metaRot, NEG_Z), l1);
  const dist = addScaled(prox, qRotate(proxRot, NEG_Z), l2);
  const tip = addScaled(dist, qRotate(distRot, NEG_Z), l3);
  return { positions: [cmc, prox, dist, tip], rotations: [metaRot, proxRot, distRot, distRot] };
}

/**
 * Place the thumb so its tip lands on `target` (hand-local): pick the MCP/IP
 * flexion that gives the right reach, then swing the whole thumb from the CMC
 * with the shortest rotation from its default orientation. Returns the residual
 * distance (0 when reachable).
 */
function solveThumb(target: Vec3, spreadDeg: number, s: number): { chain: Chain; residual: number } {
  const cmc = scale(THUMB_CMC, s);
  const want = sub(target, cmc);
  const d = length(want);
  const maxMcp = THUMB_JOINT_MAX_DEG.mcp;
  const reach = (mcp: number) => length(thumbTipLocal(mcp, s));
  let mcp: number;
  if (d >= reach(0)) mcp = 0;
  else if (d <= reach(maxMcp)) mcp = maxMcp;
  else {
    // reach() decreases monotonically on [0, maxMcp]: bisect.
    let lo = 0;
    let hi: number = maxMcp;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (reach(mid) > d) lo = mid; else hi = mid;
    }
    mcp = (lo + hi) / 2;
  }
  const base = thumbBaseFrame(spreadDeg);
  const tipDir = normalize(qRotate(base, thumbTipLocal(mcp, s)));
  const swing = qFromUnitVectors(tipDir, normalize(want));
  const chain = buildThumb(qNormalize(qMul(swing, base)), mcp, s);
  return { chain, residual: distance(chain.positions[3], target) };
}

const asList = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);

/** Generate a HandFrame from a spec. Pure and deterministic. */
export function synthHand(spec: SynthHandSpec): HandFrame {
  const s = spec.size ?? 1;
  const spread = spec.spread ?? 8;
  const thumbSpread = spec.thumbSpread ?? 30;
  const gap = spec.pinchGap ?? 0.01; // absolute meters (not scaled by size)
  const pinched = asList(spec.pinch);
  const userCurl = spec.curl ?? {};
  const curlOf = (f: LongFinger): number => userCurl[f] ?? (pinched.includes(f) ? PINCH_CURL[f] : 0.05);
  const yaw: Record<LongFinger, number> = { index: spread, middle: 0, ring: -spread, pinky: -2 * spread };

  const fingers = {} as Record<LongFinger, Chain>;
  const build = (f: LongFinger, c: number) => (fingers[f] = buildFinger(f, c, yaw[f], s));
  for (const f of LONG_FINGERS) build(f, curlOf(f));

  let thumb: Chain;
  if (pinched.length > 0) {
    const targetFor = (thumbFrom: Vec3): Vec3 => {
      const tips = pinched.map((f) => fingers[f].positions[4]);
      const c = scale(tips.reduce((acc, p) => add(acc, p), [0, 0, 0] as Vec3), 1 / tips.length);
      // Stop `gap` short of the finger tip(s), on the thumb's side.
      return addScaled(c, normalize(sub(thumbFrom, c)), gap);
    };
    const cmc = scale(THUMB_CMC, s);
    let solved = solveThumb(targetFor(cmc), thumbSpread, s);
    // If a pinched finger's curl was not given and the tip is out of the thumb's
    // reach, search for the nearest curl that makes the pinch reachable.
    if (solved.residual > 0.002) {
      const free = pinched.filter((f) => userCurl[f] === undefined);
      if (free.length > 0) {
        let best = { res: solved.residual, delta: 0 };
        for (let k = 1; k <= 20; k++) {
          for (const sign of [1, -1]) {
            const delta = sign * k * 0.025;
            for (const f of free) build(f, clamp(PINCH_CURL[f] + delta, 0.1, 0.95));
            const r = solveThumb(targetFor(cmc), thumbSpread, s).residual;
            if (r < best.res - 1e-6) best = { res: r, delta };
          }
          if (best.res <= 0.002) break;
        }
        for (const f of free) build(f, clamp(PINCH_CURL[f] + best.delta, 0.1, 0.95));
        solved = solveThumb(targetFor(cmc), thumbSpread, s);
      }
    }
    thumb = solved.chain;
  } else if (spec.thumb === 'wrap') {
    // Rest the thumb pad on the outside of the curled index/middle middle phalanges.
    const curled = (['index', 'middle'] as const).filter((f) => curlOf(f) >= 0.5);
    const use = curled.length > 0 ? curled : (['middle', 'ring'] as const);
    const pts = use.map((f) => mid(fingers[f].positions[2], fingers[f].positions[3]));
    const center = scale(pts.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / pts.length);
    const target = add(center, [0, -0.015 * s, 0]);
    thumb = solveThumb(target, thumbSpread, s).chain;
  } else {
    const tc = clamp(userCurl.thumb ?? 0.05, 0, 1);
    thumb = buildThumb(thumbBaseFrame(thumbSpread), tc * THUMB_JOINT_MAX_DEG.mcp, s);
  }

  // Assemble hand-local joints (right-handed model), mirror for the left hand,
  // then place in space with the wrist pose.
  const localPos: Vec3[] = new Array(JOINT_COUNT);
  const localRot: Quat[] = new Array(JOINT_COUNT);
  localPos[0] = [0, 0, 0];
  localRot[0] = [0, 0, 0, 1];
  for (let i = 0; i < 4; i++) {
    localPos[1 + i] = thumb.positions[i];
    localRot[1 + i] = thumb.rotations[i];
  }
  for (const f of LONG_FINGERS) {
    const b = FINGER_BASE[f];
    for (let i = 0; i < 5; i++) {
      localPos[b + i] = fingers[f].positions[i];
      localRot[b + i] = fingers[f].rotations[i];
    }
  }

  const left = spec.hand === 'left';
  const wristPos: Vec3 = spec.position ?? [left ? -0.15 : 0.15, 1.2, -0.35];
  const wristRot = qNormalize(spec.rotation ?? [0, 0, 0, 1]);
  const rs = spec.radiusScale ?? s;
  const joints = new Array<number>(JOINT_COUNT * JOINT_STRIDE);
  const radii = new Array<number>(JOINT_COUNT);
  for (let i = 0; i < JOINT_COUNT; i++) {
    let p = localPos[i];
    let q = localRot[i];
    if (left) {
      // Reflect across the YZ plane: positions x → -x; rotations R → M R M, i.e. (x, -y, -z, w).
      p = [-p[0], p[1], p[2]];
      q = [q[0], -q[1], -q[2], q[3]];
    }
    const wp = add(wristPos, qRotate(wristRot, p));
    const wq = qNormalize(qMul(wristRot, q));
    joints.splice(i * JOINT_STRIDE, JOINT_STRIDE, wp[0], wp[1], wp[2], wq[0], wq[1], wq[2], wq[3]);
    radii[i] = JOINT_RADII[i] * rs;
  }
  return { hand: spec.hand, joints, radii };
}

/**
 * Wrist rotation (WebXR convention) for a hand whose fingers point along
 * `fingers` and whose palm faces `palm` (both in space coordinates; `palm` is
 * orthogonalized against `fingers`). E.g. pointing forward palm-down:
 * wristRotation([0,0,-1], [0,-1,0]) = identity.
 */
export function wristRotation(fingers: Vec3, palm: Vec3): Quat {
  const z = scale(normalize(fingers), -1);
  let y = scale(reject(palm, z), -1); // +Y = back of the hand = -palm
  if (length(y) < 1e-6) y = reject([0, 1, 0], z);
  y = normalize(y);
  const x = cross(y, z);
  return qFromBasis(x, y, z);
}

/**
 * Finger configurations for the default poses (no wrist pose: combine with
 * `position`/`rotation`, e.g. `wristRotation`). Handy for the desktop simulator.
 */
export const HAND_SHAPES: Readonly<Record<string, Omit<SynthHandSpec, 'hand'>>> = {
  open: { curl: { thumb: 0.05, index: 0.05, middle: 0.05, ring: 0.05, pinky: 0.05 }, spread: 10, thumbSpread: 40 },
  relaxed: { curl: { thumb: 0.15, index: 0.15, middle: 0.22, ring: 0.28, pinky: 0.32 }, spread: 6, thumbSpread: 25 },
  fist: { curl: { index: 0.9, middle: 0.92, ring: 0.92, pinky: 0.9 }, thumb: 'wrap', thumbSpread: 10 },
  point: { curl: { index: 0.05, middle: 0.9, ring: 0.92, pinky: 0.9 }, thumb: 'wrap', thumbSpread: 10 },
  pinch: { pinch: 'index', curl: { middle: 0.2, ring: 0.28, pinky: 0.32 }, spread: 6 },
  'pinch-middle': { pinch: 'middle', curl: { index: 0.12, ring: 0.3, pinky: 0.35 }, spread: 6 },
  'thumbs-up': { curl: { thumb: 0.02, index: 0.9, middle: 0.92, ring: 0.92, pinky: 0.9 }, thumbSpread: 75 },
};

/** Convenience: unit check used by tests — the palm-out normal implied by a wrist rotation. */
export function palmNormalOf(rotation: Quat): Vec3 {
  return qRotate(rotation, [0, -1, 0]);
}
