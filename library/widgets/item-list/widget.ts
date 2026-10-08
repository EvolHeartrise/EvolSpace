// item-list — a scrollable list card of status-tagged items (GitHub issues/PRs, tasks, runs, …).
// Each row: a status color stripe, "id  title" and a dim meta line that starts with the status
// word in its color. Filter tabs (All + one per status, with counts) sit under the title; pinch-drag
// the rows to scroll, pinch/poke a row to select it (output `select`).
//
// Data (input `items` or the `channel` prop): Item[] or {title?, updatedAt?, items: Item[]} with
// Item = {id?, title, status?, color?, meta?, url?, labels?: [{name}]}.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry, hitMaterial } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { resolveColor, hexToInt } from '../../shared/color.ts';
import { truncate, formatAge } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  title: string;
  channel: string;
  width: number;
  rows: number;
  textSize: number;
  filter: string;
  statusColors: Record<string, string>;
}

interface Item {
  id: string;
  title: string;
  status: string;
  color: string;
  meta: string;
  url?: string;
  labels: string[];
}

const PAD = 0.016;
const MAX_TABS = 6;

function parseItems(v: unknown): { title: string; updatedAt: number; items: Item[] } | null {
  let raw: unknown[] | null = null;
  let title = '', updatedAt = NaN;
  if (Array.isArray(v)) raw = v;
  else if (v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items)) {
    const o = v as { items: unknown[]; title?: unknown; updatedAt?: unknown };
    raw = o.items;
    if (typeof o.title === 'string') title = o.title;
    if (typeof o.updatedAt === 'string' || typeof o.updatedAt === 'number') updatedAt = new Date(o.updatedAt).getTime();
  }
  if (!raw) return null;
  const items: Item[] = [];
  for (const r of raw) {
    if (typeof r === 'string') { items.push({ id: '', title: r, status: '', color: '', meta: '', labels: [] }); continue; }
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' || typeof o[k] === 'number' ? String(o[k]) : '');
    const labels = Array.isArray(o.labels)
      ? o.labels.map((l) => (typeof l === 'string' ? l : l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string' ? (l as { name: string }).name : '')).filter(Boolean)
      : [];
    items.push({ id: str('id'), title: str('title') || str('name'), status: str('status').toLowerCase(), color: str('color'), meta: str('meta'), url: str('url') || undefined, labels });
  }
  return { title, updatedAt, items };
}

const definition: WidgetDefinition<Props> = {
  description:
    'Scrollable list card of status-tagged items (e.g. GitHub issues/PRs): color stripe, "id title", meta line led by the status, ' +
    'filter tabs with counts, pinch-drag to scroll, pinch/poke a row to select (output select). Input items / channel prop: ' +
    'Item[] or {title, updatedAt, items}; Item = {id, title, status, color?, meta?, url?, labels?}.',
  version: '1.0.0',
  props: {
    title: { type: 'string', default: '', description: "Card title; empty = the data's title." },
    channel: { type: 'channel', default: '', description: 'Data channel (same shapes as the items input).' },
    width: { type: 'number', default: 0.62, min: 0.25, max: 2, step: 0.01, description: 'Card width (m).' },
    rows: { type: 'integer', default: 10, min: 3, max: 30, description: 'Visible rows.' },
    textSize: { type: 'number', default: 0.0125, min: 0.006, max: 0.04, step: 0.0005, description: 'Row title em height (m); the layout scales with it.' },
    filter: { type: 'string', default: '', description: "Status shown ('' = all); set by the tabs." },
    statusColors: {
      type: 'json',
      default: { open: '#3fb950', merged: '#a371f7', closed: '#a371f7', draft: '#8b949e', 'not planned': '#8b949e' },
      description: 'Status → color, used for items without their own color.',
    },
  },
  inputs: { items: { type: 'any', description: 'Item[] or {title, updatedAt, items}.' } },
  outputs: { select: { type: 'json', description: 'The selected item.' } },
  interactions: [dragBinding('item-list-drag', 'drag')],
  size: [0.62, 0.5, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let group: THREE.Group | null = null;
    let data: { title: string; updatedAt: number; items: Item[] } = { title: '', updatedAt: NaN, items: [] };
    let shown: Item[] = [];
    let scroll = 0;
    let selected: Item | null = null;
    let hovered = -1;
    let dirty = true;
    let ageTimer = 0;

    // built parts
    let titleText: Text | null = null;
    let ageText: Text | null = null;
    let tabsGroup: THREE.Group | null = null;
    let tabKeys: string[] = [];
    const rowParts: Array<{ g: THREE.Group; stripe: THREE.Mesh; mat: THREE.MeshBasicMaterial; line1: Text; line2: Text }> = [];
    let hoverPlate: THREE.Mesh | null = null;
    let selPlate: THREE.Mesh | null = null;
    let thumb: THREE.Mesh | null = null;
    let track: THREE.Mesh | null = null;
    let L = layout();

    function layout() {
      const s = ctx.props.textSize, w = ctx.props.width, n = ctx.props.rows;
      const rowH = s * 2.9, titleH = s * 2.4, tabsH = s * 2.1;
      const h = PAD + titleH + tabsH + s * 0.8 + n * rowH + PAD * 0.7;
      const top = h / 2 - PAD;
      return { s, w, n, rowH, titleH, tabsH, h, top, rowsTop: top - titleH - tabsH - s * 0.8, x0: -w / 2 + PAD, x1: w / 2 - PAD };
    }

    const colorOf = (it: Item) => {
      const map = ctx.props.statusColors && typeof ctx.props.statusColors === 'object' ? ctx.props.statusColors : {};
      return resolveColor(theme, it.color || map[it.status] || theme.textDim, 'textDim');
    };

    function build(): void {
      if (group) disposeTree(group);
      rowParts.length = 0;
      L = layout();
      const g = (group = new T.Group());
      g.add(ctx.ui.panel(L.w, L.h));
      titleText = makeText(ctx, '', { size: L.s * 1.5, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      titleText.position.set(L.x0, L.top - L.titleH / 2 + L.s * 0.2, STYLE.zText);
      ageText = makeText(ctx, '', { size: L.s * 0.8, anchorX: 'right', anchorY: 'middle', color: theme.textDim });
      ageText.position.set(L.x1, L.top - L.titleH / 2 + L.s * 0.2, STYLE.zText);
      g.add(titleText, ageText);

      hoverPlate = ctx.ui.panel(L.w - PAD, L.rowH - L.s * 0.3, { color: theme.surface, opacity: 0.6 });
      hoverPlate.visible = false;
      hoverPlate.raycast = () => {};
      selPlate = ctx.ui.panel(L.w - PAD, L.rowH - L.s * 0.3, { color: theme.surface });
      selPlate.visible = false;
      selPlate.raycast = () => {};
      g.add(hoverPlate, selPlate);

      for (let r = 0; r < L.n; r++) {
        const rg = new T.Group();
        rg.position.set(0, L.rowsTop - (r + 0.5) * L.rowH, 0);
        const mat = ownMaterial(T, theme.textDim);
        const stripe = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        stripe.scale.set(L.s * 0.32, L.rowH - L.s * 0.7, 1);
        stripe.position.set(L.x0 + L.s * 0.16, 0, STYLE.zContent * 2);
        stripe.raycast = () => {};
        const tx = L.x0 + L.s * 0.9;
        const line1 = makeText(ctx, '', { size: L.s, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        line1.position.set(tx, L.s * 0.55, STYLE.zText);
        const line2 = makeText(ctx, '', { size: L.s * 0.78, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
        line2.position.set(tx, -L.s * 0.68, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(L.w - PAD, L.rowH, 0.01);
        hit.name = `row:${r}`;
        ctx.interactive(hit);
        rg.add(stripe, line1, line2, hit);
        g.add(rg);
        rowParts.push({ g: rg, stripe, mat, line1, line2 });
      }

      const rowsH = L.n * L.rowH;
      track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      track.scale.set(L.s * 0.18, rowsH, 1);
      track.position.set(L.w / 2 - PAD * 0.45, L.rowsTop - rowsH / 2, STYLE.zContent);
      thumb = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.textDim));
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      for (const m of [track, thumb]) { m.raycast = () => {}; g.add(m); }

      ctx.root.add(g);
      tabKeys = [];
      tabsGroup = null; // disposed with the old group
      buildTabs();
      dirty = true;
    }

    function counts(): Map<string, number> {
      const m = new Map<string, number>();
      for (const it of data.items) if (it.status) m.set(it.status, (m.get(it.status) ?? 0) + 1);
      return m;
    }

    /** Tabs: All + each status (open first, then by count). Rebuilt when statuses/counts/filter change. */
    function buildTabs(): void {
      if (!group) return;
      const c = counts();
      const statuses = [...c.keys()].sort((a, b) => (a === 'open' ? -1 : b === 'open' ? 1 : (c.get(b) ?? 0) - (c.get(a) ?? 0))).slice(0, MAX_TABS - 1);
      const keys = ['', ...statuses];
      const sig = keys.map((k) => `${k}:${k ? c.get(k) : data.items.length}`).join('|') + `#${ctx.props.filter}`;
      if (sig === tabKeys.join('|')) return;
      tabKeys = sig.split('|');
      if (tabsGroup) disposeTree(tabsGroup);
      const tg = (tabsGroup = new T.Group());
      const y = L.top - L.titleH - L.tabsH / 2 + L.s * 0.2;
      let x = L.x0;
      const fs = L.s * 0.82, h = L.s * 1.7;
      keys.forEach((k, i) => {
        const label = `${k ? k[0].toUpperCase() + k.slice(1) : 'All'}  ${k ? c.get(k) : data.items.length}`;
        const w = Math.max(L.s * 4, label.length * fs * 0.56 + L.s * 1.4);
        const active = (ctx.props.filter || '') === k;
        const chip = ctx.ui.panel(w, h, { color: active ? (k ? colorOf({ status: k } as Item) : theme.accent) : theme.surface, opacity: active ? 0.9 : 1 });
        chip.position.set(x + w / 2, y, STYLE.zContent);
        chip.name = `tab:${i}`;
        ctx.interactive(chip);
        const t = makeText(ctx, label, { size: fs, anchorX: 'center', anchorY: 'middle', color: active ? theme.background : theme.text, weight: active ? 'semibold' : 'regular' });
        t.position.set(0, 0, STYLE.zText);
        chip.add(t);
        chip.userData.filterKey = k;
        tg.add(chip);
        x += w + L.s * 0.5;
      });
      group.add(tg);
    }

    function applyFilter(): void {
      const f = ctx.props.filter || '';
      shown = f ? data.items.filter((it) => it.status === f) : data.items;
      scroll = Math.min(scroll, Math.max(0, shown.length - L.n));
    }

    function render(): void {
      if (!group) return;
      const name = ctx.props.title || data.title || 'Items';
      titleText!.set(name);
      renderAge();
      const first = Math.round(scroll);
      const avail = L.x1 - (L.x0 + L.s * 0.9) - L.s * 0.6;
      const chars1 = Math.max(8, Math.floor(avail / (L.s * 0.5)));
      const chars2 = Math.max(8, Math.floor(avail / (L.s * 0.78 * 0.5)));
      const textInt = hexToInt(resolveColor(theme, 'text')), dimInt = hexToInt(resolveColor(theme, 'textDim'));
      let selRow = -1;
      for (let r = 0; r < L.n; r++) {
        const p = rowParts[r], it = shown[first + r];
        p.g.visible = !!it || (r === 0 && !shown.length);
        if (!it) {
          if (r === 0) {
            p.line1.set(data.items.length ? 'Nothing with this status' : 'Waiting for data…');
            p.line2.set('');
            p.stripe.visible = false;
          }
          continue;
        }
        p.stripe.visible = true;
        const col = colorOf(it);
        p.mat.color.set(col);
        const id = it.id ? `${it.id}  ` : '';
        p.line1.set(truncate(id + it.title, chars1));
        setColorRanges(p.line1, id ? { 0: dimInt, [id.length]: textInt } : null);
        const status = it.status ? it.status.toUpperCase() : '';
        const extra = [it.meta, it.labels.length ? it.labels.join(', ') : ''].filter(Boolean).join(' · ');
        const meta = status ? (extra ? `${status} · ${extra}` : status) : extra;
        p.line2.set(truncate(meta, chars2));
        setColorRanges(p.line2, status ? { 0: hexToInt(col), [status.length]: dimInt } : null);
        if (selected && it === selected) selRow = r;
      }
      selPlate!.visible = selRow >= 0;
      if (selRow >= 0) selPlate!.position.set(0, rowParts[selRow].g.position.y, STYLE.zContent);
      hoverPlate!.visible = hovered >= 0 && hovered < L.n && !!shown[first + hovered] && hovered !== selRow;
      if (hoverPlate!.visible) hoverPlate!.position.set(0, rowParts[hovered].g.position.y, STYLE.zContent);
      const over = shown.length > L.n;
      track!.visible = thumb!.visible = over;
      if (over) {
        const rowsH = L.n * L.rowH, th = Math.max(L.s * 1.5, (rowsH * L.n) / shown.length);
        const u = first / (shown.length - L.n);
        thumb!.scale.set(L.s * 0.18, th, 1);
        thumb!.position.y = L.rowsTop - th / 2 - u * (rowsH - th);
      }
    }

    function renderAge(): void {
      const n = shown.length, total = data.items.length;
      const count = ctx.props.filter ? `${n} of ${total}` : `${total}`;
      const age = Number.isFinite(data.updatedAt) ? ` · updated ${formatAge(Date.now() - data.updatedAt)}${Date.now() - data.updatedAt < 1000 ? '' : ' ago'}` : '';
      ageText!.set(`${count}${age}`);
    }

    function setData(v: unknown): void {
      const d = parseItems(v);
      if (!d) { ctx.error('item-list: expected Item[] or {items: Item[]}'); return; }
      const selKey = selected ? selected.id + selected.title : null;
      data = d;
      selected = selKey ? d.items.find((it) => it.id + it.title === selKey) ?? null : null;
      buildTabs();
      applyFilter();
      dirty = true;
    }

    // ---- interaction --------------------------------------------------------------------------
    let dragHand: string | null = null;
    let dragY0 = 0, scroll0 = 0, dragMoved = false, dragPart = '';

    function rowAt(part: string): number {
      return part.startsWith('row:') ? Number(part.slice(4)) : -1;
    }

    build();
    const channel = new ChannelProp(ctx, (v: ChannelValue) => setData(v));
    applyFilter();

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.rows !== prev.rows || p.textSize !== prev.textSize) build();
        if (p.filter !== prev.filter) { buildTabs(); applyFilter(); }
        if (p.channel !== prev.channel) channel.refresh();
        if (p.statusColors !== prev.statusColors) { tabKeys = []; buildTabs(); }
        dirty = true;
      },
      onInput(port, v) {
        if (port === 'items') setData(v);
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') {
          const r = rowAt(part);
          const next = e.phase === 'end' ? -1 : r;
          if (next !== hovered) { hovered = next; dirty = true; }
          return;
        }
        if (e.phase === 'start') {
          if (dragHand) return;
          dragHand = e.hand;
          dragPart = part;
          dragY0 = e.localPoint[1];
          scroll0 = scroll;
          dragMoved = false;
          return;
        }
        if (e.hand !== dragHand) return;
        if (e.phase === 'move') {
          const dy = e.localPoint[1] - dragY0;
          if (!dragMoved && Math.abs(dy) > L.rowH * 0.45 && dragPart.startsWith('row:')) dragMoved = true;
          if (dragMoved) {
            const max = Math.max(0, shown.length - L.n);
            const s = Math.min(max, Math.max(0, scroll0 + dy / L.rowH));
            if (Math.round(s) !== Math.round(scroll)) dirty = true;
            scroll = s;
          }
          return;
        }
        // end / cancel
        dragHand = null;
        if (e.phase !== 'end' || dragMoved) return;
        if (dragPart.startsWith('tab:')) {
          const chip = tabsGroup?.getObjectByName(dragPart);
          const k = (chip?.userData.filterKey as string | undefined) ?? '';
          if (k !== (ctx.props.filter || '')) {
            ctx.setProps({ filter: k });
            scroll = 0;
            buildTabs();
            applyFilter();
            dirty = true;
          }
        } else {
          const r = rowAt(dragPart), it = r >= 0 ? shown[Math.round(scroll) + r] : undefined;
          if (it) {
            selected = selected === it ? null : it;
            if (selected) ctx.emit('select', { ...selected });
            dirty = true;
          }
        }
      },
      update(dt) {
        ageTimer += dt;
        if (ageTimer > 5) { ageTimer = 0; if (group) renderAge(); }
        if (!dirty) return;
        dirty = false;
        render();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
