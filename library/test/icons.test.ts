// shared/icons.ts — Lucide icons stroked into flat meshes.
import { expect, it } from 'vitest';
import * as THREE from 'three';
import { hasIcon, iconTriangles, makeIcon, setIcon } from '../shared/icons.ts';

it('strokes every generated icon inside the unit box', () => {
  for (const name of ['play', 'pause', 'volume-2', 'rotate-ccw', 'gauge', 'git-pull-request']) {
    expect(hasIcon(name)).toBe(true);
    const t = iconTriangles(name);
    expect(t.length % 9).toBe(0);
    expect(t.length).toBeGreaterThan(9 * 20);
    let max = 0;
    for (let i = 0; i < t.length; i += 3) max = Math.max(max, Math.abs(t[i]), Math.abs(t[i + 1]));
    expect(max).toBeLessThanOrEqual(0.5 + 1e-6); // 24-unit box incl. the stroke
  }
  expect(() => iconTriangles('no-such-icon')).toThrow(/gen-lucide/);
});

it('makes sized meshes, falls back for unknown names, swaps shapes', () => {
  const m = makeIcon({ THREE }, 'play', { size: 0.02, color: '#ffffff' });
  expect(m.scale.x).toBeCloseTo(0.02);
  const playGeo = m.geometry;
  setIcon(THREE, m, 'pause');
  expect(m.name).toBe('icon:pause');
  expect(m.geometry).not.toBe(playGeo);
  setIcon(THREE, m, 'play');
  expect(m.geometry).toBe(playGeo); // shared per icon
  expect(makeIcon({ THREE }, 'nope', { size: 1, color: '#fff' }).name).toBe('icon:circle-question-mark');
});
