import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { explicitCamera, frameBox, lookRotation, niceGridStep, userCamera, applyPlacement } from '../framing.ts';
import { SceneIndex } from '../scene-index.ts';
import type { UserPose } from '@evolspace/protocol';

function project(p: ReturnType<typeof frameBox>, aspect: number, pts: THREE.Vector3[]): THREE.Vector3[] {
  const cam = new THREE.PerspectiveCamera();
  applyPlacement(cam, p, aspect);
  return pts.map((v) => v.clone().project(cam));
}

function corners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  return out;
}

describe('frameBox', () => {
  const cases: Array<[string, THREE.Box3, THREE.Vector3, number]> = [
    ['cube front', new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5)), new THREE.Vector3(0, 0, 1), 4 / 3],
    ['wide panel 3/4', new THREE.Box3(new THREE.Vector3(-1, 1, -0.01), new THREE.Vector3(1, 1.5, 0.01)), new THREE.Vector3(0.3, 0.25, 1), 1],
    ['tall thing from above', new THREE.Box3(new THREE.Vector3(2, 0, 2), new THREE.Vector3(2.2, 3, 2.2)), new THREE.Vector3(0, 1, 0.2), 16 / 9],
  ];
  for (const [name, box, dir, aspect] of cases) {
    it(`keeps every corner inside the padded frame (${name})`, () => {
      const p = frameBox(box, dir, { aspect, padding: 0.1 });
      const ndc = project(p, aspect, corners(box));
      const maxX = Math.max(...ndc.map((v) => Math.abs(v.x)));
      const maxY = Math.max(...ndc.map((v) => Math.abs(v.y)));
      // inside the frame, and tight in at least one dimension (≈ 1/(1+2·0.1))
      expect(maxX).toBeLessThanOrEqual(1 / 1.2 + 1e-6);
      expect(maxY).toBeLessThanOrEqual(1 / 1.2 + 1e-6);
      expect(Math.max(maxX, maxY)).toBeGreaterThan(0.75);
      // in front of the camera
      for (const v of ndc) expect(v.z).toBeLessThan(1);
      // camera looks at the box center
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion);
      const toCenter = box.getCenter(new THREE.Vector3()).sub(p.position).normalize();
      expect(fwd.dot(toCenter)).toBeGreaterThan(0.9999);
    });
  }
  it('handles a degenerate (point) box', () => {
    const p = frameBox(new THREE.Box3(new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1)), new THREE.Vector3(0, 0, 1), { aspect: 1 });
    expect(p.position.distanceTo(new THREE.Vector3(1, 1, 1))).toBeGreaterThan(0.1);
  });
});

describe('cameras', () => {
  it('user camera copies head pose and defaults fov to 90', () => {
    const pose: UserPose = { t: 0, mode: 'vr', head: { position: [1, 1.6, 2], rotation: [0, 0.7071068, 0, 0.7071068] }, hands: {} };
    const p = userCamera(pose);
    expect(p.fov).toBe(90);
    expect(p.position.toArray()).toEqual([1, 1.6, 2]);
    expect(userCamera({ ...pose, fov: 100 }).fov).toBe(100);
  });
  it('explicit camera: rotation > lookAt > fallback target', () => {
    const lookAt = explicitCamera({ position: [0, 1, 5], lookAt: [0, 1, 0] }, null);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(lookAt.quaternion);
    expect(fwd.z).toBeCloseTo(-1, 6);
    const fb = explicitCamera({ position: [5, 1, 0] }, new THREE.Vector3(0, 1, 0));
    expect(new THREE.Vector3(0, 0, -1).applyQuaternion(fb.quaternion).x).toBeCloseTo(-1, 6);
    expect(explicitCamera({ position: [0, 0, 0], rotation: [0, 0, 0, 1], lookAt: [1, 0, 0] }, null).quaternion.w).toBeCloseTo(1);
    expect(explicitCamera({ position: [0, 0, 0] }, null).fov).toBe(60);
  });
  it('lookRotation survives straight-down views', () => {
    const q = lookRotation(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 0, 0));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(fwd.y).toBeCloseTo(-1, 6);
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
  });
  it('niceGridStep picks 1/2/5 steps', () => {
    expect(niceGridStep(1)).toBeCloseTo(0.2);
    expect(niceGridStep(0.3)).toBeCloseTo(0.05);
    expect(niceGridStep(10)).toBeCloseTo(2);
  });
});

describe('SceneIndex', () => {
  const t = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
  const ent = (id: string, parent: string | null, extra: object = {}) => ({ id, parent, widget: 'box', props: {}, transform: t, visible: true, ...extra });
  it('tracks snapshot + patches, removing subtrees', () => {
    const idx = new SceneIndex();
    idx.applySnapshot({ version: 1, workspace: 'w', links: {}, entities: { a: ent('a', null), b: ent('b', 'a'), c: ent('c', 'b') } as never });
    expect(idx.entities.size).toBe(3);
    idx.applyPatch(2, [{ op: 'add', entity: ent('d', null, { name: 'dee' }) as never }, { op: 'update', id: 'a', patch: { visible: false } }]);
    expect(idx.entities.get('d')?.name).toBe('dee');
    expect(idx.isEffectivelyVisible('c')).toBe(false);
    expect(idx.isEffectivelyVisible('d')).toBe(true);
    idx.applyPatch(3, [{ op: 'remove', id: 'a' }]);
    expect([...idx.entities.keys()]).toEqual(['d']);
    idx.applyPatch(4, [{ op: 'clear' }]);
    expect(idx.entities.size).toBe(0);
    expect(idx.version).toBe(4);
  });
});
