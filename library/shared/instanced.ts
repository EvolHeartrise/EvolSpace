// InstancedMesh whose *object* transform spans the instances' bounding box.
//
// Why: generic bounds code (the runtime's picker/framing, Box3.setFromObject
// without `precise`) measures `geometry.boundingBox × object.matrixWorld`. With
// a shared unit geometry and an identity object transform that is a fixed
// 1 m box, whatever the instances are. FittedInstances sets the mesh's
// position/scale so the unit geometry box (±0.5) maps exactly onto the box you
// declare, and converts the instance matrices you give it (in parent space)
// into that frame. Rendering is unchanged (parent · M · M⁻¹ · instance).
// Requires a unit geometry centered at the origin with a ±0.5 bounding box
// (all of resources.ts' unit geometries qualify).

import type * as THREE from 'three';

const MIN_EXTENT = 1e-4;

export class FittedInstances {
  readonly mesh: THREE.InstancedMesh;
  private inv: THREE.Matrix4;
  private tmp: THREE.Matrix4;

  constructor(T: typeof THREE, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.mesh = new T.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.inv = new T.Matrix4();
    this.tmp = new T.Matrix4();
  }

  /** Declare the parent-space box the instances occupy (call before setMatrixAt for this update). */
  fit(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    const m = this.mesh;
    const sx = Math.max(MIN_EXTENT, maxX - minX);
    const sy = Math.max(MIN_EXTENT, maxY - minY);
    const sz = Math.max(MIN_EXTENT, maxZ - minZ);
    m.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    m.quaternion.identity();
    m.scale.set(sx, sy, sz);
    m.updateMatrix();
    this.inv.copy(m.matrix).invert();
  }

  /** Set instance i from a matrix in parent space. */
  setMatrixAt(i: number, parentSpace: THREE.Matrix4): void {
    this.mesh.setMatrixAt(i, this.tmp.multiplyMatrices(this.inv, parentSpace));
  }

  setColorAt(i: number, c: THREE.Color): void {
    this.mesh.setColorAt(i, c);
  }

  /** Finish an update: instance count, upload flags, bounds. */
  commit(count: number): void {
    const m = this.mesh;
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingBox();
    m.computeBoundingSphere();
  }
}
