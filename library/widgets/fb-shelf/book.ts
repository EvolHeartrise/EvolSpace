// fb-shelf — the book that flies out of its slot and opens in front of the case.
//
// One reusable rig: two halves hinged at the spine (x = 0). Closed, the left half is folded over the
// right one (its cover faces the viewer); seen spine-first (rotated 90° about Y and scaled to the
// shelf book's size) it *is* the book on the shelf, so the hand-off from the instanced spine is
// seamless. progress p: 0 = in the slot, FLY = in front of the case (closed), 1 = open.
// Pages show syntax-highlighted text flowing left page → right page (tap a page to turn), or an image.

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeGlyph as makeIcon, setGlyph as setIcon } from './glyphs.ts';
import { truncate } from '../../shared/format.ts';
import { ageText, CATS, type Category, fmtSize } from './layout.ts';

export interface Preview {
  kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string;
  text?: string; lines?: number; truncated?: boolean; src?: string; error?: string;
}

export const PW = 0.4;     // page width
export const PH = 0.5;     // page height
const BLOCK = 0.014;       // page block thickness per half
const COVER = 0.006;
const PAD = 0.022;
const FS = 0.0105;         // body font size (mono)
const LH = 1.28;
const LINE = FS * LH;
const HEADER = 0.068;
const OPEN = 0.16;         // open V angle per half (rad)
const FLY = 0.55;          // share of progress spent flying
export const CLOSED_T = 2 * (BLOCK + COVER) + 0.002;

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const BODY_LINES_LEFT = Math.floor((PH - 2 * PAD - HEADER) / LINE);
export const BODY_LINES_RIGHT = Math.floor((PH - 2 * PAD - 0.024) / LINE);
export const COLS = Math.floor((PW - 2 * PAD - 0.032) / (FS * 0.6));

export interface LaunchInfo { name: string; cat: Category; color: string; size: number | null; mtime: number | null }

export class OpenBook {
  readonly group: THREE.Group;
  /** 0 = in slot, 1 = open. */
  p = 0;
  target = 0;
  speed = 1;
  info: LaunchInfo | null = null;
  preview: Preview | null = null;
  spread = 0;
  onClosed: (() => void) | null = null;

  private readonly T: typeof THREE;
  private readonly left: THREE.Group;
  private readonly right: THREE.Group;
  private readonly leftContent: THREE.Group;
  private readonly rightContent: THREE.Group;
  private readonly coverMat: THREE.MeshBasicMaterial;
  private readonly icon: THREE.Mesh;
  private readonly title: Text;
  private readonly meta: Text;
  private readonly numsL: Text;
  private readonly bodyL: Text;
  private readonly numsR: Text;
  private readonly bodyR: Text;
  private readonly footer: Text;
  private readonly msg: Text;
  private readonly img: THREE.Mesh;
  private readonly imgMat: THREE.MeshBasicMaterial;
  private tex: THREE.Texture | null = null;
  private texSrc = '';
  private hlLines: string[] = [];
  private hlSpans: Span[][] = [];
  private hlLang = '';
  private readonly ints: Record<TokenKind, number>;
  private readonly S: THREE.Vector3;
  private readonly C: THREE.Vector3;
  private readonly E: THREE.Vector3;
  private readonly S0: THREE.Vector3;
  private startYaw = Math.PI / 2;
  private endYaw = 0;

  constructor(private ctx: WidgetContext) {
    const T = (this.T = ctx.THREE);
    const theme = ctx.theme;
    this.ints = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
    this.S = new T.Vector3(); this.C = new T.Vector3(); this.E = new T.Vector3(); this.S0 = new T.Vector3(1, 1, 1);
    const g = (this.group = new T.Group());
    g.name = 'open-book';
    g.visible = false;
    this.coverMat = ownMaterial(T, '#888888', { shaded: true });
    const blockMat = ownMaterial(T, '#d6d0c2', { shaded: true });
    const pageMat = ownMaterial(T, '#12171e');
    const noRay = () => {};
    const half = (sign: 1 | -1) => {
      const pivot = new T.Group();
      const cx = (sign * PW) / 2;
      const block = new T.Mesh(shadedGeometry(T, 'box'), blockMat);
      block.scale.set(PW - 0.004, PH - 0.006, BLOCK);
      block.position.set(cx, 0, -BLOCK / 2);
      const cover = new T.Mesh(shadedGeometry(T, 'box'), this.coverMat);
      cover.scale.set(PW + 0.008, PH + 0.018, COVER);
      cover.position.set(sign * (PW + 0.008) / 2, 0, -BLOCK - COVER / 2);
      const page = new T.Mesh(sharedGeometry(T, 'plane'), pageMat);
      page.scale.set(PW - 0.012, PH - 0.016, 1);
      page.position.set(cx, 0, 0.0004);
      for (const m of [block, cover, page]) { m.raycast = noRay; pivot.add(m); }
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(PW, PH, 0.02);
      hit.position.set(cx, 0, 0);
      hit.name = sign < 0 ? 'book:left' : 'book:right';
      ctx.interactive(hit);
      pivot.add(hit);
      const content = new T.Group();
      content.position.z = 0.0014;
      content.visible = false;
      pivot.add(content);
      return { pivot, content };
    };
    const L = half(-1), R = half(1);
    this.left = L.pivot; this.leftContent = L.content;
    this.right = R.pivot; this.rightContent = R.content;
    this.left.position.z = 0.0012; // folded, the left page rests just in front of the right one
    const spine = new T.Mesh(shadedGeometry(T, 'box'), this.coverMat);
    spine.scale.set(0.008, PH + 0.018, CLOSED_T + 0.002);
    spine.position.set(-0.002, 0, 0);
    spine.raycast = noRay;
    g.add(this.left, this.right, spine);

    // left page: header + first column of lines
    const lx0 = -PW + PAD, top = PH / 2 - PAD;
    this.icon = makeIcon(ctx, 'file', { size: 0.024, color: theme.text });
    this.icon.position.set(lx0 + 0.012, top - 0.013, 0);
    this.title = makeText(ctx, '', { size: 0.017, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    this.title.position.set(lx0 + 0.032, top - 0.011, 0);
    this.meta = makeText(ctx, '', { size: 0.011, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
    this.meta.position.set(lx0 + 0.032, top - 0.036, 0);
    const rule = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, mixHex(theme.border, '#12171e', 0.3)));
    rule.scale.set(PW - 2 * PAD, 0.0015, 1);
    rule.position.set(-PW / 2, top - HEADER + 0.012, 0);
    rule.raycast = noRay;
    const body = (x: number, y: number) => {
      const nums = makeText(ctx, '', { size: FS, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: LH, whiteSpace: 'nowrap' });
      nums.position.set(x + 0.024, y, 0);
      const b = makeText(ctx, '', { size: FS, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', lineHeight: LH, whiteSpace: 'nowrap' });
      b.position.set(x + 0.031, y, 0);
      return [nums, b] as const;
    };
    [this.numsL, this.bodyL] = body(lx0 - 0.004, top - HEADER);
    [this.numsR, this.bodyR] = body(PAD - 0.004, top);
    this.leftContent.add(this.icon, this.title, this.meta, rule, this.numsL, this.bodyL);
    this.footer = makeText(ctx, '', { size: 0.011, anchorX: 'center', anchorY: 'bottom', color: theme.textDim });
    this.footer.position.set(PW / 2, -PH / 2 + PAD * 0.6, 0);
    this.msg = makeText(ctx, '', { size: 0.015, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: PW - 4 * PAD, textAlign: 'center' });
    this.msg.position.set(PW / 2, 0, 0);
    this.imgMat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    this.img = new T.Mesh(sharedGeometry(T, 'plane'), this.imgMat);
    this.img.raycast = noRay;
    this.img.visible = false;
    this.img.position.set(PW / 2, 0, 0.0002);
    this.rightContent.add(this.numsR, this.bodyR, this.footer, this.msg, this.img);

    // bookmark tabs above the right page: close (put back) and ask Claude
    const tab = (name: string, iconName: string, x: number, color: string) => {
      const t = ctx.ui.panel(0.042, 0.05, { color, radius: 0.008 });
      t.position.set(x, PH / 2 + 0.024, -0.004);
      t.name = name;
      ctx.interactive(t);
      const ic = makeIcon(ctx, iconName, { size: 0.024, color: theme.text });
      ic.position.set(0, 0.006, 0.002);
      t.add(ic);
      this.rightContent.add(t);
    };
    tab('book:close', 'x', PW - 0.035, theme.surface);
    tab('book:ask', 'message-square', PW - 0.085, theme.surface);
    ctx.root.add(g);
  }

  get open(): boolean { return this.target === 1; }
  get busy(): boolean { return this.p !== this.target || this.p > 0; }

  /**
   * Start flying a book out of its slot. `start` = spine-face center (root coords) and the shelf
   * book's size [thickness, height, depth]; `end` = where the open book's spine stands, facing `yaw`.
   */
  launch(info: LaunchInfo, start: [number, number, number], size: [number, number, number], end: [number, number, number], yaw: number): void {
    this.info = info;
    this.preview = null;
    this.spread = 0;
    this.coverMat.color.set(info.color);
    setIcon(this.T, this.icon, CATS[info.cat].icon);
    (this.icon.material as THREE.MeshBasicMaterial).color.set(info.color);
    this.S.set(start[0], start[1], start[2]);
    this.C.set(start[0], start[1], start[2] + 0.35);
    this.E.set(end[0], end[1], end[2]);
    this.S0.set(size[2] / PW, size[1] / PH, size[0] / CLOSED_T);
    this.startYaw = Math.PI / 2;
    this.endYaw = yaw;
    this.p = 0;
    this.target = 1;
    this.speed = 1;
    this.group.visible = true;
    this.render();
    this.apply();
  }

  /** Fold and fly back into the slot (fast = when switching to another book). */
  close(fast = false): void {
    if (this.target === 0) return;
    this.target = 0;
    this.speed = fast ? 2.6 : 1;
  }

  /** Snap shut and hide (navigation away). */
  reset(): void {
    this.target = 0;
    this.p = 0;
    this.group.visible = false;
    this.info = null;
    this.preview = null;
    this.setImage(null);
  }

  setPreview(p: Preview): void {
    this.preview = p;
    this.spread = 0;
    if (p.type === 'text') {
      const lang = languageFor(p.name);
      this.hlLines = (p.text ?? '').replace(/\t/g, '  ').split('\n');
      if (this.hlLines.length && this.hlLines[this.hlLines.length - 1] === '') this.hlLines.pop();
      this.hlSpans = highlight(this.hlLines.join('\n'), lang);
      this.hlLang = lang?.id ?? '';
    } else { this.hlLines = []; this.hlSpans = []; this.hlLang = ''; }
    this.render();
  }

  get spreads(): number {
    return Math.max(1, Math.ceil(this.hlLines.length / (BODY_LINES_LEFT + BODY_LINES_RIGHT)));
  }

  /** Turn pages: +1 next spread, −1 previous. Returns true if it moved. */
  turn(dir: number): boolean {
    const next = Math.max(0, Math.min(this.spreads - 1, this.spread + dir));
    if (next === this.spread) return false;
    this.spread = next;
    this.render();
    return true;
  }

  /** Advance the animation; returns true while something moved. */
  update(dt: number): boolean {
    if (this.p === this.target) return false;
    const step = (dt / 0.62) * this.speed;
    this.p = this.target > this.p ? Math.min(this.target, this.p + step) : Math.max(this.target, this.p - step);
    this.apply();
    if (this.p === 0 && this.target === 0) {
      this.group.visible = false;
      this.setImage(null);
      const cb = this.onClosed;
      cb?.();
    }
    return true;
  }

  private apply(): void {
    const u = smooth(clamp01(this.p / FLY));
    const v = smooth(clamp01((this.p - FLY) / (1 - FLY)));
    const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    const g = this.group;
    g.position.set(a * this.S.x + b * this.C.x + c * this.E.x, a * this.S.y + b * this.C.y + c * this.E.y, a * this.S.z + b * this.C.z + c * this.E.z);
    g.rotation.set(0, this.startYaw + (this.endYaw - this.startYaw) * u, 0);
    g.scale.set(this.S0.x + (1 - this.S0.x) * u, this.S0.y + (1 - this.S0.y) * u, this.S0.z + (1 - this.S0.z) * u);
    this.left.rotation.y = Math.PI - 0.02 + (OPEN - Math.PI + 0.02) * v;
    this.right.rotation.y = -OPEN * v;
    const show = v > 0.35;
    this.leftContent.visible = show;
    this.rightContent.visible = show;
  }

  private setImage(src: string | null): void {
    if (this.tex) { this.tex.dispose(); this.tex = null; }
    this.imgMat.map = null;
    this.imgMat.needsUpdate = true;
    this.img.visible = false;
    this.texSrc = src ?? '';
    if (!src || typeof document === 'undefined') return;
    const T = this.T;
    this.tex = new T.TextureLoader().load(src, (t) => {
      if (this.tex !== t) return;
      t.colorSpace = T.SRGBColorSpace;
      const im = t.image as { width: number; height: number };
      const bw = PW - 2 * PAD, bh = PH - 2 * PAD - 0.02;
      const ar = im.width / Math.max(1, im.height);
      const sw = ar > bw / bh ? bw : bh * ar, sh = ar > bw / bh ? bw / ar : bh;
      this.img.scale.set(sw, sh, 1);
      this.imgMat.map = t;
      this.imgMat.needsUpdate = true;
      this.img.visible = true;
      this.msg.set('');
    }, undefined, () => this.ctx.error(`fb-shelf: could not load ${src}`));
  }

  /** Fill the pages from the info/preview (cheap: text.set is a no-op when unchanged). */
  render(): void {
    const info = this.info, p = this.preview;
    const theme = this.ctx.theme;
    const name = p?.name ?? info?.name ?? '';
    this.title.set(truncate(name, Math.floor((PW - 2 * PAD - 0.035) / (0.017 * 0.56))));
    const size = p?.size ?? info?.size ?? null;
    const mtime = p?.mtime ?? info?.mtime ?? null;
    const parts = [fmtSize(size), mtime ? `modified ${ageText(mtime)}` : ''];
    if (p?.type === 'text') parts.push(`${p.lines ?? this.hlLines.length} lines${p.truncated ? ' (first 64 KB)' : ''}`);
    this.meta.set(parts.filter(Boolean).join(' · '));
    const isText = p?.type === 'text';
    const want = p?.type === 'image' && p.src ? p.src : null;
    if ((want ?? '') !== this.texSrc) this.setImage(want);
    let msg = '';
    if (!p) msg = 'Opening…';
    else if (p.type === 'binary') msg = 'Binary file — no preview';
    else if (p.type === 'denied') msg = p.error ?? 'Private file';
    else if (p.type === 'image') msg = typeof document === 'undefined' || !this.img.visible ? 'Image' : '';
    else if (p.type === 'error') msg = p.error ?? 'No preview';
    else if (isText && !this.hlLines.length) msg = 'Empty file';
    this.msg.set(msg);
    this.msg.visible = !!msg;
    if (!isText) {
      for (const t of [this.numsL, this.bodyL, this.numsR, this.bodyR]) t.set('');
      setColorRanges(this.bodyL, null);
      setColorRanges(this.bodyR, null);
      this.footer.set('');
      return;
    }
    const per = BODY_LINES_LEFT + BODY_LINES_RIGHT;
    const from = this.spread * per;
    this.fill(this.numsL, this.bodyL, from, BODY_LINES_LEFT, theme.text);
    this.fill(this.numsR, this.bodyR, from + BODY_LINES_LEFT, BODY_LINES_RIGHT, theme.text);
    const n = this.spreads;
    this.footer.set(n > 1 ? `${this.spread * 2 + 1}–${this.spread * 2 + 2}  /  ${n * 2}    ‹ tap a page to turn ›` : '');
  }

  private fill(nums: Text, body: Text, from: number, count: number, base: string): void {
    const all = this.hlLines;
    const shownFull = all.slice(from, from + count);
    const shown = shownFull.map((l) => (l.length > COLS ? l.slice(0, COLS - 1) + '…' : l));
    body.set(shown.join('\n'));
    nums.set(shown.map((_, i) => String(from + i + 1)).join('\n'));
    const clips = shown.map((l, i) => (l.length < shownFull[i].length ? l.length - 1 : l.length));
    setColorRanges(body, this.hlLang && shown.length ? colorRanges(this.hlSpans.slice(from, from + count), shown.map((l) => l.length), this.ints, hexToInt(base), clips) : null);
  }

  dispose(): void {
    if (this.tex) this.tex.dispose();
    this.tex = null;
    disposeTree(this.group);
  }
}
