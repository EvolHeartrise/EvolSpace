// github-item — detail card for one GitHub issue or pull request: status chip, number, title,
// author/dates/labels, PR facts (branch → base, diff size, CI, review), then the description and
// comments as paged markup (Prev/Next page). Reads the prefetched `<prefix>.details` channel of the
// `github` source, so switching items is instant. Link an item-list's `select` output to `item`
// (tap a row → its details), or set `number`.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, parseMarkup, setColorRanges, spanColorRanges, textSize, type Block, type Text } from '../../shared/text.ts';
import { hexToInt, resolveColor } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { STYLE } from '../../shared/style.ts';

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
    "as paged markup (Prev/Next page). Reads the github source's prefetched <prefix>.details channel (instant). Input item: an item-list " +
    "select (link it), '#11', 11 or a URL; prop number.",
  version: '1.0.0',
  props: {
    channel: { type: 'channel', default: 'github.bsrl.details', description: "Details channel of the github source ({items: {'<n>': Detail}})." },
    control: { type: 'channel', default: 'github.bsrl.ctl.show', description: "Channel of show requests ('#11', 11, …) — the voice fast path 'show issue 11' publishes here." },
    number: { type: 'integer', default: 0, min: 0, max: 1000000, description: 'Issue/PR number shown (set by the item input).' },
    width: { type: 'number', default: 0.56, min: 0.3, max: 2, step: 0.01, description: 'Card width (m).' },
    height: { type: 'number', default: 0.62, min: 0.3, max: 2, step: 0.01, description: 'Card height (m); longer text pages.' },
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
    let pageGroup: THREE.Group | null = null;
    let blocks: Block[] = [];
    let page = 0;
    let pageStarts: number[] = [0];
    let estPages = 1;
    let pageItems: Array<{ b: Block; text: Text | null; marker: Text | null; deco: THREE.Mesh | null; size: number; indent: number; font: 'sans' | 'mono' }> = [];
    let bodyTop = 0;
    let bodyBottom = 0;
    const watch = new MeasureWatch();
    let pageText: Text | null = null;
    let prevBtn: THREE.Mesh | null = null;
    let nextBtn: THREE.Mesh | null = null;
    let decoMat: THREE.MeshBasicMaterial | null = null;
    let codeMat: THREE.MeshBasicMaterial | null = null;
    let pressPart = '';
    let pressHand: string | null = null;
    let current = -1;

    const W = () => ctx.props.width, H = () => ctx.props.height, S = () => ctx.props.textSize;
    const colW = () => W() - 2 * PAD;

    function build(): void {
      if (group) disposeTree(group);
      pageGroup = null;
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
      pageText = makeText(ctx, '', { size: s * 0.85, anchorX: 'right', anchorY: 'middle', color: theme.textDim });
      pageText.position.set(W() / 2 - PAD, y - chipH / 2, STYLE.zText);
      g.add(chip, kind, pageText);
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

      // footer: page buttons
      const bh = s * 2.2, bw = s * 8;
      const fy = -H() / 2 + PAD + bh / 2;
      bodyBottom = fy + bh / 2 + s * 0.6;
      prevBtn = ctx.ui.panel(bw, bh, { color: theme.surface });
      prevBtn.position.set(-W() / 2 + PAD + bw / 2, fy, STYLE.zContent);
      prevBtn.name = 'btn:prev';
      nextBtn = ctx.ui.panel(bw, bh, { color: theme.surface });
      nextBtn.position.set(W() / 2 - PAD - bw / 2, fy, STYLE.zContent);
      nextBtn.name = 'btn:next';
      for (const [btn, label] of [[prevBtn, 'Prev page'], [nextBtn, 'Next page']] as const) {
        const t = makeText(ctx, label, { size: s * 0.9, anchorX: 'center', anchorY: 'middle', color: theme.text });
        t.position.set(0, 0, STYLE.zText);
        btn.add(t);
        ctx.interactive(btn);
        g.add(btn);
      }
      ctx.root.add(g);

      blocks = parseBlocks(documentOf(d));
      pageStarts = [0];
      page = 0;
      estPages = estimatePages();
      showPage();
    }

    /** Height of a block at the body column (estimate unless `mesh` has been measured). */
    function blockHeight(b: Block, mesh: THREE.Object3D | null): number {
      const s = S();
      if (b.kind === 'blank') return s * 0.6;
      if (b.kind === 'rule') return s * 0.9;
      const size = b.kind === 'heading' ? s * 1.15 : s;
      const indent = b.kind === 'bullet' ? (b.indent + 1) * s * 1.2 : 0;
      const pad = b.kind === 'code' ? s * 0.5 : 0;
      const h = textSize(mesh ?? ({} as THREE.Object3D), { text: b.text, size, maxWidth: Math.max(0.02, colW() - indent - 2 * pad), font: b.kind === 'code' ? 'mono' : 'sans' }).height;
      return h + 2 * pad + s * 0.35 + (b.kind === 'heading' ? s * 0.35 : 0);
    }

    function estimatePages(): number {
      const avail = bodyTop - bodyBottom;
      let n = 1, used = 0;
      for (const b of blocks) {
        const h = blockHeight(b, null);
        if (used > 0 && used + h > avail) { n++; used = 0; if (b.kind === 'blank' || b.kind === 'rule') continue; }
        used += h;
      }
      return n;
    }

    /** Create the current page's texts (from pageStarts[page]); layout() decides what fits. */
    function showPage(): void {
      if (!group) return;
      if (pageGroup) disposeTree(pageGroup);
      pageGroup = new T.Group();
      group.add(pageGroup);
      pageItems = [];
      const s = S();
      const accent = resolveColor(theme, 'accent');
      const spanCols = { bold: hexToInt(accent), code: hexToInt(theme.accent2) };
      const avail = bodyTop - bodyBottom;
      let est = 0;
      for (let i = pageStarts[page]; i < blocks.length && est < avail * 1.4; i++) {
        const b = blocks[i];
        est += blockHeight(b, null);
        const it = { b, text: null as Text | null, marker: null as Text | null, deco: null as THREE.Mesh | null, size: s, indent: 0, font: 'sans' as 'sans' | 'mono' };
        if (b.kind === 'heading') it.size = s * 1.15;
        if (b.kind === 'code') it.font = 'mono';
        if (b.kind === 'bullet') it.indent = (b.indent + 1) * s * 1.2;
        if (b.kind === 'rule' || b.kind === 'code') {
          it.deco = new T.Mesh(sharedGeometry(T, 'plane'), b.kind === 'rule' ? decoMat! : codeMat!);
          it.deco.raycast = () => {};
          pageGroup.add(it.deco);
        }
        if (b.kind !== 'rule' && b.kind !== 'blank') {
          const pad = b.kind === 'code' ? s * 0.5 : 0;
          it.text = makeText(ctx, b.text, {
            size: it.size, anchorX: 'left', anchorY: 'top', color: theme.text, font: it.font,
            maxWidth: Math.max(0.02, colW() - it.indent - 2 * pad), weight: b.strong || b.kind === 'heading' ? 'semibold' : 'regular',
          });
          setColorRanges(it.text, spanColorRanges(b.spans, hexToInt(theme.text), spanCols));
          pageGroup.add(it.text);
          if (b.kind === 'bullet') {
            it.marker = makeText(ctx, b.marker ?? '•', { size: it.size, color: accent, anchorX: 'right', anchorY: 'top' });
            pageGroup.add(it.marker);
          }
        }
        pageItems.push(it);
      }
      watch.reset(pageItems.flatMap((i) => (i.text ? [i.text] : [])));
      layout();
    }

    /** Place the page's blocks top-down; blocks that don't fit are hidden and start the next page. */
    function layout(): void {
      if (!pageGroup) return;
      const s = S(), x0 = -W() / 2 + PAD;
      let y = bodyTop;
      let end = pageStarts[page] + pageItems.length;
      let full = false;
      for (let k = 0; k < pageItems.length; k++) {
        const it = pageItems[k], b = it.b;
        const h = blockHeight(b, it.text);
        // the first block always shows (even if taller than the page); later ones only while they fit
        if (!full && k > 0 && y - h < bodyBottom) { full = true; end = pageStarts[page] + k; }
        if (full) {
          for (const o of [it.text, it.marker, it.deco]) if (o) o.visible = false;
          continue;
        }
        for (const o of [it.text, it.marker, it.deco]) if (o) o.visible = true;
        if (b.kind === 'heading' && k > 0) y -= s * 0.35;
        const pad = b.kind === 'code' ? s * 0.5 : 0;
        if (b.kind === 'rule') {
          it.deco!.scale.set(colW(), 0.0012, 1);
          it.deco!.position.set(0, y - s * 0.4, STYLE.zContent);
        } else if (it.text) {
          it.text.position.set(x0 + it.indent + pad, y - pad, STYLE.zText);
          if (it.marker) it.marker.position.set(x0 + it.indent - s * 0.4, y, STYLE.zText);
          if (it.deco) {
            const dh = h - s * 0.35, dw = colW() - it.indent;
            it.deco.scale.set(dw, dh, 1);
            it.deco.position.set(x0 + it.indent + dw / 2, y - dh / 2, STYLE.zContent);
          }
        }
        y -= b.kind === 'heading' && k > 0 ? h - s * 0.35 : h;
      }
      // skip leading blanks/rules on the next page
      while (end < blocks.length && (blocks[end].kind === 'blank' || blocks[end].kind === 'rule')) end++;
      pageStarts[page + 1] = end;
      pageStarts.length = page + 2;
      const more = end < blocks.length;
      const total = Math.max(estPages, page + (more ? 2 : 1));
      pageText?.set(`page ${page + 1} / ${more ? total : page + 1}`);
      if (prevBtn) prevBtn.visible = page > 0;
      if (nextBtn) nextBtn.visible = more;
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
      // a periodic refresh that didn't change this item keeps the card (and its page) as is
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
        if (e.phase === 'start') {
          if (part.startsWith('btn:')) { pressPart = part; pressHand = e.hand; }
          return;
        }
        if (e.hand !== pressHand || (e.phase !== 'end' && e.phase !== 'cancel')) return;
        pressHand = null;
        if (e.phase !== 'end') return;
        if (pressPart === 'btn:next' && pageStarts[page + 1] < blocks.length) { page++; showPage(); }
        else if (pressPart === 'btn:prev' && page > 0) { page--; showPage(); }
      },
      update() {
        if (watch.changed()) layout();
      },
      dispose() {
        channel.dispose();
        control.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
