// image: shows a picture from a URL or raw pixels on a quad (width fixed,
// height from the aspect ratio). URLs load with three's TextureLoader (needs
// CORS for cross-origin hosts); `pixels` takes an image tensor (e.g. a
// matplotlib render or camera frame published from Python).

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';
import { halfToFloat, isTensor } from '../../shared/tensor.ts';
import type { TensorValue } from '@evolspace/protocol';

interface ImageProps extends Record<string, unknown> {
  url: string;
  width: number;
  opacity: number;
  caption: string;
  frame: boolean;
}

const definition: WidgetDefinition<ImageProps> = {
  description:
    'Image on a quad: `url` (http(s)/data URL; cross-origin hosts need CORS) or input `pixels` = tensor [H, W, C] (C = 1/3/4; u8 0..255 or float 0..1) / [H, W] grayscale. ' +
    'Width fixed in meters, height from the aspect ratio; optional caption and frame.',
  version: '1.0.0',
  props: {
    url: { type: 'string', default: '', description: 'Image URL.' },
    width: { type: 'number', default: 0.3, min: 0.01, max: 10 },
    opacity: { type: 'number', default: 1, min: 0, max: 1 },
    caption: { type: 'string', default: '' },
    frame: { type: 'boolean', default: true, description: 'Card behind the image.' },
  },
  inputs: {
    url: { type: 'string', description: 'Load this URL (overrides the prop).' },
    pixels: { type: 'tensor', description: 'Image tensor (see description); overrides the URL.' },
  },
  outputs: {
    loaded: { type: 'json', description: '{width, height} in pixels after an image loaded.' },
  },
  size: [0.3, 0.2, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let quad: THREE.Mesh | null = null;
    let material: THREE.MeshBasicMaterial | null = null;
    let status: Text | null = null;
    let texture: THREE.Texture | null = null;
    let aspect = 4 / 3;
    let token = 0;
    let urlIn: string | null = null;
    let pixelBytes: Uint8Array | null = null;
    let message = '';

    function build(): void {
      // Keep the current texture across rebuilds: detach it so disposeTree skips it.
      if (material) material.map = null;
      if (group) disposeTree(group);
      const p = ctx.props;
      group = new T.Group();
      group.name = 'image-root';
      material = new T.MeshBasicMaterial({ color: 0xffffff, transparent: p.opacity < 1, opacity: p.opacity, side: T.DoubleSide, map: texture });
      quad = new T.Mesh(sharedGeometry(T, 'plane'), material);
      quad.name = 'image';
      quad.position.z = STYLE.zContent;
      group.add(quad);
      status = makeText(ctx, message, { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: 'center', anchorY: 'middle', maxWidth: p.width * 0.9 });
      group.add(status);
      ctx.root.add(group);
      layout();
    }

    function layout(): void {
      if (!group || !quad) return;
      const p = ctx.props;
      const w = p.width;
      const h = w / (aspect > 0 ? aspect : 1);
      quad.scale.set(w, h, 1);
      quad.visible = !!texture;
      // Frame/caption are rebuilt only on size change (cheap: panel geometry is cached).
      const old = group.getObjectByName('frame');
      if (old) disposeTree(old);
      const capH = p.caption ? STYLE.labelSize * 1.8 : 0;
      if (p.frame || p.caption) {
        const f = new T.Group();
        f.name = 'frame';
        const pad = p.frame ? 0.008 : 0;
        const panel = ctx.ui.panel(w + 2 * pad, h + 2 * pad + capH);
        panel.position.y = -capH / 2;
        if (p.frame) f.add(panel);
        if (p.caption) {
          const c = makeText(ctx, p.caption, { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: 'center', anchorY: 'middle', maxWidth: w });
          c.position.set(0, -h / 2 - capH / 2, STYLE.zText);
          f.add(c);
        }
        group.add(f);
      }
      if (status) status.set(texture ? '' : message);
    }

    function setTexture(t: THREE.Texture | null, a: number): void {
      if (texture && texture !== t) texture.dispose();
      texture = t;
      if (a > 0 && Number.isFinite(a)) aspect = a;
      if (material) {
        material.map = t;
        material.needsUpdate = true;
      }
      layout();
    }

    function load(url: string): void {
      const my = ++token;
      if (!url) {
        message = 'no image';
        setTexture(null, aspect);
        return;
      }
      message = 'loading…';
      layout();
      try {
        const loader = new T.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
          url,
          (tex) => {
            if (my !== token) { tex.dispose(); return; }
            tex.colorSpace = T.SRGBColorSpace;
            const img = tex.image as { width?: number; height?: number } | undefined;
            const wpx = img?.width ?? 0;
            const hpx = img?.height ?? 0;
            setTexture(tex, wpx && hpx ? wpx / hpx : aspect);
            ctx.emit('loaded', { width: wpx, height: hpx });
          },
          undefined,
          () => {
            if (my !== token) return;
            message = `failed to load ${url.length > 60 ? url.slice(0, 59) + '…' : url}`;
            ctx.error(`image: failed to load ${url}`);
            setTexture(null, aspect);
          },
        );
      } catch (err) {
        message = 'image loading unavailable';
        ctx.error(`image: cannot load ${url}: ${(err as Error)?.message ?? err}`);
        setTexture(null, aspect);
      }
    }

    function showPixels(t: TensorValue): void {
      const s = t.shape;
      if (s.length < 2 || s.length > 3) {
        ctx.error(`image: pixels must be [H, W] or [H, W, C], got [${s.join(', ')}]`);
        return;
      }
      const [h, w] = s;
      const c = s.length === 3 ? s[2] : 1;
      if (![1, 3, 4].includes(c) || !h || !w) {
        ctx.error(`image: pixels channel count must be 1, 3 or 4 (got ${c})`);
        return;
      }
      const n = w * h;
      if (!pixelBytes || pixelBytes.length !== n * 4) pixelBytes = new Uint8Array(n * 4);
      const out = pixelBytes;
      const src = t.data;
      const isFloat = t.dtype === 'f32' || t.dtype === 'f16';
      const f16 = t.dtype === 'f16';
      const val = (i: number) => {
        const x = f16 ? halfToFloat(src[i]) : src[i];
        return isFloat ? Math.max(0, Math.min(255, Math.round(x * 255))) : Math.max(0, Math.min(255, x));
      };
      for (let y = 0; y < h; y++) {
        // Tensor row 0 is the top of the image; texture row 0 is the bottom.
        const dstRow = (h - 1 - y) * w;
        for (let x = 0; x < w; x++) {
          const si = (y * w + x) * c;
          const di = (dstRow + x) * 4;
          const r = val(si);
          out[di] = r;
          out[di + 1] = c >= 3 ? val(si + 1) : r;
          out[di + 2] = c >= 3 ? val(si + 2) : r;
          out[di + 3] = c === 4 ? val(si + 3) : 255;
        }
      }
      // Reuse the DataTexture while the size stays the same (video-like streams).
      const cur = texture as THREE.DataTexture | null;
      if (cur && (cur as { isDataTexture?: boolean }).isDataTexture && cur.image.width === w && cur.image.height === h && cur.image.data === out) {
        cur.needsUpdate = true;
        return;
      }
      ++token; // cancel pending URL loads
      const tex = new T.DataTexture(out, w, h, T.RGBAFormat);
      tex.colorSpace = T.SRGBColorSpace;
      tex.needsUpdate = true;
      setTexture(tex, w / h);
    }

    build();
    load(ctx.props.url);
    return {
      onProps(p, prev) {
        build();
        if (p.url !== prev.url && urlIn === null && !pixelBytes) load(p.url as string);
      },
      onInput(port, v) {
        if (port === 'url') {
          urlIn = typeof v === 'string' ? v : null;
          pixelBytes = null;
          load(urlIn ?? ctx.props.url);
        } else if (port === 'pixels') {
          if (isTensor(v)) showPixels(v);
          else if (v === null || v === undefined) {
            pixelBytes = null;
            load(urlIn ?? ctx.props.url);
          }
        }
      },
      dispose() {
        ++token;
        texture?.dispose();
        texture = null;
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
