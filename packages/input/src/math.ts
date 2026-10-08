// Small, dependency-free vector/quaternion helpers on protocol tuples.
// Conventions: Vec3 = [x, y, z]; Quat = [x, y, z, w] (unit, Hamilton product,
// same as three.js). Right-handed, Y-up space; "forward" is -Z.
//
// These allocate fresh tuples. The input pipeline runs a handful of these per
// hand per frame, which is negligible next to rendering; clarity wins here.

import type { Vec3, Quat, Transform } from '@evolspace/protocol';

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;

export const UP: Readonly<Vec3> = [0, 1, 0];
export const FORWARD: Readonly<Vec3> = [0, 0, -1];

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Unit vector in the direction of `a`; `fallback` (default -Z) when `a` is ~zero. */
export function normalize(a: Readonly<Vec3>, fallback: Readonly<Vec3> = FORWARD): Vec3 {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [fallback[0], fallback[1], fallback[2]];
}

/** Component of `a` perpendicular to unit vector `n`. */
export const reject = (a: Readonly<Vec3>, n: Readonly<Vec3>): Vec3 => addScaled(a, n, -dot(a, n));

/** Unsigned angle between two vectors, degrees (robust near 0 and 180). */
export function angleDeg(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.atan2(length(cross(a, b)), dot(a, b)) * DEG;
}

// ---------------------------------------------------------------- quaternions

export const qIdentity = (): Quat => [0, 0, 0, 1];

export function qMul(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qConj = (q: Readonly<Quat>): Quat => [-q[0], -q[1], -q[2], q[3]];

export function qNormalize(q: Readonly<Quat>): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

/** Rotate vector v by unit quaternion q. */
export function qRotate(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

export function qFromAxisAngle(axis: Readonly<Vec3>, rad: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(rad / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)];
}

/** Shortest-arc rotation taking unit vector `a` onto unit vector `b`. */
export function qFromUnitVectors(a: Readonly<Vec3>, b: Readonly<Vec3>): Quat {
  const d = dot(a, b);
  if (d < -0.999999) {
    // Opposite: rotate 180° about any axis perpendicular to a.
    let axis = cross([1, 0, 0], a);
    if (length(axis) < 1e-6) axis = cross([0, 1, 0], a);
    return qFromAxisAngle(axis, Math.PI);
  }
  const c = cross(a, b);
  return qNormalize([c[0], c[1], c[2], 1 + d]);
}

/** Quaternion from an orthonormal right-handed basis given as the rotated X, Y, Z axes. */
export function qFromBasis(x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): Quat {
  // Rotation matrix columns are x, y, z.
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return qNormalize(q);
}

/**
 * Rotation whose local -Z points along `forward` and whose local +Y is as close
 * as possible to `up` (three.js/WebXR "look" convention).
 */
export function lookRotation(forward: Readonly<Vec3>, up: Readonly<Vec3> = UP): Quat {
  const z = scale(normalize(forward), -1);
  let x = cross(up, z);
  if (length(x) < 1e-6) x = cross(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1], z);
  x = normalize(x);
  const y = cross(z, x);
  return qFromBasis(x, y, z);
}

/** Rotation about world +Y only, keeping the heading of `q`'s forward (-Z) axis. */
export function yawOnly(q: Readonly<Quat>): Quat {
  const f = qRotate(q, FORWARD);
  let h: Vec3 = [f[0], 0, f[2]];
  if (length(h) < 0.1) {
    // Looking (nearly) straight up/down: the head's up vector tells the heading.
    const u = qRotate(q, UP);
    h = f[1] > 0 ? [-u[0], 0, -u[2]] : [u[0], 0, u[2]];
  }
  const yaw = Math.atan2(-h[0], -h[2]);
  return qFromAxisAngle(UP, yaw);
}

export function qSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    return qNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

// ---------------------------------------------------------------- rigid poses

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/** Express `t` relative to the rigid frame `frame` (i.e. frame⁻¹ ∘ t). Scale is carried through. */
export function relativeTo(frame: Pose, t: Transform): Transform {
  const inv = qConj(frame.rotation);
  return {
    position: qRotate(inv, sub(t.position, frame.position)),
    rotation: qNormalize(qMul(inv, t.rotation)),
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  };
}

/** Inverse of relativeTo: place a frame-relative transform back into the parent space. */
export function applyFrame(frame: Pose, local: Transform): Transform {
  return {
    position: add(frame.position, qRotate(frame.rotation, local.position)),
    rotation: qNormalize(qMul(frame.rotation, local.rotation)),
    scale: [local.scale[0], local.scale[1], local.scale[2]],
  };
}

export const cloneTransform = (t: Transform): Transform => ({
  position: [t.position[0], t.position[1], t.position[2]],
  rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
  scale: [t.scale[0], t.scale[1], t.scale[2]],
});
