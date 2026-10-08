// Charts: line-plot, bar-chart, heatmap.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import linePlot from '../widgets/line-plot/widget.ts';
import barChart from '../widgets/bar-chart/widget.ts';
import heatmap from '../widgets/heatmap/widget.ts';
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

const line = (x: Harness, i = 0) => x.root.getObjectByName(`series-${i}`) as THREE.Line;
const drawCount = (l: THREE.Line) => l.geometry.drawRange.count;
const ys = (l: THREE.Line) => {
  const pos = l.geometry.getAttribute('position').array as Float32Array;
  return Array.from({ length: drawCount(l) }, (_, i) => pos[i * 3 + 1]);
};

describe('line-plot', () => {
  it('streams values into a rolling window, newest at the right edge', async () => {
    h = await mount(linePlot, { window: 5, title: 'loss' });
    for (let i = 1; i <= 8; i++) h.input('value', i);
    h.frame();
    const l = line(h);
    expect(drawCount(l)).toBe(5);
    const v = ys(l);
    expect(v[4]).toBeGreaterThan(v[0]); // increasing data → rising line
    expect(h.hasText('8')).toBe(true); // latest value
    expect(h.hasText('loss')).toBe(true);
    expect(h.hasText('now')).toBe(true);
  });

  it('coalesces many samples per frame into one redraw', async () => {
    h = await mount(linePlot, { window: 100 });
    for (let i = 0; i < 50; i++) h.input('value', Math.sin(i));
    const before = (line(h).geometry.getAttribute('position') as THREE.BufferAttribute).version;
    h.frame();
    expect((line(h).geometry.getAttribute('position') as THREE.BufferAttribute).version).toBe(before + 1);
  });

  it('multi-series streams via number[] and whole series via tensor [S, N]', async () => {
    h = await mount(linePlot, {});
    h.input('value', [1, 2]);
    h.input('value', [2, 3]);
    h.frame();
    expect(line(h, 1)).toBeTruthy();
    expect(drawCount(line(h, 0))).toBe(2);
    h.input('series', tensor('f32', [3, 4], [0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 1, 1]));
    h.frame();
    expect(line(h, 2)).toBeTruthy();
    expect(drawCount(line(h, 0))).toBe(4);
    const s0 = ys(line(h, 0));
    const s1 = ys(line(h, 1));
    expect(s0[0]).toBeCloseTo(s1[3]);
    // Different series colors (first = prop color, then palette).
    const c0 = (line(h, 0).material as THREE.LineBasicMaterial).color.getHex();
    const c1 = (line(h, 1).material as THREE.LineBasicMaterial).color.getHex();
    expect(c0).not.toBe(c1);
  });

  it('fixed range clamps, clear empties, NaN does not break the line', async () => {
    h = await mount(linePlot, { autoscale: false, min: 0, max: 1 });
    h.input('series', [0, 0.5, 5, NaN]);
    h.frame();
    const v = ys(line(h));
    expect(Math.max(...v)).toBeLessThanOrEqual(v[2] + 1e-9); // 5 clamps to the top
    expect(v.every(Number.isFinite)).toBe(true);
    h.input('clear', true);
    h.frame();
    expect(line(h)).toBeUndefined();
  });

  it('reads a channel: numbers stream, arrays replace', async () => {
    h = await mount(linePlot, { channel: 'train.loss' });
    h.publish('train.loss', 1);
    h.publish('train.loss', 0.5);
    h.frame();
    expect(drawCount(line(h))).toBe(2);
    h.publish('train.loss', [3, 2, 1]);
    h.frame();
    expect(drawCount(line(h))).toBe(3);
  });

  it('keeps data across prop rebuilds and rejects unusable values', async () => {
    h = await mount(linePlot, {});
    h.input('series', [1, 2, 3]);
    h.frame();
    await h.setProps({ title: 'renamed', color: 'secondary' });
    h.frame();
    expect(drawCount(line(h))).toBe(3);
    h.input('series', { nope: true });
    expect(h.rec.errors).toHaveLength(1);
  });
});

describe('bar-chart', () => {
  it('draws one instanced bar per {label, value}, with labels and values', async () => {
    h = await mount(barChart, { title: 'Probes' });
    h.input('data', [{ label: 'a', value: 1 }, { label: 'b', value: 3 }, { label: 'c', value: -2 }]);
    h.frame();
    const bars = h.root.getObjectByName('bars') as THREE.InstancedMesh;
    expect(bars.count).toBe(3);
    expect(h.hasText('a')).toBe(true);
    expect(h.hasText('3')).toBe(true);
    expect(h.hasText('-2')).toBe(true);
    // Negative bar hangs below the positive bars' base.
    const pos = (i: number) => new THREE.Vector3().setFromMatrixPosition(instanceMatrix(bars, i));
    const scl = (i: number) => new THREE.Vector3().setFromMatrixScale(instanceMatrix(bars, i));
    expect(pos(2).y + scl(2).y / 2).toBeCloseTo(pos(0).y - scl(0).y / 2, 5);
    expect(scl(1).y).toBeCloseTo(scl(0).y * 3, 4);
  });

  it('accepts records, arrays, tensors; palette colors; label prop fallback', async () => {
    h = await mount(barChart, { color: 'palette', labels: ['x', 'y'] });
    h.input('data', { p: 1, q: 2 });
    h.frame();
    expect(h.hasText('p')).toBe(true);
    h.input('data', [5, 6]);
    h.frame();
    expect(h.hasText('x')).toBe(true);
    const bars = h.root.getObjectByName('bars') as THREE.InstancedMesh;
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    bars.getColorAt(0, c0);
    bars.getColorAt(1, c1);
    expect(c0.equals(c1)).toBe(false);
    h.input('data', tensor('f32', [2, 2], [1, 2, 3, 4]));
    h.frame();
    expect(bars.count).toBe(4);
  });

  it('hides texts for many bars and caps at maxBars', async () => {
    h = await mount(barChart, { maxBars: 40 });
    h.input('data', Array.from({ length: 100 }, (_, i) => i));
    h.frame();
    expect((h.root.getObjectByName('bars') as THREE.InstancedMesh).count).toBe(40);
    // Per-bar value texts are hidden (axis ticks are multiples of 10).
    expect(h.hasText('35')).toBe(false);
    expect(h.hasText('7')).toBe(false);
  });

  it('interactive bars emit {index, label, value} on press', async () => {
    h = await mount(barChart, { interactive: true });
    h.input('data', [{ label: 'a', value: 1 }, { label: 'b', value: 2 }]);
    h.frame();
    const bars = h.root.getObjectByName('bars') as THREE.InstancedMesh;
    const p = new THREE.Vector3().setFromMatrixPosition(instanceMatrix(bars, 1));
    h.interact({ handler: 'press', phase: 'start', objectName: 'bars', localPoint: [p.x, p.y, 0] });
    expect(h.lastEmit('bar')).toEqual({ index: 1, label: 'b', value: 2 });
  });
});

describe('heatmap', () => {
  const m = [[0, 1, 2], [3, 4, 5]];

  it('uploads a DataTexture (row 0 at the top) and shows colorbar extents', async () => {
    h = await mount(heatmap, {});
    h.input('data', m);
    h.frame();
    const quad = h.root.getObjectByName('cells') as THREE.Mesh;
    const tex = (quad.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    expect(tex.image.width).toBe(3);
    expect(tex.image.height).toBe(2);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    const d = tex.image.data as Uint8Array;
    // Texture row 1 (top) holds matrix row 0 → its first cell is the minimum (darkest).
    const top0 = d.slice(3 * 4, 3 * 4 + 3);
    const bottom2 = d.slice(2 * 4, 2 * 4 + 3);
    expect(top0[0] + top0[1] + top0[2]).toBeLessThan(bottom2[0] + bottom2[1] + bottom2[2]);
    expect(h.hasText('0')).toBe(true);
    expect(h.hasText('5')).toBe(true);
  });

  it('reuses the texture for same-shape updates and reallocates on shape change', async () => {
    h = await mount(heatmap, {});
    h.input('data', tensor('f32', [2, 3], [0, 1, 2, 3, 4, 5]));
    h.frame();
    const quad = h.root.getObjectByName('cells') as THREE.Mesh;
    const t1 = (quad.material as THREE.MeshBasicMaterial).map;
    h.input('data', tensor('f32', [2, 3], [5, 4, 3, 2, 1, 0]));
    h.frame();
    expect((quad.material as THREE.MeshBasicMaterial).map).toBe(t1);
    h.input('data', tensor('f32', [4, 4, 4], new Array(64).fill(1))); // rank 3 → first [4, 4] slice
    h.frame();
    const t2 = (quad.material as THREE.MeshBasicMaterial).map as THREE.DataTexture;
    expect(t2).not.toBe(t1);
    expect(t2.image.width).toBe(4);
  });

  it('diverging autoscale is symmetric around zero', async () => {
    h = await mount(heatmap, { colormap: 'diverging' });
    h.input('data', [[-1, 3]]);
    h.frame();
    expect(h.hasText('-3')).toBe(true);
    expect(h.hasText('3')).toBe(true);
  });

  it('hover emits cell (once per cell) and highlights it; press emits select; leaving emits null', async () => {
    h = await mount(heatmap, { rowLabels: ['r0', 'r1'], colLabels: ['a', 'b', 'c'] });
    h.input('data', m);
    h.frame();
    const quad = h.root.getObjectByName('cells') as THREE.Mesh;
    // Center of cell (row 1, col 2): quad spans its scale around its position.
    const cx = quad.position.x + quad.scale.x * (2.5 / 3 - 0.5);
    const cy = quad.position.y + quad.scale.y * (0.5 - 1.5 / 2);
    h.interact({ handler: 'hover', phase: 'start', objectName: 'cells', localPoint: [cx, cy, 0] });
    h.interact({ handler: 'hover', phase: 'move', objectName: 'cells', localPoint: [cx + 0.001, cy, 0] });
    expect(h.emitsOn('cell')).toEqual([{ row: 1, col: 2, value: 5 }]);
    expect(h.hasText(/r1 · c\s+5/)).toBe(true);
    h.interact({ handler: 'press', phase: 'start', objectName: 'cells', localPoint: [cx, cy, 0] });
    expect(h.lastEmit('select')).toEqual({ row: 1, col: 2, value: 5 });
    h.interact({ handler: 'hover', phase: 'end', objectName: 'cells', localPoint: [cx, cy, 0] });
    expect(h.lastEmit('cell')).toBeNull();
    expect(h.visibleTexts()).toEqual(expect.arrayContaining(['r0', 'r1', 'a', 'b', 'c']));
  });

  it('non-interactive heatmaps register no hit targets; bad data reports an error', async () => {
    h = await mount(heatmap, { interactive: false });
    expect(h.interactives.size).toBe(0);
    h.input('data', 'nope');
    expect(h.rec.errors).toHaveLength(1);
  });
});

describe('instanced bounds (runtime picker/framing view)', () => {
  it('bar chart bounds equal the card, not a 1 m unit box', async () => {
    h = await mount(barChart, { width: 0.4, height: 0.24 });
    h.input('data', [1, 2, 3]);
    h.frame();
    const size = pickerBounds(h.root).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(0.4, 3);
    expect(size.y).toBeCloseTo(0.24, 3);
  });
});
