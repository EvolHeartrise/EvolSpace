// fb-treemap — "Files · Treemap": the current folder as a squarified treemap wall (via the `files`
// source's `tree` command). Tiles are sized by recursive bytes and colored by type; folder tiles show
// their biggest children nested inside. Pinch a folder tile to zoom into it (the tile grows into the
// wall), a nested tile to jump two levels at once, a file tile to preview it in a side card, the
// "+N more" tile to see the tail. The breadcrumb bar jumps back up any number of levels (zooming out).
//
// Requests go to <prefix>.request with reply channels <prefix>.fb-treemap.<entityId>.{tree,preview}.
// Tree replies are cached per path (instant back/forward, refreshed in the background).

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { dragBinding } from '../../shared/handle.ts';
import { truncate } from '../../shared/format.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';
import {
  buildLayout, CATEGORIES, CATEGORY_INFO, crumbsOf, DEFAULT_LAYOUT, fmtCount, fmtSize, hitTest, isUnder, tileForPath,
  type Category, type Crumb, type Layout, type Rect, type Tile, type TreeNode, type TreeReply,
} from './layout.ts';
import { PreviewCard, type Preview } from './preview.ts';

export { squarify, buildLayout, categoryOf, crumbsOf, fmtSize, hitTest, tileForPath, groupChildren } from './layout.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  width: number;
  height: number;
  nested: boolean;
  interactive: boolean;
  prefix: string;
}

const PAD = 0.02;          // grabbable margin around everything
const HEAD = 0.052;        // breadcrumb bar
const FOOT = 0.04;         // legend
const PREVIEW_W = 0.6;
const Z_TILE = 0.002, Z_INNER = 0.0035, Z_LABEL = 0.006, Z_FRAME = 0.0075, Z_TIP = 0.03;
const CAPACITY = (DEFAULT_LAYOUT.maxTiles + 2) * (DEFAULT_LAYOUT.maxInner + 3);
const ZOOM_S = 0.34, FADE_S = 0.2;
const TAP_MOVE = 0.02;     // m: more movement than this makes a pinch a drag, not a tap
const MAX_CRUMBS = 8;
const POOLS: Array<{ size: number; n: number }> = [{ size: 0.026, n: 6 }, { size: 0.016, n: 20 }, { size: 0.0125, n: 16 }];

interface View { path: string; display: string; root: TreeNode; partial: boolean; skip: number; provisional: boolean; src: unknown }
type Shown = { path: string; display: string; root: TreeNode | null; partial: boolean };
interface Label { t: Text; size: number; used: boolean }

const ease = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const txt = (t: THREE.Object3D) => (t as unknown as { text?: string }).text ?? '';
const tint = (t: THREE.Object3D, c: string) => { (t as unknown as { color: string }).color = c; };

const definition: WidgetDefinition<Props> = {
  description:
    "Files as a treemap wall (via the 'files' source): the current folder's children as tiles sized by recursive bytes, colored by type " +
    '(legend with byte shares), biggest sub-items nested in folder tiles. Pinch a folder tile to zoom in, a nested tile to jump two levels, ' +
    'a file to preview it (syntax-highlighted text / image), "+N more" for the tail; the breadcrumb bar zooms back out any number of levels. ' +
    'Hover a tile for name, size, share and file count. Inputs: path, open (tile name or path), up.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Include dot files/folders (secrets stay hidden regardless).' },
    width: { type: 'number', default: 1.2, min: 0.5, max: 3, step: 0.01, description: 'Wall width (m); the preview card opens beside it.' },
    height: { type: 'number', default: 0.75, min: 0.35, max: 2, step: 0.01, description: 'Wall height (m).' },
    nested: { type: 'boolean', default: true, description: 'Show the biggest sub-items inside folder tiles.' },
    interactive: { type: 'boolean', default: true, description: 'Tiles react to hover/pinch (off: only the header buttons; the wall can be grabbed anywhere).' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    open: { type: 'string', description: 'Act like a pinch on the tile with this name (folder: zoom in, file: preview), or open a path.' },
    up: { type: 'any', description: 'Go up one level.' },
  },
  outputs: {
    path: { type: 'string', description: 'Absolute path of the folder shown.' },
    selected: { type: 'string', description: 'Absolute path of the file last previewed.' },
  },
  interactions: [dragBinding('fb-treemap-drag', 'drag')],
  size: [1.2, 0.75, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const W = () => ctx.props.width, H = () => ctx.props.height;
    const prefix = () => ctx.props.prefix || 'files';
    const treeCh = () => `${prefix()}.fb-treemap.${ctx.entityId}.tree`;
    const previewCh = () => `${prefix()}.fb-treemap.${ctx.entityId}.preview`;

    // ---- state ---------------------------------------------------------------------------------
    let view: View | null = null;
    let layout: Layout | null = null;
    let want = String(ctx.props.path || '~');
    let wantSkip = 0;
    let loading = false, loadT = 0;
    let errorMsg = '';
    let home = '';
    let lastPathOut = '';
    const cache = new Map<string, TreeReply>();      // by absolute path
    let anim: { mode: 'in' | 'out'; t: number; src: Rect } | null = null;
    let afterZoom: { path: string; skip: number; provisional: TreeNode | null } | null = null;
    let zoomOutFrom: string | null = null;           // abs path of the view we leave when going up
    let fade = -1;
    let hover = -1, selected = -1, selectedPath = '';
    let preview: Preview | null = null, pendingPreview = '';
    let press: { hand: string; part: string; x: number; y: number; tile: number; scroll0: number; moved: boolean } | null = null;
    let nonce = 0;
    const offs: Array<() => void> = [];

    // ---- scene objects -------------------------------------------------------------------------
    let chrome: THREE.Group | null = null;
    let area: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let tiles!: FittedInstances;
    let hit!: THREE.Mesh;
    let labels: Label[] = [];
    let statusText!: Text, noteText!: Text, message!: Text, hiddenIcon!: THREE.Mesh;
    let loadBar!: THREE.Mesh;
    let crumbTexts: Text[] = [], crumbSeps: THREE.Mesh[] = [];
    let crumbGroup: THREE.Group | null = null;
    let crumbs: Crumb[] = [];
    let crumbX0 = 0, crumbX1 = 0, crumbY = 0;
    const crumbWatch = new MeasureWatch();
    let legend: Array<{ sw: THREE.Mesh; t: Text }> = [];
    const legendWatch = new MeasureWatch();
    let hoverFrame!: THREE.Group, selFrame!: THREE.Group;
    let tip!: THREE.Group, tipBg!: THREE.Mesh, tipBorder!: THREE.Mesh, tipIcon!: THREE.Mesh, tipName!: Text, tipMeta!: Text;
    const tipWatch = new MeasureWatch();
    let tipAt = [0, 0];
    const card = new PreviewCard(ctx, PREVIEW_W, ctx.props.height);

    const m4 = new T.Matrix4();
    const col = new T.Color(), bgCol = new T.Color(theme.background);
    const tileColors: THREE.Color[] = [];            // per tile, from layout
    const catFill = {} as Record<Category, { l1: THREE.Color; l2: THREE.Color }>;
    for (const c of CATEGORIES) {
      const base = CATEGORY_INFO[c].color;
      const k1 = c === 'other' ? 0.6 : c === 'folder' ? 0.5 : 0.4, k2 = c === 'other' ? 0.62 : c === 'folder' ? 0.6 : 0.46;
      catFill[c] = { l1: new T.Color(mixHex(base, theme.background, k1)), l2: new T.Color(mixHex(base, theme.background, k2)) };
    }
    const folderFrame = new T.Color(mixHex(CATEGORY_INFO.folder.color, theme.background, 0.8));
    const moreFill = new T.Color(mixHex(theme.border, theme.background, 0.25));
    const textInt = hexToInt(theme.text), dimInt = hexToInt(theme.textDim), folderTextInt = hexToInt(mixHex(CATEGORY_INFO.folder.color, '#ffffff', 0.35));

    function makeFrame(color: string, thick: number): THREE.Group {
      const g = new T.Group();
      for (let i = 0; i < 4; i++) {
        const m = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, color));
        m.raycast = () => {};
        g.add(m);
      }
      g.userData.thick = thick;
      g.visible = false;
      return g;
    }
    function placeFrame(g: THREE.Group, r: Rect): void {
      const d = g.userData.thick as number, w = r.x1 - r.x0, h = r.y1 - r.y0, cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      const [a, b, c, e] = g.children as THREE.Mesh[];
      a.scale.set(w + d, d, 1); a.position.set(cx, r.y1, Z_FRAME);
      b.scale.set(w + d, d, 1); b.position.set(cx, r.y0, Z_FRAME);
      c.scale.set(d, h + d, 1); c.position.set(r.x0, cy, Z_FRAME);
      e.scale.set(d, h + d, 1); e.position.set(r.x1, cy, Z_FRAME);
      g.visible = true;
    }

    function headerButton(g: THREE.Group, id: string, icon: string, x: number, y: number): THREE.Mesh {
      const d = 0.036;
      const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
      b.position.set(x, y, STYLE.zContent);
      b.name = `btn:${id}`;
      ctx.interactive(b);
      const ic = makeIcon(ctx, icon, { size: d * 0.52, color: theme.text });
      ic.position.z = STYLE.zText;
      b.add(ic);
      g.add(b);
      return ic;
    }

    function build(): void {
      if (chrome) disposeTree(chrome);
      const g = (chrome = new T.Group());
      const w = W(), h = H();
      g.add(ctx.ui.panel(w, h));
      area = { x0: -w / 2 + PAD, x1: w / 2 - PAD, y0: -h / 2 + PAD + FOOT, y1: h / 2 - PAD - HEAD };
      // header: up · breadcrumbs ……… status · ask · hidden · refresh
      const hy = h / 2 - PAD - HEAD / 2 + 0.004;
      crumbY = hy;
      headerButton(g, 'up', 'corner-left-up', area.x0 + 0.018, hy);
      headerButton(g, 'refresh', 'refresh-cw', area.x1 - 0.018, hy);
      hiddenIcon = headerButton(g, 'hidden', ctx.props.showHidden ? 'eye' : 'eye-off', area.x1 - 0.062, hy);
      headerButton(g, 'ask', 'message-square', area.x1 - 0.106, hy);
      statusText = makeText(ctx, '', { size: 0.0135, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      statusText.position.set(area.x1 - 0.136, hy, STYLE.zText);
      g.add(statusText);
      crumbX0 = area.x0 + 0.046;
      crumbX1 = area.x1 - 0.136 - Math.min(0.3, w * 0.28);
      crumbTexts = [];
      crumbSeps = [];
      for (let i = 0; i < MAX_CRUMBS; i++) {
        const t = makeText(ctx, '', { size: 0.0155, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
        t.position.set(0, hy, STYLE.zText);
        t.visible = false;
        const s = makeIcon(ctx, 'chevron-right', { size: 0.014, color: theme.textDim });
        s.position.set(0, hy, STYLE.zText);
        s.visible = false;
        crumbTexts.push(t);
        crumbSeps.push(s);
        g.add(t, s);
      }
      crumbWatch.reset(crumbTexts);
      loadBar = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.accent));
      loadBar.raycast = () => {};
      loadBar.visible = false;
      g.add(loadBar);

      // tiles: one instanced mesh, picked through one invisible plane over the area
      tiles = new FittedInstances(T, sharedGeometry(T, 'plane'), ownMaterial(T, '#ffffff'), CAPACITY);
      tiles.mesh.raycast = () => {};
      tiles.mesh.frustumCulled = false;
      g.add(tiles.mesh);
      hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(area.x1 - area.x0, area.y1 - area.y0, 0.01);
      hit.position.set((area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2, 0.004);
      hit.name = 'map';
      if (ctx.props.interactive) ctx.interactive(hit);
      g.add(hit);

      labels = [];
      for (const p of POOLS) {
        for (let i = 0; i < p.n; i++) {
          const t = makeText(ctx, '', { size: p.size, anchorX: 'left', anchorY: 'top', color: theme.text, whiteSpace: 'nowrap', lineHeight: 1.15, weight: p.size > 0.02 ? 'semibold' : 'regular' });
          t.visible = false;
          g.add(t);
          labels.push({ t, size: p.size, used: false });
        }
      }
      message = makeText(ctx, '', { size: 0.018, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: (area.x1 - area.x0) * 0.8, textAlign: 'center' });
      message.position.set((area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2, Z_TIP - 0.01);
      g.add(message);

      // footer: legend chips (categories present, by bytes) · note
      legend = [];
      const fy = -h / 2 + PAD + FOOT / 2 - 0.004;
      for (let i = 0; i < CATEGORIES.length; i++) {
        const sw = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, '#ffffff'));
        sw.scale.set(0.016, 0.016, 1);
        sw.position.set(0, fy, STYLE.zContent);
        sw.raycast = () => {};
        const t = makeText(ctx, '', { size: 0.014, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
        t.position.set(0, fy, STYLE.zText);
        sw.visible = t.visible = false;
        g.add(sw, t);
        legend.push({ sw, t });
      }
      legendWatch.reset(legend.map((l) => l.t));
      noteText = makeText(ctx, '', { size: 0.0122, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      noteText.position.set(area.x1, fy, STYLE.zText);
      g.add(noteText);

      hoverFrame = makeFrame('#ffffff', 0.004);
      selFrame = makeFrame(theme.accent, 0.005);
      g.add(hoverFrame, selFrame);

      // hover tooltip (floats in front of the wall)
      tip = new T.Group();
      tip.visible = false;
      tipBorder = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      tipBg = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
      tipBg.position.z = 0.0005;
      tipIcon = makeIcon(ctx, 'file', { size: 0.02, color: theme.text });
      tipName = makeText(ctx, '', { size: 0.0165, anchorX: 'left', anchorY: 'top', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      tipMeta = makeText(ctx, '', { size: 0.0128, anchorX: 'left', anchorY: 'top', color: theme.textDim, whiteSpace: 'nowrap', lineHeight: 1.3 });
      for (const m of [tipBorder, tipBg]) m.raycast = () => {};
      tipIcon.position.z = tipName.position.z = tipMeta.position.z = 0.001;
      tip.add(tipBorder, tipBg, tipIcon, tipName, tipMeta);
      tipWatch.reset([tipName, tipMeta]);
      g.add(tip);
      ctx.root.add(g);
    }

    // ---- data ----------------------------------------------------------------------------------

    function request(cmd: 'tree' | 'preview', p: string): void {
      const msg: Record<string, unknown> = { cmd, path: p, reply: cmd === 'tree' ? treeCh() : previewCh(), nonce: ++nonce };
      if (cmd === 'tree') { msg.depth = 2; msg.hidden = !!ctx.props.showHidden; }
      ctx.channels.publish(`${prefix()}.request`, msg as never);
    }

    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
    /** Display form ("~/…") of an absolute path once the home folder is known. */
    const displayOf = (abs: string) => (home && abs === home ? '~' : home && abs.startsWith(home + '/') ? `~/${abs.slice(home.length + 1)}` : abs);
    const absOf = (p: string) => (home && p === '~' ? home : home && p.startsWith('~/') ? `${home}/${p.slice(2)}` : p);
    const matches = (r: TreeReply, p: string) => r.path === norm(p) || r.display === norm(p) || r.path === absOf(norm(p));
    function cached(p: string): TreeReply | undefined {
      const c = cache.get(absOf(norm(p)));
      return c ?? [...cache.values()].find((r) => matches(r, p));
    }
    function remember(r: TreeReply): void {
      cache.delete(r.path);
      cache.set(r.path, r);
      while (cache.size > 16) cache.delete(cache.keys().next().value as string);
    }

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(treeCh(), (v: ChannelValue) => onTree(v)));
      offs.push(ctx.channels.subscribe(previewCh(), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Preview).kind !== 'preview') return;
        const got = (v as Preview).path;
        if (!pendingPreview || (got !== pendingPreview && got !== absOf(pendingPreview))) return;
        preview = v as Preview;
        card.show(preview, W() / 2 + 0.012 + PREVIEW_W / 2);
        updateSelection();
      }));
    }

    function onTree(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as TreeReply).kind !== 'tree') return;
      const r = v as TreeReply;
      if (typeof r.path !== 'string') return;
      if (!home && typeof r.display === 'string' && r.display.startsWith('~')) {
        home = r.display === '~' ? r.path : r.path.slice(0, r.path.length - (r.display.length - 1));
      }
      if (r.root && !r.error) {
        if (!r.root || typeof r.root !== 'object' || typeof r.root.size !== 'number') { ctx.error('fb-treemap: malformed tree reply'); return; }
        remember(r);
      }
      if (!matches(r, want)) return;
      loading = false;
      if (r.error || !r.root) failed = r;
      if (anim) return; // applied when the zoom finishes (from the cache)
      if (failed) { showError(failed); return; }
      show(r, wantSkip, false);
    }

    let failed: TreeReply | null = null;
    function showError(r: TreeReply): void {
      failed = null;
      errorMsg = r.error || 'Nothing here';
      view = null;
      zoomOutFrom = null;
      crumbs = crumbsOf(r.display || want);
      relayout();
    }

    /** Show a reply (or a provisional node); zooms out when we come from below it, else fades in. */
    function show(r: Shown, skip: number, provisional: boolean): void {
      const same = view && view.path === r.path && view.skip === skip;
      const prevSkip = view?.skip ?? 0;
      const from = zoomOutFrom;
      zoomOutFrom = null;
      errorMsg = '';
      view = { path: r.path, display: r.display || displayOf(r.path), root: r.root!, partial: !!r.partial, skip, provisional, src: r };
      want = view.display;
      wantSkip = skip;
      crumbs = crumbsOf(view.display);
      relayout();
      if (!same && layout) {
        let src: Rect | null = null;
        if (from && from !== r.path && isUnder(from, r.path)) {
          const i = tileForPath(layout, from);
          if (i >= 0) src = layout.tiles[i].content ?? layout.tiles[i].r;
        } else if (from === r.path && skip === 0 && prevSkip > 0 && layout.top && layout.tiles[layout.top - 1].more) {
          src = layout.tiles[layout.top - 1].r; // back from "+N more"
        }
        if (src) { anim = { mode: 'out', t: 0, src }; applyRects(1, src); hideOverlays(); }
        else startFade();
      }
      if (!provisional && !ctx.isMirror && view.display !== ctx.props.path) ctx.setProps({ path: view.display });
      if (view.path !== lastPathOut) { lastPathOut = view.path; ctx.emit('path', view.path); }
    }

    /** Navigate to a folder (display or absolute path). */
    function go(p: string, skip = 0): void {
      const target = norm(p.trim() || '~');
      settle();
      zoomOutFrom = view ? view.path : null;
      want = target;
      wantSkip = skip;
      errorMsg = '';
      failed = null;
      loading = true; // (a cached view shows at once and refreshes in the background)
      loadT = 0;
      const c = cached(target);
      if (c && c.root && !c.error) show(c, skip, false);
      else {
        crumbs = crumbsOf(displayOf(target));
        layoutCrumbs();
      }
      request('tree', target);
      renderStatus();
    }

    function zoomInto(i: number): void {
      settle();
      if (!layout) return;
      const t = layout.tiles[i];
      if (!t) return;
      if (t.more) {
        if (t.level === 2) { zoomInto(t.parent); return; }
        // the tail of the same folder
        anim = { mode: 'in', t: 0, src: t.r };
        afterZoom = { path: view!.path, skip: t.more.skip, provisional: null };
        hideOverlays();
        return;
      }
      const n = t.node!;
      anim = { mode: 'in', t: 0, src: t.content ?? t.r };
      afterZoom = { path: n.path, skip: 0, provisional: n.children?.length ? n : null };
      want = n.path;
      wantSkip = 0;
      crumbs = crumbsOf(displayOf(n.path));
      layoutCrumbs();
      hideOverlays();
      const c = cache.get(n.path);
      loading = !c; loadT = 0;
      request('tree', n.path);
    }

    function finishZoomIn(): void {
      const z = afterZoom!;
      afterZoom = null;
      if (view && z.path === view.path) { show({ ...view }, z.skip, view.provisional); return; }
      if (failed) { showError(failed); return; }
      const c = cache.get(z.path);
      if (c && c.root && !c.error) { show(c, z.skip, false); return; }
      if (z.provisional) {
        const r = view;
        show({ path: z.path, display: displayOf(z.path), root: z.provisional, partial: !!r?.partial }, 0, true);
        return;
      }
      // nothing to show yet: the zoomed tile keeps filling the wall until the reply arrives
    }

    function openTile(i: number): void {
      if (!layout) return;
      const t = layout.tiles[i];
      if (!t) return;
      if (t.more || t.node?.type === 'dir') { zoomInto(i); return; }
      const n = t.node!;
      selectedPath = n.path;
      pendingPreview = n.path;
      ctx.emit('selected', n.path);
      request('preview', n.path);
      updateSelection();
    }

    function goUp(): void {
      if (view?.skip) { go(view.display, 0); return; }
      const cs = crumbsOf(view?.display ?? displayOf(want));
      if (cs.length > 1) go(cs[cs.length - 2].path);
    }

    // ---- rendering -----------------------------------------------------------------------------

    function relayout(): void {
      hover = -1;
      for (const l of labels) { l.used = false; l.t.visible = false; }
      if (!view) {
        layout = null;
        tiles.commit(0);
      } else {
        layout = buildLayout(view.root, area, { ...DEFAULT_LAYOUT, nested: !!ctx.props.nested }, view.skip);
        const n = Math.min(layout.tiles.length, CAPACITY);
        tileColors.length = n;
        tiles.fit(area.x0, area.y0, Z_TILE, area.x1, area.y1, Z_INNER);
        for (let i = 0; i < n; i++) {
          const t = layout.tiles[i];
          const c = (tileColors[i] ??= new T.Color());
          c.copy(t.more ? moreFill : t.level === 1 ? (t.content ? folderFrame : catFill[t.cat].l1) : catFill[t.cat].l2);
          if (!t.content) c.offsetHSL(0, 0, ((i * 7) % 5 - 2) * 0.008); // neighbours of one color stay distinguishable
          tiles.setColorAt(i, c);
        }
        applyRects(0, area);
        tiles.commit(n);
        placeLabels();
      }
      hideOverlays();
      updateSelection();
      renderLegend();
      layoutCrumbs();
      renderStatus();
    }

    /** Instance rects for zoom progress p (0 = as laid out, 1 = `src` fills the area), clipped to the area. */
    function applyRects(p: number, src: Rect): void {
      if (!layout) return;
      const sw = src.x1 - src.x0 || 1, sh = src.y1 - src.y0 || 1;
      const kx = 1 + ((area.x1 - area.x0) / sw - 1) * p, ky = 1 + ((area.y1 - area.y0) / sh - 1) * p;
      const ox = src.x0 + (area.x0 - src.x0) * p, oy = src.y0 + (area.y0 - src.y0) * p;
      const n = Math.min(layout.tiles.length, CAPACITY);
      for (let i = 0; i < n; i++) {
        const r = layout.tiles[i].r;
        let x0 = ox + (r.x0 - src.x0) * kx, x1 = ox + (r.x1 - src.x0) * kx, y0 = oy + (r.y0 - src.y0) * ky, y1 = oy + (r.y1 - src.y0) * ky;
        if (x0 < area.x0) x0 = area.x0;
        if (x1 > area.x1) x1 = area.x1;
        if (y0 < area.y0) y0 = area.y0;
        if (y1 > area.y1) y1 = area.y1;
        const w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) m4.makeScale(0, 0, 0);
        else { m4.makeScale(w, h, 1); m4.setPosition((x0 + x1) / 2, (y0 + y1) / 2, layout.tiles[i].level === 1 ? Z_TILE : Z_INNER); }
        tiles.setMatrixAt(i, m4);
      }
      tiles.mesh.instanceMatrix.needsUpdate = true;
    }

    function startFade(): void {
      fade = 0;
      applyFade(0);
    }
    function applyFade(k: number): void {
      if (!layout) return;
      const n = Math.min(layout.tiles.length, CAPACITY);
      for (let i = 0; i < n; i++) {
        col.copy(bgCol).lerp(tileColors[i], k);
        tiles.setColorAt(i, col);
      }
      if (tiles.mesh.instanceColor) tiles.mesh.instanceColor.needsUpdate = true;
    }

    function takeLabel(minSize: number, maxSize: number): Label | null {
      for (const l of labels) if (!l.used && l.size >= minSize && l.size <= maxSize) { l.used = true; return l; }
      return null;
    }

    function placeLabels(): void {
      if (!layout) return;
      const pre = view?.partial ? '≥ ' : '';
      const order = layout.tiles.map((_, i) => i).sort((a, b) => area2(layout!.tiles[b]) - area2(layout!.tiles[a]));
      for (const i of order) {
        const t = layout.tiles[i];
        const w = t.r.x1 - t.r.x0, h = t.r.y1 - t.r.y0;
        const name = t.more ? `+${t.more.count} more` : t.node!.name + (t.node!.type === 'dir' ? '/' : '');
        const size = pre + fmtSize(t.more ? t.more.size : t.node!.size);
        let l: Label | null = null, text = '', nameLen = 0;
        const fit = (s: number) => Math.floor((w - 0.012) / (s * 0.56));
        if (t.content) {
          // folder header strip: "name/  size" on one line
          l = (t.header > 0.04 ? takeLabel(0.026, 0.026) : null) ?? takeLabel(0.016, 0.016) ?? takeLabel(0.0125, 0.0125);
          if (!l) continue;
          const chars = fit(l.size);
          if (chars < 4) { l.used = false; continue; }
          const nm = truncate(name, Math.max(3, chars - size.length - 2));
          text = chars >= nm.length + size.length + 2 ? `${nm}  ${size}` : truncate(name, chars);
          nameLen = nm.length;
          l.t.position.set(t.r.x0 + 0.006, t.r.y1 - (t.header - l.size * 1.15) / 2 + 0.001, Z_LABEL);
          l.t.set(text);
          setColorRanges(l.t, { 0: folderTextInt, [nameLen]: dimInt });
          l.t.visible = true;
          continue;
        }
        if (t.level === 1 && w >= 0.2 && h >= 0.1) l = takeLabel(0.026, 0.026);
        if (!l && w >= 0.07 && h >= 0.03) l = takeLabel(0.016, 0.016);
        if (!l && w >= 0.05 && h >= 0.02) l = takeLabel(0.0125, 0.0125);
        if (!l) continue;
        const chars = fit(l.size);
        if (chars < 3) { l.used = false; continue; }
        const twoLines = h >= l.size * 2.4 + 0.01;
        const nm = truncate(name, chars);
        text = twoLines ? `${nm}\n${size}` : nm;
        l.t.position.set(t.r.x0 + 0.006, t.r.y1 - 0.005, Z_LABEL);
        l.t.set(text);
        setColorRanges(l.t, { 0: t.node?.type === 'dir' ? folderTextInt : textInt, [nm.length]: dimInt });
        l.t.visible = true;
      }
    }
    const area2 = (t: Tile) => (t.r.x1 - t.r.x0) * (t.r.y1 - t.r.y0) + (t.level === 1 ? 100 : 0); // level 1 first, then by area

    function setLabelsVisible(on: boolean): void {
      for (const l of labels) l.t.visible = on && l.used;
    }

    function hideOverlays(): void {
      hover = -1;
      if (hoverFrame) hoverFrame.visible = false;
      if (tip) tip.visible = false;
      if (anim) { setLabelsVisible(false); if (selFrame) selFrame.visible = false; }
    }

    function updateSelection(): void {
      selected = -1;
      if (layout && selectedPath && preview) selected = layout.tiles.findIndex((t) => t.node?.path === selectedPath);
      if (selected >= 0 && !anim) placeFrame(selFrame, layout!.tiles[selected].r);
      else selFrame.visible = false;
    }

    function renderLegend(): void {
      const on = layout ? CATEGORIES.filter((c) => layout!.byCat[c] > 0).sort((a, b) => layout!.byCat[b] - layout!.byCat[a]) : [];
      let total = 0;
      for (const c of on) total += layout!.byCat[c];
      for (let i = 0; i < legend.length; i++) {
        const L = legend[i], c = on[i];
        L.sw.visible = L.t.visible = !!c;
        if (!c) continue;
        (L.sw.material as THREE.MeshBasicMaterial).color.copy(catFill[c].l1);
        const pct = (100 * layout!.byCat[c]) / (total || 1);
        L.t.set(`${CATEGORY_INFO[c].label} ${pct >= 1 ? Math.round(pct) : '<1'}%`);
      }
      const notes: string[] = [];
      if (view?.skip) notes.push(`items ${view.skip + 1}–${view.skip + (layout?.top ?? 0)} by size`);
      if (layout?.empty) notes.push(`${layout.empty} empty / skipped`);
      if (view?.partial) notes.push('partial scan: sizes are lower bounds');
      noteText.set(notes.join(' · '));
      layoutLegend();
    }
    function layoutLegend(): void {
      let x = area.x0;
      const noteW = textSize(noteText, { text: txt(noteText), size: 0.0122 }).width;
      for (const L of legend) {
        if (!L.t.visible && !L.sw.visible) continue;
        const tw = textSize(L.t, { text: txt(L.t), size: 0.014 }).width;
        if (x + 0.02 + tw > area.x1 - noteW - 0.02) { L.sw.visible = L.t.visible = false; continue; }
        L.sw.position.x = x + 0.007;
        L.t.position.x = x + 0.019;
        x += 0.019 + tw + 0.022;
      }
    }

    function layoutCrumbs(): void {
      if (crumbGroup) disposeTree(crumbGroup);
      crumbGroup = new T.Group();
      chrome!.add(crumbGroup);
      const cs = crumbs.length ? crumbs : crumbsOf(displayOf(want));
      const sizeOf = (i: number, label: string) => textSize(crumbTexts[i], { text: label, size: 0.0155 }).width;
      // shown entries: the root, maybe "…", the last k (as many as fit)
      const items: Array<{ label: string; path: string; current: boolean; skip: number }> = cs.map((c, i) => ({ label: c.label, path: c.path, current: i === cs.length - 1 && !view?.skip, skip: 0 }));
      if (view?.skip && crumbs.length && view.display === crumbs[crumbs.length - 1].path) items.push({ label: `+${view.skip} more`, path: view.display, current: true, skip: view.skip });
      const avail = crumbX1 - crumbX0;
      const est = (s: string) => s.length * 0.0155 * 0.56 + 0.022 + 0.018;
      let shown = items;
      let total = shown.reduce((a, it) => a + est(it.label), 0);
      while (shown.length > 2 && (total > avail || shown.length > MAX_CRUMBS)) {
        const dropAt = shown[1].label === '…' ? 2 : 1;
        if (shown.length <= dropAt + 1) break;
        const dropped = shown[dropAt];
        shown = shown[1].label === '…'
          ? [shown[0], { ...shown[1], path: dropped.path }, ...shown.slice(dropAt + 1)]
          : [shown[0], { label: '…', path: dropped.path, current: false, skip: 0 }, ...shown.slice(2)];
        total = shown.reduce((a, it) => a + est(it.label), 0);
      }
      let x = crumbX0;
      for (let i = 0; i < MAX_CRUMBS; i++) {
        const it = shown[i], t = crumbTexts[i], sep = crumbSeps[i];
        t.visible = !!it;
        sep.visible = !!it && i < shown.length - 1;
        if (!it) continue;
        t.set(it.label);
        tint(t, it.current ? theme.accent : theme.text);
        const tw = sizeOf(i, it.label);
        const pw = tw + 0.022;
        if (!it.current) {
          const pill = ctx.ui.panel(pw, 0.034, { color: theme.surface, radius: 0.012 });
          pill.position.set(x + pw / 2, crumbY, STYLE.zContent);
          pill.name = `crumb:${i}`;
          pill.userData.path = it.path;
          pill.userData.skip = it.skip;
          ctx.interactive(pill);
          crumbGroup.add(pill);
        }
        t.position.x = x + 0.011;
        x += pw;
        sep.position.x = x + 0.009;
        x += 0.018;
      }
    }

    function renderStatus(): void {
      if (!statusText) return;
      let s = '';
      let color = theme.textDim;
      if (view && layout) {
        const r = view.root;
        s = `${view.partial ? '≥ ' : ''}${fmtSize(r.size)} · ${fmtCount(r.files ?? 0)} files`;
        if (view.partial) color = theme.accent2;
      }
      if (loading && loadT > 10) { s = "no reply: is the 'files' source running?"; color = theme.negative; }
      else if (loading) s = s ? `${s} · scanning…` : 'scanning…';
      statusText.set(s);
      tint(statusText, color);
      const msg = errorMsg || (!view && !loading ? '' : !view ? 'Scanning…' : layout && !layout.top ? (view.root.children?.length ? 'Only empty files here' : 'Empty folder') : '');
      message.set(loading && loadT > 10 && !view ? "No reply. Start the 'files' source." : msg);
      message.visible = !!txt(message);
      if (message.visible) tint(message, errorMsg ? theme.negative : theme.textDim);
    }

    // ---- hover tooltip -------------------------------------------------------------------------

    function setHover(i: number, x: number, y: number): void {
      tipAt = [x, y];
      if (i !== hover) {
        hover = i;
        if (i < 0 || !layout) { hoverFrame.visible = false; tip.visible = false; return; }
        const t = layout.tiles[i];
        placeFrame(hoverFrame, t.r);
        const pre = view?.partial ? '≥ ' : '';
        const size = t.more ? t.more.size : t.node!.size;
        const pct = (100 * size) / (view?.root.size || 1);
        const share = pct >= 10 ? `${Math.round(pct)}%` : pct >= 0.1 ? `${pct.toFixed(1)}%` : '<0.1%';
        const info = CATEGORY_INFO[t.cat];
        setIcon(T, tipIcon, t.more ? 'layout-grid' : info.icon);
        (tipIcon.material as THREE.MeshBasicMaterial).color.set(t.more ? theme.textDim : info.color);
        if (t.more) {
          tipName.set(`${t.more.count} smaller items`);
          tipMeta.set(`${pre}${fmtSize(size)} · ${share} · ${fmtCount(t.more.files)} files\npinch: show them`);
        } else {
          const n = t.node!;
          tipName.set(truncate(n.name + (n.type === 'dir' ? '/' : ''), 46));
          const what = n.type === 'dir' ? `${fmtCount(n.files ?? 0)} files` : info.label.replace(/s$/, '');
          tipMeta.set(`${pre}${fmtSize(size)} · ${share} · ${what}\n${n.type === 'dir' ? (t.level === 2 ? 'pinch: open (2 levels down)' : 'pinch: open') : 'pinch: preview'}`);
        }
        sizeTip();
      }
      if (hover >= 0) positionTip();
    }
    let tipW = 0.2, tipH = 0.06;
    function sizeTip(): void {
      const a = textSize(tipName, { text: txt(tipName), size: 0.0165 });
      const b = textSize(tipMeta, { text: txt(tipMeta), size: 0.0128, lineHeight: 1.3 });
      tipW = Math.max(a.width, b.width) + 0.05;
      tipH = a.height + b.height + 0.03;
      tipBorder.scale.set(tipW + 0.003, tipH + 0.003, 1);
      tipBg.scale.set(tipW, tipH, 1);
      tipIcon.position.set(-tipW / 2 + 0.019, tipH / 2 - 0.02, 0.001);
      tipName.position.set(-tipW / 2 + 0.035, tipH / 2 - 0.011, 0.001);
      tipMeta.position.set(-tipW / 2 + 0.035, tipH / 2 - 0.016 - a.height, 0.001);
    }
    function positionTip(): void {
      let x = tipAt[0], y = tipAt[1] + 0.035 + tipH / 2;
      if (y + tipH / 2 > H() / 2) y = tipAt[1] - 0.035 - tipH / 2;
      x = Math.min(W() / 2 - tipW / 2, Math.max(-W() / 2 + tipW / 2, x));
      tip.position.set(x, y, Z_TIP);
      tip.visible = true;
    }

    // ---- input ---------------------------------------------------------------------------------

    function tileByName(s: string): number {
      if (!layout) return -1;
      const q = s.trim().replace(/\/$/, '').toLowerCase();
      let best = -1;
      for (let i = 0; i < layout.tiles.length; i++) {
        const n = layout.tiles[i].node;
        if (n && n.name.toLowerCase() === q) return i;
        if (best < 0 && n && n.name.toLowerCase().startsWith(q)) best = i;
      }
      return best;
    }

    function onPart(part: string, obj: { path?: string; skip?: number } | null): void {
      if (part === 'btn:up') goUp();
      else if (part === 'btn:refresh') { cache.clear(); go(view?.display ?? want, view?.skip ?? 0); }
      else if (part === 'btn:hidden') { if (!ctx.isMirror) ctx.setProps({ showHidden: !ctx.props.showHidden }); setIcon(T, hiddenIcon, ctx.props.showHidden ? 'eye' : 'eye-off'); cache.clear(); go(view?.display ?? want, 0); }
      else if (part === 'btn:ask') {
        const where = view?.display ?? want;
        const top = layout ? layout.tiles.slice(0, Math.min(layout.top, 6)).filter((t) => t.node).map((t) => `${t.node!.name} ${fmtSize(t.node!.size)}`).join(', ') : '';
        ctx.askAgent(`I'm looking at the disk usage treemap of ${where}${view ? ` (${fmtSize(view.root.size)}; biggest: ${top})` : ''}. What's taking the space here, and what could I clean up?`);
      } else if (part.startsWith('crumb:') && obj?.path) go(obj.path, obj.skip ?? 0);
      else if (part === 'pv:close') { preview = null; pendingPreview = ''; selectedPath = ''; card.clear(); updateSelection(); }
      else if (part === 'pv:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
    }

    /** Advance the zoom / fade animations. */
    function step(dt: number): void {
      if (anim) {
        anim.t += dt;
        const k = ease(Math.min(1, anim.t / ZOOM_S));
        applyRects(anim.mode === 'in' ? k : 1 - k, anim.src);
        if (anim.t >= ZOOM_S) {
          const mode = anim.mode;
          anim = null;
          if (mode === 'in') finishZoomIn();
          else {
            applyRects(0, area);
            tiles.commit(Math.min(layout?.tiles.length ?? 0, CAPACITY));
            setLabelsVisible(true);
            updateSelection();
            if (failed) showError(failed);
            else { const c = view && cache.get(view.path); if (c && view && c !== view.src && !view.skip) show(c, 0, false); }
          }
        }
      } else if (fade >= 0) {
        fade += dt;
        const k = Math.min(1, fade / FADE_S);
        applyFade(k);
        if (k >= 1) fade = -1;
      }
    }

    /** Finish running animations at once (a new navigation arrived mid-zoom). */
    function settle(): void {
      for (let i = 0; i < 4 && anim; i++) step(ZOOM_S * 2);
      if (fade >= 0) { applyFade(1); fade = -1; }
    }

    build();
    subscribe();
    go(want);

    return {
      onProps(p, prev) {
        if (p.width !== prev.width || p.height !== prev.height || p.interactive !== prev.interactive) {
          crumbGroup = null;
          build();
          if (card.group) card.clear();
          card.height = H();
          if (preview) card.show(preview, W() / 2 + 0.012 + PREVIEW_W / 2);
          relayout();
        }
        if (p.nested !== prev.nested) relayout();
        if (p.prefix !== prev.prefix) { subscribe(); cache.clear(); go(want); }
        else if (p.showHidden !== prev.showHidden) { setIcon(T, hiddenIcon, ctx.props.showHidden ? 'eye' : 'eye-off'); cache.clear(); go(view?.display ?? want); }
        else if (p.path !== prev.path && norm(String(p.path || '~')) !== (view?.display ?? want)) go(String(p.path || '~'));
      },
      onInput(port, v) {
        if (port === 'path' && typeof v === 'string' && v.trim()) go(v.trim());
        else if (port === 'up' && v != null && v !== false) goUp();
        else if (port === 'open' && typeof v === 'string' && v.trim()) {
          const s = v.trim();
          if (s === '..') { goUp(); return; }
          const i = tileByName(s);
          if (i >= 0) openTile(i);
          else if (s.startsWith('/') || s.startsWith('~')) go(s);
          else ctx.event('fb-treemap.open', { notFound: s });
        }
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        const [x, y] = e.localPoint;
        if (e.handler === 'hover') {
          if (part === 'map' && e.phase !== 'end' && layout && !anim) setHover(hitTest(layout, x, y), x, y);
          else if (hover >= 0) setHover(-1, 0, 0);
          return;
        }
        if (e.phase === 'start') {
          if (press) return;
          press = { hand: e.hand, part, x, y, tile: part === 'map' && layout ? hitTest(layout, x, y) : -1, scroll0: card.scroll, moved: false };
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          if (!press.moved && Math.hypot(x - press.x, y - press.y) > TAP_MOVE) press.moved = true;
          if (press.moved && press.part === 'pv:text') { card.scroll = Math.max(0, press.scroll0 + (y - press.y) / (0.0115 * 1.25)); card.render(); }
          return;
        }
        const p = press;
        press = null;
        if (e.phase !== 'end' || p.moved) return;
        if (p.part === 'map') { if (p.tile >= 0 && !anim) openTile(p.tile); return; }
        let obj: { path?: string; skip?: number } | null = null;
        if (p.part.startsWith('crumb:') && crumbGroup) {
          const pill = crumbGroup.children.find((c) => c.name === p.part);
          obj = pill ? (pill.userData as { path?: string; skip?: number }) : null;
        }
        onPart(p.part, obj);
      },
      update(dt) {
        if (loading) {
          loadT += dt;
          const show = loadT > 0.15;
          loadBar.visible = show;
          if (show) {
            const aw = area.x1 - area.x0, bw = aw * 0.22;
            const u = (loadT * 0.7) % 1;
            loadBar.scale.set(bw, 0.003, 1);
            loadBar.position.set(area.x0 + bw / 2 + (aw - bw) * (0.5 - 0.5 * Math.cos(u * Math.PI * 2)), area.y1 + 0.006, STYLE.zText);
          }
          if (loadT > 10 && loadT - dt <= 10) renderStatus();
        } else if (loadBar.visible) { loadBar.visible = false; renderStatus(); }
        step(dt);
        if (crumbWatch.changed()) layoutCrumbs();
        if (legendWatch.changed()) layoutLegend();
        if (tipWatch.changed() && hover >= 0) { sizeTip(); positionTip(); }
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        card.clear();
        if (chrome) disposeTree(chrome);
      },
    };
  },
};

export default definition;
