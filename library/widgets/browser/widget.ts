// browser — live view of the agent's browser (the `browser` source's headless Chromium). Claude
// drives it with scripts/browser.mjs; every action shows here: the page streams in as JPEG frames
// (<prefix>.frame), the bar shows URL / loading, the status line says what Claude (or you) just did,
// and a ring flashes where a click lands. You can tap the page to click, pinch-drag it to scroll, and
// use back / forward / reload. Typing goes through Claude (voice).

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { truncate, formatAge } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  width: number;
  prefix: string;
}

interface BrowserState { url: string; title: string; loading: boolean; canGoBack: boolean; viewport: { w: number; h: number } }
interface Action { text: string; at: number; source?: string; x?: number; y?: number; kind?: string }

const BAR = 0.05;
const STATUS = 0.04;
const TAP_SLOP = 0.012; // m of hand travel before a pinch on the page becomes a scroll

/** Readable URL for the bar: no scheme, no trailing slash. */
export function displayUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Hand travel (m) on a page of height `pageH` (m) showing `viewportH` px → wheel delta in px. */
export function scrollPixels(dyMeters: number, pageH: number, viewportH: number): number {
  return Math.round((dyMeters / pageH) * viewportH * 1.5);
}

const definition: WidgetDefinition<Props> = {
  description:
    "Live view of the agent's browser (the 'browser' source's Chromium, driven by Claude via scripts/browser.mjs): streamed page, URL bar, " +
    'what Claude is doing, click markers. Tap to click, pinch-drag to scroll, back/forward/reload.',
  version: '1.0.0',
  props: {
    width: { type: 'number', default: 1.0, min: 0.3, max: 4, step: 0.05, description: 'Screen width (m).' },
    prefix: { type: 'string', default: 'browser', description: "Channel prefix of the 'browser' source." },
  },
  inputs: {},
  outputs: {},
  interactions: [dragBinding('browser-drag', 'drag')],
  size: [1.0, 0.72, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const canDecode = typeof createImageBitmap === 'function' && typeof Blob !== 'undefined';
    let state: BrowserState | null = null;
    let action: Action | null = null;
    let group: THREE.Group | null = null;
    let screenMat: THREE.MeshBasicMaterial | null = null;
    let texture: THREE.Texture | null = null;
    let bitmap: ImageBitmap | null = null;
    let decoding = false;
    let nextFrame: Uint8Array | null = null;
    let hasFrame = false;
    let urlText: Text | null = null, statusText: Text | null = null, overlay: Text | null = null;
    let lockIcon: THREE.Mesh | null = null, actorIcon: THREE.Mesh | null = null, loadDot: THREE.Mesh | null = null;
    let marker: THREE.Mesh | null = null, markerMat: THREE.MeshBasicMaterial | null = null;
    let markerAge = 99;
    let t = 0, timer = 0;
    let aspect = 1280 / 800;
    let press: { hand: string; part: string; y0: number; lastY: number; moved: boolean; u: number; v: number } | null = null;
    let lastScrollSent = 0, scrollAcc = 0;
    const offs: Array<() => void> = [];

    const W = () => ctx.props.width;
    const H = () => W() / aspect;
    const prefix = () => ctx.props.prefix || 'browser';

    function build(): void {
      if (group) disposeTree(group);
      const g = (group = new T.Group());
      const w = W(), h = H();
      // card behind everything
      const total = BAR + h + STATUS + 0.02;
      const card = ctx.ui.panel(w + 0.03, total + 0.01);
      card.position.set(0, (BAR - STATUS) / 2, -0.003);
      g.add(card);

      // screen
      screenMat = new T.MeshBasicMaterial({ color: hasFrame ? '#ffffff' : '#0b0d11', map: hasFrame ? texture : null, toneMapped: false });
      const screen = new T.Mesh(sharedGeometry(T, 'plane'), screenMat);
      screen.scale.set(w, h, 1);
      screen.name = 'screen';
      ctx.interactive(screen);
      overlay = makeText(ctx, '', { size: Math.max(0.016, w * 0.022), anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w * 0.8, textAlign: 'center' });
      overlay.position.z = 0.002;
      markerMat = ownMaterial(T, theme.accent, { opacity: 0.9, doubleSide: true });
      marker = new T.Mesh(sharedGeometry(T, 'ring'), markerMat);
      marker.visible = false;
      marker.raycast = () => {};
      marker.position.z = 0.003;
      g.add(screen, overlay, marker);

      // top bar: back / forward / reload, lock|globe + URL, loading dot
      const by = h / 2 + BAR / 2 + 0.004, x0 = -w / 2;
      const btn = (id: string, icon: string, x: number) => {
        const d = 0.032;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, by, STYLE.zContent);
        b.name = `btn:${id}`;
        ctx.interactive(b);
        const ic = makeIcon(ctx, icon, { size: d * 0.55, color: theme.text });
        ic.position.z = STYLE.zText;
        b.add(ic);
        g.add(b);
      };
      btn('back', 'arrow-left', x0 + 0.016);
      btn('forward', 'arrow-right', x0 + 0.054);
      btn('reload', 'rotate-cw', x0 + 0.092);
      const field = ctx.ui.panel(w - 0.13, 0.032, { color: theme.surface, radius: 0.016 });
      field.position.set(x0 + 0.12 + (w - 0.13) / 2, by, STYLE.zContent);
      field.raycast = () => {};
      g.add(field);
      lockIcon = makeIcon(ctx, 'globe', { size: 0.016, color: theme.textDim });
      lockIcon.position.set(x0 + 0.138, by, STYLE.zText);
      urlText = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      urlText.position.set(x0 + 0.152, by, STYLE.zText);
      loadDot = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, theme.accent));
      loadDot.scale.setScalar(0.009);
      loadDot.position.set(w / 2 - 0.02, by, STYLE.zText);
      loadDot.raycast = () => {};
      g.add(lockIcon, urlText, loadDot);

      // status line: who did what
      const sy = -h / 2 - STATUS / 2 - 0.004;
      actorIcon = makeIcon(ctx, 'bot', { size: 0.02, color: theme.accent });
      actorIcon.position.set(x0 + 0.014, sy, STYLE.zText);
      statusText = makeText(ctx, '', { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      statusText.position.set(x0 + 0.032, sy, STYLE.zText);
      g.add(actorIcon, statusText);

      ctx.root.add(g);
      paint();
    }

    function paint(): void {
      const w = W();
      const chars = Math.floor((w - 0.2) / (0.0135 * 0.62));
      urlText?.set(state ? truncate(displayUrl(state.url), chars) : 'browser not running');
      if (lockIcon) {
        const secure = !!state?.url.startsWith('https://');
        setIcon(T, lockIcon, secure ? 'lock' : 'globe');
      }
      if (loadDot) loadDot.visible = !!state?.loading;
      overlay?.set(!state ? "Start the 'browser' source to see the agent's browser" : !canDecode ? 'Live view appears in the headset / browser' : hasFrame ? '' : 'Waiting for the first frame…');
      if (overlay) overlay.visible = !hasFrame || !canDecode;
      paintStatus();
    }

    function paintStatus(): void {
      if (!statusText || !actorIcon) return;
      const fresh = action && Date.now() - action.at < 8000;
      const who = action?.source === 'claude' ? 'Claude' : 'You';
      const age = action ? formatAge(Date.now() - action.at) : '';
      statusText.set(action ? truncate(`${who}: ${action.text}${fresh ? '' : `  ·  ${age} ago`}`, Math.floor((W() - 0.05) / (0.0135 * 0.5))) : state ? truncate(state.title || 'Idle', 80) : '');
      (statusText as unknown as { color: string }).color = fresh ? theme.text : theme.textDim;
      setIcon(T, actorIcon, action?.source === 'claude' || !action ? 'bot' : 'mouse-pointer-2');
    }

    // ---- frames -------------------------------------------------------------------------------

    async function decode(): Promise<void> {
      if (decoding || !nextFrame) return;
      const bytes = nextFrame;
      nextFrame = null;
      decoding = true;
      try {
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'flipY' });
        if (!group) { bmp.close(); return; }
        const a = bmp.width / bmp.height;
        if (!texture) {
          texture = new T.Texture(bmp as unknown as HTMLImageElement);
          texture.colorSpace = T.SRGBColorSpace;
          texture.flipY = false; // flipped at decode (ImageBitmaps ignore flipY in WebGL)
          texture.generateMipmaps = false;
          texture.minFilter = T.LinearFilter;
        } else {
          texture.image = bmp;
        }
        texture.needsUpdate = true;
        bitmap?.close();
        bitmap = bmp;
        const first = !hasFrame;
        hasFrame = true;
        if (Math.abs(a - aspect) > 0.01) { aspect = a; build(); }
        else if (first && screenMat) { screenMat.map = texture; screenMat.color.set('#ffffff'); screenMat.needsUpdate = true; paint(); }
      } catch (e) {
        ctx.error('browser: could not decode a frame', String(e));
      } finally {
        decoding = false;
        if (nextFrame) void decode();
      }
    }

    function onFrame(v: ChannelValue): void {
      if (!canDecode || !isTensor(v) || !(v.data instanceof Uint8Array)) return;
      nextFrame = v.data; // latest wins
      void decode();
    }

    // ---- input --------------------------------------------------------------------------------

    function send(cmd: Record<string, unknown>): void {
      ctx.channels.publish(`${prefix()}.ctl`, { ...cmd, nonce: Date.now() } as never);
    }

    /** ctx.root point on the screen plane → normalized page coords (0..1, y down). */
    function uv(lp: readonly number[]): [number, number] {
      const w = W(), h = H();
      return [Math.min(1, Math.max(0, lp[0] / w + 0.5)), Math.min(1, Math.max(0, 0.5 - lp[1] / h))];
    }

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(`${prefix()}.frame`, onFrame));
      offs.push(ctx.channels.subscribe(`${prefix()}.state`, (v) => {
        if (!v || typeof v !== 'object' || isTensor(v)) return;
        state = v as BrowserState;
        const vp = state.viewport;
        if (!hasFrame && vp?.w && vp?.h && Math.abs(vp.w / vp.h - aspect) > 0.01) { aspect = vp.w / vp.h; build(); }
        paint();
      }));
      offs.push(ctx.channels.subscribe(`${prefix()}.action`, (v) => {
        if (!v || typeof v !== 'object' || isTensor(v)) return;
        const a = v as Action;
        const isNew = !action || a.at !== action.at;
        action = a;
        if (isNew && Number.isFinite(a.x) && Number.isFinite(a.y) && Date.now() - a.at < 5000) {
          markerAge = 0;
          marker?.position.set((a.x! - 0.5) * W(), (0.5 - a.y!) * H(), 0.003);
        }
        paintStatus();
      }));
    }

    build();
    subscribe();

    return {
      onProps(p, prev) {
        if (p.width !== prev.width) build();
        if (p.prefix !== prev.prefix) { state = null; action = null; hasFrame = false; subscribe(); build(); }
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName ?? '';
        const lp = e.localPoint;
        if (e.phase === 'start') {
          if (press) return;
          if (part === 'screen' || part.startsWith('btn:')) {
            const [u, v] = uv(lp);
            press = { hand: e.hand, part, y0: lp[1], lastY: lp[1], moved: false, u, v };
          }
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          if (press.part !== 'screen') return;
          if (!press.moved && Math.abs(lp[1] - press.y0) > TAP_SLOP) press.moved = true;
          if (press.moved) {
            // content follows the hand: hand up → page scrolls down
            scrollAcc += scrollPixels(lp[1] - press.lastY, H(), state?.viewport?.h ?? 800);
            press.lastY = lp[1];
            const now = Date.now();
            if (Math.abs(scrollAcc) >= 20 && now - lastScrollSent > 80) {
              send({ cmd: 'scroll', dy: scrollAcc, x: press.u, y: press.v });
              scrollAcc = 0;
              lastScrollSent = now;
            }
          }
          return;
        }
        const p = press;
        press = null;
        if (e.phase !== 'end') return;
        if (p.part === 'screen') {
          if (p.moved) { if (scrollAcc) send({ cmd: 'scroll', dy: scrollAcc, x: p.u, y: p.v }); scrollAcc = 0; }
          else send({ cmd: 'click', x: p.u, y: p.v });
        } else if (p.part === 'btn:back') send({ cmd: 'back' });
        else if (p.part === 'btn:forward') send({ cmd: 'forward' });
        else if (p.part === 'btn:reload') send({ cmd: 'reload' });
      },
      update(dt) {
        t += dt;
        if (marker && markerMat) {
          markerAge += dt;
          const on = markerAge < 1;
          marker.visible = on;
          if (on) {
            marker.scale.setScalar(0.02 + markerAge * 0.05);
            markerMat.opacity = 0.95 * (1 - markerAge);
          }
        }
        if (loadDot?.visible) loadDot.scale.setScalar(0.007 + 0.003 * Math.sin(t * 8));
        timer += dt;
        if (timer > 1) { timer = 0; paintStatus(); }
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        bitmap?.close();
        texture?.dispose();
        if (group) disposeTree(group);
        group = null;
      },
    };
  },
};

export default definition;
