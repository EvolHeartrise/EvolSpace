// shared/scroll.ts — SmoothScroll motion (follow, fling, friction, ends, scrollTo) and ScrollViewport clipping.
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { ScrollViewport, SmoothScroll } from '../shared/scroll.ts';
import itemList from '../widgets/item-list/widget.ts';
import { mount } from './harness.ts';

function clocked() {
  let t = 0;
  const s = new SmoothScroll(() => t);
  return { s, advance: (ms: number) => { t += ms; } };
}

it('follows the drag 1:1, flings on release, decelerates and stops at the ends', () => {
  const { s, advance } = clocked();
  s.setMax(100);
  s.dragStart();
  for (let i = 1; i <= 5; i++) { advance(16); s.dragMove(i * 0.5); } // 0.5 units / 16 ms ≈ 31 units/s
  expect(s.pos).toBeCloseTo(2.5);
  s.dragEnd();
  expect(s.active).toBe(true);
  let moved = 0;
  for (let i = 0; i < 30; i++) if (s.step(1 / 60)) moved++;
  expect(moved).toBeGreaterThan(20);
  expect(s.pos).toBeGreaterThan(8); // glided well past where the hand let go
  for (let i = 0; i < 300; i++) s.step(1 / 60);
  expect(s.active).toBe(false);
  const rest = s.pos;
  expect(rest).toBeLessThan(2.5 + 31 * 0.32 + 1); // v·τ bounds the glide

  // A slow release doesn't fling; the ends clamp.
  s.dragStart(); advance(200); s.dragMove(0.1); advance(200); s.dragEnd();
  expect(s.active).toBe(false);
  s.dragStart(); s.dragMove(-1000); s.dragEnd(false);
  expect(s.pos).toBe(0);
});

it('scrollTo eases to the target; setMax clamps', () => {
  const { s } = clocked();
  s.setMax(10);
  s.scrollTo(8);
  s.step(1 / 60);
  expect(s.pos).toBeGreaterThan(0);
  expect(s.pos).toBeLessThan(8);
  for (let i = 0; i < 120; i++) s.step(1 / 60);
  expect(s.pos).toBe(8);
  s.setMax(3);
  expect(s.pos).toBe(3);
});

it('ScrollViewport clips meshes with planes (cloning shared materials), texts with clipRect, and hides out-of-view hit targets', () => {
  const frame = new THREE.Group();
  frame.position.set(1, 2, 3);
  const shared = new THREE.MeshBasicMaterial();
  shared.userData.evolShared = true;
  const row = new THREE.Group();
  row.position.y = 0.3;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(), shared);
  const text = Object.assign(new THREE.Mesh(), { text: 'hi', clipRect: null as number[] | null });
  text.position.y = 0.05;
  const hitMat = new THREE.MeshBasicMaterial();
  hitMat.visible = false;
  const hit = new THREE.Mesh(new THREE.BoxGeometry(), hitMat);
  hit.scale.y = 0.1;
  row.add(plate, text, hit);
  frame.add(row);
  const v = new ScrollViewport(THREE, frame, -0.2, 0.2);
  v.add(row);
  v.update();
  expect(plate.material).not.toBe(shared);
  expect((plate.material as THREE.Material).userData.evolShared).toBeUndefined();
  expect((plate.material as THREE.Material).clippingPlanes).toBe(v.planes);
  expect(v.planes[1].distanceToPoint(new THREE.Vector3(1, 2.1, 3))).toBeGreaterThan(0); // inside: kept
  expect(v.planes[1].distanceToPoint(new THREE.Vector3(1, 2.3, 3))).toBeLessThan(0); // above the top: clipped
  expect(text.clipRect![1]).toBeCloseTo(-0.2 - 0.35);
  expect(text.clipRect![3]).toBeCloseTo(0.2 - 0.35);
  expect(hit.visible).toBe(false); // spans [0.25, 0.35]: outside [-0.2, 0.2]
  row.position.y = 0.18; // spans [0.13, 0.23]: trimmed to [0.13, 0.2]
  v.update();
  expect(hit.visible).toBe(true);
  expect(hit.scale.y).toBeCloseTo(0.07);
  expect(row.position.y + hit.position.y).toBeCloseTo(0.165);
});

it('item-list: a drag leaves a fractional position with the spare row shown, and rows follow the hand', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `#${i}`, title: `Item ${i}`, status: 'open' }));
  const h = await mount(itemList, { rows: 4 });
  h.input('items', items);
  h.frame(3);
  expect(h.hasText('#4  Item 4')).toBe(false);
  const rowH = 0.0125 * 2.9;
  h.drag('row:1', [0, rowH * 2, 0], { steps: 8, end: false }); // past the tap threshold, then 1.55 rows of content travel
  h.frame(3);
  expect(h.hasText('#4  Item 4')).toBe(true); // the spare row is partly visible at the bottom
  expect(h.hasText('#1  Item 1')).toBe(true); // and the top row partly visible
  expect(h.rec.errors).toEqual([]);
  h.dispose();
});

it('item-list: scrolling less than a row keeps every in-view item in its text object (no re-layout flicker)', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `#${i}`, title: `Item ${i}`, status: 'open' }));
  const h = await mount(itemList, { rows: 4 });
  h.input('items', items);
  h.frame(3);
  const textOf = (s: string) => h.root.getObjectsByProperty('text', s)[0];
  const before = textOf('#2  Item 2');
  const rowH = 0.0125 * 2.9;
  h.drag('row:1', [0, rowH * 1.4, 0], { steps: 8, end: false }); // ≈ 1 row of content travel after the tap threshold
  h.frame(3);
  expect(textOf('#2  Item 2')).toBe(before); // same mesh, text never re-set
  expect(textOf('#2  Item 2').visible).toBe(true);
  h.dispose();
});
