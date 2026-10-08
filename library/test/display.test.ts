// Display widgets: shape, box, group, text, panel, image, channel-view.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import shape from '../widgets/shape/widget.ts';
import box from '../widgets/box/widget.ts';
import group from '../widgets/group/widget.ts';
import text from '../widgets/text/widget.ts';
import panel from '../widgets/panel/widget.ts';
import image from '../widgets/image/widget.ts';
import channelView from '../widgets/channel-view/widget.ts';
import { FakeText, mount, tensor, type Harness } from './harness.ts';

let h: Harness | null = null;
afterEach(() => {
  if (h) {
    h.dispose();
    expect(h.rec.afterDispose).toEqual([]);
    expect(h.root.children).toHaveLength(0);
  }
  h = null;
});

const body = (x: Harness) => x.root.getObjectByName('body') as THREE.Mesh;

describe('shape', () => {
  it('renders every kind with shared geometry scaled to size × dims', async () => {
    for (const kind of shape.props!.kind.options!) {
      const x = await mount(shape, { kind, size: 0.2, dims: [1, 2, 0.5] });
      const m = body(x);
      expect(m.geometry.userData.evolShared).toBe(true);
      expect(m.scale.toArray()).toEqual([0.2, 0.4, 0.1]);
      x.dispose();
    }
  });

  it('applies color tokens, opacity and wireframe; outline adds edges; label shows', async () => {
    h = await mount(shape, { color: 'positive', opacity: 0.5, outline: true, label: 'A' });
    const mat = body(h).material as THREE.MeshBasicMaterial;
    expect('#' + mat.color.getHexString(THREE.SRGBColorSpace)).toBe('#45d49b');
    expect(mat.transparent).toBe(true);
    expect(h.root.getObjectByName('outline')).toBeTruthy();
    expect(h.hasText('A')).toBe(true);
    await h.setProps({ wireframe: true });
    expect((body(h).material as THREE.MeshBasicMaterial).wireframe).toBe(true);
  });

  it('inputs override color, scale and visibility', async () => {
    h = await mount(shape, { size: 0.1 });
    h.input('color', 'negative');
    expect('#' + (body(h).material as THREE.MeshBasicMaterial).color.getHexString(THREE.SRGBColorSpace)).toBe('#ff5d6c');
    h.input('scale', 3);
    expect(body(h).scale.x).toBeCloseTo(0.3);
    h.input('visible', false);
    expect(h.root.getObjectByName('shape')!.visible).toBe(false);
    // Rebuild on props keeps input overrides.
    await h.setProps({ kind: 'sphere' });
    expect(body(h).scale.x).toBeCloseTo(0.3);
    expect(h.root.getObjectByName('shape')!.visible).toBe(false);
  });

  it('pressable shapes emit press and are not interactive otherwise', async () => {
    h = await mount(shape, {});
    expect(h.interactives.size).toBe(0);
    await h.setProps({ pressable: true });
    h.press('body');
    expect(h.emitsOn('press')).toHaveLength(1);
  });
});

describe('box', () => {
  it('is a shape with kind fixed to box', async () => {
    h = await mount(box, { size: 0.3 });
    expect(box.props!.kind).toBeUndefined();
    expect(body(h).geometry.type).toBe('BoxGeometry');
    expect(body(h).scale.x).toBeCloseTo(0.3);
  });
});

describe('group', () => {
  it('has no visuals by default; handle shows a grab bar', async () => {
    h = await mount(group, {});
    expect(h.drawables()).toBe(0);
    await h.setProps({ handle: true, label: 'cluster' });
    expect(h.root.getObjectByName('grab-bar')).toBeTruthy();
    expect(h.hasText('cluster')).toBe(true);
    expect(h.interactives.size).toBe(0); // grabbing the bar grabs the group
  });
});

describe('text', () => {
  it('renders text with props and replaces it from the input', async () => {
    h = await mount(text, { text: 'Hello', size: 0.05, color: 'accent', align: 'left' });
    const t = h.texts.find((x) => x.text === 'Hello')!;
    expect(t.fontSize).toBe(0.05);
    expect(t.color).toBe('#4cc3ff');
    expect(t.anchorX).toBe('left');
    h.input('text', 3.14159);
    expect(h.hasText('3.142')).toBe(true);
    h.input('text', { a: 1 });
    expect(h.hasText('{"a":1}')).toBe(true);
  });

  it('background plate fits the text and follows changes', async () => {
    h = await mount(text, { text: 'Hi', background: true });
    h.frame();
    const w1 = h.bounds().getSize(new THREE.Vector3()).x;
    h.input('text', 'A much longer line of text');
    h.frame();
    const w2 = h.bounds().getSize(new THREE.Vector3()).x;
    expect(w2).toBeGreaterThan(w1 * 3);
    expect(h.root.getObjectByName('panel')).toBeTruthy();
  });

  it('billboard turns to face the camera (yaw keeps it upright)', async () => {
    h = await mount(text, { text: 'B', billboard: 'yaw' });
    const label = h.texts.find((x) => x.text === 'B')!;
    expect(typeof label.onBeforeRender).toBe('function');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(1, 1.5, 0); // to the +X side, above
    cam.updateMatrixWorld();
    h.root.updateMatrixWorld(true);
    label.onBeforeRender({ info: { render: { frame: 1 } } } as never, new THREE.Scene(), cam, label.geometry, label.material as THREE.Material, null as never);
    expect(label.prepared).toBe(1); // troika's own onBeforeRender still runs (chained)
    const pivot = h.root.getObjectByName('text-pivot')!;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(pivot.quaternion);
    expect(fwd.x).toBeCloseTo(1, 5);
    expect(fwd.y).toBeCloseTo(0, 5);
    await h.setProps({ billboard: 'off' });
    expect(pivot.quaternion.equals(new THREE.Quaternion())).toBe(true);
    // After a rebuild without billboarding the hooks are gone and troika's method is back.
    const fresh = h.texts.filter((x) => x.text === 'B' && !x.disposed).pop()!;
    expect(Object.prototype.hasOwnProperty.call(fresh, 'onBeforeRender')).toBe(false);
  });
});

describe('panel', () => {
  it('renders title and markup blocks (headings, bullets, code, rules)', async () => {
    h = await mount(panel, {
      title: 'Notes',
      body: '# Plan\n- first **bold**\n  - nested `code`\n1. numbered\n---\n```\nconst x = 1;\nx++;\n```\nplain para',
    });
    const texts = h.visibleTexts();
    expect(texts).toContain('Notes');
    expect(texts).toContain('Plan');
    expect(texts).toContain('first bold'); // markers stripped
    expect(texts).toContain('nested code');
    expect(texts).toContain('1.');
    expect(texts).toContain('const x = 1;\nx++;'); // fenced lines merged into one mono block
    expect(texts).toContain('plain para');
    expect(h.root.getObjectByName('rule')).toBeTruthy();
    expect(h.root.getObjectByName('code-bg')).toBeTruthy();
    const bold = h.texts.find((t) => t.text === 'first bold')!;
    expect(bold.colorRanges).toBeTruthy(); // inline emphasis colors
    const code = h.texts.find((t) => t.text.startsWith('const'))!;
    expect(code.font).toBe('mono');
  });

  it('auto-sizes to content and respects fixed width', async () => {
    h = await mount(panel, { title: 'T', body: 'short' });
    h.frame();
    const small = h.bounds().getSize(new THREE.Vector3());
    h.input('body', 'a much longer body line that will need to wrap around at least once or twice in the panel\n- and\n- more\n- bullets');
    h.frame();
    const big = h.bounds().getSize(new THREE.Vector3());
    expect(big.y).toBeGreaterThan(small.y * 2);
    expect(big.x).toBeLessThanOrEqual(0.45 + 1e-6);
    await h.setProps({ width: 0.6 });
    h.frame();
    expect(h.bounds().getSize(new THREE.Vector3()).x).toBeCloseTo(0.6, 3);
  });

  it('non-string body input renders as a JSON code block; title input replaces the title', async () => {
    h = await mount(panel, {});
    h.input('body', { loss: 0.5, step: 10 });
    expect(h.visibleTexts().some((t) => t.includes('"loss": 0.5'))).toBe(true);
    h.input('title', 'Status');
    expect(h.hasText('Status')).toBe(true);
  });

  it('keeps text inside the card (content below the top edge, left of the right edge)', async () => {
    h = await mount(panel, { title: 'Title', body: 'line one\nline two' });
    h.frame();
    const card = h.root.getObjectByName('card') as THREE.Mesh;
    card.geometry.computeBoundingBox();
    const cb = card.geometry.boundingBox!;
    h.root.updateMatrixWorld(true);
    for (const t of h.texts.filter((x) => !x.disposed && x.parent)) {
      const bb = t.textRenderInfo!.blockBounds;
      const p = t.position;
      expect(p.y + bb[3]).toBeLessThanOrEqual(cb.max.y + 1e-6);
      expect(p.y + bb[1]).toBeGreaterThanOrEqual(cb.min.y - 1e-6);
      expect(p.x + bb[2]).toBeLessThanOrEqual(cb.max.x + 1e-6);
    }
  });
});

describe('image', () => {
  it('shows a placeholder without url and reports loader failures without throwing', async () => {
    h = await mount(image, {});
    expect(h.hasText('no image')).toBe(true);
    // Node has no DOM image loader: the widget must degrade to an error message.
    await h.setProps({ url: 'https://example.com/x.png' });
    expect(h.rec.errors.length).toBeGreaterThan(0);
  });

  it('renders pixel tensors (u8 RGB and float grayscale) with the right aspect', async () => {
    h = await mount(image, { width: 0.4 });
    const px = new Uint8Array(2 * 4 * 3).fill(200);
    h.input('pixels', tensor('u8', [2, 4, 3], px));
    const quad = h.root.getObjectByName('image') as THREE.Mesh;
    const mat = quad.material as THREE.MeshBasicMaterial;
    expect(mat.map).toBeInstanceOf(THREE.DataTexture);
    expect(quad.scale.x).toBeCloseTo(0.4);
    expect(quad.scale.y).toBeCloseTo(0.2);
    const data = (mat.map as THREE.DataTexture).image.data as Uint8Array;
    expect(Array.from(data.slice(0, 4))).toEqual([200, 200, 200, 255]);
    // Same size → texture reused in place.
    const tex = mat.map;
    h.input('pixels', tensor('u8', [2, 4, 3], px));
    expect(mat.map).toBe(tex);
    h.input('pixels', tensor('f32', [3, 3], new Array(9).fill(0.5)));
    expect(((mat.map as THREE.DataTexture).image.data as Uint8Array)[0]).toBe(128);
    // Prop rebuild keeps the texture.
    await h.setProps({ caption: 'cap' });
    expect(((h.root.getObjectByName('image') as THREE.Mesh).material as THREE.MeshBasicMaterial).map).toBeTruthy();
    expect(h.hasText('cap')).toBe(true);
  });

  it('rejects malformed pixel tensors via ctx.error', async () => {
    h = await mount(image, {});
    h.input('pixels', tensor('u8', [2, 2, 2], new Array(8).fill(0)));
    expect(h.rec.errors.some((e) => e.message.includes('channel count'))).toBe(true);
  });
});

describe('channel-view', () => {
  it('summarizes tensors (stats, signature, histogram) at a limited rate', async () => {
    h = await mount(channelView, { channel: 'interp.resid.norm' });
    h.frame();
    expect(h.hasText('waiting for a value…')).toBe(true);
    h.publish('interp.resid.norm', tensor('f32', [2, 3], [1, 2, 3, 4, NaN, 6]));
    h.frame();
    expect(h.hasText('tensor f32[2, 3]')).toBe(false); // rate-limited (default 5 Hz)
    h.frame(20);
    expect(h.hasText('interp.resid.norm')).toBe(true);
    expect(h.hasText('tensor f32[2, 3]')).toBe(true);
    expect(h.hasText(/min {2}1\n/)).toBe(true);
    expect(h.hasText('non-finite 1 of 6')).toBe(true);
    const hist = h.root.getObjectByName('histogram') as THREE.InstancedMesh;
    expect(hist.count).toBe(32);
    expect(h.hasText(/#1 · now/)).toBe(true);
  });

  it('pretty-prints JSON, truncates long values, and inspects a linked input', async () => {
    h = await mount(channelView, { maxLines: 4 });
    h.input('value', { a: 1, b: [1, 2, 3], c: 'x' });
    h.frame();
    expect(h.hasText('json object(3 keys)')).toBe(true);
    expect(h.hasText(/more lines/)).toBe(true);
    expect(h.hasText('input: value')).toBe(true);
  });

  it('decodes f16 tensors', async () => {
    h = await mount(channelView, {});
    h.input('value', tensor('f16', [2], [0x3c00, 0xc000])); // 1, -2
    h.frame();
    expect(h.hasText(/max {2}1\n/)).toBe(true);
    expect(h.hasText(/min {2}-2\n/)).toBe(true);
  });
});

describe('harness sanity', () => {
  it('FakeText measures like the runtime stub', () => {
    const t = new FakeText();
    t.text = 'abcd';
    t.fontSize = 0.1;
    t.anchorX = 'left';
    t.sync();
    expect(t.textRenderInfo!.blockBounds[2]).toBeCloseTo(0.22);
  });
});
