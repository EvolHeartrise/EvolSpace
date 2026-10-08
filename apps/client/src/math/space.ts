// Space-origin math. Pure, allocation-conscious, no DOM / three.js dependency
// so it is unit-testable in Node and safe to call every frame.
//
// Frames involved:
//   world  = the XR reference space (local-floor). three.js renders in this frame.
//   space  = the shared EvolSpace frame (protocol "space coordinates"). Its pose in
//            world is the *space origin* (a persistent anchor in AR / VR, or the
//            local-floor identity as a fallback). runtime.root is placed at it.
//
//   p_world = origin * p_space          p_space = origin⁻¹ * p_world
//
// Quaternions are [x, y, z, w] like the protocol.

import type { Vec3, Quat, HandFrame } from '@evolspace/protocol';

/** A rigid transform (no scale). */
export interface Pose {
  position: Vec3;
  rotation: Quat;
}

export const IDENTITY_POSE: Readonly<Pose> = Object.freeze({
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0, 1] as Quat,
});

export function clonePose(p: Pose): Pose {
  return { position: [p.position[0], p.position[1], p.position[2]], rotation: [p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]] };
}

// ------------------------------------------------------------------ quaternions

/** out = a * b (apply b first, then a). `out` may alias a or b. */
export function quatMultiply(a: ArrayLike<number>, b: ArrayLike<number>, out: number[] | Float32Array, o = 0): void {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = q · v (rotate vector v by unit quaternion q). `out` may alias v. */
export function quatRotate(q: ArrayLike<number>, v: ArrayLike<number>, out: number[] | Float32Array, o = 0): void {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w * t + cross(q.xyz, t)
  out[o] = vx + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

export function quatNormalize(q: number[] | Float32Array, o = 0): void {
  const l = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]) || 1;
  q[o] /= l; q[o + 1] /= l; q[o + 2] /= l; q[o + 3] /= l;
}

/** Quaternion for a rotation of `angle` radians about +Y. */
export function quatFromYaw(angle: number): Quat {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/**
 * Rotation part of a column-major 4×4 matrix (WebXR / three.js layout, as
 * written by XRFrame.fillPoses) → unit quaternion into out[o..o+3].
 * Assumes the upper 3×3 is orthonormal (rigid transforms).
 */
export function quatFromMatrix(m: ArrayLike<number>, mo: number, out: number[] | Float32Array, o = 0): void {
  const m11 = m[mo], m12 = m[mo + 4], m13 = m[mo + 8];
  const m21 = m[mo + 1], m22 = m[mo + 5], m23 = m[mo + 9];
  const m31 = m[mo + 2], m32 = m[mo + 6], m33 = m[mo + 10];
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

// ------------------------------------------------------------------ rigid transforms

/** Inverse of a rigid transform: (R, t)⁻¹ = (R⁻¹, -R⁻¹ t). */
export function invertPose(p: Pose, out: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] }): Pose {
  const [x, y, z, w] = p.rotation;
  out.rotation[0] = -x; out.rotation[1] = -y; out.rotation[2] = -z; out.rotation[3] = w;
  quatRotate(out.rotation, p.position, out.position);
  out.position[0] = -out.position[0]; out.position[1] = -out.position[1]; out.position[2] = -out.position[2];
  return out;
}

/** out = a ∘ b (b expressed in a's frame → world). `out` may alias b but not a. */
export function composePose(a: Pose, b: Pose, out: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] }): Pose {
  quatRotate(a.rotation, b.position, out.position); // reads b fully before writing → aliasing-safe
  out.position[0] += a.position[0]; out.position[1] += a.position[1]; out.position[2] += a.position[2];
  quatMultiply(a.rotation, b.rotation, out.rotation);
  return out;
}

/** Transform a point by a rigid transform: out = R p + t. */
export function transformPoint(t: Pose, p: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  quatRotate(t.rotation, p, out);
  out[0] += t.position[0]; out[1] += t.position[1]; out[2] += t.position[2];
  return out;
}

/** Rotate a direction by a rigid transform (no translation). */
export function transformDirection(t: Pose, d: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  quatRotate(t.rotation, d, out);
  return out;
}

/** world pose → space pose given the space origin (pose of space in world). */
export function worldToSpace(origin: Pose, world: Pose, out?: Pose): Pose {
  return composePose(invertPose(origin), world, out);
}

/** space pose → world pose given the space origin. */
export function spaceToWorld(origin: Pose, space: Pose, out?: Pose): Pose {
  return composePose(origin, space, out);
}

// ------------------------------------------------------------------ hand joints

/** Floats per joint in HandFrame.joints: px py pz qx qy qz qw. */
export const JOINT_STRIDE = 7;
export const JOINT_COUNT = 25;

/**
 * Converts 25 column-major joint matrices (XRFrame.fillPoses output, 16 floats
 * each) into the HandFrame joint layout, transformed by `toSpace` (normally the
 * inverse space origin). Writes into `out` (length ≥ 175). No allocation.
 */
export function matricesToJoints(matrices: ArrayLike<number>, toSpace: Pose, out: number[] | Float32Array): void {
  const tp = toSpace.position, tq = toSpace.rotation;
  const tmp = scratch4;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const m = j * 16, o = j * JOINT_STRIDE;
    // position: world → space
    tmp[0] = matrices[m + 12]; tmp[1] = matrices[m + 13]; tmp[2] = matrices[m + 14];
    quatRotate(tq, tmp, out, o);
    out[o] += tp[0]; out[o + 1] += tp[1]; out[o + 2] += tp[2];
    // orientation: world → space
    quatFromMatrix(matrices, m, tmp, 0);
    quatMultiply(tq, tmp, out, o + 3);
  }
}

const scratch4: number[] = [0, 0, 0, 0];

/**
 * Transform HandFrame-layout joints in place by a rigid transform (e.g. space ⇄ world).
 */
export function transformJointsInPlace(joints: number[] | Float32Array, t: Pose): void {
  const tmp = scratch4;
  for (let o = 0; o + JOINT_STRIDE <= joints.length; o += JOINT_STRIDE) {
    tmp[0] = joints[o]; tmp[1] = joints[o + 1]; tmp[2] = joints[o + 2];
    quatRotate(t.rotation, tmp, joints, o);
    joints[o] += t.position[0]; joints[o + 1] += t.position[1]; joints[o + 2] += t.position[2];
    tmp[0] = joints[o + 3]; tmp[1] = joints[o + 4]; tmp[2] = joints[o + 5]; tmp[3] = joints[o + 6];
    quatMultiply(t.rotation, tmp, joints, o + 3);
  }
}

/** Returns a copy of a HandFrame transformed by `t` (does not mutate the input). */
export function transformHandFrame(frame: HandFrame, t: Pose): HandFrame {
  const joints = frame.joints.slice();
  transformJointsInPlace(joints, t);
  return { hand: frame.hand, joints, radii: frame.radii.slice() };
}

/** Pose of joint `index` (HAND_JOINTS order) of a frame. */
export function jointPose(frame: HandFrame, index: number): Pose {
  const o = index * JOINT_STRIDE, j = frame.joints;
  return { position: [j[o], j[o + 1], j[o + 2]], rotation: [j[o + 3], j[o + 4], j[o + 5], j[o + 6]] };
}

// ------------------------------------------------------------------ recalibration

/**
 * Space origin for "recalibrate": on the floor (y = floorY) directly below the
 * head, yawed so that space -Z (forward) points where the head is facing,
 * projected on the floor. Looking straight up/down falls back to the head's
 * up/down vector so the result is always well defined.
 */
export function originFromHead(head: Pose, floorY = 0): Pose {
  const f: Vec3 = [0, 0, 0];
  quatRotate(head.rotation, [0, 0, -1], f);
  let fx = f[0], fz = f[2];
  if (Math.hypot(fx, fz) < 0.2) {
    // Nearly vertical gaze: the head's up vector (looking down) or down vector (looking up) points "forward".
    const u: Vec3 = [0, 0, 0];
    quatRotate(head.rotation, [0, 1, 0], u);
    const sign = f[1] < 0 ? 1 : -1;
    fx = u[0] * sign; fz = u[2] * sign;
  }
  const yaw = Math.atan2(-fx, -fz);
  return { position: [head.position[0], floorY, head.position[2]], rotation: quatFromYaw(yaw) };
}

/** Yaw angle (radians about +Y) of a rotation's forward (-Z) direction. */
export function yawOf(q: Quat): number {
  const f: Vec3 = [0, 0, 0];
  quatRotate(q, [0, 0, -1], f);
  return Math.atan2(-f[0], -f[2]);
}

/** Vertical FOV (degrees) and aspect from a column-major perspective projection matrix. */
export function fovFromProjection(
  p: ArrayLike<number>,
  out: { fov: number; aspect: number } = { fov: 0, aspect: 1 },
): { fov: number; aspect: number } {
  out.fov = (2 * Math.atan(1 / p[5]) * 180) / Math.PI;
  out.aspect = p[5] / p[0];
  return out;
}

/** Round to `digits` decimals (for compact JSON). */
export function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
