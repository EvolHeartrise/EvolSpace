// 3-D widgets: points, line, arrow, axes.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import points from '../widgets/points/widget.ts';
import lineWidget from '../widgets/line/widget.ts';
import arrow from '../widgets/arrow/widget.ts';
import axes from '../widgets/axes/widget.ts';
import { instanceMatrix, mount, pickerBounds, tensor, type Harness } from './harness.ts';

let h: Harness | null = null;
afterEach(() => {
  if (h) {
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
    expect(h.root.children).toHaveLength(0);
  }
  h = null;
});

const cloud = (x: Harness) => x.root.getObjectByName('cloud') as THREE.InstancedMesh;
const posOf = (m: THREE.InstancedMesh, i: number) => new THREE.Vector3().setFromMatrixPosition(instanceMatrix(m, i));

describe('points', () => {
  const pts = tensor('f32', [4, 3], [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);

  it('fits [N, 3] data into the extent cube with one instanced draw', async () => {
    h = await mount(points, { extent: 0.2 });
    h.input('points', pts);
    h.frame();
    const m = cloud(h);
    expect(m.count).toBe(4);
    const box = new THREE.Box3();
    for (let i = 0; i < 4; i++) box.expandByPoint(posOf(m, i));
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(0.2, 5);
    expect(box.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-6);
    expect(h.root.getObjectByName('cloud')).toBeTruthy();
  });

  it('fit=false keeps coordinates in meters; [N, 2] and number[][] work', async () => {
    h = await mount(points, { fit: false });
    h.input('points', [[0.1, 0.2], [0.3, 0.4, 0.5]]);
    h.frame();
    expect(posOf(cloud(h), 1).toArray()).toEqual([0.3, 0.4, 0.5].map((x) => Math.fround(x)).map((x) => expect.closeTo(x, 6)));
    h.input('points', tensor('f32', [2, 2], [1, 2, 3, 4]));
    h.frame();
    expect(posOf(cloud(h), 1).z).toBe(0);
  });

  it('scalar colors map through the colormap; RGB colors are used directly; sizes scale points', async () => {
    h = await mount(points, {});
    h.input('points', pts);
    h.input('colors', tensor('f32', [4], [0, 1, 2, 3]));
    h.input('sizes', [1, 2, 1, 1]);
    h.frame();
    const m = cloud(h);
    const a = new THREE.Color();
    const b = new THREE.Color();
    m.getColorAt(0, a);
    m.getColorAt(3, b);
    expect(a.equals(b)).toBe(false);
    expect(new THREE.Vector3().setFromMatrixScale(instanceMatrix(m, 1)).x).toBeCloseTo(0.016, 6);
    h.input('colors', tensor('f32', [4, 3], [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]));
    h.frame();
    m.getColorAt(0, a);
    expect(a.r).toBeCloseTo(1);
    expect(a.g).toBeCloseTo(0);
  });

  it('ray picking returns the point closest along the ray (custom raycast)', async () => {
    h = await mount(points, { fit: false, pointSize: 0.01 });
    h.input('points', [[0, 0, -0.1], [0, 0, 0.1], [0.2, 0, 0]]);
    h.frame();
    h.root.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
    const hits = rc.intersectObject(cloud(h), false);
    expect(hits).toHaveLength(1);
    expect(hits[0].instanceId).toBe(1); // nearest along the ray
    expect(hits[0].point.z).toBeCloseTo(0.1, 6);
    const miss = new THREE.Raycaster(new THREE.Vector3(0.5, 0.5, 1), new THREE.Vector3(0, 0, -1)).intersectObject(cloud(h), false);
    expect(miss).toHaveLength(0);
  });

  it('press emits index and shows a selection marker; hover emits hover; select input highlights', async () => {
    h = await mount(points, { fit: false });
    h.input('points', [[0, 0, 0], [0.1, 0, 0]]);
    h.frame();
    h.interact({ handler: 'press', phase: 'start', objectName: 'cloud', localPoint: [0.1, 0, 0] });
    expect(h.emitsOn('index')).toEqual([1]);
    expect(h.hasText('#1')).toBe(true);
    h.interact({ handler: 'hover', phase: 'start', objectName: 'cloud', localPoint: [0, 0, 0] });
    h.interact({ handler: 'hover', phase: 'end', objectName: 'cloud', localPoint: [0, 0, 0] });
    expect(h.emitsOn('hover')).toEqual([0, -1]);
    h.input('select', 0);
    expect(h.hasText('#0')).toBe(true);
    h.input('select', -1);
    expect(h.hasText('#0')).toBe(false);
  });

  it('grows its instance buffer in powers of two and respects maxPoints', async () => {
    h = await mount(points, { maxPoints: 100 });
    h.input('points', tensor('f32', [70, 3], new Array(210).fill(0).map((_, i) => i)));
    h.frame();
    expect(cloud(h).instanceMatrix.count).toBe(100);
    h.input('points', tensor('f32', [500, 3], new Array(1500).fill(1)));
    h.frame();
    expect(cloud(h).count).toBe(100);
  });

  it('reads a channel and reports bad input', async () => {
    h = await mount(points, { channel: 'emb.xyz' }, { channels: { 'emb.xyz': pts } });
    h.frame();
    expect(cloud(h).count).toBe(4);
    h.input('points', { not: 'points' });
    expect(h.rec.errors).toHaveLength(1);
  });
});

describe('line', () => {
  it('draws a hairline through the points prop; closed uses a loop', async () => {
    h = await mount(lineWidget, { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] });
    const l = h.root.getObjectByName('polyline') as THREE.Line;
    expect(l.geometry.drawRange.count).toBe(3);
    await h.setProps({ closed: true });
    expect((h.root.getObjectByName('polyline') as THREE.LineLoop).isLineLoop).toBe(true);
  });

  it('streams tensor points in place when capacity allows', async () => {
    h = await mount(lineWidget, {});
    const l = h.root.getObjectByName('polyline') as THREE.Line;
    h.input('points', tensor('f32', [4, 3], [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]));
    expect(h.root.getObjectByName('polyline')).toBe(l); // reused
    expect(l.geometry.drawRange.count).toBe(4);
    h.input('points', tensor('f32', [40, 3], new Array(120).fill(0)));
    expect(h.root.getObjectByName('polyline')).not.toBe(l); // grew
  });

  it('radius > 0 builds instanced tube segments + joints', async () => {
    h = await mount(lineWidget, { radius: 0.01, points: [[0, 0, 0], [0.1, 0, 0], [0.1, 0.1, 0]] });
    const tube = h.root.getObjectByName('tube') as THREE.InstancedMesh;
    expect(tube.count).toBe(2);
    const s = new THREE.Vector3().setFromMatrixScale(instanceMatrix(tube, 0));
    expect(s.y).toBeCloseTo(0.1, 6); // segment length
    expect(s.x).toBeCloseTo(0.02, 6); // diameter
    expect((h.root.getObjectByName('joints') as THREE.InstancedMesh).count).toBe(3);
  });
});

describe('arrow', () => {
  it('spans from → to with the head ending at the tip', async () => {
    h = await mount(arrow, { from: [0, 0, 0], to: [0, 0.2, 0], headLength: 0.05, label: 'v' });
    const shaft = h.root.getObjectByName('shaft') as THREE.Mesh;
    const head = h.root.getObjectByName('head') as THREE.Mesh;
    expect(shaft.scale.y).toBeCloseTo(0.15, 6);
    expect(head.position.y + head.scale.y / 2).toBeCloseTo(0.2, 6);
    expect(h.hasText('v')).toBe(true);
  });

  it('inputs move endpoints (vec3 arrays or {x,y,z}); head is capped for short arrows', async () => {
    h = await mount(arrow, {});
    h.input('to', { x: 0.01, y: 0, z: 0 });
    const head = h.root.getObjectByName('head') as THREE.Mesh;
    expect(head.scale.y).toBeCloseTo(0.005, 6);
    h.input('from', [0, 0, 0.01]);
    h.input('to', [0, 0, 0.01]);
    expect((h.root.getObjectByName('shaft') as THREE.Mesh).visible).toBe(false);
  });
});

describe('axes', () => {
  it('draws three colored axes with ticks and labels', async () => {
    h = await mount(axes, { length: 0.3, min: 0, max: 10, ticks: 5 });
    expect(h.root.getObjectByName('axis-x')).toBeTruthy();
    expect(h.root.getObjectByName('axis-y')).toBeTruthy();
    expect(h.root.getObjectByName('axis-z')).toBeTruthy();
    expect(h.visibleTexts()).toEqual(expect.arrayContaining(['x', 'y', 'z', '0', '10']));
    const x = h.root.getObjectByName('axis-x') as THREE.LineSegments;
    // 1 axis segment + one per tick (0, 2, …, 10)
    expect(x.geometry.getAttribute('position').count / 2).toBe(1 + 6);
  });

  it('negative axes extend both ways; ticks 0 hides tick labels', async () => {
    h = await mount(axes, { negative: true, ticks: 0, labels: 'a,b,c' });
    const x = h.root.getObjectByName('axis-x') as THREE.LineSegments;
    x.geometry.computeBoundingBox();
    expect(x.geometry.boundingBox!.min.x).toBeCloseTo(-0.3);
    expect(h.visibleTexts().sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('instanced bounds (runtime picker/framing view)', () => {
  it('points, tubes report tight geometry×matrix bounds, not a 1 m unit box', async () => {
    h = await mount(points, { extent: 0.2 });
    h.input('points', tensor('f32', [3, 3], [0, 0, 0, 1, 1, 1, 2, 0, 1]));
    h.frame();
    const size = pickerBounds(h.root.getObjectByName('cloud')!).getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeLessThan(0.25);
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(0.19);
    h.dispose();
    h = await mount(lineWidget, { radius: 0.005, points: [[0, 0, 0], [0.1, 0, 0]] });
    const t = pickerBounds(h.root.getObjectByName('tube')!).getSize(new THREE.Vector3());
    expect(t.x).toBeCloseTo(0.11, 6);
    expect(t.y).toBeCloseTo(0.01, 6);
  });
});
