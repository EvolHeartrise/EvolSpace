// fb-city — the preview "billboard" that rises above the city: syntax-highlighted text with line
// numbers (pinch-drag to scroll), images as textures, a note for binary/private files; close +
// "ask Claude" buttons. (Adapted from fb-treemap/preview.ts; widget folders don't share code.)

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt } from '../../shared/color.ts';
import { makeIcon } from '../../shared/icons.ts';
import { truncate } from '../../shared/format.ts';
import { STYLE } from '../../shared/style.ts';
import { CATEGORY_INFO, categoryOf, fmtAge, fmtSize } from './city.ts';

export interface Preview {
  kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string;
  text?: string; lines?: number; truncated?: boolean; src?: string; error?: string;
}

const PAD = 0.018;
export const LINE = 0.0135;
export const LH = 1.25;
const HEAD = 0.07;

export class PreviewCard {
  /** Holds the card; the widget positions/animates/billboards it. */
  readonly group: THREE.Group;
  scroll = 0;
  shown = false;
  private body: Text | null = null;
  private nums: Text | null = null;
  private lines: string[] = [];
  private spans: Span[][] = [];
  private lang = '';
  private tex: THREE.Texture | null = null;
  private shownFrom = -1;
  private inner: THREE.Group | null = null;
  private readonly ints: Record<TokenKind, number>;

  constructor(private ctx: WidgetContext, public width: number, public height: number) {
    this.group = new ctx.THREE.Group();
    this.ints = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
  }

  get visibleLines(): number {
    return Math.max(5, Math.floor((this.height - 2 * PAD - HEAD) / (LINE * LH)));
  }

  /** Build the card for `p` (null clears), centered on the group's origin, facing +Z. */
  show(p: Preview | null): void {
    this.clear();
    if (!p) return;
    this.shown = true;
    const ctx = this.ctx, T = ctx.THREE, theme = ctx.theme;
    const w = this.width, h = this.height;
    const g = (this.inner = new T.Group());
    g.add(ctx.ui.panel(w, h, { opacity: 0.95 }));
    const x0 = -w / 2 + PAD, x1 = w / 2 - PAD, top = h / 2 - PAD;
    const info = CATEGORY_INFO[categoryOf({ type: 'file', ext: p.name.includes('.') ? p.name.split('.').pop()!.toLowerCase() : '' })];
    // a colored roof strip: the building's color, so the card reads as "that building"
    const roof = new T.Mesh(sharedGeometry(T, 'plane'), ctx.ui.material(info.color));
    roof.scale.set(w - 0.02, 0.006, 1);
    roof.position.set(0, h / 2 - 0.006, STYLE.zContent);
    roof.raycast = () => {};
    const ic = makeIcon(ctx, info.icon, { size: 0.026, color: info.color });
    ic.position.set(x0 + 0.013, top - 0.018, STYLE.zText);
    const title = makeText(ctx, truncate(p.name, Math.floor((w - 0.16) / (0.019 * 0.55))), { size: 0.019, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    title.position.set(x0 + 0.034, top - 0.014, STYLE.zText);
    const meta = makeText(ctx, [p.size != null ? fmtSize(p.size) : '', p.mtime ? `modified ${fmtAge(p.mtime)}` : '', p.type === 'text' ? `${p.lines} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join(' · '),
      { size: 0.0135, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
    meta.position.set(x0 + 0.034, top - 0.04, STYLE.zText);
    g.add(roof, ic, title, meta);
    const btn = (id: string, icon: string, bx: number) => {
      const d = 0.04;
      const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
      b.position.set(bx, top - 0.02, STYLE.zContent);
      b.name = `pv:${id}`;
      ctx.interactive(b);
      const bi = makeIcon(ctx, icon, { size: d * 0.5, color: theme.text });
      bi.position.z = STYLE.zText;
      b.add(bi);
      g.add(b);
    };
    btn('close', 'x', x1 - 0.02);
    btn('ask', 'message-square', x1 - 0.07);
    const bodyTop = top - HEAD + 0.004, bodyH = h - 2 * PAD - HEAD + 0.004;
    if (p.type === 'text') {
      const lang = languageFor(p.name);
      this.lines = (p.text ?? '').replace(/\t/g, '  ').split('\n');
      this.spans = highlight(this.lines.join('\n'), lang);
      this.lang = lang?.id ?? '';
      this.nums = makeText(ctx, '', { size: LINE, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: LH });
      this.nums.position.set(x0 + 0.034, bodyTop, STYLE.zText);
      this.body = makeText(ctx, '', { size: LINE, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: LH });
      this.body.position.set(x0 + 0.044, bodyTop, STYLE.zText);
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(w - PAD, bodyH, 0.01);
      hit.position.set(0, bodyTop - bodyH / 2, 0.004);
      hit.name = 'pv:text';
      ctx.interactive(hit);
      g.add(this.nums, this.body, hit);
      this.render();
    } else if (p.type === 'image' && p.src && typeof document !== 'undefined') {
      const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
      const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
      img.raycast = () => {};
      img.visible = false;
      img.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
      g.add(img);
      this.tex = new T.TextureLoader().load(p.src, (t) => {
        if (this.tex !== t) return;
        t.colorSpace = T.SRGBColorSpace;
        const im = t.image as { width: number; height: number };
        const a = im.width / im.height, bw = w - 2 * PAD, bh = bodyH;
        img.scale.set(a > bw / bh ? bw : bh * a, a > bw / bh ? bw / a : bh, 1);
        mat.map = t;
        mat.needsUpdate = true;
        img.visible = true;
      }, undefined, () => ctx.error(`fb-city: could not load ${p.src}`));
    } else {
      const msg = p.type === 'binary' ? 'Binary file: no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
      const t = makeText(ctx, msg, { size: 0.016, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
      t.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
      g.add(t);
    }
    this.group.add(g);
  }

  /** Re-render the visible text window (cheap when the scroll position is unchanged). */
  render(): void {
    if (!this.body || !this.nums) return;
    const visible = this.visibleLines;
    const from = Math.min(Math.max(0, Math.round(this.scroll)), Math.max(0, this.lines.length - visible));
    this.scroll = Math.min(this.scroll, Math.max(0, this.lines.length - visible));
    if (from === this.shownFrom) return;
    this.shownFrom = from;
    const src = this.lines.slice(from, from + visible);
    const cols = Math.floor((this.width - 0.08) / (LINE * 0.6));
    const shown = src.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
    this.body.set(shown.join('\n'));
    const clips = shown.map((l, i) => (l.length < src[i].length ? l.length - 1 : l.length));
    setColorRanges(this.body, this.lang ? colorRanges(this.spans.slice(from, from + visible), shown.map((l) => l.length), this.ints, hexToInt(this.ctx.theme.text), clips) : null);
    this.nums.set(src.map((_, i) => String(from + i + 1)).join('\n'));
  }

  clear(): void {
    this.tex?.dispose();
    this.tex = null;
    if (this.inner) disposeTree(this.inner);
    this.inner = null;
    this.shown = false;
    this.body = this.nums = null;
    this.lines = [];
    this.spans = [];
    this.scroll = 0;
    this.shownFrom = -1;
  }
}
