// Conversions between protocol tuples and three.js objects, plus a few
// allocation-free helpers used in per-frame code.

import * as THREE from 'three';
import type { Quat, Transform, Vec3 } from '@evolspace/protocol';

export function applyTransform(obj: THREE.Object3D, t: Transform): void {
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
  // Guard against degenerate scales (a zero scale makes matrices non-invertible,
  // which breaks raycasting and local-point conversion).
  obj.scale.set(nz(t.scale[0]), nz(t.scale[1]), nz(t.scale[2]));
}

function nz(v: number): number {
  return Number.isFinite(v) && Math.abs(v) > 1e-6 ? v : 1e-6;
}

export function vec3(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export function quat(q: THREE.Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

export function transformFromMatrix(m: THREE.Matrix4, out?: Transform): Transform {
  m.decompose(_p, _q, _s);
  if (!out) return { position: vec3(_p), rotation: quat(_q), scale: vec3(_s) };
  out.position[0] = _p.x; out.position[1] = _p.y; out.position[2] = _p.z;
  out.rotation[0] = _q.x; out.rotation[1] = _q.y; out.rotation[2] = _q.z; out.rotation[3] = _q.w;
  out.scale[0] = _s.x; out.scale[1] = _s.y; out.scale[2] = _s.z;
  return out;
}

export function matrixFromTransform(t: Transform, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(t.position[0], t.position[1], t.position[2]);
  _q.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
  _s.set(nz(t.scale[0]), nz(t.scale[1]), nz(t.scale[2]));
  return out.compose(_p, _q, _s);
}

export function isFiniteVec(v: unknown, n: number): v is number[] {
  if (!Array.isArray(v) || v.length !== n) return false;
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return false;
  return true;
}

/** Yaw-only rotation (about +Y) that faces the same horizontal direction as `q`. */
export function yawOnly(q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  _f.set(0, 0, -1).applyQuaternion(q);
  const yaw = Math.atan2(-_f.x, -_f.z);
  return out.setFromAxisAngle(_up, yaw);
}

/** Exponential smoothing factor for a rate (1/s) over dt seconds; frame-rate independent. */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _f = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
