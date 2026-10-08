// Tiny transform math (no three.js on the server).
import type { Quat, Transform, Vec3 } from '@evolspace/protocol';

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1, expanded.
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/** parent ∘ child: the child's transform expressed in the parent's frame. */
export function composeTransforms(parent: Transform, child: Transform): Transform {
  const scaled: Vec3 = [child.position[0] * parent.scale[0], child.position[1] * parent.scale[1], child.position[2] * parent.scale[2]];
  const r = rotateVec(parent.rotation, scaled);
  return {
    position: [parent.position[0] + r[0], parent.position[1] + r[1], parent.position[2] + r[2]],
    rotation: quatMul(parent.rotation, child.rotation),
    scale: [parent.scale[0] * child.scale[0], parent.scale[1] * child.scale[1], parent.scale[2] * child.scale[2]],
  };
}

export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function roundVec<T extends number[]>(v: T, digits = 3): T {
  return v.map((x) => round(x, digits)) as T;
}
