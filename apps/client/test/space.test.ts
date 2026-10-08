import { describe, it, expect } from 'vitest';
import {
  composePose, invertPose, worldToSpace, spaceToWorld, transformPoint, quatFromYaw, quatFromMatrix,
  quatRotate, quatMultiply, matricesToJoints, transformHandFrame, originFromHead, yawOf, fovFromProjection,
  JOINT_COUNT, JOINT_STRIDE, type Pose,
} from '../src/math/space.ts';
import type { HandFrame, Quat, Vec3 } from '@evolspace/protocol';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};
/** q and -q are the same rotation. */
const closeQuat = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  expect(Math.abs(Math.abs(dot) - 1)).toBeLessThan(eps);
};

function axisAngle(axis: Vec3, angle: number): Quat {
  const l = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Column-major 4×4 from a pose (reference implementation via basis vectors). */
function poseToMatrix(p: Pose): number[] {
  const x: Vec3 = [0, 0, 0], y: Vec3 = [0, 0, 0], z: Vec3 = [0, 0, 0];
  quatRotate(p.rotation, [1, 0, 0], x);
  quatRotate(p.rotation, [0, 1, 0], y);
  quatRotate(p.rotation, [0, 0, 1], z);
  return [...x, 0, ...y, 0, ...z, 0, ...p.position, 1];
}

const ORIGIN: Pose = { position: [1.5, 0.02, -3], rotation: axisAngle([0.1, 1, 0.05], 1.1) };

describe('rigid transforms', () => {
  it('inverse composes to identity', () => {
    const id = composePose(ORIGIN, invertPose(ORIGIN));
    close(id.position, [0, 0, 0]);
    closeQuat(id.rotation, [0, 0, 0, 1]);
  });

  it('worldToSpace is the inverse of spaceToWorld', () => {
    const p: Pose = { position: [0.3, 1.6, -0.4], rotation: axisAngle([1, 2, 3], 0.7) };
    const w = spaceToWorld(ORIGIN, p);
    const back = worldToSpace(ORIGIN, w);
    close(back.position, p.position);
    closeQuat(back.rotation, p.rotation);
  });

  it('a point at the origin pose maps to space zero', () => {
    const inv = invertPose(ORIGIN);
    close(transformPoint(inv, ORIGIN.position), [0, 0, 0]);
  });

  it('yaw origin: a point 1m in front of the origin is at space (0,0,-1)', () => {
    const origin: Pose = { position: [2, 0, 2], rotation: quatFromYaw(Math.PI / 2) }; // facing -X
    const inv = invertPose(origin);
    close(transformPoint(inv, [1, 0, 2]), [0, 0, -1]);
  });

  it('quatMultiply composes rotations (apply b then a)', () => {
    const a = axisAngle([0, 1, 0], Math.PI / 2), b = axisAngle([1, 0, 0], Math.PI / 2);
    const ab = [0, 0, 0, 0];
    quatMultiply(a, b, ab);
    const v1: Vec3 = [0, 0, 0], v2: Vec3 = [0, 0, 0];
    quatRotate(b, [0, 1, 0], v1);
    quatRotate(a, v1, v1);
    quatRotate(ab, [0, 1, 0], v2);
    close(v1, v2);
  });
});

describe('matrix → joints', () => {
  it('quatFromMatrix round-trips (incl. 180° rotations)', () => {
    for (const q of [axisAngle([0, 1, 0], Math.PI), axisAngle([1, 0, 0], Math.PI), axisAngle([0, 0, 1], 3.1), axisAngle([1, -2, 0.5], 2.2), [0, 0, 0, 1] as Quat]) {
      const m = poseToMatrix({ position: [0, 0, 0], rotation: q });
      const out = [0, 0, 0, 0];
      quatFromMatrix(m, 0, out);
      closeQuat(out, q);
    }
  });

  it('fillPoses matrices are converted into space-coordinate joints', () => {
    const worldJoints: Pose[] = Array.from({ length: JOINT_COUNT }, (_, j) => ({
      position: [0.1 * j, 1 + 0.01 * j, -0.5], rotation: axisAngle([j + 1, 1, -j], 0.1 * j + 0.2),
    }));
    const mats = new Float32Array(JOINT_COUNT * 16);
    worldJoints.forEach((p, j) => mats.set(poseToMatrix(p), j * 16));
    const out = new Array<number>(JOINT_COUNT * JOINT_STRIDE).fill(0);
    matricesToJoints(mats, invertPose(ORIGIN), out);
    worldJoints.forEach((w, j) => {
      const s = worldToSpace(ORIGIN, w);
      const o = j * JOINT_STRIDE;
      close(out.slice(o, o + 3), s.position, 1e-5);
      closeQuat(out.slice(o + 3, o + 7), s.rotation, 1e-5);
    });
  });

  it('transformHandFrame does not mutate its input and round-trips', () => {
    const joints: number[] = [];
    for (let j = 0; j < JOINT_COUNT; j++) joints.push(j * 0.01, 1, -0.3, ...axisAngle([0, 1, 0], j * 0.05));
    const f: HandFrame = { hand: 'right', joints, radii: new Array(JOINT_COUNT).fill(0.01) };
    const copy = joints.slice();
    const there = transformHandFrame(f, ORIGIN);
    expect(f.joints).toEqual(copy);
    const back = transformHandFrame(there, invertPose(ORIGIN));
    close(back.joints, joints, 1e-9);
    expect(back.hand).toBe('right');
  });
});

describe('recalibration', () => {
  it('places the origin on the floor under the head, facing the head direction', () => {
    const head: Pose = { position: [3, 1.7, -2], rotation: composePose({ position: [0, 0, 0], rotation: quatFromYaw(0.8) }, { position: [0, 0, 0], rotation: axisAngle([1, 0, 0], -0.4) }).rotation };
    const o = originFromHead(head);
    close(o.position, [3, 0, -2]);
    expect(yawOf(o.rotation)).toBeCloseTo(0.8, 6);
    // origin's forward is horizontal
    const f: Vec3 = [0, 0, 0];
    quatRotate(o.rotation, [0, 0, -1], f);
    expect(f[1]).toBeCloseTo(0, 9);
  });

  it('is well defined when looking straight down', () => {
    const head: Pose = { position: [0, 1.6, 0], rotation: composePose({ position: [0, 0, 0], rotation: quatFromYaw(-1.2) }, { position: [0, 0, 0], rotation: axisAngle([1, 0, 0], -Math.PI / 2) }).rotation };
    const o = originFromHead(head);
    expect(yawOf(o.rotation)).toBeCloseTo(-1.2, 5);
  });
});

describe('projection', () => {
  it('extracts vertical FOV and aspect', () => {
    const fov = 90, aspect = 1.25;
    const f = 1 / Math.tan((fov * Math.PI) / 360);
    const p = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
    const r = fovFromProjection(p);
    expect(r.fov).toBeCloseTo(90, 6);
    expect(r.aspect).toBeCloseTo(1.25, 6);
  });
});
