// Orienting unit Y-up geometry (cylinder/cone/capsule from resources.ts)
// between two points. Allocation-free with a reusable scratch object.

import type * as THREE from 'three';

export class SegmentMath {
  private readonly up: THREE.Vector3;
  private readonly dir: THREE.Vector3;
  private readonly a: THREE.Vector3;
  private readonly q: THREE.Quaternion;
  private readonly s: THREE.Vector3;

  constructor(T: typeof THREE) {
    this.up = new T.Vector3(0, 1, 0);
    this.dir = new T.Vector3();
    this.a = new T.Vector3();
    this.q = new T.Quaternion();
    this.s = new T.Vector3();
  }

  /**
   * Matrix placing a unit Y-up shape (height 1, diameter 1, centered) as a rod
   * of `radius` from a to b. Returns the length (0 for degenerate segments → zero scale).
   */
  rod(out: THREE.Matrix4, ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): number {
    this.dir.set(bx - ax, by - ay, bz - az);
    const len = this.dir.length();
    if (len < 1e-9) {
      out.makeScale(0, 0, 0);
      return 0;
    }
    this.dir.multiplyScalar(1 / len);
    this.q.setFromUnitVectors(this.up, this.dir);
    this.a.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.s.set(radius * 2, len, radius * 2);
    out.compose(this.a, this.q, this.s);
    return len;
  }

  /** Same as rod() but applied to an Object3D's position/quaternion/scale. */
  place(obj: THREE.Object3D, ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): number {
    this.dir.set(bx - ax, by - ay, bz - az);
    const len = this.dir.length();
    if (len < 1e-9) {
      obj.scale.set(0, 0, 0);
      return 0;
    }
    this.dir.multiplyScalar(1 / len);
    obj.quaternion.setFromUnitVectors(this.up, this.dir);
    obj.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    obj.scale.set(radius * 2, len, radius * 2);
    return len;
  }
}

/** Parse a vec3-ish value ([x,y,z], {x,y,z}, tensor of 3) into out; returns false if invalid. */
export function readVec3(v: unknown, out: [number, number, number]): boolean {
  let a: ArrayLike<number> | null = null;
  if (Array.isArray(v)) a = v as number[];
  else if (v && typeof v === 'object' && '$tensor' in v) a = (v as unknown as { data: ArrayLike<number> }).data;
  else if (v && typeof v === 'object' && 'x' in v) {
    const o = v as { x: unknown; y: unknown; z?: unknown };
    a = [Number(o.x), Number(o.y), Number(o.z ?? 0)];
  }
  if (!a || a.length < 2) return false;
  const x = Number(a[0]), y = Number(a[1]), z = a.length > 2 ? Number(a[2]) : 0;
  if (![x, y, z].every(Number.isFinite)) return false;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return true;
}
