// github-item — detail card for one GitHub issue or pull request: status chip, number, title,
// author/dates/labels, PR facts (branch → base, diff size, CI, review), then the description and
// comments in a scroll view (pinch-drag the text or the scrollbar). Reads the prefetched
// `<prefix>.details` channel of the `github` source, so switching items is instant. Link an
// item-list's `select` output to `item` (tap a row → its details), or set `number`.
//
// The scroll view is virtualized: block heights are estimated (then measured once troika lays a
// block out), only blocks near the viewport get text meshes, and texts are clipped to it (troika
// clipRect); rules / code backgrounds are clipped by hand.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, parseMarkup, setColorRanges, spanColorRanges, textSize, type Block, type Text } from '../../shared/text.ts';
import { hexToInt, resolveColor } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { STYLE } from '../../shared/style.ts';
import { SmoothScroll } from '../../shared/scroll.ts';

interface Props extends Record<string, unknown> {
  channel: string;
  control: string;
  number: number;
  width: number;
  height: number;
  textSize: number;
}

interface Detail {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  status: string;
  color: string;
  author: string;
  created: string;
  updated: string;
  closed: string;
  labels: string[];
  url: string;
  facts: string[];
  body: string;
  comments: Array<{ author: string; at: string; body: string }>;
}

const PAD = 0.018;
/** Room for the scrollbar at the right of the text column. */
const BAR = 0.014;

/** "#11", "11", "issue 11", "PR #62", {id: "#11"}, {number: 11}, a GitHub URL → 11 (NaN if none). */
export function itemNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : NaN;
  if (typeof v === 'string') {
    const m = /(?:\/(?:issues|pull)\/|#|\b)(\d+)\s*$/.exec(v.trim());
    return m ? Number(m[1]) : NaN;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['number', 'id', 'url']) {
      const n = itemNumber(o[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

/** Description + comments as one markup document. */
function documentOf(d: Detail): string {
  const parts = [d.body || 'No description.'];
  for (const c of d.comments) parts.push(`---\n# ${c.author} commented · ${c.at}\n${c.body}`);
  return parts.join('\n\n');
}

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  for (const b of parseMarkup(src)) {
    const prev = blocks[blocks.length - 1];
    if (b.kind === 'code' && prev?.kind === 'code') prev.text += '\n' + b.text;
    else if (b.kind === 'blank' && (!prev || prev.kind === 'blank')) continue;
    else blocks.push({ ...b });
  }
  while (blocks.length && blocks[blocks.length - 1].kind === 'blank') blocks.pop();
  return blocks;
}

const definition: WidgetDefinition<Props> = {
  description:
    'GitHub issue/PR detail card: status chip, number, title, author/dates/labels, PR branch/diff/CI/review, then description + comments ' +
    "in a scroll view (pinch-drag the text or scrollbar). Reads the github source's prefetched <prefix>.details channel (instant). Input item: an item-list " +
    "select (link it), '#11', 11 or a URL; prop number.",
  version: '1.1.0',
  props: {
    channel: { type: 'channel', default: 'github.bsrl.details', description: "Details channel of the github source ({items: {'<n>': Detail}})." },
    control: { type: 'channel', default: 'github.bsrl.ctl.show', description: "Channel of show requests ('#11', 11, …) — the voice fast path 'show issue 11' publishes here." },
    number: { type: 'integer', default: 0, min: 0, max: 1000000, description: 'Issue/PR number shown (set by the item input).' },
    width: { type: 'number', default: 0.56, min: 0.3, max: 2, step: 0.01, description: 'Card width (m).' },
    height: { type: 'number', default: 0.62, min: 0.3, max: 2, step: 0.01, description: 'Card height (m); longer text scrolls.' },
    textSize: { type: 'number', default: 0.0125, min: 0.006, max: 0.04, step: 0.0005, description: 'Body em height (m).' },
  },
  inputs: { item: { type: 'any', description: "Item to show: item-list select output, '#11', 11 or a GitHub URL." } },
  outputs: {},
  interactions: [dragBinding('github-item-press', 'drag')],
  size: [0.56, 0.62, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let details: Record<string, Detail> = {};
    let detail: Detail | null = null;
    let group: THREE.Group | null = null;
    let decoMat: THREE.MeshBasicMaterial | null = null;
    let codeMat: THREE.MeshBasicMaterial | null = null;
    let current = -1;

    // scroll view state
    interface Live { text: Text | null; marker: Text | null; deco: THREE.Mesh | null; size: number; indent: number; font: 'sans' | 'mono'; measured: boolean }
    let view: THREE.Group | null = null;
    let blocks: Block[] = [];
    let heights = new Float64Array(0);
    let offsets = new Float64Array(1); // offsets[i] = top of block i below the content top; offsets[n] = total
    const live = new Map<number, Live>();
    /**
     * Scroll position (content top above the view top) in centimeters — SmoothScroll's fling thresholds
     * are tuned for row-sized units: follows the hand, glides after a flick.
     */
    const sc = new SmoothScroll();
    const CM = 100;
    let bodyTop = 0, bodyBottom = 0;
    let track: THREE.Mesh | null = null;
    let thumb: THREE.Mesh | null = null;
    let dirty = false;
    let drag: { hand: string; part: string; y0: number } | null = null;

    const W = () => ctx.props.width, H = () => ctx.props.height, S = () => ctx.props.textSize;
    const colW = () => W() - 2 * PAD;
    const textW = () => colW() - BAR;
    const viewH = () => Math.max(0.01, bodyTop - bodyBottom);
    const total = () => offsets[blocks.length] ?? 0;
    const maxScroll = () => Math.max(0, total() - viewH());

    function build(): void {
      if (group) disposeTree(group);
      for (const l of live.values()) freeLive(l);
      live.clear();
      view = null;
      const g = (group = new T.Group());
      g.add(ctx.ui.panel(W(), H()));
      decoMat = ownMaterial(T, resolveColor(theme, 'accent'), { opacity: 0.45 });
      codeMat = ownMaterial(T, theme.surface, { opacity: 0.9 });
      const s = S(), x0 = -W() / 2 + PAD;
      let y = H() / 2 - PAD;
      const d = detail;
      if (!d) {
        const t = makeText(ctx, Object.keys(details).length
          ? (ctx.props.number ? `#${ctx.props.number} is not in this repo's issues or PRs.` : 'Tap an issue or PR in a list to see it here.')
          : 'Waiting for GitHub data (github source)…', { size: s * 1.1, anchorX: 'left', anchorY: 'top', color: theme.textDim, maxWidth: colW() });
        t.position.set(x0, y, STYLE.zText);
        g.add(t);
        ctx.root.add(g);
        blocks = [];
        return;
      }
      // status chip + "Issue #11"
      const chipLabel = d.status.toUpperCase();
      const chipW = chipLabel.length * s * 0.62 + s * 1.6, chipH = s * 1.9;
      const chip = ctx.ui.panel(chipW, chipH, { color: resolveColor(theme, d.color || 'accent') });
      chip.position.set(x0 + chipW / 2, y - chipH / 2, STYLE.zContent);
      chip.raycast = () => {};
      const chipText = makeText(ctx, chipLabel, { size: s * 0.85, anchorX: 'center', anchorY: 'middle', color: '#0d1117', weight: 'semibold' });
      chipText.position.set(0, 0, STYLE.zText);
      chip.add(chipText);
      const kind = makeText(ctx, `${d.kind === 'pr' ? 'Pull request' : 'Issue'} #${d.number}`, { size: s, anchorX: 'left', anchorY: 'middle', color: theme.textDim, weight: 'semibold' });
      kind.position.set(x0 + chipW + s * 0.8, y - chipH / 2, STYLE.zText);
      g.add(chip, kind);
      y -= chipH + s * 0.7;

      // title (at most 3 lines), meta, facts
      const ts = s * 1.45;
      const perLine = Math.max(10, Math.floor(colW() / (ts * 0.52)));
      const title = makeText(ctx, truncate(d.title, perLine * 3), { size: ts, anchorX: 'left', anchorY: 'top', color: theme.text, weight: 'semibold', maxWidth: colW() });
      title.position.set(x0, y, STYLE.zText);
      g.add(title);
      const tSize = textSize(title, { text: truncate(d.title, perLine * 3), size: ts, maxWidth: colW() });
      y -= tSize.height + s * 0.6;
      const when = d.kind === 'pr'
        ? d.status === 'merged' ? `merged ${d.closed}` : d.status === 'closed' ? `closed ${d.closed}` : `opened ${d.created}`
        : d.status === 'open' ? `opened ${d.created}` : `closed ${d.closed}`;
      const metaParts = [`${d.author} ${when}`, `updated ${d.updated}`, `${d.comments.length} comment${d.comments.length === 1 ? '' : 's'}`];
      const meta = makeText(ctx, metaParts.join(' · '), { size: s * 0.85, anchorX: 'left', anchorY: 'top', color: theme.textDim, maxWidth: colW() });
      meta.position.set(x0, y, STYLE.zText);
      g.add(meta);
      y -= s * 1.35;
      const lines = [...(d.facts.length ? [d.facts.join(' · ')] : []), ...(d.labels.length ? [d.labels.map((l) => `\`${l}\``).join(' · ')] : [])];
      const spanCols = { bold: hexToInt(resolveColor(theme, 'accent')), code: hexToInt(theme.accent2) };
      for (const line of lines) {
        const [b] = parseMarkup(line);
        const t = makeText(ctx, b.text, { size: s * 0.85, anchorX: 'left', anchorY: 'top', color: theme.textDim, maxWidth: colW() });
        setColorRanges(t, spanColorRanges(b.spans, hexToInt(theme.textDim), spanCols));
        t.position.set(x0, y, STYLE.zText);
        g.add(t);
        y -= s * 1.35;
      }
      y -= s * 0.2;
      const rule = new T.Mesh(sharedGeometry(T, 'plane'), decoMat);
      rule.scale.set(colW(), 0.0012, 1);
      rule.position.set(0, y, STYLE.zContent);
      rule.raycast = () => {};
      g.add(rule);
      bodyTop = y - s * 0.8;

      bodyBottom = -H() / 2 + PAD;

      // the scroll view: a hit plane for pinch-drag scrolling, the scrollbar, the (virtual) content
      const vh = bodyTop - bodyBottom;
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(textW(), vh, 0.01);
      hit.position.set(x0 + textW() / 2, bodyBottom + vh / 2, 0.004);
      hit.name = 'body';
      ctx.interactive(hit);
      track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      track.scale.set(s * 0.35, vh, 1);
      track.position.set(W() / 2 - PAD - s * 0.2, bodyBottom + vh / 2, STYLE.zContent);
      track.raycast = () => {};
      thumb = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.textDim));
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      thumb.raycast = () => {};
      const barHit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      barHit.scale.set(BAR + s, vh, 0.01);
      barHit.position.set(track.position.x, track.position.y, 0.004);
      barHit.name = 'scrollbar';
      ctx.interactive(barHit);
      view = new T.Group();
      g.add(hit, track, thumb, barHit, view);
      ctx.root.add(g);

      blocks = parseBlocks(documentOf(d));
      heights = new Float64Array(blocks.length);
      for (let i = 0; i < blocks.length; i++) heights[i] = blockHeight(blocks[i], null);
      offsets = new Float64Array(blocks.length + 1);
      recomputeOffsets();
      sc.stop();
      sc.setMax(0); // back to the top for a new item
      render();
    }

    /** Height of a block in the text column (estimate unless `mesh` has been measured). */
    function blockHeight(b: Block, mesh: THREE.Object3D | null): number {
      const s = S();
      if (b.kind === 'blank') return s * 0.6;
      if (b.kind === 'rule') return s * 0.9;
      const size = b.kind === 'heading' ? s * 1.15 : s;
      const indent = b.kind === 'bullet' ? (b.indent + 1) * s * 1.2 : 0;
      const pad = b.kind === 'code' ? s * 0.5 : 0;
      const h = textSize(mesh ?? ({} as THREE.Object3D), { text: b.text, size, maxWidth: Math.max(0.02, textW() - indent - 2 * pad), font: b.kind === 'code' ? 'mono' : 'sans' }).height;
      return h + 2 * pad + s * 0.35 + (b.kind === 'heading' ? s * 0.35 : 0);
    }

    function recomputeOffsets(): void {
      let y = 0;
      for (let i = 0; i < blocks.length; i++) { offsets[i] = y; y += heights[i]; }
      offsets[blocks.length] = y;
    }

    function makeLive(i: number): Live {
      const b = blocks[i], s = S();
      const accent = resolveColor(theme, 'accent');
      const l: Live = { text: null, marker: null, deco: null, size: s, indent: 0, font: 'sans', measured: false };
      if (b.kind === 'heading') l.size = s * 1.15;
      if (b.kind === 'code') l.font = 'mono';
      if (b.kind === 'bullet') l.indent = (b.indent + 1) * s * 1.2;
      if (b.kind === 'rule' || b.kind === 'code') {
        l.deco = new T.Mesh(sharedGeometry(T, 'plane'), b.kind === 'rule' ? decoMat! : codeMat!);
        l.deco.raycast = () => {};
        view!.add(l.deco);
      }
      if (b.kind !== 'rule' && b.kind !== 'blank') {
        const pad = b.kind === 'code' ? s * 0.5 : 0;
        l.text = makeText(ctx, b.text, {
          size: l.size, anchorX: 'left', anchorY: 'top', color: theme.text, font: l.font,
          maxWidth: Math.max(0.02, textW() - l.indent - 2 * pad), weight: b.strong || b.kind === 'heading' ? 'semibold' : 'regular',
        });
        setColorRanges(l.text, spanColorRanges(b.spans, hexToInt(theme.text), { bold: hexToInt(accent), code: hexToInt(theme.accent2) }));
        view!.add(l.text);
        if (b.kind === 'bullet') {
          l.marker = makeText(ctx, b.marker ?? '•', { size: l.size, color: accent, anchorX: 'right', anchorY: 'top' });
          view!.add(l.marker);
        }
      } else l.measured = true;
      return l;
    }

    function freeLive(l: Live): void {
      for (const o of [l.text, l.marker]) if (o) disposeTree(o);
      if (l.deco) l.deco.removeFromParent(); // shared geometry + the card's materials
    }

    /** Place what's in (or near) the viewport; create/free block meshes as they enter/leave. */
    function render(): void {
      if (!view || !blocks.length) return;
      const s = S(), x0 = -W() / 2 + PAD, vh = viewH();
      sc.setMax(maxScroll() * CM);
      const scroll = sc.pos / CM;
      const lo = scroll - vh * 0.5, hi = scroll + vh * 1.5;
      for (const [i, l] of live) {
        if (offsets[i + 1] < lo - vh || offsets[i] > hi + vh) { freeLive(l); live.delete(i); }
      }
      for (let i = 0; i < blocks.length; i++) {
        if (offsets[i + 1] < lo || offsets[i] > hi) {
          const off = live.get(i); // kept around for scrolling back, but out of view
          if (off) for (const o of [off.text, off.marker, off.deco]) if (o) o.visible = false;
          continue;
        }
        let l = live.get(i);
        if (!l) { l = makeLive(i); live.set(i, l); }
        const b = blocks[i];
        let top = bodyTop + scroll - offsets[i]; // block top in card coords
        if (b.kind === 'heading' && i > 0) top -= s * 0.35;
        const pad = b.kind === 'code' ? s * 0.5 : 0;
        const inView = top > bodyBottom && top - heights[i] < bodyTop;
        if (l.text) {
          l.text.visible = inView;
          const ty = top - pad;
          l.text.position.set(x0 + l.indent + pad, ty, STYLE.zText);
          // troika clipRect is in the text's own frame: [minX, minY, maxX, maxY]
          (l.text as unknown as { clipRect: number[] | null }).clipRect = [-1, bodyBottom - ty, 10, bodyTop - ty];
        }
        if (l.marker) {
          l.marker.visible = inView && top <= bodyTop + 1e-6 && top - l.size >= bodyBottom;
          l.marker.position.set(x0 + l.indent - s * 0.4, top, STYLE.zText);
        }
        if (l.deco) {
          // clip the rule / code background to the viewport by hand
          const h0 = b.kind === 'rule' ? 0.0012 : heights[i] - s * 0.35;
          const yTop = b.kind === 'rule' ? top - s * 0.4 : top;
          const a = Math.min(yTop, bodyTop), z = Math.max(yTop - h0, bodyBottom);
          const dw = colW() - BAR - l.indent;
          l.deco.visible = a > z;
          if (a > z) {
            l.deco.scale.set(dw, b.kind === 'rule' ? 0.0012 : a - z, 1);
            l.deco.position.set(x0 + l.indent + dw / 2, (a + z) / 2, STYLE.zContent);
          }
        }
      }
      // scrollbar
      const over = total() > vh + 1e-6;
      track!.visible = thumb!.visible = over;
      if (over) {
        const th = Math.max(s * 2, (vh * vh) / total());
        thumb!.scale.set(s * 0.35, th, 1);
        thumb!.position.y = bodyTop - th / 2 - (scroll / maxScroll()) * (vh - th);
      }
    }

    /** Swap estimated heights for measured ones as troika finishes laying out live blocks. */
    function remeasure(): boolean {
      let changed = false;
      for (const [i, l] of live) {
        if (l.measured || !l.text) continue;
        const info = (l.text as unknown as { textRenderInfo?: unknown }).textRenderInfo;
        if (!info) continue;
        l.measured = true;
        const h = blockHeight(blocks[i], l.text);
        if (Math.abs(h - heights[i]) > 1e-5) { heights[i] = h; changed = true; }
      }
      if (changed) recomputeOffsets();
      return changed;
    }

    function show(n: number): void {
      const d = details[String(n)] ?? null;
      if (d === detail && n === current) return;
      detail = d;
      current = n;
      build();
    }

    function setDetails(v: ChannelValue): void {
      const items = v && typeof v === 'object' && !Array.isArray(v) ? (v as { items?: unknown }).items : null;
      if (!items || typeof items !== 'object') { ctx.error('github-item: expected {items: {"<n>": Detail}}'); return; }
      details = items as Record<string, Detail>;
      const next = details[String(ctx.props.number)] ?? null;
      // a periodic refresh that didn't change this item keeps the card (and its scroll) as is
      if (detail && next && JSON.stringify(next) === JSON.stringify(detail)) { detail = next; return; }
      current = -1;
      show(ctx.props.number);
    }

    function request(v: unknown): void {
      const n = itemNumber(v);
      if (!Number.isFinite(n)) return;
      if (n !== ctx.props.number && !ctx.isMirror) ctx.setProps({ number: n });
      show(n);
    }

    build();
    const channel = new ChannelProp(ctx, setDetails);
    // show requests: only new ones (the value already on the channel at subscribe time is history)
    let subscribing = true;
    const control = new ChannelProp(ctx, (v) => { if (!subscribing) request(v); }, 'control');
    subscribing = false;

    return {
      onProps(p, prev) {
        if (p.channel !== prev.channel) channel.refresh();
        if (p.control !== prev.control) { subscribing = true; control.refresh(); subscribing = false; }
        if (p.width !== prev.width || p.height !== prev.height || p.textSize !== prev.textSize) { current = -1; show(Number(p.number)); }
        else if (p.number !== prev.number) show(Number(p.number));
      },
      onInput(port, v) {
        if (port === 'item') request(v);
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName ?? '';
        const y = e.localPoint[1];
        if (e.phase === 'start') {
          if (drag || (part !== 'body' && part !== 'scrollbar')) return;
          drag = { hand: e.hand, part, y0: y };
          if (part === 'body') sc.dragStart(); else sc.stop();
        } else if (!drag || e.hand !== drag.hand) return;
        else if (e.phase === 'end' || e.phase === 'cancel') {
          if (drag.part === 'body') sc.dragEnd(e.phase === 'end'); // keeps gliding after a flick
          drag = null;
          dirty = true;
          return;
        }
        if (drag.part === 'body') sc.dragMove((y - drag.y0) * CM); // content follows the hand
        else {
          // the thumb jumps to the hand: map the bar position to the scroll range (no glide)
          const vh = viewH(), th = Math.max(S() * 2, (vh * vh) / Math.max(total(), 1e-6));
          const u = (bodyTop - th / 2 - y) / Math.max(1e-6, vh - th);
          sc.scrollTo(Math.min(1, Math.max(0, u)) * maxScroll() * CM, false);
        }
        dirty = true;
      },
      update(dt) {
        if (sc.active && sc.step(dt)) dirty = true;
        if (remeasure()) dirty = true;
        if (!dirty) return;
        dirty = false;
        render();
      },
      dispose() {
        channel.dispose();
        control.dispose();
        for (const l of live.values()) freeLive(l);
        live.clear();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
