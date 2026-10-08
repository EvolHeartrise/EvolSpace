import type * as THREE from 'three';

/** True if `o` and all its ancestors are visible. */
export function effectivelyVisible(o: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}
