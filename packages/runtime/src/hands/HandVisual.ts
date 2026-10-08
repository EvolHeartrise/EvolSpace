// Diagrammatic hand: 25 joint spheres + 27 bone capsules (cylinders), as two
// InstancedMeshes (2 draw calls per hand). Used for VR hands and the mirror's
// ghost hands. update() is allocation-free.

import * as THREE from 'three';
import type { HandFrame, Theme } from '@evolspace/protocol';

export interface HandVisualOptions {
  /** Bone color (default theme.textDim). */
  color?: string;
  /** Joint color (default theme.text). */
  jointColor?: string;
  opacity?: number;
  /** Multiplier on tracked joint radii for the spheres. */
  jointScale?: number;
  /** Bone radius as a fraction of the smaller adjacent joint radius. */
  boneScale?: number;
}

export interface HandVisual {
  readonly object: THREE.Group;
  /** Pose from a frame (space coords, if `object` is under the space root); undefined hides the hand. */
  update(frame: HandFrame | undefined): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

/** Bones as joint index pairs (HAND_JOINTS order). */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = (() => {
  const bones: Array<[number, number]> = [];
  // Thumb: wrist → metacarpal → proximal → distal → tip
  bones.push([0, 1], [1, 2], [2, 3], [3, 4]);
  // Fingers: wrist → metacarpal → proximal → intermediate → distal → tip
  for (const base of [5, 10, 15, 20]) {
    bones.push([0, base]);
    for (let i = 0; i < 4; i++) bones.push([base + i, base + i + 1]);
  }
  // Palm: knuckle line across proximal phalanx bases.
  bones.push([6, 11], [11, 16], [16, 21]);
  return bones;
})();

const JOINTS = 25;

export function createHandVisual(theme: Theme, opts: HandVisualOptions = {}): HandVisual {
  const opacity = opts.opacity ?? 0.85;
  const jointScale = opts.jointScale ?? 0.9;
  const boneScale = opts.boneScale ?? 0.55;
  const group = new THREE.Group();
  group.name = 'hand-visual';
  group.visible = false;

  const jointMat = new THREE.MeshBasicMaterial({ color: opts.jointColor ?? theme.text, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  const boneMat = new THREE.MeshBasicMaterial({ color: opts.color ?? theme.textDim, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  const sphere = new THREE.IcosahedronGeometry(1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

  const joints = new THREE.InstancedMesh(sphere, jointMat, JOINTS);
  const bones = new THREE.InstancedMesh(cylinder, boneMat, HAND_BONES.length);
  for (const m of [joints, bones]) {
    m.frustumCulled = false; // instance bounds change every frame
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.raycast = () => {};
  }
  joints.name = 'hand-joints';
  bones.name = 'hand-bones';
  group.add(bones, joints);

  const pos = new Float32Array(JOINTS * 3);
  const rad = new Float32Array(JOINTS);

  function update(frame: HandFrame | undefined): void {
    if (!frame || frame.joints.length < JOINTS * 7) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const j = frame.joints;
    for (let i = 0; i < JOINTS; i++) {
      const o = i * 7;
      pos[i * 3] = j[o];
      pos[i * 3 + 1] = j[o + 1];
      pos[i * 3 + 2] = j[o + 2];
      const r = frame.radii[i];
      rad[i] = Number.isFinite(r) && r > 0 ? r : 0.008;
      _p.set(j[o], j[o + 1], j[o + 2]);
      _s.setScalar(rad[i] * jointScale);
      _m.compose(_p, _qi, _s);
      joints.setMatrixAt(i, _m);
    }
    for (let b = 0; b < HAND_BONES.length; b++) {
      const [a, c] = HAND_BONES[b];
      _a.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
      _c.set(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]);
      _d.subVectors(_c, _a);
      const len = _d.length();
      if (len < 1e-5) {
        _m.makeScale(0, 0, 0);
        bones.setMatrixAt(b, _m);
        continue;
      }
      _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
      _p.addVectors(_a, _c).multiplyScalar(0.5);
      const r = Math.min(rad[a], rad[c]) * boneScale;
      _s.set(r, len, r);
      _m.compose(_p, _q, _s);
      bones.setMatrixAt(b, _m);
    }
    joints.instanceMatrix.needsUpdate = true;
    bones.instanceMatrix.needsUpdate = true;
  }

  return {
    object: group,
    update,
    setOpacity(o: number) {
      for (const m of [jointMat, boneMat]) {
        m.opacity = o;
        m.transparent = o < 1;
        m.depthWrite = o >= 1;
      }
    },
    dispose() {
      group.removeFromParent();
      sphere.dispose();
      cylinder.dispose();
      jointMat.dispose();
      boneMat.dispose();
      joints.dispose();
      bones.dispose();
    },
  };
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
