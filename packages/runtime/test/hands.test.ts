import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HAND_JOINTS, type HandFrame } from '@evolspace/protocol';
import { createHandVisual, HAND_BONES } from '../src/hands/HandVisual.ts';
import { createTheme } from '../src/theme.ts';

function frame(): HandFrame {
  const joints: number[] = [];
  for (let i = 0; i < HAND_JOINTS.length; i++) joints.push(0.01 * i, 1 + 0.005 * i, -0.3, 0, 0, 0, 1);
  return { hand: 'right', joints, radii: new Array(25).fill(0.01) };
}

describe('createHandVisual', () => {
  it('has a bone for every finger segment', () => {
    expect(HAND_BONES).toHaveLength(27);
    for (const [a, b] of HAND_BONES) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(25);
    }
  });

  it('poses instanced joints and bones from a frame; hides without one', () => {
    const v = createHandVisual(createTheme());
    expect(v.object.visible).toBe(false);
    v.update(frame());
    expect(v.object.visible).toBe(true);
    const joints = v.object.getObjectByName('hand-joints') as THREE.InstancedMesh;
    const bones = v.object.getObjectByName('hand-bones') as THREE.InstancedMesh;
    expect(joints.count).toBe(25);
    const m = new THREE.Matrix4();
    joints.getMatrixAt(9, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(0.09);
    bones.getMatrixAt(0, m); // wrist → thumb metacarpal: midpoint
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(0.005);
    v.update(undefined);
    expect(v.object.visible).toBe(false);
    v.setOpacity(0.3);
    v.dispose();
  });
});
