// library/shared helpers.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { hexToInt, mixHex, paletteColor, parseHex, resolveColor } from '../shared/color.ts';
import { buildLut, categoryT, divergingT, lutColor, lutIndex, rangeT } from '../shared/colormap.ts';
import { formatAge, formatBytes, formatNumber, formatTick, formatValue, truncate } from '../shared/format.ts';
import { estimateTextBlock, niceRange, niceTicks, snap, stackDown } from '../shared/layout.ts';
import { asLabeled, asMatrix, asPoints, asSeries, asVector, extent, halfToFloat, normalize, offsetOf, stats, strides, tensorAt, toFloat32, toScalar } from '../shared/tensor.ts';
import { parseInline, parseMarkup, spanColorRanges } from '../shared/text.ts';
import { DragHandle, PressTracker, along } from '../shared/handle.ts';
import { ChannelProp, Throttle } from '../shared/binding.ts';
import { disposeTree, isShared, ownMaterial, shadedGeometry, sharedGeometry, UNIT_GEOMETRIES } from '../shared/resources.ts';
import { SegmentMath, readVec3 } from '../shared/segments.ts';
import { TEST_THEME, tensor } from './harness.ts';

describe('color', () => {
  it('resolves theme tokens, hex, numbers and falls back', () => {
    expect(resolveColor(TEST_THEME, 'accent')).toBe(TEST_THEME.accent);
    expect(resolveColor(TEST_THEME, 'secondary')).toBe(TEST_THEME.accent2);
    expect(resolveColor(TEST_THEME, 'Dim')).toBe(TEST_THEME.textDim);
    expect(resolveColor(TEST_THEME, '#123456')).toBe('#123456');
    expect(resolveColor(TEST_THEME, 0x00ff00)).toBe('#00ff00');
    expect(resolveColor(TEST_THEME, 'palette:2')).toBe(TEST_THEME.palette[2]);
    expect(resolveColor(TEST_THEME, '', 'negative')).toBe(TEST_THEME.negative);
    expect(resolveColor(TEST_THEME, undefined)).toBe(TEST_THEME.accent);
    expect(paletteColor(TEST_THEME, -1)).toBe(TEST_THEME.palette[TEST_THEME.palette.length - 1]);
  });

  it('parses and mixes hex', () => {
    expect(parseHex('#4af')).toEqual([0x44, 0xaa, 0xff]);
    expect(parseHex('#11223344')).toEqual([0x11, 0x22, 0x33]);
    expect(parseHex('red')).toBeNull();
    expect(hexToInt('#010203')).toBe(0x010203);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('colormap', () => {
  it('builds LUTs whose ends match the stops', () => {
    const lut = buildLut(TEST_THEME, 'sequential', 64);
    expect(lut.bytes.length).toBe(256);
    expect(Array.from(lut.bytes.slice(0, 3))).toEqual(parseHex(TEST_THEME.sequential[0]));
    expect(Array.from(lut.bytes.slice(63 * 4, 63 * 4 + 3))).toEqual(parseHex(TEST_THEME.sequential.at(-1)!));
    const div = buildLut(TEST_THEME, 'diverging', 3);
    expect(Array.from(div.bytes.slice(4, 7))).toEqual(parseHex(TEST_THEME.diverging[1]));
    expect(lutIndex(lut, NaN)).toBe(0);
    expect(lutIndex(lut, 2)).toBe(63);
  });

  it('palette LUT is categorical and categoryT picks each color', () => {
    const lut = buildLut(TEST_THEME, 'palette');
    for (let k = 0; k < TEST_THEME.palette.length; k++) {
      const i = lutIndex(lut, categoryT(k, TEST_THEME.palette.length)) * 4;
      expect(Array.from(lut.bytes.slice(i, i + 3))).toEqual(parseHex(TEST_THEME.palette[k]));
    }
  });

  it('maps values', () => {
    expect(divergingT(0, 5)).toBe(0.5);
    expect(divergingT(-10, 5)).toBe(0);
    expect(rangeT(5, 0, 10)).toBe(0.5);
    expect(rangeT(5, 1, 1)).toBe(0.5);
    const c = lutColor(THREE, buildLut(TEST_THEME, 'gray', 2), 1, new THREE.Color());
    expect(c.getHexString(THREE.SRGBColorSpace)).toBe('f0f0f0');
  });
});

describe('format', () => {
  it('formats numbers in every mode', () => {
    expect(formatNumber(1234.5678)).toBe('1,235');
    expect(formatNumber(0.000123456)).toBe('0.0001235');
    expect(formatNumber(0.00001234)).toBe('1.234e-5');
    expect(formatNumber(12, { unit: 'ms' })).toBe('12 ms');
    expect(formatNumber(1.5, { format: 'fixed', precision: 3 })).toBe('1.500');
    expect(formatNumber(1234567, { format: 'int' })).toBe('1,234,567');
    expect(formatNumber(0.256, { format: 'percent', precision: 1 })).toBe('25.6%');
    expect(formatNumber(12345, { format: 'sci', precision: 3 })).toBe('1.23e+4');
    expect(formatNumber(1500, { format: 'si', precision: 2, unit: 'B' })).toBe('1.5 kB');
    expect(formatNumber(0.002, { format: 'si' })).toBe('2m');
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(-Infinity)).toBe('-∞');
  });

  it('formats ticks, values, ages, bytes, truncation', () => {
    expect(formatTick(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatTick(-0, 1)).toBe('0');
    expect(formatTick(20000, 10000)).toBe('20000');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(undefined)).toBe('—');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(formatAge(500)).toBe('now');
    expect(formatAge(90_000)).toBe('1 min');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});

describe('layout', () => {
  it('nice ticks cover the range with round steps', () => {
    expect(niceTicks(0, 1, 5)).toEqual({ ticks: [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1], step: 0.2 });
    const { ticks, step } = niceTicks(-3.7, 12.2, 5);
    expect(step).toBe(5);
    expect(ticks).toEqual([0, 5, 10]);
    expect(niceTicks(2, 2).ticks).toEqual([2]);
    expect(niceRange(0.13, 0.87)).toEqual([0, 1]);
    expect(niceRange(5, 5)).toEqual([4.5, 5.5]);
  });

  it('snaps to step within range without float noise', () => {
    expect(snap(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
    expect(snap(7.3, 0, 10, 2)).toBe(8);
    expect(snap(-4, 0, 10, 0)).toBe(0);
    expect(snap(3, 1, 10, 2)).toBe(3);
  });

  it('estimates text blocks and stacks', () => {
    const b = estimateTextBlock('aaaa aaaa', 0.1, 0.25);
    expect(b.lines).toBe(3); // character-based (conservative) wrapping: 4 chars per line
    expect(stackDown([0.1, 0.2], 0, 0.05)).toEqual([-0.05, -0.25]);
  });
});

describe('tensor', () => {
  it('decodes f16', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7bff)).toBe(65504);
    expect(halfToFloat(0x0001)).toBeCloseTo(5.96e-8, 10);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
  });

  it('indexes, converts and summarizes', () => {
    const t = tensor('f32', [2, 3], [1, 2, 3, 4, 5, 6]);
    expect(strides([2, 3, 4])).toEqual([12, 4, 1]);
    expect(offsetOf([2, 3], [1, 2])).toBe(5);
    expect(offsetOf([2, 3], [2, 0])).toBe(-1);
    expect(tensorAt(t, 1, 0)).toBe(4);
    expect(toFloat32(t)).toBe(t.data); // no copy for f32
    expect(Array.from(toFloat32(tensor('f16', [2], [0x3c00, 0x4000])))).toEqual([1, 2]);
    expect(Array.from(toFloat32(tensor('u8', [2], [3, 255])))).toEqual([3, 255]);
    const s = stats([1, 2, 3, NaN, Infinity]);
    expect(s).toMatchObject({ count: 3, nonFinite: 2, min: 1, max: 3, mean: 2 });
    expect(s.std).toBeCloseTo(Math.sqrt(2 / 3));
    expect(extent([NaN, 2, -1])).toEqual([-1, 2]);
    expect(extent([NaN])).toEqual([NaN, NaN]);
    expect(Array.from(normalize([0, 5, 10, 20], 0, 10))).toEqual([0, 0.5, 1, 1]);
  });

  it('coerces common shapes', () => {
    expect(toScalar('3')).toBe(3);
    expect(toScalar(tensor('f32', [1], [2]))).toBe(2);
    expect(toScalar({ value: 4 })).toBe(4);
    expect(toScalar([5])).toBe(5);
    expect(toScalar({})).toBeNaN();
    expect(Array.from(asVector([[1, 2], [3]])!)).toEqual([1, 2, 3]);
    expect(asVector('x')).toBeNull();
    const m = asMatrix([[1, 2], [3]])!;
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(2);
    expect(m.data[3]).toBeNaN();
    expect(asMatrix(tensor('f32', [2, 2, 2], [1, 2, 3, 4, 5, 6, 7, 8]))).toMatchObject({ rows: 2, cols: 2 });
    expect(asMatrix(tensor('f32', [3], [1, 2, 3]))).toMatchObject({ rows: 1, cols: 3 });
    expect(asPoints(tensor('f32', [2, 2], [1, 2, 3, 4]))!.xyz.length).toBe(6);
    expect(asPoints([[1, 2, 3]])!.count).toBe(1);
    expect(asPoints(tensor('f32', [2, 4], new Array(8).fill(0)))).toBeNull();
    expect(asSeries(tensor('f32', [2, 3], [1, 2, 3, 4, 5, 6]))!.map((s) => Array.from(s))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(asSeries([[1], [2]])).toHaveLength(2);
    expect(asLabeled([{ label: 'a', value: 1 }, { name: 'b', value: '2' }])).toEqual({ labels: ['a', 'b'], values: Float32Array.from([1, 2]) });
    expect(asLabeled({ x: 1, y: 'no' })!.labels).toEqual(['x']);
    expect(asLabeled([1, 2])!.labels).toBeNull();
  });
});

describe('markup', () => {
  it('parses inline bold/code and keeps unclosed markers', () => {
    expect(parseInline('a **b** `c` d')).toEqual({ text: 'a b c d', spans: [{ start: 2, end: 3, style: 'bold' }, { start: 4, end: 5, style: 'code' }] });
    expect(parseInline('2 ** 3').text).toBe('2 ** 3');
    expect(spanColorRanges([{ start: 2, end: 3, style: 'bold' }], 1, { bold: 2, code: 3 })).toEqual({ 0: 1, 2: 2, 3: 1 });
  });

  it('parses blocks', () => {
    const b = parseMarkup('\n# T\n\n\n- a\n    - b\n3. c\n**all bold**\n`all code`\n---\n```\n  x\n```\n');
    expect(b.map((x) => x.kind)).toEqual(['heading', 'blank', 'bullet', 'bullet', 'bullet', 'para', 'code', 'rule', 'code']);
    expect(b[3].indent).toBe(2);
    expect(b[4].marker).toBe('3.');
    expect(b[5].strong).toBe(true);
    expect(b[8].text).toBe('  x');
  });
});

describe('handle', () => {
  const ev = (handler: string, phase: 'start' | 'move' | 'end' | 'cancel', p: [number, number, number] = [0, 0, 0], hand: 'left' | 'right' = 'right') => ({
    handler, phase, hand, localPoint: p, point: p, pointer: { position: p, rotation: [0, 0, 0, 1] as [number, number, number, number] },
  });

  it('DragHandle tracks one hand, deltas and hover', () => {
    const calls: string[] = [];
    const d = new DragHandle(THREE, {
      onStart: (_p, part) => calls.push(`start:${part}`),
      onMove: (_p, delta) => calls.push(`move:${delta.x.toFixed(2)}`),
      onEnd: (c) => calls.push(`end:${c}`),
      onHover: (hv) => calls.push(`hover:${hv}`),
    });
    expect(d.handle({ ...ev('drag', 'start', [1, 0, 0]), objectName: 'knob' })).toBe(true);
    d.handle(ev('drag', 'move', [5, 0, 0], 'left')); // other hand ignored
    d.handle(ev('drag', 'move', [1.5, 0, 0]));
    d.handle(ev('drag', 'cancel'));
    d.handle(ev('hover', 'start'));
    d.handle(ev('hover', 'start', [0, 0, 0], 'left'));
    d.handle(ev('hover', 'end'));
    d.handle(ev('hover', 'end', [0, 0, 0], 'left'));
    expect(d.handle(ev('other', 'start'))).toBe(false);
    expect(calls).toEqual(['start:knob', 'move:0.50', 'end:true', 'hover:true', 'hover:false']);
    expect(along(new THREE.Vector3(1, 2, 3), [0, 1, 0])).toBe(2);
  });

  it('PressTracker merges hands and distinguishes cancel', () => {
    const p = new PressTracker();
    expect(p.handle(ev('press', 'start'))).toBe('down');
    expect(p.handle(ev('press', 'start', [0, 0, 0], 'left'))).toBeNull();
    expect(p.handle(ev('press', 'end'))).toBeNull();
    expect(p.handle(ev('press', 'cancel', [0, 0, 0], 'left'))).toBe('up');
    expect(p.handle(ev('press', 'start'))).toBe('down');
    expect(p.handle(ev('press', 'cancel'))).toBe('cancel');
    expect(p.handle(ev('drag', 'start'))).toBeNull();
  });
});

describe('binding', () => {
  it('Throttle: leading call, one trailing call with the latest value, flush/cancel', () => {
    vi.useFakeTimers();
    let now = 0;
    const seen: number[] = [];
    const t = new Throttle<number>((v) => seen.push(v), 100, () => now);
    t.call(1);
    t.call(2);
    t.call(3);
    expect(seen).toEqual([1]);
    now = 100;
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1, 3]);
    t.call(4);
    t.flush();
    expect(seen).toEqual([1, 3, 4]);
    now = 150;
    t.call(5);
    t.cancel();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1, 3, 4]);
    vi.useRealTimers();
  });

  it('ChannelProp re-subscribes only when the name changes', () => {
    const subs: string[] = [];
    const offs: string[] = [];
    const ctx = {
      props: { channel: 'a' } as Record<string, unknown>,
      channels: {
        get: () => undefined,
        publish: () => {},
        subscribe: (name: string, cb: (v: unknown) => void) => { subs.push(name); cb(1); return () => offs.push(name); },
      },
    };
    const got: unknown[] = [];
    const c = new ChannelProp(ctx, (v, ch) => got.push([ch, v]));
    c.refresh();
    ctx.props.channel = 'b';
    c.refresh();
    ctx.props.channel = '';
    c.refresh();
    expect(subs).toEqual(['a', 'b']);
    expect(offs).toEqual(['a', 'b']);
    expect(got).toEqual([['a', 1], ['b', 1]]);
  });
});

describe('resources & segments', () => {
  it('shared geometries are cached, tagged, and survive disposeTree', () => {
    for (const k of UNIT_GEOMETRIES) {
      const g = sharedGeometry(THREE, k);
      expect(isShared(g)).toBe(true);
      expect(sharedGeometry(THREE, k)).toBe(g);
      const size = g.boundingBox!.getSize(new THREE.Vector3());
      expect(Math.max(size.x, size.y, size.z)).toBeLessThanOrEqual(1 + 1e-6);
    }
    const own = new THREE.MeshBasicMaterial();
    let disposed = 0;
    own.addEventListener('dispose', () => disposed++);
    const g = sharedGeometry(THREE, 'box');
    let gDisposed = 0;
    g.addEventListener('dispose', () => gDisposed++);
    const parent = new THREE.Group();
    parent.add(new THREE.Mesh(g, own));
    disposeTree(parent);
    expect(disposed).toBe(1);
    expect(gDisposed).toBe(0);
  });

  it('shadedGeometry bakes a 0.4..1 shade into shared vertex colors; ownMaterial enables them', () => {
    const g = shadedGeometry(THREE, 'sphere');
    expect(isShared(g)).toBe(true);
    expect(shadedGeometry(THREE, 'sphere')).toBe(g);
    expect(g).not.toBe(sharedGeometry(THREE, 'sphere'));
    const c = g.getAttribute('color').array as Float32Array;
    expect(Math.min(...c)).toBeGreaterThanOrEqual(0.4 - 1e-6);
    expect(Math.max(...c)).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.max(...c) - Math.min(...c)).toBeGreaterThan(0.4); // visible variation
    expect(ownMaterial(THREE, '#fff', { shaded: true }).vertexColors).toBe(true);
    expect(ownMaterial(THREE, '#fff').vertexColors).toBe(false);
  });

  it('SegmentMath orients unit rods between points', () => {
    const s = new SegmentMath(THREE);
    const o = new THREE.Object3D();
    expect(s.place(o, 0, 0, 0, 1, 0, 0, 0.1)).toBeCloseTo(1);
    const tip = new THREE.Vector3(0, 0.5, 0).applyQuaternion(o.quaternion).add(o.position);
    expect(tip.x).toBeCloseTo(1);
    const m = new THREE.Matrix4();
    expect(s.rod(m, 0, 0, 0, 0, 0, 0, 1)).toBe(0);
    const out: [number, number, number] = [0, 0, 0];
    expect(readVec3({ x: 1, y: 2 }, out)).toBe(true);
    expect(out).toEqual([1, 2, 0]);
    expect(readVec3(tensor('f32', [3], [4, 5, 6]), out)).toBe(true);
    expect(readVec3('nope', out)).toBe(false);
  });
});
