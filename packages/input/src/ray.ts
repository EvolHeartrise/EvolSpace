// Hand rays and pointer points.
//
// handRay follows the Quest system-pointer model: a ray cast from an estimated
// shoulder position through a stable point on the hand (between the index
// knuckle and the thumb's MCP joint, which barely move while pinching). Aiming
// with the whole arm is far steadier than using the wrist or finger direction,
// and the ray does not jump when the fingers close for a pinch.

import type { HandFrame, Quat, Vec3 } from '@evolspace/protocol';
import { add, distance, lerp, lookRotation, normalize, qRotate, scale, sub, yawOnly, FORWARD } from './math.ts';
import { INDEX_PROXIMAL, INDEX_TIP, THUMB_PROXIMAL, THUMB_TIP, jointPos } from './joints.ts';
import type { HeadPose } from './features.ts';

export interface Ray {
  origin: Vec3;
  /** Unit direction. */
  direction: Vec3;
}

export interface HandRayOptions {
  /** Shoulder offset from the head (eyes) in the head's yaw-only frame: x is the outward lateral distance. */
  shoulderOffset?: Vec3;
  /** 0 = index knuckle, 1 = thumb MCP joint; the ray passes through this blend. Default 0.5. */
  anchorBlend?: number;
}

/** Default shoulder offset from the eyes: 18 cm sideways, 22 cm down, 6 cm back. */
export const DEFAULT_SHOULDER_OFFSET: Readonly<Vec3> = [0.18, -0.22, 0.06];

/** Estimated shoulder position for a hand, from the head pose (yaw only, so looking up/down doesn't move it). */
export function shoulderPosition(hand: 'left' | 'right', head: HeadPose, offset: Readonly<Vec3> = DEFAULT_SHOULDER_OFFSET): Vec3 {
  const side = hand === 'right' ? 1 : -1;
  return add(head.position, qRotate(yawOnly(head.rotation), [offset[0] * side, offset[1], offset[2]]));
}

/** The point on the hand the ray passes through (stable during pinches). */
export function rayAnchor(frame: HandFrame, blend = 0.5): Vec3 {
  return lerp(jointPos(frame, INDEX_PROXIMAL), jointPos(frame, THUMB_PROXIMAL), blend);
}

/**
 * Quest-style pointing ray: origin at the hand anchor, direction from the
 * estimated shoulder through the anchor. Unsmoothed — see RaySmoother.
 */
export function handRay(frame: HandFrame, head: HeadPose, opts: HandRayOptions = {}): Ray {
  const anchor = rayAnchor(frame, opts.anchorBlend ?? 0.5);
  const shoulder = shoulderPosition(frame.hand, head, opts.shoulderOffset ?? DEFAULT_SHOULDER_OFFSET);
  const dir = sub(anchor, shoulder);
  return { origin: anchor, direction: normalize(dir, qRotate(head.rotation, FORWARD)) };
}

/** Midpoint between the thumb tip and the index tip. */
export function pinchPoint(frame: HandFrame): Vec3 {
  return scale(add(jointPos(frame, THUMB_TIP), jointPos(frame, INDEX_TIP)), 0.5);
}

/**
 * Where the hand "acts" for touch targeting: the pinch point while thumb and
 * index tips are within `pinchRange` meters, otherwise the index tip.
 */
export function contactPoint(frame: HandFrame, pinchRange = 0.045): Vec3 {
  const thumb = jointPos(frame, THUMB_TIP);
  const index = jointPos(frame, INDEX_TIP);
  return distance(thumb, index) <= pinchRange ? scale(add(thumb, index), 0.5) : index;
}

/** Orientation whose -Z looks along the ray (up ≈ world up). */
export function rayRotation(ray: Ray): Quat {
  return lookRotation(ray.direction);
}

// ---------------------------------------------------------------- smoothing

export interface OneEuroOptions {
  /** Cutoff (Hz) at rest; lower = smoother but laggier. */
  minCutoff?: number;
  /** Speed coefficient; higher = less lag during fast motion. */
  beta?: number;
  /** Cutoff (Hz) for the derivative estimate. */
  dCutoff?: number;
}

const alpha = (cutoffHz: number, dtS: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

/**
 * One-euro filter (Casiez et al. 2012) over a fixed-size numeric vector.
 * Speed-adaptive low-pass: heavy smoothing when still, little lag when moving.
 * Time is passed explicitly (milliseconds) so results are deterministic.
 */
export class OneEuroFilter {
  private x: number[] | null = null;
  private dx: number[] = [];
  private lastT = 0;
  readonly minCutoff: number;
  readonly beta: number;
  readonly dCutoff: number;

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 1.0;
    this.beta = opts.beta ?? 0.5;
    this.dCutoff = opts.dCutoff ?? 1.0;
  }

  reset(): void {
    this.x = null;
  }

  filter(value: readonly number[], tMs: number): number[] {
    // Time going backwards means a new clock base: start over.
    if (!this.x || value.length !== this.x.length || tMs < this.lastT) {
      this.x = value.slice();
      this.dx = value.map(() => 0);
      this.lastT = tMs;
      return this.x.slice();
    }
    // A repeated timestamp carries no timing information: keep the current
    // estimate instead of inventing a tiny dt (which would read as a huge
    // speed and defeat the smoothing).
    if (tMs === this.lastT) return this.x.slice();
    const dt = Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const ad = alpha(this.dCutoff, dt);
    let speed = 0;
    for (let i = 0; i < value.length; i++) {
      const d = (value[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      speed += this.dx[i] * this.dx[i];
    }
    const a = alpha(this.minCutoff + this.beta * Math.sqrt(speed), dt);
    for (let i = 0; i < value.length; i++) this.x[i] += a * (value[i] - this.x[i]);
    return this.x.slice();
  }
}

export interface RaySmootherOptions {
  origin?: OneEuroOptions;
  direction?: OneEuroOptions;
  /** If the input jumps by more than this (m), reset instead of smoothing (e.g. tracking re-acquired). */
  resetDistance?: number;
}

/** Stateful smoother for a hand ray (one per hand). */
export class RaySmoother {
  private origin: OneEuroFilter;
  private direction: OneEuroFilter;
  private last: Ray | null = null;
  /** Last raw (unsmoothed) origin, for jump detection. */
  private lastRaw: Vec3 | null = null;
  private readonly resetDistance: number;

  constructor(opts: RaySmootherOptions = {}) {
    this.origin = new OneEuroFilter({ minCutoff: 1.5, beta: 4, ...opts.origin });
    this.direction = new OneEuroFilter({ minCutoff: 0.8, beta: 3, ...opts.direction });
    this.resetDistance = opts.resetDistance ?? 0.3;
  }

  reset(): void {
    this.origin.reset();
    this.direction.reset();
    this.last = null;
    this.lastRaw = null;
  }

  update(ray: Ray, tMs: number): Ray {
    // Compare raw to raw: the smoothed origin lags during fast motion.
    if (this.lastRaw && distance(this.lastRaw, ray.origin) > this.resetDistance) this.reset();
    this.lastRaw = [ray.origin[0], ray.origin[1], ray.origin[2]];
    const o = this.origin.filter(ray.origin, tMs);
    const d = this.direction.filter(ray.direction, tMs);
    const out: Ray = { origin: [o[0], o[1], o[2]], direction: normalize([d[0], d[1], d[2]], ray.direction) };
    this.last = out;
    return out;
  }

  /** Last smoothed ray, if any. */
  current(): Ray | null {
    return this.last;
  }
}
