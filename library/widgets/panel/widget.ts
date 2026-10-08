// panel: a card with a title and a body of lightly formatted text — notes,
// explanations, status read-outs. Markup (one block per line):
//   # heading · - bullets (indent 2 spaces per level) · 1. numbered · ``` code fences ```
//   --- rule · blank line = gap · inline **bold** and `code` (shown in accent colors)
// Auto-sizes to its content unless width/height are given. Layout runs with
// estimated glyph sizes first and is refined once the real text is measured.

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { hexToInt, resolveColor } from '../../shared/color.ts';
import { formatValue } from '../../shared/format.ts';
import { ownMaterial, disposeTree, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, parseMarkup, setColorRanges, spanColorRanges, textSize, type Block, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface PanelProps extends Record<string, unknown> {
  title: string;
  body: string;
  width: number;
  height: number;
  maxWidth: number;
  textSize: number;
  color: string;
  opacity: number;
  accent: string;
}

interface Item {
  block: Block;
  /** Main text mesh (null for rules/blanks). */
  text: Text | null;
  marker: Text | null;
  /** Rule line / code background. */
  deco: THREE.Mesh | null;
  size: number;
  font: 'sans' | 'mono';
  indentX: number;
}

const definition: WidgetDefinition<PanelProps> = {
  description:
    'A card with a title and formatted body text (notes, explanations, status). Body markup per line: "# heading", "- bullet" (2-space indent nests), "1. numbered", ``` code fences, "---" rule, blank line = gap, inline **bold** and `code`. ' +
    'Auto-sizes unless width/height are set. Inputs `body`/`title` replace the text.',
  version: '1.0.0',
  props: {
    title: { type: 'string', default: 'Panel', description: 'Title line (empty = none).' },
    body: { type: 'string', default: 'Body text with **bold**, `code` and\n- bullet points', description: 'Body markup (see description).' },
    width: { type: 'number', default: 0, min: 0, max: 5, description: 'Fixed width in meters; 0 = fit content up to maxWidth.' },
    height: { type: 'number', default: 0, min: 0, max: 5, description: 'Fixed height in meters; 0 = fit content. Overflowing content is not clipped.' },
    maxWidth: { type: 'number', default: 0.45, min: 0.05, max: 5, description: 'Wrap width for auto-sized panels (meters).' },
    textSize: { type: 'number', default: 0.016, min: 0.004, max: 0.2, description: 'Body em height in meters (title is 1.3×).' },
    color: { type: 'color', default: 'background', description: 'Panel fill (theme token or CSS color).' },
    opacity: { type: 'number', default: 0.86, min: 0, max: 1 },
    accent: { type: 'color', default: 'accent', description: 'Color of bullets, rules and **bold** text.' },
  },
  inputs: {
    body: { type: 'any', description: 'Replaces the body (strings as markup; other values as JSON).' },
    title: { type: 'string', description: 'Replaces the title.' },
  },
  size: [0.4, 0.25, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const root = new T.Group();
    root.name = 'panel-root';
    ctx.root.add(root);
    let content: THREE.Group | null = null;
    let card: THREE.Mesh | null = null;
    let cardKey = '';
    let title: Text | null = null;
    let items: Item[] = [];
    let bodyOverride: string | null = null;
    let titleOverride: string | null = null;
    let decoMat: THREE.MeshBasicMaterial | null = null;
    let codeMat: THREE.MeshBasicMaterial | null = null;
    const watch = new MeasureWatch();

    const bodyText = () => bodyOverride ?? String(ctx.props.body ?? '');
    const titleText = () => titleOverride ?? String(ctx.props.title ?? '');

    /** Wrap width available to text in the content column. */
    const columnWidth = () => {
      const p = ctx.props;
      return (p.width > 0 ? p.width : p.maxWidth) - 2 * STYLE.pad;
    };

    function build(): void {
      if (content) disposeTree(content);
      content = new T.Group();
      content.name = 'panel-content';
      root.add(content);
      const p = ctx.props;
      const accent = resolveColor(ctx.theme, p.accent, 'accent');
      decoMat?.dispose();
      codeMat?.dispose();
      decoMat = ownMaterial(T, accent, { opacity: 0.5 });
      codeMat = ownMaterial(T, ctx.theme.surface, { opacity: 0.9 });
      const colW = columnWidth();
      const ts = p.textSize;
      title = null;
      const tt = titleText();
      if (tt) {
        title = makeText(ctx, tt, { size: ts * 1.3, color: ctx.theme.text, anchorX: 'left', anchorY: 'top', maxWidth: colW, weight: 'semibold' });
        title.name = 'title';
        content.add(title);
      }
      items = [];
      const { base: baseInt, spans: spanColors } = inlineColors();
      for (const b of parseBlocks(bodyText())) {
        const it: Item = { block: b, text: null, marker: null, deco: null, size: ts, font: 'sans', indentX: 0 };
        if (b.kind === 'heading') it.size = ts * 1.15;
        if (b.kind === 'code') it.font = 'mono';
        if (b.kind === 'bullet') it.indentX = (b.indent + 1) * ts * 1.2;
        if (b.kind === 'rule') {
          it.deco = new T.Mesh(sharedGeometry(T, 'plane'), decoMat);
          it.deco.name = 'rule';
        }
        if (b.kind === 'code') {
          it.deco = new T.Mesh(sharedGeometry(T, 'plane'), codeMat);
          it.deco.name = 'code-bg';
        }
        if (it.deco) {
          it.deco.raycast = () => {};
          content.add(it.deco);
        }
        if (b.kind !== 'rule' && b.kind !== 'blank') {
          const pad = b.kind === 'code' ? ts * 0.5 : 0;
          it.text = makeText(ctx, b.text, {
            size: it.size,
            color: ctx.theme.text,
            anchorX: 'left',
            anchorY: 'top',
            font: it.font,
            maxWidth: Math.max(0.02, colW - it.indentX - 2 * pad),
            weight: b.strong || b.kind === 'heading' ? 'semibold' : 'regular',
          });
          it.text.name = b.kind;
          setColorRanges(it.text, spanColorRanges(b.spans, baseInt, spanColors));
          content.add(it.text);
          if (b.kind === 'bullet') {
            it.marker = makeText(ctx, b.marker ?? '•', { size: it.size, color: accent, anchorX: 'right', anchorY: 'top' });
            content.add(it.marker);
          }
        }
        items.push(it);
      }
      watch.reset([...(title ? [title] : []), ...items.flatMap((i) => (i.text ? [i.text] : []))]);
      layout();
    }

    /** Body markup → blocks, consecutive code lines merged into one mono block. */
    function parseBlocks(src: string): Block[] {
      const blocks: Block[] = [];
      for (const b of parseMarkup(src)) {
        const prev = blocks[blocks.length - 1];
        if (b.kind === 'code' && prev?.kind === 'code') prev.text += '\n' + b.text;
        else blocks.push({ ...b });
      }
      return blocks;
    }

    /** troika colorRanges colors for inline **bold** / `code` spans. */
    function inlineColors(): { base: number; spans: { bold: number; code: number } } {
      const accent = resolveColor(ctx.theme, ctx.props.accent, 'accent');
      return { base: hexToInt(ctx.theme.text), spans: { bold: hexToInt(accent), code: hexToInt(ctx.theme.accent2) } };
    }

    /**
     * The body changed but its block structure didn't (same kinds, nesting and markers —
     * the common case for a status panel fed by a channel): update the existing texts in
     * place instead of re-creating every SDF text mesh. Returns false when a rebuild is needed.
     */
    function updateBodyInPlace(): boolean {
      const blocks = parseBlocks(bodyText());
      if (blocks.length !== items.length) return false;
      for (let i = 0; i < blocks.length; i++) {
        const a = items[i].block;
        const b = blocks[i];
        if (a.kind !== b.kind || a.strong !== b.strong || a.indent !== b.indent || (a.marker ?? '') !== (b.marker ?? '')) return false;
      }
      const { base, spans } = inlineColors();
      for (let i = 0; i < blocks.length; i++) {
        const it = items[i];
        it.block = blocks[i];
        if (it.text) {
          it.text.set(blocks[i].text);
          setColorRanges(it.text, spanColorRanges(blocks[i].spans, base, spans));
        }
      }
      layout();
      return true;
    }

    /** Position everything top-down and size the card. Cheap; runs again when measurements arrive. */
    function layout(): void {
      const p = ctx.props;
      const ts = p.textSize;
      const colW = columnWidth();
      let y = 0;
      let widest = 0;
      const placed: Array<{ it: Item; y: number; h: number; w: number }> = [];
      if (title) {
        const s = textSize(title, { text: titleText(), size: ts * 1.3, maxWidth: colW });
        title.position.set(0, 0, STYLE.zText);
        y -= s.height + ts * 0.6;
        widest = Math.max(widest, s.width);
      }
      for (const it of items) {
        const b = it.block;
        if (b.kind === 'blank') { y -= ts * 0.6; continue; }
        if (b.kind === 'rule') {
          y -= ts * 0.4;
          placed.push({ it, y, h: 0.0012, w: 0 });
          y -= ts * 0.5;
          continue;
        }
        const pad = b.kind === 'code' ? ts * 0.5 : 0;
        const s = textSize(it.text!, { text: b.text, size: it.size, maxWidth: Math.max(0.02, colW - it.indentX - 2 * pad), font: it.font });
        if (b.kind === 'heading' && placed.length) y -= ts * 0.35;
        placed.push({ it, y, h: s.height + 2 * pad, w: s.width + 2 * pad });
        widest = Math.max(widest, it.indentX + s.width + 2 * pad);
        y -= s.height + 2 * pad + ts * 0.35;
      }
      const contentH = -y - (items.length || title ? ts * 0.35 : 0);
      // Quantize auto sizes to 5 mm so small re-measurements don't churn panel geometries.
      const q = (x: number) => Math.ceil(x / 0.005 - 1e-6) * 0.005;
      const w = p.width > 0 ? p.width : q(Math.min(p.maxWidth, Math.max(0.08, widest + 2 * STYLE.pad)));
      const h = p.height > 0 ? p.height : q(Math.max(0.04, contentH + 2 * STYLE.pad));
      // Origin = card center; content column starts at the top-left inner corner.
      const x0 = -w / 2 + STYLE.pad;
      const y0 = h / 2 - STYLE.pad;
      if (title) title.position.set(x0, y0, STYLE.zText);
      for (const { it, y: yy, h: hh } of placed) {
        const pad = it.block.kind === 'code' ? ts * 0.5 : 0;
        if (it.text) it.text.position.set(x0 + it.indentX + pad, y0 + yy - pad, STYLE.zText);
        if (it.marker) it.marker.position.set(x0 + it.indentX - ts * 0.4, y0 + yy, STYLE.zText);
        if (it.deco) {
          const dw = w - 2 * STYLE.pad - it.indentX;
          it.deco.scale.set(dw, hh, 1);
          it.deco.position.set(x0 + it.indentX + dw / 2, y0 + yy - hh / 2, STYLE.zContent);
        }
      }
      // Re-create the card only when its size changes.
      const key = `${w.toFixed(4)}|${h.toFixed(4)}|${p.color}|${p.opacity}`;
      if (key !== cardKey) {
        card?.removeFromParent();
        card = ctx.ui.panel(w, h, { color: resolveColor(ctx.theme, p.color, 'background'), opacity: p.opacity });
        card.name = 'card';
        root.add(card);
        cardKey = key;
      }
    }

    build();
    return {
      onProps: build,
      onInput(port, v) {
        if (port === 'body') {
          bodyOverride = v === undefined || v === null ? null : typeof v === 'string' ? v : toMarkup(v);
          if (!updateBodyInPlace()) build();
          return;
        }
        if (port !== 'title') return;
        const hadTitle = !!titleText();
        titleOverride = v === undefined || v === null ? null : String(v);
        // A title before and after: swap its text in place.
        if (title && hadTitle && titleText()) {
          title.set(titleText());
          layout();
        } else build();
      },
      update() {
        if (watch.changed()) layout();
      },
      dispose() {
        disposeTree(root);
      },
    };
  },
};

/** Non-string body input → pretty JSON in a code block (numbers/booleans inline). */
function toMarkup(v: unknown): string {
  if (typeof v !== 'object') return formatValue(v);
  let json: string;
  try {
    json = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    json = String(v);
  }
  const lines = json.split('\n');
  const shown = lines.length > 40 ? [...lines.slice(0, 40), '…'] : lines;
  return '```\n' + shown.join('\n') + '\n```';
}

export default definition;
