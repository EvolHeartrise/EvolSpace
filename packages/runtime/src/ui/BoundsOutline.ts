// Corner-bracket frame around an entity's bounds (hover highlight, selection).
// One LineSegments with shared geometry; its matrix is composed each frame
// from the entity node's world matrix and its local AABB — no allocation.

import * as THREE from 'three';
import { unitBracketGeometry } from './geometry.ts';

export class BoundsOutline {
  readonly object: THREE.LineSegments;
  private material: THREE.LineBasicMaterial;

  constructor(color: string, opacity: number, private padding = 0.01) {
    this.material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
    this.object = new THREE.LineSegments(unitBracketGeometry(), this.material);
    this.object.matrixAutoUpdate = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.raycast = () => {};
    this.object.name = 'bounds-outline';
  }

  setColor(color: string, opacity?: number): void {
    this.material.color.set(color);
    if (opacity !== undefined) this.material.opacity = opacity;
  }

  /**
   * Show around `localBox` (in `node`'s frame). `parentInverse` = inverse world
   * matrix of this outline's parent (the space root).
   */
  show(node: THREE.Object3D, localBox: THREE.Box3, parentInverse: THREE.Matrix4): void {
    localBox.getCenter(_c);
    localBox.getSize(_s);
    // Pad in world units regardless of entity scale (the caller updated node.matrixWorld).
    _ws.setFromMatrixScale(node.matrixWorld);
    _s.x += (2 * this.padding) / Math.max(1e-6, Math.abs(_ws.x));
    _s.y += (2 * this.padding) / Math.max(1e-6, Math.abs(_ws.y));
    _s.z += (2 * this.padding) / Math.max(1e-6, Math.abs(_ws.z));
    _local.compose(_c, _q.identity(), _s);
    this.object.matrix.multiplyMatrices(parentInverse, node.matrixWorld).multiply(_local);
    this.object.matrixWorldNeedsUpdate = true;
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    this.material.dispose();
    this.object.removeFromParent();
  }
}

const _c = new THREE.Vector3();
const _s = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _local = new THREE.Matrix4();
