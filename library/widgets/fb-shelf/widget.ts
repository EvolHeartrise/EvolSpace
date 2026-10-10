// fb-shelf — "Files · Library": the file system as a physical library. The current folder is a
// floor-standing bookcase: sub-folders are labelled archive boxes on the upper shelves (width ∝ log of
// the folder's recursive size), files are books (spine thickness ∝ log size, height + spine color by
// type), ordered A→Z (or newest first) left→right, top→bottom, so positions are stable landmarks.
//
//   hover a book      → it slides out, a horizontal label pops above it (name, type, size, age)
//   pinch a book      → it flies out toward you and opens: syntax-highlighted text flowing over two
//                       pages (tap a page to turn), or the image; pinch it again / the ✕ tab / another
//                       book puts it back. Pinch-dragging a book toward you also pulls it out.
//   pinch a box       → the box grows into that folder's bookcase; the current case steps left and
//                       dims, so the path is a physical row of cases (pinch one to go back up there,
//                       or pinch a box in it to jump to a sibling folder)
//   case side handles → next / previous page (the case revolves) when a folder overflows the shelves
//   crest buttons     → up, A–Z ↔ recent, show hidden
//
// Requests go to <prefix>.request; replies come on <prefix>.fb-shelf.<entityId>.<purpose> and are
// matched by path (several clients run the same entity and share these channels).

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { makeGlyph as makeIcon, setGlyph as setIcon } from './glyphs.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { truncate } from '../../shared/format.ts';
import { ageText, baseName, caseDims, type CaseDims, CATS, fmtSize, joinPath, parentOf, pathChain, type SortMode } from './layout.ts';
import { CaseView, type LabelPool, type Listing } from './shelf.ts';
import { OpenBook, type Preview } from './book.ts';

interface Props extends Record<string, unknown> {
  path: string;
  sort: SortMode;
  showHidden: boolean;
  width: number;
  height: number;
  titles: 'up' | 'down';
  ancestors: number;
  prefix: string;
}

interface TreeNode { name: string; type: string; size: number; files?: number; children?: TreeNode[] }
interface TreeReply { kind: 'tree'; path: string; root?: TreeNode; error?: string }

const TAP = 0.025;          // movement (m) that turns a press into a drag
const PULL_OUT = 0.06;      // drag toward you that counts as "pull the book out"
const BOOK_POOL = 28;
const BOX_POOL = 10;
const BOOK_LABEL = 0.0118;
const BOX_LABEL = 0.016;
const CREST_H = 0.13;

const definition: WidgetDefinition<Props> = {
  description:
    "Files · Library (via the 'files' source): the current folder as a floor-standing bookcase. Folders are labelled boxes on the upper shelves " +
    '(size ∝ log of recursive size), files are books (thickness ∝ log size, height/color by type) in stable A→Z or newest-first order. Hover slides a ' +
    'book out with a label; pinch (or pull toward you) opens it as a floating book with syntax-highlighted pages or the image; pinch a box to step into ' +
    'that folder — ancestors stand as dimmer cases to the left (pinch to go back). Props: path, sort, showHidden, width, height, titles, ancestors. ' +
    'Inputs: path (open folder), open (file/folder name or path). Outputs: selected (opened file), folder (current folder).',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    sort: { type: 'enum', options: ['name', 'recent'], default: 'name', description: 'Shelf order: A→Z or newest first (folders always first).' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    width: { type: 'number', default: 1.4, min: 0.8, max: 2.4, step: 0.05, description: 'Bookcase width (m).' },
    height: { type: 'number', default: 1.6, min: 0.9, max: 2.4, step: 0.05, description: 'Bookcase height (m); stands on the floor at the entity origin.' },
    titles: { type: 'enum', options: ['up', 'down'], default: 'up', description: 'Spine titles read bottom→top (up) or top→bottom (down).' },
    ancestors: { type: 'integer', default: 3, min: 0, max: 4, description: 'Parent folders shown as dimmer cases to the left.' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    open: { type: 'string', description: 'Open an item: a name in the current folder, or a path (file → book, folder → case).' },
  },
  outputs: {
    selected: { type: 'string', description: 'Absolute path of the book last opened.' },
    folder: { type: 'string', description: 'Absolute path of the current folder.' },
  },
  interactions: [dragBinding('fb-shelf-drag', 'drag')],
  size: [1.4, 1.75, 0.3],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const props = ctx.props;
    let dims: CaseDims = caseDims(props.width, props.height);
    const views: CaseView[] = [];
    let chain: CaseView[] = [];
    let viewSeq = 0;
    const listCache = new Map<string, Listing>();
    const sigs = new Map<string, string>();
    const sizeCache = new Map<string, Map<string, number>>();
    const countCache = new Map<string, Map<string, number>>();
    const treeAsked = new Set<string>();
    let home: string | null = null;
    let nonce = 0;
    let disposed = false;
    const offs: Array<() => void> = [];
    const v1 = new T.Vector3(), v2 = new T.Vector3();

    // ---- channels --------------------------------------------------------------------------------
    const pre = () => props.prefix || 'files';
    const ch = (k: string) => `${pre()}.fb-shelf.${ctx.entityId}.${k}`;
    function request(cmd: string, path: string, replyKey: string, extra: Record<string, unknown> = {}): void {
      ctx.channels.publish(`${pre()}.request`, { cmd, path, hidden: !!props.showHidden, reply: ch(replyKey), nonce: ++nonce, ...extra } as never);
    }

    // ---- book --------------------------------------------------------------------------------------
    const book = new OpenBook(ctx);
    let bookFrom: { view: CaseView; name: string; path: string } | null = null;
    let queued: { view: CaseView; idx: number } | null = null;
    book.onClosed = () => {
      if (bookFrom) bookFrom.view.setHidden(-1);
      bookFrom = null;
      const q = queued;
      queued = null;
      if (q && views.includes(q.view) && q.view === chain[0]) openBook(q.view, q.idx);
    };

    // ---- widget-level UI (crest buttons, path line, page handles, hover label, message) ---------------
    let ui: THREE.Group | null = null;
    let pathText: Text, message: Text, hoverName: Text, hoverMeta: Text;
    let hoverPlate: THREE.Mesh, hoverGroup: THREE.Group;
    let sortIcon: THREE.Mesh, hiddenIcon: THREE.Mesh;
    let pgPrev: THREE.Mesh, pgNext: THREE.Mesh;
    const pool: LabelPool = { books: [], boxes: [], bookSize: BOOK_LABEL, boxSize: BOX_LABEL };
    for (let i = 0; i < BOOK_POOL; i++) pool.books.push(makeText(ctx, '', { size: BOOK_LABEL, anchorX: 'center', anchorY: 'middle', color: '#121820', whiteSpace: 'nowrap' }));
    for (let i = 0; i < BOX_POOL; i++) pool.boxes.push(makeText(ctx, '', { size: BOX_LABEL, anchorX: 'center', anchorY: 'middle', color: '#2a2118', weight: 'semibold', whiteSpace: 'nowrap' }));

    function buildUi(): void {
      if (ui) disposeTree(ui);
      const g = (ui = new T.Group());
      g.name = 'shelf-ui';
      const W = dims.width, H = dims.height, D = dims.depth;
      const crestY = H + CREST_H / 2, zf = D / 2 - 0.004;
      const btn = (name: string, icon: string, x: number) => {
        const d = 0.052;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, crestY, zf + 0.003);
        b.name = name;
        ctx.interactive(b);
        const ic = makeIcon(ctx, icon, { size: d * 0.55, color: theme.text });
        ic.position.z = 0.002;
        b.add(ic);
        g.add(b);
        return ic;
      };
      btn('btn:up', 'corner-left-up', -W * 0.43 + 0.045);
      sortIcon = btn('btn:sort', props.sort === 'recent' ? 'clock' : 'arrow-down-wide-narrow', W * 0.43 - 0.045);
      hiddenIcon = btn('btn:hidden', props.showHidden ? 'eye' : 'eye-off', W * 0.43 - 0.11);
      pathText = makeText(ctx, '', { size: 0.017, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      pathText.position.set(0, H + CREST_H * 0.24, zf + 0.0015);
      message = makeText(ctx, '', { size: 0.03, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: W * 0.7, textAlign: 'center' });
      message.position.set(0, H * 0.6, D / 2 + 0.02);
      g.add(pathText, message);
      const handle = (name: string, icon: string, x: number) => {
        const h = ctx.ui.panel(0.056, 0.26, { color: theme.surface, radius: 0.02 });
        h.position.set(x, H * 0.5, D / 2 - 0.05);
        h.name = name;
        ctx.interactive(h);
        const ic = makeIcon(ctx, icon, { size: 0.04, color: theme.text });
        ic.position.z = 0.002;
        h.add(ic);
        h.visible = false;
        g.add(h);
        return h;
      };
      pgPrev = handle('pg:prev', 'chevron-left', -W / 2 - 0.04);
      pgNext = handle('pg:next', 'chevron-right', W / 2 + 0.04);
      hoverGroup = new T.Group();
      hoverGroup.visible = false;
      hoverPlate = ctx.ui.panel(0.3, 0.066, { color: theme.surface, radius: 0.012 });
      hoverPlate.raycast = () => {};
      hoverName = makeText(ctx, '', { size: 0.018, anchorX: 'center', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      hoverName.position.set(0, 0.012, 0.002);
      hoverMeta = makeText(ctx, '', { size: 0.0125, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      hoverMeta.position.set(0, -0.015, 0.002);
      hoverGroup.add(hoverPlate, hoverName, hoverMeta);
      g.add(hoverGroup);
      ctx.root.add(g);
      refreshUi();
    }

    const main = (): CaseView | null => chain[0] ?? null;

    function refreshUi(): void {
      const m = main();
      const l = m?.listing ?? null;
      const n = l?.entries?.length ?? 0;
      const parts: string[] = [];
      const disp = l?.display ?? m?.path ?? '';
      const par = disp && disp !== '~' && disp !== '/' ? (parentOf(disp) ?? '') : '';
      if (par) parts.push(truncate(par, 44));
      if (l && !l.error) parts.push(`${n}${l.truncated ? '+' : ''} item${n === 1 ? '' : 's'}`);
      if (m && m.pages > 1) parts.push(`case ${m.page + 1} / ${m.pages}`);
      parts.push(props.sort === 'recent' ? 'newest first' : 'A → Z');
      pathText.set(parts.join('   ·   '));
      const msg = !m || !l ? 'Loading…' : l.error ? l.error : n === 0 ? 'Empty folder' : '';
      message.set(msg);
      message.visible = !!msg;
      setIcon(T, sortIcon, props.sort === 'recent' ? 'clock' : 'arrow-down-wide-narrow');
      setIcon(T, hiddenIcon, props.showHidden ? 'eye' : 'eye-off');
      pgPrev.visible = !!m && m.page > 0;
      pgNext.visible = !!m && m.page < m.pages - 1;
    }

    // ---- navigation -----------------------------------------------------------------------------------
    const toAbs = (p: string): string | null => {
      const s = p.trim().replace(/(.)\/+$/, '$1');
      if (s.startsWith('/')) return s;
      if (home && (s === '~' || s.startsWith('~/'))) return s === '~' ? home : joinPath(home, s.slice(2));
      return null;
    };

    function slotTarget(v: CaseView, k: number): void {
      const t = v.tgt, W = dims.width;
      if (k === 0) { t.x = 0; t.y = 0; t.z = 0; t.ry = 0; t.s = 1; t.dim = 0; return; }
      const s = 0.5;
      t.s = s;
      t.x = -W / 2 - 0.16 - (k - 1) * (W * s + 0.13) - (W * s) / 2;
      t.y = 0;
      t.z = 0.1 + 0.13 * (k - 1);
      t.ry = 0.3 + 0.1 * (k - 1);
      t.dim = hoverAnc === v ? 0.25 : 0.55;
    }

    function createView(path: string): CaseView {
      const v = new CaseView(ctx, ++viewSeq, dims, path);
      v.titles = props.titles;
      ctx.root.add(v.group);
      views.push(v);
      const cached = listCache.get(path);
      if (cached) v.setListing(cached, props.sort, sizeCache.get(path));
      return v;
    }

    /** Make `paths` (main first, then ancestors) the row of cases; `from` = the box the main grows out of. */
    function arrange(paths: string[], from?: { view: CaseView; idx: number }, refresh = true): void {
      const old = main();
      const next: CaseView[] = paths.map((p) => views.find((v) => !v.leaving && v.path === p) ?? null).map((v, k) => {
        if (v) return v;
        const nv = createView(paths[k]);
        slotTarget(nv, k);
        Object.assign(nv.cur, nv.tgt);
        nv.cur.s = 0.001;
        return nv;
      });
      const nm = next[0];
      if (old !== nm) {
        resetBook();
        old?.detachLabels();
        nm.attachLabels(pool, 0, dims.height * 0.72);
        clearHover();
      }
      // a case entered from a box grows out of that box
      if (from && nm !== from.view && nm.cur.s < 0.01) {
        const s = from.view.slots[from.idx];
        if (s) {
          from.view.spineCenter(from.idx, v1);
          from.view.toRoot(v1);
          nm.cur.x = v1.x; nm.cur.y = v1.y - s.h / 2; nm.cur.z = v1.z - s.d / 2; nm.cur.s = s.h / dims.height; nm.cur.ry = 0;
        }
      }
      for (const v of views) {
        if (next.includes(v) || v.leaving) continue;
        v.leaving = true;
        v.detachLabels();
        // a case we leave upward shrinks back into its box in the parent (if that is the new main)
        const box = nm.slots.findIndex((s) => s.folder && s.name === baseName(v.path));
        if (v === old && box >= 0 && parentOf(v.path) === nm.path) {
          const s = nm.slots[box];
          nm.spineCenter(box, v1);
          v.tgt.x = v1.x; v.tgt.y = v1.y - s.h / 2; v.tgt.z = v1.z - s.d / 2; v.tgt.s = 0.001; v.tgt.ry = 0; v.tgt.dim = 0;
        } else {
          v.tgt.s = 0.001;
          v.tgt.dim = 1;
        }
      }
      chain = next;
      chain.forEach((v, k) => {
        slotTarget(v, k);
        const mark = k > 0 ? baseName(chain[k - 1].path) : null;
        if (v.mark !== mark) {
          v.mark = mark;
          if (v.layout) v.relayout(props.sort, sizeCache.get(v.path), false);
          v.markChanged();
        }
      });
      // data
      chain.forEach((v, k) => {
        if (k === 0 ? refresh || !v.listing : !v.listing) request('list', v.path, `l${Math.min(k, 4)}`);
      });
      if (nm.adopted) askTree(nm.path);
      if (nm.adopted && nm.listing) {
        if (old !== nm) ctx.emit('folder', nm.path);
        const d = nm.listing.display;
        if (d && d !== props.path && !ctx.isMirror) ctx.setProps({ path: d });
      }
      refreshUi();
    }

    function navigate(target: string, from?: { view: CaseView; idx: number }): void {
      const raw = target.trim() || '~';
      const abs = toAbs(raw);
      if (abs) arrange(pathChain(abs, 1 + props.ancestors), from);
      else arrange([raw], from);
    }

    function askTree(path: string): void {
      if (treeAsked.has(path)) return;
      treeAsked.add(path);
      request('tree', path, 'tree', { depth: 1 });
    }

    // ---- replies --------------------------------------------------------------------------------------
    const listSig = (l: Listing) => `${l.error ?? ''}|${l.truncated}|${(l.entries ?? []).map((e) => `${e.name}:${e.size}:${e.mtime}:${e.type}`).join('/')}`;

    function onList(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as unknown as Listing).kind !== 'list') return;
      const l = v as unknown as Listing;
      if (typeof l.path !== 'string' || !Array.isArray(l.entries)) { ctx.error('fb-shelf: malformed list reply'); return; }
      if (l.display && l.display.startsWith('~') && !home) home = l.display === '~' ? l.path : l.path.slice(0, l.path.length - (l.display.length - 1));
      const sig = listSig(l);
      const same = sigs.get(l.path) === sig;
      listCache.set(l.path, l);
      sigs.set(l.path, sig);
      if (listCache.size > 48) { const k = listCache.keys().next().value as string; listCache.delete(k); sigs.delete(k); }
      let adoptedMain = false;
      for (const view of views) {
        if (view.leaving) continue;
        const match = view.path === l.path || (!view.adopted && (view.path === l.display || toAbs(view.path) === l.path));
        if (!match) continue;
        if (same && view.listing && view.adopted) continue;
        const glide = !!view.listing && view.path === l.path;
        view.listing = l; view.path = l.path; view.adopted = true;
        view.relayout(props.sort, sizeCache.get(l.path), glide);
        if (view === main()) { adoptedMain = true; rehide(); }
      }
      if (adoptedMain) {
        const m = main()!;
        if (l.display && l.display !== props.path && !ctx.isMirror) ctx.setProps({ path: l.display });
        // complete the row of ancestor cases now that the absolute path is known
        const want = pathChain(m.path, 1 + props.ancestors);
        if (want.length !== chain.length || want.some((p, k) => chain[k].path !== p)) arrange(want, undefined, false);
        askTree(m.path);
        ctx.emit('folder', m.path);
        if (pendingOpen) { const p = pendingOpen; pendingOpen = null; openByName(p); }
      }
      refreshUi();
    }

    function onTree(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as unknown as TreeReply).kind !== 'tree') return;
      const t = v as unknown as TreeReply;
      if (typeof t.path !== 'string' || !t.root || !Array.isArray(t.root.children)) return;
      const sizes = new Map<string, number>(), counts = new Map<string, number>();
      for (const c of t.root.children) if (c && c.type === 'dir' && typeof c.name === 'string') { sizes.set(c.name, Number(c.size) || 0); counts.set(c.name, Number(c.files) || 0); }
      const prev = sizeCache.get(t.path);
      sizeCache.set(t.path, sizes);
      countCache.set(t.path, counts);
      if (prev && prev.size === sizes.size && [...sizes].every(([k, s]) => prev.get(k) === s)) return;
      for (const view of views) {
        if (view.leaving || view.path !== t.path || !view.listing) continue;
        view.relayout(props.sort, sizes, true);
        if (view === main()) rehide();
      }
      refreshUi();
    }

    let pendingPreview = '';
    function onPreview(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as unknown as Preview).kind !== 'preview') return;
      const p = v as unknown as Preview;
      if (!pendingPreview || p.path !== pendingPreview || !book.info) return;
      book.setPreview(p);
    }

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      for (let k = 0; k <= 4; k++) offs.push(ctx.channels.subscribe(ch(`l${k}`), onList));
      offs.push(ctx.channels.subscribe(ch('tree'), onTree));
      offs.push(ctx.channels.subscribe(ch('preview'), onPreview));
    }

    // ---- books ----------------------------------------------------------------------------------------
    function resetBook(): void {
      if (bookFrom) bookFrom.view.setHidden(-1);
      bookFrom = null;
      queued = null;
      pendingPreview = '';
      book.reset();
    }

    /** After a relayout of the main case, keep the open book's slot empty. */
    function rehide(): void {
      const m = main();
      if (!m || !bookFrom || bookFrom.view !== m) return;
      const i = m.slots.findIndex((s) => s.name === bookFrom!.name && !s.folder);
      if (i < 0) { resetBook(); return; }
      m.setHidden(i);
    }

    function openBook(view: CaseView, idx: number): void {
      const s = view.slots[idx];
      if (!s || s.folder || !view.adopted) return;
      if (bookFrom) { // another book is out: put it back first
        if (bookFrom.view === view && bookFrom.name === s.name) { book.close(); return; }
        queued = { view, idx };
        book.close(true);
        return;
      }
      const e = view.entryOf(s);
      view.spineCenter(idx, v1);
      view.toRoot(v1);
      // land between the case and the user's head, facing them
      const H = dims.height, D = dims.depth;
      v2.set(ctx.user.head.position[0], ctx.user.head.position[1], ctx.user.head.position[2]);
      ctx.root.updateWorldMatrix(true, false);
      ctx.root.worldToLocal(v2);
      const fy = Math.max(0.95, Math.min(H - 0.05, v2.y - 0.18));
      let dx = v2.x, dz = v2.z - D / 2;
      const len = Math.hypot(dx, dz);
      if (!(len > 0.2) || dz < 0.1) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
      const dist = Math.max(0.38, Math.min(0.75, (len || 1) * 0.5));
      let yaw = Math.atan2(dx, dz);
      yaw = Math.max(-0.7, Math.min(0.7, yaw));
      const ex = Math.max(-dims.width * 0.3, Math.min(dims.width * 0.3, dx * dist));
      const path = joinPath(view.path, s.name);
      book.launch({ name: s.name, cat: s.cat, color: s.color, size: e?.size ?? null, mtime: e?.mtime ?? null }, [v1.x, v1.y, v1.z], [s.w, s.h, s.d], [ex, fy, D / 2 + dz * dist], yaw);
      view.setHidden(idx);
      bookFrom = { view, name: s.name, path };
      pendingPreview = path;
      request('preview', path, 'preview');
      ctx.emit('selected', path);
      hideHover();
    }

    function closeBook(): void { if (bookFrom) book.close(); }

    let pendingOpen: string | null = null;
    /** Open an item of the main case by name (switching page if needed). */
    function openByName(name: string): boolean {
      const m = main();
      if (!m || !m.layout) return false;
      const s = m.layout.slots.find((x) => x.name === name) ?? m.layout.slots.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!s) return false;
      if (s.page !== m.page) { resetBook(); m.showPage(s.page, false); refreshUi(); }
      const idx = m.slots.findIndex((x) => x.name === s.name);
      activate(m, idx);
      return true;
    }

    function activate(view: CaseView, idx: number): void {
      const s = view.slots[idx];
      if (!s) return;
      if (s.folder) navigate(joinPath(view.path, s.name), { view, idx });
      else openBook(view, idx);
    }

    // ---- hover --------------------------------------------------------------------------------------------
    const hov = { left: { view: null as CaseView | null, idx: -1 }, right: { view: null as CaseView | null, idx: -1 } };
    let hoverAnc: CaseView | null = null;
    let label: { view: CaseView; idx: number } | null = null;

    function clearHover(): void {
      for (const h of [hov.left, hov.right]) { if (h.view && h.idx >= 0) h.view.setPull(h.idx, false); h.view = null; h.idx = -1; }
      setHoverAnc(null);
      hideHover();
    }

    function hideHover(): void { label = null; if (hoverGroup) hoverGroup.visible = false; }

    function setHoverAnc(v: CaseView | null): void {
      if (hoverAnc === v) return;
      hoverAnc = v;
      chain.forEach((c, k) => { if (k > 0) c.tgt.dim = c === v ? 0.25 : 0.55; });
    }

    function hoverAt(hand: 'left' | 'right', view: CaseView | null, lp: readonly number[] | null): void {
      const h = hov[hand];
      let idx = -1;
      if (view && lp) {
        v1.set(lp[0], lp[1], lp[2]);
        view.toLocal(v1);
        // hysteresis: stay on the current item until the hand clearly leaves it
        if (h.view === view && h.idx >= 0 && h.idx < view.slots.length) {
          const s = view.slots[h.idx];
          if (Math.abs(v1.x - s.x) < s.w / 2 + 0.005) idx = view.slotIndexAt(s.x, v1.y) === h.idx ? h.idx : -1;
        }
        if (idx < 0) idx = view.slotIndexAt(v1.x, v1.y);
      }
      if (h.view === view && h.idx === idx) return;
      const isMain = view !== null && view === main();
      if (h.view && h.idx >= 0) h.view.setPull(h.idx, false);
      h.view = view; h.idx = idx;
      if (view && idx >= 0 && isMain) view.setPull(idx, true);
      setHoverAnc(hov.left.view && hov.left.view !== main() ? hov.left.view : hov.right.view && hov.right.view !== main() ? hov.right.view : null);
      const other = hov[hand === 'left' ? 'right' : 'left'];
      const act = h.view ? h : other;
      if (act.view && (act.idx >= 0 || act.view !== main())) showHover(act.view, act.idx);
      else hideHover();
      if (view && isMain && idx >= 0 && !view.hasLabel(idx)) {
        view.spineCenter(idx, v2);
        view.assignLabels(v2.x, v2.y);
      }
    }

    function showHover(view: CaseView, idx: number): void {
      label = { view, idx };
      const isMain = view === main();
      let name = '', meta = '';
      if (idx >= 0) {
        const s = view.slots[idx];
        const e = view.entryOf(s);
        if (s.folder) {
          const files = countCache.get(view.path)?.get(s.name);
          name = s.name + '/';
          meta = [isMain ? 'folder' : `folder in ${view.title()}`, fmtSize(s.size), files ? `${files} files` : ''].filter(Boolean).join(' · ');
        } else if (isMain) {
          name = s.name;
          meta = [CATS[s.cat].label, fmtSize(e?.size ?? null), ageText(e?.mtime ?? null)].filter(Boolean).join(' · ');
        } else {
          name = `↑ ${view.title()}`;
          meta = 'back to this folder';
        }
      } else {
        name = `↑ ${view.title() || baseName(view.path)}`;
        meta = 'back to this folder';
      }
      name = truncate(name, 48);
      hoverName.set(name);
      hoverMeta.set(meta);
      const w = Math.max(name.length * 0.018 * 0.56, meta.length * 0.0125 * 0.55) + 0.05;
      hoverPlate.scale.set(w / 0.3, 1, 1);
      hoverGroup.visible = true;
      placeHover();
    }

    function placeHover(): void {
      if (!label) return;
      const { view, idx } = label;
      if (!views.includes(view) || view.leaving) { hideHover(); return; }
      if (idx >= 0 && idx < view.slots.length) {
        const s = view.slots[idx];
        view.spineCenter(idx, v2);
        v2.y += s.h / 2 + 0.05;
        v2.z += 0.07;
      } else {
        v2.set(0, dims.height + CREST_H + 0.08, dims.depth / 2 + 0.05);
      }
      view.toRoot(v2);
      hoverGroup.position.copy(v2);
      hoverGroup.rotation.set(0, view.cur.ry, 0);
    }

    // ---- press / drag ------------------------------------------------------------------------------------
    let press: { hand: string; part: string; view: CaseView | null; idx: number; x: number; y: number; z: number; moved: boolean; dz: number; dx: number } | null = null;

    function viewOfPart(part: string): CaseView | null {
      if (!part.startsWith('case:')) return null;
      const id = Number(part.slice(5));
      for (const v of views) if (v.id === id && !v.leaving) return v;
      return null;
    }

    function onPressStart(e: InteractionEvent): void {
      if (press) return;
      const part = e.objectName ?? '';
      const view = viewOfPart(part);
      let idx = -1;
      if (view) {
        v1.set(e.localPoint[0], e.localPoint[1], e.localPoint[2]);
        view.toLocal(v1);
        const h = hov[e.hand];
        idx = h.view === view && h.idx >= 0 ? h.idx : view.slotIndexAt(v1.x, v1.y);
        if (view === main() && idx >= 0) { view.pressed = idx; view.dragZ = 0; view.setPull(idx, true); }
      }
      press = { hand: e.hand, part, view, idx, x: e.localPoint[0], y: e.localPoint[1], z: e.localPoint[2], moved: false, dz: 0, dx: 0 };
    }

    function onPressMove(e: InteractionEvent): void {
      if (!press || e.hand !== press.hand) return;
      const dx = e.localPoint[0] - press.x, dy = e.localPoint[1] - press.y, dz = e.localPoint[2] - press.z;
      if (!press.moved && Math.hypot(dx, dy, dz) > TAP) press.moved = true;
      press.dz = dz; press.dx = dx;
      const v = press.view;
      if (v && v === main() && press.idx >= 0 && v.pressed === press.idx) {
        v.dragZ = Math.max(0, Math.min(0.22, dz * 0.85));
        v.setPull(press.idx, true);
      }
    }

    function onPressEnd(e: InteractionEvent, cancelled: boolean): void {
      if (!press || e.hand !== press.hand) return;
      const p = press;
      press = null;
      const v = p.view;
      if (v) { if (v.pressed === p.idx) { v.pressed = -1; v.dragZ = 0; } const h = hov[e.hand]; if (!(h.view === v && h.idx === p.idx)) v.setPull(p.idx, false); else v.setPull(p.idx, true); }
      if (cancelled) return;
      const pulled = p.moved && p.dz > PULL_OUT && p.dz > Math.abs(p.dx);
      if (p.part.startsWith('book:')) {
        if (p.part === 'book:close') { if (!p.moved) closeBook(); return; }
        if (p.part === 'book:ask') { if (!p.moved && bookFrom) ctx.askAgent(`Take a look at this file and tell me about it: ${bookFrom.path}`); return; }
        // swipe like turning a page, or tap a page
        if (p.moved && Math.abs(p.dx) > 0.05) book.turn(p.dx < 0 ? 1 : -1);
        else if (!p.moved) book.turn(p.part === 'book:right' ? 1 : -1);
        return;
      }
      if (p.moved && !pulled) return;
      if (v) {
        if (v === main()) { if (p.idx >= 0) activate(v, p.idx); return; }
        // an ancestor case: a folder box in it jumps there (sibling), anything else goes up to it
        const s = p.idx >= 0 ? v.slots[p.idx] : null;
        if (s && s.folder) navigate(joinPath(v.path, s.name));
        else navigate(v.path);
        return;
      }
      if (p.moved) return;
      const m = main();
      if (p.part === 'btn:up') { const par = m?.listing?.parent ?? (m ? parentOf(m.path) : null); if (par) navigate(par); }
      else if (p.part === 'btn:sort') setSort(props.sort === 'recent' ? 'name' : 'recent');
      else if (p.part === 'btn:hidden') setHidden(!props.showHidden);
      else if (p.part === 'pg:prev' || p.part === 'pg:next') flip(p.part === 'pg:next' ? 1 : -1);
    }

    function flip(dir: number): void {
      const m = main();
      if (!m) return;
      resetBook();
      clearHover();
      if (m.flip(dir)) pendingUi = 0.22;
    }
    let pendingUi = -1;

    function setSort(sort: SortMode): void {
      if (!ctx.isMirror) ctx.setProps({ sort });
      applySort();
    }
    function applySort(): void {
      for (const v of views) if (!v.leaving && v.listing) v.relayout(props.sort, sizeCache.get(v.path), true);
      rehide();
      refreshUi();
    }
    function setHidden(on: boolean): void {
      if (!ctx.isMirror) ctx.setProps({ showHidden: on });
      reloadAll();
    }
    function reloadAll(): void {
      listCache.clear(); sigs.clear(); treeAsked.clear();
      chain.forEach((v, k) => request('list', v.path, `l${Math.min(k, 4)}`));
      const m = main();
      if (m?.adopted) askTree(m.path);
      refreshUi();
    }

    function rebuildAll(): void {
      resetBook();
      clearHover();
      const paths = chain.map((v) => v.path);
      for (const v of views.splice(0)) v.dispose();
      chain = [];
      dims = caseDims(props.width, props.height);
      buildUi();
      arrange(paths.length ? paths : [String(props.path || '~')], undefined, false);
    }

    // ---- start ---------------------------------------------------------------------------------------------
    buildUi();
    subscribe();
    navigate(String(props.path || '~'));

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.height !== prev.height) { rebuildAll(); return; }
        if (p.prefix !== prev.prefix) { subscribe(); reloadAll(); }
        if (p.sort !== prev.sort) applySort();
        if (p.showHidden !== prev.showHidden) reloadAll();
        if (p.titles !== prev.titles) { for (const v of views) v.titles = props.titles; main()?.assignLabels(0, dims.height * 0.72); }
        if (p.ancestors !== prev.ancestors) { const m = main(); if (m?.adopted) arrange(pathChain(m.path, 1 + props.ancestors), undefined, false); }
        if (p.path !== prev.path) {
          const m = main();
          const cur = m?.listing?.display ?? m?.path;
          if (String(p.path || '~') !== cur && toAbs(String(p.path || '~')) !== m?.path) navigate(String(p.path || '~'));
        }
        refreshUi();
      },
      onInput(port, v) {
        if (typeof v !== 'string' || !v.trim()) { if (port === 'path' || port === 'open') ctx.error(`fb-shelf: '${port}' expects a non-empty string`); return; }
        const s = v.trim();
        if (port === 'path') navigate(s);
        else if (port === 'open') {
          if (s.includes('/')) {
            const abs = toAbs(s) ?? s;
            const par = parentOf(abs);
            const m = main();
            if (m && par === m.path) { if (!openByName(baseName(abs))) ctx.error(`fb-shelf: no '${baseName(abs)}' here`); }
            else if (par) { pendingOpen = baseName(abs); navigate(par); }
          } else if (!openByName(s)) ctx.error(`fb-shelf: no '${s}' in this folder`);
        }
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') {
          const view = viewOfPart(part);
          if (e.phase === 'end') hoverAt(e.hand, null, null);
          else hoverAt(e.hand, view, view ? e.localPoint : null);
          return;
        }
        if (e.handler !== 'drag' && e.handler !== 'press') return;
        if (e.phase === 'start') onPressStart(e);
        else if (e.phase === 'move') onPressMove(e);
        else onPressEnd(e, e.phase === 'cancel');
      },
      update(dt) {
        if (disposed) return;
        let moved = false;
        for (let i = views.length - 1; i >= 0; i--) {
          const v = views[i];
          const busy = v.update(dt);
          moved ||= busy;
          if (v.leaving && !busy) { v.dispose(); views.splice(i, 1); }
        }
        book.update(dt);
        if (pendingUi >= 0) { pendingUi -= dt; if (pendingUi < 0) refreshUi(); }
        if (label && moved) placeHover();
      },
      dispose() {
        disposed = true;
        for (const o of offs.splice(0)) o();
        for (const v of views.splice(0)) v.dispose();
        for (const t of [...pool.books, ...pool.boxes]) { t.removeFromParent(); (t as unknown as { dispose(): void }).dispose(); }
        book.dispose();
        if (ui) disposeTree(ui);
      },
    };
  },
};

export default definition;
