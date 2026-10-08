import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RuntimeUiKit, rampColor } from '../src/ui/UiKit.ts';
import { stubTextFactory } from '../src/ui/stubText.ts';
import { DEFAULT_THEME, createTheme } from '../src/theme.ts';
import { isShared } from '../src/ui/geometry.ts';
import { fontUrl } from '../src/ui/fonts.ts';

const kit = () => new RuntimeUiKit(createTheme(), { textFactory: stubTextFactory });

describe('theme', () => {
  it('has a usable categorical palette and ramps', () => {
    expect(DEFAULT_THEME.palette.length).toBeGreaterThanOrEqual(8);
    expect(new Set(DEFAULT_THEME.palette).size).toBe(DEFAULT_THEME.palette.length);
    expect(DEFAULT_THEME.diverging).toHaveLength(3);
    // Sequential ramp lightness increases monotonically.
    const l = DEFAULT_THEME.sequential.map((h) => new THREE.Color(h).getHSL({ h: 0, s: 0, l: 0 }).l);
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
  });

  it('createTheme copies arrays and applies overrides', () => {
    const t = createTheme({ accent: '#123456' });
    t.palette.push('#000000');
    expect(DEFAULT_THEME.palette).not.toContain('#000000');
    expect(t.accent).toBe('#123456');
  });
});

describe('rampColor', () => {
  const th = createTheme();
  const hex = (c: THREE.Color) => '#' + c.getHexString();
  it('palette: integer index wraps, fraction scales', () => {
    expect(hex(rampColor(th, 'palette', 0, new THREE.Color()))).toBe(th.palette[0]);
    expect(hex(rampColor(th, 'palette', th.palette.length + 1, new THREE.Color()))).toBe(th.palette[1]);
    expect(hex(rampColor(th, 'palette', 0.99, new THREE.Color()))).toBe(th.palette[th.palette.length - 1]);
  });
  it('diverging: -1 / 0 / +1 hit the three stops', () => {
    expect(hex(rampColor(th, 'diverging', -1, new THREE.Color()))).toBe(th.diverging[0]);
    expect(hex(rampColor(th, 'diverging', 0, new THREE.Color()))).toBe(th.diverging[1]);
    expect(hex(rampColor(th, 'diverging', 5, new THREE.Color()))).toBe(th.diverging[2]);
  });
  it('sequential: endpoints and clamping, NaN safe', () => {
    expect(hex(rampColor(th, 'sequential', 0, new THREE.Color()))).toBe(th.sequential[0]);
    expect(hex(rampColor(th, 'sequential', 2, new THREE.Color()))).toBe(th.sequential.at(-1));
    expect(hex(rampColor(th, 'sequential', NaN, new THREE.Color()))).toBe(th.sequential[0]);
  });
  it('kit.color reuses a target when given', () => {
    const k = kit();
    const target = new THREE.Color();
    expect(k.color('palette', 2, target)).toBe(target);
  });
});

describe('RuntimeUiKit', () => {
  it('caches materials and panel geometry, marked shared', () => {
    const k = kit();
    expect(k.material('#ff0000')).toBe(k.material('#ff0000'));
    expect(k.material('#ff0000', { opacity: 0.5 })).not.toBe(k.material('#ff0000'));
    const m = k.material('#ff0000', { opacity: 0.5 }) as THREE.MeshBasicMaterial;
    expect(m.transparent).toBe(true);
    expect(isShared(m)).toBe(true);
    const p1 = k.panel(0.4, 0.3);
    const p2 = k.panel(0.4, 0.3);
    expect(p1.geometry).toBe(p2.geometry);
    expect(isShared(p1.geometry)).toBe(true);
    expect(p1.getObjectByName('panel-border')).toBeDefined();
    expect(k.panel(0.4, 0.3, { border: false }).children).toHaveLength(0);
  });

  it('text: fonts, options, and batched sync on flush', () => {
    const k = kit();
    const t = k.text('hello', { size: 0.05, font: 'mono', anchorX: 'left', maxWidth: 0.3, color: '#abcdef' });
    expect(t.font).toBe(fontUrl('mono'));
    expect(t.fontSize).toBe(0.05);
    expect(t.anchorX).toBe('left');
    expect(t.maxWidth).toBe(0.3);
    expect(t.color).toBe('#abcdef');
    const st = t as unknown as { syncCount: number };
    expect(st.syncCount).toBe(0);
    k.flush();
    expect(st.syncCount).toBe(1);
    t.set('hello'); // unchanged → no resync
    t.set('world');
    t.set('world!');
    k.flush();
    expect(st.syncCount).toBe(2);
    expect(t.text).toBe('world!');
    expect(k.textEx('x', { weight: 'semibold' }).font).toBe(fontUrl('sansSemiBold'));
  });
});
