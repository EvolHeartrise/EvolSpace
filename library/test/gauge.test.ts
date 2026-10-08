// gauge — also the worked example in library/widgets/README.md.
import { expect, it } from 'vitest';
import type * as THREE from 'three';
import gauge from '../widgets/gauge/widget.ts';
import { mount } from './harness.ts';

it('shows the value as text and as an arc proportional to (value - min) / (max - min)', async () => {
  const h = await mount(gauge, { max: 10, label: 'loss', unit: 'ms' });
  expect(h.hasText('loss')).toBe(true);
  h.input('value', 2.5);
  expect(h.hasText('2.5 ms')).toBe(true);
  const rings = h.root.getObjectByName('gauge')!.children.filter((o) => (o as THREE.Mesh).geometry?.type === 'RingGeometry') as THREE.Mesh[];
  const fill = rings[1];
  expect(fill.geometry.drawRange.count).toBe(16 * 6); // 25% of 64 segments
  h.input('value', 50); // clamps
  expect(fill.geometry.drawRange.count).toBe(64 * 6);
  h.input('value', 'nope'); // ignored
  expect(h.hasText('50 ms')).toBe(true);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('a prop value change is shown; other prop changes keep the input value', async () => {
  const h = await mount(gauge, { value: 0.5 });
  expect(h.hasText('0.5')).toBe(true);
  h.input('value', 0.7);
  await h.setProps({ label: 'acc' });
  expect(h.hasText('0.7')).toBe(true);
  await h.setProps({ value: 0.2 });
  expect(h.hasText('0.2')).toBe(true);
  h.dispose();
});
