// Text helpers on top of ctx.ui.text (troika SDF text in the headset).
//
// - makeText(): ctx.ui.text with the runtime's optional extensions (weight,
//   lineHeight, textAlign) passed through; hosts that don't know them ignore them.
// - textSize(): measured block size once troika has laid the glyphs out
//   (textRenderInfo), else an estimate — so layouts can be built immediately
//   and refined a frame later (see MeasureWatch).
// - parseMarkup(): the tiny markup the panel widget renders.

import type { TextOptions, WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { estimateTextBlock, LINE_HEIGHT } from './layout.ts';

export type Text = THREE.Mesh & { set(text: string): void };

export interface TextOptionsEx extends TextOptions {
  /** Runtime extension: 'semibold' for headings. Ignored by hosts without it. */
  weight?: 'regular' | 'semibold';
  lineHeight?: number;
  textAlign?: 'left' | 'right' | 'center' | 'justify';
  whiteSpace?: 'normal' | 'nowrap';
}

export function makeText(ctx: Pick<WidgetContext, 'ui'>, content: string, opts: TextOptionsEx = {}): Text {
  const t = ctx.ui.text(content, opts as TextOptions) as Text;
  t.raycast = noRaycast; // labels are never hit targets (keeps picking cheap and grabs on the panel)
  return t;
}

const noRaycast = () => {};

interface RenderInfoHolder {
  textRenderInfo?: { blockBounds?: ArrayLike<number> } | null;
  text?: string;
  fontSize?: number;
  maxWidth?: number;
}

/**
 * Size of a text block: the real glyph bounds when troika has synced
 * (textRenderInfo.blockBounds), otherwise an estimate from the given parameters.
 */
export function textSize(
  mesh: THREE.Object3D,
  fallback: { text: string; size: number; maxWidth?: number; font?: 'sans' | 'mono'; lineHeight?: number },
): { width: number; height: number; measured: boolean } {
  const bb = (mesh as unknown as RenderInfoHolder).textRenderInfo?.blockBounds;
  if (bb && bb.length >= 4 && Number.isFinite(bb[0])) {
    return { width: Math.max(0, bb[2] - bb[0]), height: Math.max(0, bb[3] - bb[1]), measured: true };
  }
  const e = estimateTextBlock(fallback.text, fallback.size, fallback.maxWidth, fallback.font, fallback.lineHeight ?? LINE_HEIGHT);
  return { width: e.width, height: e.height, measured: false };
}

/**
 * Detects when troika finishes (re)measuring any of a set of texts, so a widget
 * can re-run its layout once with real sizes. Allocation-free per poll.
 */
export class MeasureWatch {
  private seen: unknown[] = [];
  constructor(private texts: THREE.Object3D[] = []) {
    this.seen = texts.map(() => undefined);
  }

  reset(texts: THREE.Object3D[]): void {
    this.texts = texts;
    this.seen = texts.map(() => undefined);
  }

  /** True if any text has new render info since the last call. */
  changed(): boolean {
    let any = false;
    for (let i = 0; i < this.texts.length; i++) {
      const info = (this.texts[i] as unknown as RenderInfoHolder).textRenderInfo ?? undefined;
      if (info !== this.seen[i]) {
        this.seen[i] = info;
        if (info) any = true;
      }
    }
    return any;
  }
}

/** Set troika colorRanges when the text implementation supports it (no-op otherwise). */
export function setColorRanges(mesh: THREE.Object3D, ranges: Record<number, number> | null): void {
  const m = mesh as unknown as { colorRanges?: Record<number, number> | null };
  if (!('colorRanges' in m || 'text' in m)) return;
  // A new object makes troika lay the text out again (async: the old layout shows meanwhile), so an
  // unchanged range set — widgets re-render every frame while scrolling — must not be reassigned.
  if (sameRanges(m.colorRanges ?? null, ranges)) return;
  m.colorRanges = ranges;
}

function sameRanges(a: Record<number, number> | null, b: Record<number, number> | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k as unknown as number] !== b[k as unknown as number]) return false;
  return true;
}

// ---------------------------------------------------------------------------- markup

export type BlockKind = 'heading' | 'para' | 'bullet' | 'code' | 'rule' | 'blank';
export type SpanStyle = 'bold' | 'code';

export interface Span {
  start: number;
  end: number;
  style: SpanStyle;
}

export interface Block {
  kind: BlockKind;
  /** Text with markup removed (bullet marker not included). */
  text: string;
  /** Inline emphasis ranges into `text`. */
  spans: Span[];
  /** Bullet marker ("•", "1.") for bullets. */
  marker?: string;
  /** Nesting level for bullets (2 leading spaces = 1 level). */
  indent: number;
  /** Whole block is bold (e.g. a line that is entirely **…**) → render semibold. */
  strong: boolean;
}

/**
 * Parse panel markup, line by line:
 *   `# Title` / `## Sub`      heading
 *   `- item` / `* item` / `• item` / `1. item`   bullet (indent with 2 spaces per level)
 *   ```                       fence: lines until the closing ``` are code (mono)
 *   `---`                     horizontal rule
 *   blank line                vertical gap
 *   inline **bold** and `code`
 * A line that is entirely **bold** renders semibold; entirely `code` renders mono.
 */
export function parseMarkup(src: string): Block[] {
  const out: Block[] = [];
  let inFence = false;
  for (const raw of (src ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push({ kind: 'code', text: raw.replace(/\t/g, '  '), spans: [], indent: 0, strong: false });
      continue;
    }
    if (!line.trim()) {
      out.push({ kind: 'blank', text: '', spans: [], indent: 0, strong: false });
      continue;
    }
    if (/^\s*(-{3,}|_{3,}|\*{3,})$/.test(line)) {
      out.push({ kind: 'rule', text: '', spans: [], indent: 0, strong: false });
      continue;
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const { text, spans } = parseInline(h[1]);
      out.push({ kind: 'heading', text, spans, indent: 0, strong: true });
      continue;
    }
    const b = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (b) {
      const { text, spans } = parseInline(b[3]);
      const marker = /^\d/.test(b[2]) ? b[2] : '•';
      out.push({ kind: 'bullet', text, spans, marker, indent: Math.floor(b[1].replace(/\t/g, '  ').length / 2), strong: isWhole(spans, text, 'bold') });
      continue;
    }
    const { text, spans } = parseInline(line.trim());
    if (isWhole(spans, text, 'code')) out.push({ kind: 'code', text, spans: [], indent: 0, strong: false });
    else out.push({ kind: 'para', text, spans, indent: 0, strong: isWhole(spans, text, 'bold') });
  }
  // Trim leading/trailing blanks; collapse runs of blanks.
  const trimmed: Block[] = [];
  for (const blk of out) {
    if (blk.kind === 'blank' && (!trimmed.length || trimmed[trimmed.length - 1].kind === 'blank')) continue;
    trimmed.push(blk);
  }
  while (trimmed.length && trimmed[trimmed.length - 1].kind === 'blank') trimmed.pop();
  return trimmed;
}

function isWhole(spans: Span[], text: string, style: SpanStyle): boolean {
  return spans.length === 1 && spans[0].style === style && spans[0].start === 0 && spans[0].end === text.length && text.length > 0;
}

/** Strip **bold** and `code` markers, recording their ranges. Unclosed markers are kept literally. */
export function parseInline(s: string): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('**', i)) {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) {
        const start = text.length;
        text += s.slice(i + 2, j);
        spans.push({ start, end: text.length, style: 'bold' });
        i = j + 2;
        continue;
      }
    }
    if (s[i] === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        const start = text.length;
        text += s.slice(i + 1, j);
        spans.push({ start, end: text.length, style: 'code' });
        i = j + 1;
        continue;
      }
    }
    text += s[i];
    i++;
  }
  return { text, spans };
}

/** troika colorRanges for inline spans: {charIndex: color} switching at span edges. */
export function spanColorRanges(spans: Span[], base: number, colors: Record<SpanStyle, number>): Record<number, number> | null {
  if (!spans.length) return null;
  const r: Record<number, number> = { 0: base };
  for (const s of spans) {
    r[s.start] = colors[s.style];
    r[s.end] = base;
  }
  return r;
}
