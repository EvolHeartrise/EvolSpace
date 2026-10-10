// fb-city — "Files · City": the file system as a tabletop city diorama (via the `files` source's
// `tree` command). The entity origin is the table top; the city is a ~1.2 m square on a turntable.
//
//   current folder  = the city; each sub-folder is a district (raised plinth, name on a sign strip
//                     along its near edge), laid out as a squarified treemap by recursive bytes (area ∝ √bytes
//                     by default so small code folders stay visible districts; `footprint: linear` = ∝ bytes)
//   file            = building: footprint ∝ size, HEIGHT = recency (log scale: modified minutes ago →
//                     tall tower, a week → mid-rise, ≥ 2 years → flat), color = type
//   nested folders  = blocks inside districts (with their own small buildings: depth 3)
//
//   hover           floating label above the hand point: name, size, age / file count, what a pinch does
//   pinch district  the district grows into the whole city (scale/translate animation, then the new
//                   city's buildings rise); pinch a block inside a district = two levels at once
//   pinch building  its preview billboard rises above the city (syntax-highlighted text / image);
//                   pinch the building again or the × to lower it; pinch-drag the text to scroll
//   pinch-drag      on the city or the rim: spin the turntable (persisted in `spin`)
//   elevator        breadcrumb column at the front-left corner: one floor per ancestor, current folder
//                   at the bottom; pinch a floor to go up there (the city zooms out into it)
//
// Requests go to <prefix>.request; replies on <prefix>.fb-city.<entityId>.{tree,preview}, matched by
// path (several clients share them). Tree replies are cached per path; a new city replaces the old
// one only when it has arrived (the refresh icon spins meanwhile).

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { dragBinding } from '../../shared/handle.ts';
import { truncate } from '../../shared/format.ts';
import { isTensor } from '../../shared/tensor.ts';
import { Billboard } from '../../shared/billboard.ts';
import {
  actionTile, buildCity, CATEGORIES, CATEGORY_INFO, crumbsOf, DEFAULT_CITY, fmtAge, fmtCount, fmtSize, HEIGHT_MODES, hitTest, isUnder, tileForPath,
  type Category, type City, type CityOptions, type Crumb, type HeightMode, type Rect, type Tile, type TreeNode, type TreeReply,
} from './city.ts';
import { LH, LINE, PreviewCard, type Preview } from './preview.ts';

export { buildCity, hitTest, actionTile, recency, squarify, crumbsOf, fmtSize } from './city.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  size: number;
  maxHeight: number;
  heightBy: HeightMode;
  footprint: 'balanced' | 'linear';
  depth: number;
  spin: number;
  interactive: boolean;
  prefix: string;
}

const RIM = 0.045;          // turntable rim (rotate handle) width
const BASE_H = 0.024;       // diorama base slab; the city ground is its top
const TAP_MOVE = 0.02;      // m: more movement than this makes a pinch a drag, not a tap
const ZOOM_S = 0.45, GROW_S = 0.55, RISE_S = 0.35;
const CARD_W = 0.74, CARD_H = 0.5;
const CAPACITY = 2048;
const MAX_FLOORS = 7;
const FLOOR_H = 0.042, FLOOR_GAP = 0.012, FLOOR_TEXT = 0.017;
const POOLS: Array<{ size: number; n: number; kind: 'sign' | 'roof' }> = [
  { size: 0.024, n: 9, kind: 'sign' }, { size: 0.0145, n: 16, kind: 'sign' }, { size: 0.016, n: 5, kind: 'roof' },
];

interface View { path: string; display: string; root: TreeNode; partial: boolean; skip: number; provisional: boolean; src: unknown }
type Shown = { path: string; display: string; root: TreeNode | null; partial: boolean };
interface Label { t: Text; size: number; kind: 'sign' | 'roof'; used: boolean }
interface Press { hand: string; part: string; x: number; y: number; z: number; tile: number; moved: boolean; spin0: number; a0: number; scroll0: number; data: { path?: string } | null }

const ease = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const txt = (t: THREE.Object3D) => (t as unknown as { text?: string }).text ?? '';
const tint = (t: THREE.Object3D, c: string) => { (t as unknown as { color: string }).color = c; };
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

const definition: WidgetDefinition<Props> = {
  description:
    "Files as a tabletop city diorama (via the 'files' source; the entity sits at table height): sub-folders are districts on raised plinths laid out " +
    'by recursive bytes, files are buildings (footprint = size (√ by default), height = recency, color = type), nested folders are blocks with their own buildings. ' +
    'Hover for name/size/age; pinch a district to zoom into it (a nested block jumps two levels), a building to raise its preview billboard ' +
    '(syntax-highlighted text / image); pinch-drag the city or rim to spin the table; the elevator column (breadcrumb floors) goes back up. ' +
    'Inputs: path, open (name or path), up.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Include dot files/folders (secrets stay hidden regardless).' },
    size: { type: 'number', default: 1.2, min: 0.5, max: 2.5, step: 0.01, description: 'City footprint (m, square).' },
    maxHeight: { type: 'number', default: 0.16, min: 0.05, max: 0.6, step: 0.01, description: 'Tallest building (m).' },
    heightBy: { type: 'enum', options: [...HEIGHT_MODES], default: 'recency', description: 'Building height: recency (recently modified = tall), size (log bytes) or flat.' },
    footprint: { type: 'enum', options: ['balanced', 'linear'], default: 'balanced', description: 'Footprint area: balanced (∝ √bytes, small folders stay visible districts) or linear (∝ bytes, true proportions).' },
    depth: { type: 'number', default: 3, min: 1, max: 3, step: 1, description: 'Levels drawn: 1 = districts only, 2 = + their buildings/blocks, 3 = + buildings inside blocks.' },
    spin: { type: 'number', default: 0, min: -180, max: 180, step: 1, description: 'Turntable rotation (degrees); set by pinch-dragging the rim or city.' },
    interactive: { type: 'boolean', default: true, description: 'City reacts to hover/pinch (off: only the elevator and rim).' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    open: { type: 'string', description: 'Act like a pinch on the district/building with this name (zoom in / preview), or open a path.' },
    up: { type: 'any', description: 'Go up one level.' },
  },
  outputs: {
    path: { type: 'string', description: 'Absolute path of the folder shown.' },
    selected: { type: 'string', description: 'Absolute path of the file last previewed.' },
  },
  interactions: [dragBinding('fb-city-drag', 'drag')],
  size: [1.29, 0.3, 1.29],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const S = () => Math.max(0.3, Number(ctx.props.size) || 1.2);
    const prefix = () => ctx.props.prefix || 'files';
    const treeCh = () => `${prefix()}.fb-city.${ctx.entityId}.tree`;
    const previewCh = () => `${prefix()}.fb-city.${ctx.entityId}.preview`;
    const opts = (): CityOptions => ({
      ...DEFAULT_CITY,
      maxHeight: Math.max(0.03, Number(ctx.props.maxHeight) || 0.16) * (S() / 1.2),
      heightBy: (HEIGHT_MODES as readonly string[]).includes(ctx.props.heightBy) ? ctx.props.heightBy : 'recency',
      depth: Math.max(1, Math.min(3, Math.round(Number(ctx.props.depth)) || 3)),
      gamma: ctx.props.footprint === 'linear' ? 1 : 0.5,
    });

    // ---- state ---------------------------------------------------------------------------------
    let view: View | null = null;
    let city: City | null = null;
    let want = String(ctx.props.path || '~');
    let wantSkip = 0;
    let loading = false, loadT = 0;
    let errorMsg = '';
    let failed: TreeReply | null = null;
    let home = '';
    let lastPathOut = '';
    const cache = new Map<string, TreeReply>();
    let anim: { mode: 'in' | 'out'; t: number; src: Rect } | null = null;
    let afterZoom: { path: string; skip: number; provisional: TreeNode | null } | null = null;
    let zoomOutFrom: string | null = null;
    let grow = -1;                                   // building rise animation time (-1: off)
    let hover = -1;
    let selectedPath = '';
    let preview: Preview | null = null, pendingPreview = '';
    let rise = -1;                                   // preview rise animation time (-1: off)
    let press: Press | null = null;
    let spin = Number(ctx.props.spin) || 0;
    let rimHover = false;
    let waiting = false;                             // zoomed into a folder whose tree hasn't arrived
    let nonce = 0;
    const offs: Array<() => void> = [];

    // ---- scene ---------------------------------------------------------------------------------
    let scene: THREE.Group | null = null;
    let turn!: THREE.Group, cityG!: THREE.Group;
    let solids!: FittedInstances;
    let ground!: THREE.Mesh;
    let rimMat!: THREE.MeshBasicMaterial;
    let labels: Label[] = [];
    let tip!: THREE.Group, tipBg!: THREE.Mesh, tipBorder!: THREE.Mesh, tipIcon!: THREE.Mesh, tipName!: Text, tipMeta!: Text;
    let tipBoard!: Billboard;
    const tipWatch = new MeasureWatch();
    let tipW = 0.2, tipH = 0.06;
    let elev!: THREE.Group, elevBoard!: Billboard, floorGroup: THREE.Group | null = null;
    let floorTexts: Text[] = [];
    let statusText!: Text, refreshIcon!: THREE.Mesh, shaft!: THREE.Mesh;
    const floorWatch = new MeasureWatch();
    let crumbs: Crumb[] = [];
    let msgG!: THREE.Group, message!: Text, msgBoard!: Billboard;
    let cardPivot!: THREE.Group, cardBoard!: Billboard, beam!: THREE.Mesh;
    const card = new PreviewCard(ctx, CARD_W, CARD_H);

    // instance bookkeeping (per relayout)
    let nInst = 0;
    const baseCol: THREE.Color[] = [];               // per instance
    const instTile: number[] = [];                   // instance → tile
    let peak: Float32Array = new Float32Array(0);   // per tile: highest top of it and its descendants
    let maxTop = 0.05;
    let selTile = -1;

    const m4 = new T.Matrix4();
    const col = new T.Color();
    const white = new T.Color('#ffffff');
    const accentCol = new T.Color(theme.accent);
    const v1 = new T.Vector3(), v2 = new T.Vector3(), up = new T.Vector3(0, 1, 0);
    const inv = new T.Matrix4();
    const bg = theme.background;
    const fills = {} as Record<Category, THREE.Color[]>;  // [level1, level2, level3]
    for (const c of CATEGORIES) {
      const base = CATEGORY_INFO[c].color;
      fills[c] = [0.1, 0.16, 0.26].map((k) => new T.Color(mixHex(base, bg, k)));
    }
    const folder = CATEGORY_INFO.folder.color;
    // folders: muted amber ground (darker = outer), so the colored buildings carry the eye
    const earth = mixHex(folder, theme.border, 0.55);
    const plinthCol = [new T.Color(mixHex(earth, bg, 0.72)), new T.Color(mixHex(earth, bg, 0.6)), new T.Color(mixHex(earth, bg, 0.5))];
    const closedCol = [new T.Color(mixHex(earth, bg, 0.45)), new T.Color(mixHex(earth, bg, 0.4)), new T.Color(mixHex(earth, bg, 0.35))];
    const signCol = [new T.Color(mixHex(folder, bg, 0.62)), new T.Color(mixHex(folder, bg, 0.55))];
    const lotCol = new T.Color(mixHex(theme.textDim, bg, 0.55));
    const textInt = hexToInt(theme.text), dimInt = hexToInt(theme.textDim), roofInt = hexToInt(bg);
    const signInt = hexToInt(mixHex(folder, '#ffffff', 0.55));

    function build(): void {
      if (scene) disposeTree(scene);
      const g = (scene = new T.Group());
      const s = S(), B = s + 2 * RIM;
      turn = new T.Group();
      turn.rotation.y = (spin * Math.PI) / 180;
      g.add(turn);
      // base slab (not interactive: pinching its side grabs/moves the whole diorama)
      const base = new T.Mesh(shadedGeometry(T, 'box'), ownMaterial(T, mixHex(theme.surface, bg, 0.35), { shaded: true }));
      base.scale.set(B, BASE_H, B);
      base.position.y = BASE_H / 2;
      turn.add(base);
      // rim bevel = the turntable handle
      rimMat = ownMaterial(T, mixHex(theme.border, bg, 0.2), { shaded: true });
      for (let k = 0; k < 4; k++) {
        const along = k < 2;
        const bar = new T.Mesh(shadedGeometry(T, 'box'), rimMat);
        const off = (s + RIM) / 2 * (k % 2 ? 1 : -1);
        bar.scale.set(along ? B : RIM - 0.01, 0.007, along ? RIM - 0.01 : s);
        bar.position.set(along ? 0 : off, BASE_H + 0.0035, along ? off : 0);
        bar.raycast = () => {};
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(along ? B + 0.02 : RIM + 0.02, 0.05, along ? RIM + 0.02 : s);
        hit.position.set(along ? 0 : off, BASE_H + 0.012, along ? off : 0);
        hit.name = 'rim';
        ctx.interactive(hit);
        turn.add(bar, hit);
      }
      // rotate hints on the front corners
      for (const sx of [-1, 1]) {
        const ic = makeIcon(ctx, sx > 0 ? 'rotate-ccw' : 'rotate-cw', { size: RIM * 0.62, color: theme.textDim });
        ic.rotation.x = -Math.PI / 2;
        ic.position.set(sx * (s + RIM) / 2, BASE_H + 0.0075, (s + RIM) / 2);
        turn.add(ic);
      }

      cityG = new T.Group();
      cityG.position.y = BASE_H + 0.007;
      turn.add(cityG);
      solids = new FittedInstances(T, shadedGeometry(T, 'box'), ownMaterial(T, '#ffffff', { shaded: true }), CAPACITY);
      solids.mesh.frustumCulled = false;
      solids.mesh.name = 'city';
      cityG.add(solids.mesh);
      ground = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      ground.scale.set(s, 0.004, s);
      ground.position.y = 0.002;
      ground.name = 'city';
      cityG.add(ground);
      if (ctx.props.interactive) { ctx.interactive(solids.mesh); ctx.interactive(ground); }

      labels = [];
      for (const p of POOLS) {
        for (let i = 0; i < p.n; i++) {
          const t = makeText(ctx, '', { size: p.size, anchorX: 'left', anchorY: 'middle', color: p.kind === 'roof' ? bg : theme.text, whiteSpace: 'nowrap', weight: p.kind === 'roof' || p.size > 0.02 ? 'semibold' : 'regular' });
          t.rotation.x = -Math.PI / 2;
          t.visible = false;
          cityG.add(t);
          labels.push({ t, size: p.size, kind: p.kind, used: false });
        }
      }

      // hover tooltip (billboard above the hand point)
      tip = new T.Group();
      tip.visible = false;
      const inner = new T.Group();
      tipBorder = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
      tipBg = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
      tipBg.position.z = 0.0006;
      tipIcon = makeIcon(ctx, 'file', { size: 0.022, color: theme.text });
      tipName = makeText(ctx, '', { size: 0.019, anchorX: 'left', anchorY: 'top', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      tipMeta = makeText(ctx, '', { size: 0.0145, anchorX: 'left', anchorY: 'top', color: theme.textDim, whiteSpace: 'nowrap', lineHeight: 1.3 });
      for (const m of [tipBorder, tipBg]) m.raycast = () => {};
      tipIcon.position.z = tipName.position.z = tipMeta.position.z = 0.0012;
      inner.add(tipBorder, tipBg, tipIcon, tipName, tipMeta);
      tip.add(inner);
      tipWatch.reset([tipName, tipMeta]);
      turn.add(tip);
      tipBoard = new Billboard(T, tip, 'yaw');
      tipBoard.attach();

      // elevator (breadcrumb floors) at the front-left corner, outside the turntable
      elev = new T.Group();
      elev.position.set(-B / 2 - 0.05, 0, B / 2 - 0.05);
      shaft = new T.Mesh(shadedGeometry(T, 'cylinder'), ownMaterial(T, mixHex(theme.border, bg, 0.1), { shaded: true }));
      shaft.raycast = () => {};
      const foot = new T.Mesh(shadedGeometry(T, 'cylinder'), ownMaterial(T, mixHex(theme.surface, bg, 0.3), { shaded: true }));
      foot.scale.set(0.07, 0.012, 0.07);
      foot.position.y = 0.006;
      foot.raycast = () => {};
      elev.add(shaft, foot);
      floorTexts = [];
      for (let i = 0; i < MAX_FLOORS; i++) {
        const t = makeText(ctx, '', { size: FLOOR_TEXT, anchorX: 'right', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap', weight: i === 0 ? 'semibold' : 'regular' });
        t.visible = false;
        floorTexts.push(t);
        elev.add(t);
      }
      floorWatch.reset(floorTexts);
      statusText = makeText(ctx, '', { size: 0.0135, anchorX: 'right', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      statusText.position.set(-0.05, 0.034, 0.003);
      elev.add(statusText);
      // refresh button left of the status (spins while scanning)
      const rb = ctx.ui.panel(0.036, 0.036, { color: theme.surface, radius: 0.018 });
      rb.name = 'btn:refresh';
      rb.position.set(-0.024, 0.034, 0.001);
      ctx.interactive(rb);
      refreshIcon = makeIcon(ctx, 'refresh-cw', { size: 0.019, color: theme.textDim });
      refreshIcon.position.z = 0.002;
      rb.add(refreshIcon);
      elev.add(rb);
      g.add(elev);
      elevBoard = new Billboard(T, elev, 'yaw');

      // status / error message floating over the city center
      msgG = new T.Group();
      msgG.position.set(0, BASE_H + 0.12, 0);
      message = makeText(ctx, '', { size: 0.024, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: 0.6, textAlign: 'center' });
      msgG.add(message);
      g.add(msgG);
      msgBoard = new Billboard(T, msgG, 'yaw');
      msgBoard.attach();

      // preview billboard + the beam that ties it to its building
      cardPivot = new T.Group();
      cardPivot.visible = false;
      cardPivot.add(card.group);
      g.add(cardPivot);
      cardBoard = new Billboard(T, cardPivot, 'yaw');
      beam = new T.Mesh(sharedGeometry(T, 'box'), ownMaterial(T, theme.accent, { opacity: 0.7 }));
      beam.raycast = () => {};
      beam.visible = false;
      g.add(beam);
      ctx.root.add(g);
    }

    // ---- data ----------------------------------------------------------------------------------

    function request(cmd: 'tree' | 'preview', p: string): void {
      const msg: Record<string, unknown> = { cmd, path: p, reply: cmd === 'tree' ? treeCh() : previewCh(), nonce: ++nonce };
      if (cmd === 'tree') { msg.depth = opts().depth; msg.hidden = !!ctx.props.showHidden; }
      ctx.channels.publish(`${prefix()}.request`, msg as never);
    }

    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
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
      while (cache.size > 12) cache.delete(cache.keys().next().value as string);
    }

    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(treeCh(), (v: ChannelValue) => onTree(v)));
      offs.push(ctx.channels.subscribe(previewCh(), (v: ChannelValue) => {
        if (!v || typeof v !== 'object' || isTensor(v) || (v as Preview).kind !== 'preview') return;
        const got = (v as Preview).path;
        if (!pendingPreview || (got !== pendingPreview && got !== absOf(pendingPreview))) return;
        if (preview && preview.path === got && card.shown) return; // a duplicate (another client asked too)
        preview = v as Preview;
        showCard();
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
        if (typeof r.root !== 'object' || typeof r.root.size !== 'number') { ctx.error('fb-city: malformed tree reply'); return; }
        remember(r);
      }
      if (!matches(r, want)) return;
      loading = false;
      if (r.error || !r.root) failed = r;
      if (anim) return; // applied when the zoom finishes (from the cache)
      if (failed) { showError(failed); return; }
      if (view && view.path === r.path && view.src === r) return;
      show(r, wantSkip, false);
    }

    function showError(r: TreeReply): void {
      failed = null;
      waiting = false;
      errorMsg = r.error || 'Nothing here';
      view = null;
      zoomOutFrom = null;
      crumbs = crumbsOf(r.display || want);
      relayout();
    }

    /** Show a reply (or a provisional node); zooms out when we come from below it, else the city rises. */
    function show(r: Shown, skip: number, provisional: boolean, rising = true): void {
      const same = view && view.path === r.path && view.skip === skip;
      const prevSkip = view?.skip ?? 0;
      const from = zoomOutFrom;
      zoomOutFrom = null;
      waiting = false;
      errorMsg = '';
      view = { path: r.path, display: r.display || displayOf(r.path), root: r.root!, partial: !!r.partial, skip, provisional, src: r };
      want = view.display;
      wantSkip = skip;
      crumbs = crumbsOf(view.display);
      relayout();
      if (!same && city) {
        let src: Rect | null = null;
        if (from && from !== r.path && isUnder(from, r.path)) {
          const i = tileForPath(city, from);
          if (i >= 0) src = city.tiles[i].content ?? city.tiles[i].r;
        } else if (from === r.path && skip === 0 && prevSkip > 0 && city.top && city.tiles[city.top - 1].more) {
          src = city.tiles[city.top - 1].r;
        }
        if (src) { anim = { mode: 'out', t: 0, src }; grow = -1; applyMatrices(1, src); hideOverlays(); }
        else if (rising) { grow = 0; applyMatrices(0, city.area); setLabelsVisible(false); }
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
      loading = true;
      loadT = 0;
      const c = cached(target);
      if (c && c.root && !c.error) show(c, skip, false);
      else { crumbs = crumbsOf(displayOf(target)); layoutFloors(); }
      request('tree', target);
      renderStatus();
    }

    function zoomInto(i: number): void {
      settle();
      if (!city || !view) return;
      const t = city.tiles[i];
      if (!t) return;
      if (t.more) {
        if (t.level > 1 && t.parent >= 0) { zoomInto(t.parent); return; }
        anim = { mode: 'in', t: 0, src: t.r };
        afterZoom = { path: view.path, skip: t.more.skip, provisional: null };
        hideOverlays();
        return;
      }
      const n = t.node!;
      anim = { mode: 'in', t: 0, src: t.content ?? t.r };
      afterZoom = { path: n.path, skip: 0, provisional: n.children?.length ? n : null };
      want = n.path;
      wantSkip = 0;
      failed = null;
      crumbs = crumbsOf(displayOf(n.path));
      layoutFloors();
      hideOverlays();
      loading = !cache.get(n.path); loadT = 0;
      request('tree', n.path);
      renderStatus();
    }

    function finishZoomIn(): void {
      const z = afterZoom!;
      afterZoom = null;
      if (view && z.path === view.path) { show({ ...view }, z.skip, view.provisional); return; }
      if (failed) { showError(failed); return; }
      const c = cache.get(z.path);
      if (c && c.root && !c.error) { show(c, z.skip, false); return; }
      if (z.provisional) {
        show({ path: z.path, display: displayOf(z.path), root: z.provisional, partial: !!view?.partial }, 0, true);
        return;
      }
      // nothing to show yet: the zoomed district keeps filling the table until the reply arrives
      waiting = true;
    }

    function openTile(i: number): void {
      if (!city) return;
      const t = city.tiles[i];
      if (!t) return;
      if (t.more || t.node?.type === 'dir') { zoomInto(i); return; }
      const n = t.node!;
      if (selectedPath === n.path && (card.shown || pendingPreview)) { closePreview(); return; }
      selectedPath = n.path;
      pendingPreview = n.path;
      preview = null;
      ctx.emit('selected', n.path);
      request('preview', n.path);
      updateSelection();
    }

    function closePreview(): void {
      preview = null; pendingPreview = ''; selectedPath = '';
      card.clear();
      cardBoard.detach();
      cardPivot.visible = false;
      beam.visible = false;
      rise = -1;
      updateSelection();
    }

    function goUp(): void {
      if (view?.skip) { go(view.display, 0); return; }
      const cs = crumbsOf(view?.display ?? displayOf(want));
      if (cs.length > 1) go(cs[cs.length - 2].path);
    }

    // ---- city rendering --------------------------------------------------------------------------

    function relayout(): void {
      hover = -1;
      selTile = -1;
      for (const l of labels) { l.used = false; l.t.visible = false; }
      const s = S();
      const area: Rect = { x0: -s / 2, y0: -s / 2, x1: s / 2, y1: s / 2 };
      nInst = 0;
      if (!view) {
        city = null;
        solids.commit(0);
      } else {
        city = buildCity(view.root, area, opts(), view.skip);
        const tiles = city.tiles;
        peak = new Float32Array(tiles.length);
        maxTop = 0.03;
        for (let i = tiles.length - 1; i >= 0; i--) {
          const t = tiles[i];
          const top = t.y0 + t.h + (t.header ? 0.003 : 0);
          peak[i] = Math.max(peak[i], top);
          if (t.parent >= 0) peak[t.parent] = Math.max(peak[t.parent], peak[i]);
          maxTop = Math.max(maxTop, peak[i]);
        }
        instTile.length = 0;
        const add = (ti: number, c: THREE.Color) => {
          if (nInst >= CAPACITY) return;
          instTile[nInst] = ti;
          (baseCol[nInst] ??= new T.Color()).copy(c);
          solids.setColorAt(nInst, c);
          nInst++;
        };
        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i];
          const lv = t.level - 1;
          if (t.more) col.copy(lotCol);
          else if (t.kind === 'building') { col.copy(fills[t.cat][lv]); col.offsetHSL(0, 0, ((i * 7) % 5 - 2) * 0.012); }
          else col.copy(t.content ? plinthCol[lv] : closedCol[lv]);
          add(i, col);
        }
        // sign strips (label bands along the near edge of districts/blocks)
        for (let i = 0; i < tiles.length; i++) if (tiles[i].header > 0) add(-1 - i, signCol[Math.min(1, tiles[i].level - 1)]);
        solids.fit(area.x0, 0, area.y0, area.x1, maxTop, area.y1);
        applyMatrices(0, area);
        solids.commit(nInst);
        placeLabels();
      }
      hideOverlays();
      updateSelection();
      layoutFloors();
      renderStatus();
    }

    /** Instance boxes for zoom progress p (0 = as laid out, 1 = `src` fills the city), clipped to the city. */
    function applyMatrices(p: number, src: Rect): void {
      if (!city) return;
      const a = city.area;
      const sw = src.x1 - src.x0 || 1, sh = src.y1 - src.y0 || 1;
      const kx = 1 + ((a.x1 - a.x0) / sw - 1) * p, ky = 1 + ((a.y1 - a.y0) / sh - 1) * p;
      const ox = src.x0 + (a.x0 - src.x0) * p, oy = src.y0 + (a.y0 - src.y0) * p;
      const tiles = city.tiles;
      for (let k = 0; k < nInst; k++) {
        const ti = instTile[k];
        const strip = ti < 0;
        const t = tiles[strip ? -1 - ti : ti];
        const r = t.r;
        let u0 = r.x0, u1 = r.x1, w0 = r.y0, w1 = r.y1, y0 = t.y0, h = t.h;
        if (strip) { w1 = r.y0 + t.header; y0 = t.y0 + t.h; h = 0.003; }
        let x0 = ox + (u0 - src.x0) * kx, x1 = ox + (u1 - src.x0) * kx, v0 = oy + (w0 - src.y0) * ky, v1_ = oy + (w1 - src.y0) * ky;
        if (x0 < a.x0) x0 = a.x0;
        if (x1 > a.x1) x1 = a.x1;
        if (v0 < a.y0) v0 = a.y0;
        if (v1_ > a.y1) v1_ = a.y1;
        // the rise: plinths first, then buildings (staggered by level), all from the ground up
        let g = 1;
        if (grow >= 0) {
          const delay = (t.level - 1) * 0.08 + (t.kind === 'building' ? 0.1 : 0);
          g = ease(Math.min(1, Math.max(0, (grow - delay) / (GROW_S - 0.26))));
        }
        const w = x1 - x0, d = v1_ - v0;
        if (w <= 0 || d <= 0 || g <= 0) m4.makeScale(0, 0, 0);
        else {
          const hh = Math.max(0.0005, h * g), yy = y0 * g;
          m4.makeScale(w, hh, d);
          m4.setPosition((x0 + x1) / 2, yy + hh / 2, -(v0 + v1_) / 2);
        }
        solids.setMatrixAt(k, m4);
      }
      solids.mesh.instanceMatrix.needsUpdate = true;
    }

    function takeLabel(kind: 'sign' | 'roof', minSize: number, maxSize: number): Label | null {
      for (const l of labels) if (!l.used && l.kind === kind && l.size >= minSize && l.size <= maxSize) { l.used = true; return l; }
      return null;
    }

    function placeLabels(): void {
      if (!city) return;
      const pre = view?.partial ? '≥ ' : '';
      const tiles = city.tiles;
      const order = tiles.map((_, i) => i).sort((a, b) => rank(tiles[b]) - rank(tiles[a]));
      for (const i of order) {
        const t = tiles[i];
        const w = t.r.x1 - t.r.x0, d = t.r.y1 - t.r.y0;
        const name = t.more ? `+${t.more.count} more` : t.node!.name + (t.node!.type === 'dir' ? '/' : '');
        const size = pre + fmtSize(t.more ? t.more.size : t.node!.size);
        const fit = (s: number, room: number) => Math.floor(room / (s * 0.56));
        let l: Label | null = null;
        let x = t.r.x0 + 0.008, y = 0, z = 0, room = w - 0.016, dim = true;
        if (t.header > 0) {
          l = t.level === 1 ? takeLabel('sign', 0.024, 0.024) ?? takeLabel('sign', 0.0145, 0.0145) : takeLabel('sign', 0.0145, 0.0145);
          y = t.y0 + t.h + 0.0034;
          z = -(t.r.y0 + t.header / 2);
        } else if (t.kind === 'district' || t.kind === 'block' || t.more) {
          // closed folder / "+N" lot: name on its top
          if (w < 0.07 || d < 0.03 || t.level > 2) continue;
          l = takeLabel('sign', 0.0145, 0.0145);
          y = t.y0 + t.h + 0.0006;
          z = -(t.r.y0 + Math.min(d / 2, 0.016));
        } else if (t.kind === 'building' && t.level <= 2) {
          if (w < 0.09 || d < 0.045) continue;
          l = takeLabel('roof', 0.016, 0.016);
          y = t.y0 + t.h + 0.0006;
          z = -(t.r.y0 + Math.min(d / 2, 0.018));
          dim = false;
        }
        if (!l) continue;
        const chars = fit(l.size, room);
        if (chars < 4) { l.used = false; continue; }
        // the name first; its size only when both fit
        const nm = truncate(name, chars);
        const text = dim && chars >= name.length + size.length + 2 ? `${nm}  ${size}` : nm;
        l.t.position.set(x, y, z);
        l.t.set(text);
        if (l.kind === 'roof') setColorRanges(l.t, null);
        else setColorRanges(l.t, { 0: t.node?.type === 'dir' ? signInt : textInt, [Math.min(nm.length, text.length)]: dimInt });
        l.t.visible = true;
      }
    }
    const rank = (t: Tile) => (t.header > 0 ? 100 : 0) + (t.more && t.level === 1 ? 150 : 0) + (3 - t.level) * 10 + (t.r.x1 - t.r.x0) * (t.r.y1 - t.r.y0);

    function setLabelsVisible(on: boolean): void {
      for (const l of labels) l.t.visible = on && l.used;
    }

    function hideOverlays(): void {
      setHover(-1, 0, 0);
      if (anim || grow >= 0) setLabelsVisible(false);
      if (anim) beam.visible = false;
    }

    /** Recolor instances of tile i (hover = lighter, selection = accent). */
    function paintTile(i: number, on: boolean): void {
      if (!city || i < 0) return;
      for (let k = 0; k < nInst; k++) {
        if (instTile[k] !== i) continue;
        col.copy(baseCol[k]);
        if (i === selTile) col.lerp(accentCol, 0.55);
        if (on) col.lerp(white, 0.35);
        solids.setColorAt(k, col);
      }
      if (solids.mesh.instanceColor) solids.mesh.instanceColor.needsUpdate = true;
    }

    function updateSelection(): void {
      const prev = selTile;
      selTile = city && selectedPath ? city.tiles.findIndex((t) => t.node?.path === selectedPath) : -1;
      if (prev !== selTile) { paintTile(prev, prev === hover); paintTile(selTile, selTile === hover); }
      placeBeam();
    }

    // ---- hover tooltip -------------------------------------------------------------------------

    function setHover(i: number, u: number, v: number): void {
      if (i !== hover) {
        const old = hover;
        hover = i;
        paintTile(old, false);
        paintTile(i, true);
        if (i < 0 || !city) { tip.visible = false; return; }
        const t = city.tiles[i];
        const pre = view?.partial ? '≥ ' : '';
        const info = CATEGORY_INFO[t.cat];
        setIcon(T, tipIcon, t.more ? 'layout-grid' : info.icon);
        (tipIcon.material as THREE.MeshBasicMaterial).color.set(t.more ? theme.textDim : info.color);
        if (t.more) {
          tipName.set(`${t.more.count} smaller items`);
          tipMeta.set(`${pre}${fmtSize(t.more.size)} · ${fmtCount(t.more.files)} files\n${t.level === 1 ? 'pinch: show them' : 'pinch: open the folder'}`);
        } else {
          const n = t.node!;
          tipName.set(truncate(n.name + (n.type === 'dir' ? '/' : ''), 44));
          const age = fmtAge(t.newest);
          const line1 = n.type === 'dir'
            ? `${pre}${fmtSize(n.size)} · ${fmtCount(n.files ?? 0)} files${age ? ` · newest ${age}` : ''}`
            : `${fmtSize(n.size)} · ${age || 'age unknown'} · ${info.label}`;
          const hint = n.type === 'dir' ? (t.level === 1 ? 'pinch: zoom in' : `pinch: jump in (${t.level} levels)`) : selectedPath === n.path ? 'pinch: lower preview' : 'pinch: preview';
          tipMeta.set(`${line1}\n${hint}`);
        }
        sizeTip();
      }
      if (hover >= 0 && city) {
        // above the hand point, clear of everything below it
        tip.position.set(u, cityG.position.y + peak[hover] + 0.03 + tipH / 2, -v);
        tip.visible = true;
      }
    }

    function sizeTip(): void {
      const a = textSize(tipName, { text: txt(tipName), size: 0.019 });
      const b = textSize(tipMeta, { text: txt(tipMeta), size: 0.0145, lineHeight: 1.3 });
      tipW = Math.max(a.width, b.width) + 0.056;
      tipH = a.height + b.height + 0.032;
      tipBorder.scale.set(tipW + 0.004, tipH + 0.004, 1);
      tipBg.scale.set(tipW, tipH, 1);
      tipIcon.position.set(-tipW / 2 + 0.021, tipH / 2 - 0.022, 0.0012);
      tipName.position.set(-tipW / 2 + 0.04, tipH / 2 - 0.012, 0.0012);
      tipMeta.position.set(-tipW / 2 + 0.04, tipH / 2 - 0.018 - a.height, 0.0012);
    }

    // ---- elevator (breadcrumb floors) ------------------------------------------------------------

    function layoutFloors(): void {
      if (floorGroup) disposeTree(floorGroup);
      floorGroup = new T.Group();
      elev.add(floorGroup);
      const cs = crumbs.length ? crumbs : crumbsOf(displayOf(want));
      // floors bottom-up: current, parent, …; the root on top ("…" when too deep)
      const items: Array<{ label: string; path: string; skip: number }> = cs.slice().reverse().map((c) => ({ label: c.label, path: c.path, skip: 0 }));
      if (view?.skip && items.length) items.unshift({ label: `+${view.skip} more`, path: view.display, skip: view.skip });
      if (items.length > MAX_FLOORS) items.splice(MAX_FLOORS - 2, items.length - MAX_FLOORS + 1, { label: '…', path: items[MAX_FLOORS - 2].path, skip: 0 });
      let y = 0.034 + 0.03 + FLOOR_H / 2;
      for (let i = 0; i < MAX_FLOORS; i++) {
        const it = items[i], t = floorTexts[i];
        t.visible = !!it;
        if (!it) continue;
        const label = truncate(it.label, 26);
        t.set(label);
        tint(t, i === 0 ? theme.accent : theme.text);
        const tw = textSize(t, { text: label, size: FLOOR_TEXT }).width;
        const icon = i === 1 ? 'arrow-up' : it.label === '~' ? 'house' : '';
        const pw = tw + 0.034 + (icon ? 0.026 : 0);
        const pill = ctx.ui.panel(pw, FLOOR_H, { color: i === 0 ? mixHex(theme.accent, bg, 0.72) : theme.surface, radius: 0.014 });
        pill.position.set(-0.016 - pw / 2, y, 0.001);
        if (i > 0) {
          pill.name = `floor:${i}`;
          pill.userData.path = it.path;
          pill.userData.skip = it.skip;
          ctx.interactive(pill);
        }
        floorGroup.add(pill);
        t.position.set(-0.016 - 0.017, y, 0.003);
        if (icon) {
          const ic = makeIcon(ctx, icon, { size: 0.018, color: i === 1 ? theme.accent : theme.textDim });
          ic.position.set(-0.016 - pw + 0.022, y, 0.003);
          floorGroup.add(ic);
        }
        // a floor slab on the shaft
        const slab = new T.Mesh(sharedGeometry(T, 'box'), ctx.ui.material(i === 0 ? theme.accent : theme.border));
        slab.scale.set(0.03, 0.004, 0.03);
        slab.position.set(0, y - FLOOR_H / 2, 0);
        slab.raycast = () => {};
        floorGroup.add(slab);
        y += FLOOR_H + FLOOR_GAP;
      }
      shaft.scale.set(0.012, y, 0.012);
      shaft.position.y = y / 2;
      elevBoard.attach();
    }

    function renderStatus(): void {
      if (!statusText) return;
      let s = '';
      let color = theme.textDim;
      if (view && city) {
        const r = view.root;
        s = `${view.partial ? '≥ ' : ''}${fmtSize(r.size)} · ${fmtCount(r.files ?? 0)} files`;
        if (city.newest) s += ` · newest ${fmtAge(city.newest)}`;
        if (view.partial) color = theme.accent2;
      }
      if (loading && loadT > 10) { s = "no reply: is the 'files' source running?"; color = theme.negative; }
      else if (loading) s = s ? `${s} · scanning…` : 'scanning…';
      statusText.set(s);
      tint(statusText, color);
      const msg = errorMsg || (!view && !loading ? '' : !view ? 'Scanning…' : city && !city.top ? (view.root.children?.length ? 'Only empty files here' : 'Empty folder') : '');
      message.set(loading && loadT > 10 && !view ? "No reply. Start the 'files' source." : msg);
      message.visible = !!txt(message);
      if (message.visible) tint(message, errorMsg ? theme.negative : theme.textDim);
    }

    // ---- preview billboard -----------------------------------------------------------------------

    const cardHome = () => v1.set(0, BASE_H + (Number(ctx.props.maxHeight) || 0.16) * (S() / 1.2) + 0.1 + CARD_H / 2, 0.02 * S());

    function showCard(): void {
      if (!preview) return;
      card.show(preview);
      cardPivot.visible = true;
      cardBoard.attach();
      rise = 0;
      stepRise(0);
      updateSelection();
    }

    /** Building top (selected tile) in ctx.root coordinates, into `out`; false if not in the city. */
    function buildingTop(out: THREE.Vector3): boolean {
      if (!city || selTile < 0 || anim || waiting) return false;
      const t = city.tiles[selTile];
      out.set((t.r.x0 + t.r.x1) / 2, t.y0 + t.h, -(t.r.y0 + t.r.y1) / 2);
      cityG.updateMatrix();
      turn.updateMatrix();
      out.applyMatrix4(cityG.matrix).applyMatrix4(turn.matrix);
      return true;
    }

    function stepRise(dt: number): void {
      if (rise < 0) return;
      rise += dt;
      const k = ease(Math.min(1, rise / RISE_S));
      const home = cardHome();
      if (buildingTop(v2)) cardPivot.position.copy(v2).lerp(home, k);
      else cardPivot.position.copy(home);
      cardPivot.scale.setScalar(0.08 + 0.92 * k);
      if (k >= 1) rise = -1;
      placeBeam();
    }

    function placeBeam(): void {
      if (!beam) return;
      if (!card.shown || !buildingTop(v2)) { beam.visible = false; return; }
      v1.copy(cardPivot.position);
      v1.y -= (CARD_H / 2) * cardPivot.scale.y;
      v1.sub(v2);
      const len = v1.length();
      if (len < 0.01) { beam.visible = false; return; }
      beam.scale.set(0.004, len, 0.004);
      beam.position.copy(v2).addScaledVector(v1, 0.5);
      beam.quaternion.setFromUnitVectors(up, v1.normalize());
      beam.visible = true;
    }

    // ---- input ---------------------------------------------------------------------------------

    /** ctx.root point → map (u, v) and height y in the city frame. */
    function toMap(p: readonly number[]): [number, number, number] {
      turn.updateMatrix();
      cityG.updateMatrix();
      inv.multiplyMatrices(turn.matrix, cityG.matrix).invert();
      v1.set(p[0], p[1], p[2]).applyMatrix4(inv);
      return [v1.x, -v1.z, v1.y];
    }

    function pick(p: readonly number[]): number {
      if (!city) return -1;
      const [u, v, y] = toMap(p);
      const i = hitTest(city, u, v, y);
      return i < 0 ? -1 : actionTile(city, i);
    }

    /** Angle of a ctx.root point around the turntable axis (CCW from above, matches rotation.y). */
    const angleOf = (x: number, z: number) => Math.atan2(-z, x);

    function setSpin(deg: number): void {
      spin = wrapDeg(deg);
      turn.rotation.y = (spin * Math.PI) / 180;
      placeBeam();
    }

    function tileByName(s: string): number {
      if (!city) return -1;
      const q = s.trim().replace(/\/$/, '').toLowerCase();
      let best = -1;
      for (let i = 0; i < city.tiles.length; i++) {
        const n = city.tiles[i].node;
        if (n && n.name.toLowerCase() === q) return i;
        if (best < 0 && n && n.name.toLowerCase().startsWith(q)) best = i;
      }
      return best;
    }

    function onPart(p: Press): void {
      const part = p.part;
      if (part === 'city') { if (p.tile >= 0 && !anim && !waiting) openTile(p.tile); }
      else if (part === 'btn:refresh') { cache.clear(); go(view?.display ?? want, view?.skip ?? 0); }
      else if (part.startsWith('floor:') && p.data?.path) go(p.data.path, (p.data as { skip?: number }).skip ?? 0);
      else if (part === 'pv:close') closePreview();
      else if (part === 'pv:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
    }

    function step(dt: number): void {
      if (anim) {
        anim.t += dt;
        const k = ease(Math.min(1, anim.t / ZOOM_S));
        applyMatrices(anim.mode === 'in' ? k : 1 - k, anim.src);
        if (anim.t >= ZOOM_S) {
          const mode = anim.mode;
          anim = null;
          if (mode === 'in') finishZoomIn();
          else {
            if (city) applyMatrices(0, city.area);
            solids.commit(nInst);
            setLabelsVisible(true);
            updateSelection();
            if (failed) showError(failed);
            else { const c = view && cache.get(view.path); if (c && view && c !== view.src && !view.skip) show(c, 0, false, false); }
          }
        }
      } else if (grow >= 0 && city) {
        grow += dt;
        applyMatrices(0, city.area);
        if (grow >= GROW_S) {
          grow = -1;
          applyMatrices(0, city.area);
          solids.commit(nInst);
          setLabelsVisible(true);
          placeBeam();
        }
      }
    }

    /** Finish running animations at once (a new navigation arrived mid-way). */
    function settle(): void {
      for (let i = 0; i < 4 && (anim || grow >= 0); i++) step(ZOOM_S + GROW_S);
    }

    build();
    subscribe();
    go(want);

    return {
      onProps(p, prev) {
        if (p.spin !== prev.spin && Number(p.spin) !== spin) setSpin(Number(p.spin) || 0);
        if (p.size !== prev.size || p.interactive !== prev.interactive) {
          floorGroup = null;
          build();
          if (preview) showCard();
          relayout();
        } else if (p.maxHeight !== prev.maxHeight || p.heightBy !== prev.heightBy || p.footprint !== prev.footprint) relayout();
        if (p.prefix !== prev.prefix) { subscribe(); cache.clear(); go(want); }
        else if (p.showHidden !== prev.showHidden || p.depth !== prev.depth) { cache.clear(); go(view?.display ?? want); }
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
          else ctx.event('fb-city.open', { notFound: s });
        }
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        const lp = e.localPoint;
        if (e.handler === 'hover') {
          const on = e.phase !== 'end';
          if (part === 'rim' || rimHover) {
            const h = on && part === 'rim';
            if (h !== rimHover) { rimHover = h; rimMat.color.set(h ? mixHex(theme.accent, bg, 0.3) : mixHex(theme.border, bg, 0.2)); }
          }
          if (part === 'city' && on && city && !anim && !waiting && grow < 0 && !press) {
            const i = pick(lp);
            const [u, v] = toMap(lp);
            setHover(i, u, v);
          } else if (hover >= 0) setHover(-1, 0, 0);
          return;
        }
        if (e.phase === 'start') {
          if (press) return;
          const data = part.startsWith('floor:') && floorGroup ? (floorGroup.children.find((c) => c.name === part)?.userData as { path?: string } | undefined) ?? null : null;
          press = { hand: e.hand, part, x: lp[0], y: lp[1], z: lp[2], tile: part === 'city' ? pick(lp) : -1, moved: false, spin0: spin, a0: angleOf(lp[0], lp[2]), scroll0: card.scroll, data };
          return;
        }
        if (!press || e.hand !== press.hand) return;
        const p = press;
        if (e.phase === 'move') {
          if (!p.moved && Math.hypot(lp[0] - p.x, lp[1] - p.y, lp[2] - p.z) > TAP_MOVE) {
            p.moved = true;
            if (p.part === 'city') setHover(-1, 0, 0);
          }
          if (p.part === 'rim' || (p.part === 'city' && p.moved)) {
            if (Math.hypot(lp[0], lp[2]) > 0.05) setSpin(p.spin0 + ((angleOf(lp[0], lp[2]) - p.a0) * 180) / Math.PI);
          } else if (p.moved && p.part === 'pv:text') {
            card.scroll = Math.max(0, p.scroll0 + (lp[1] - p.y) / (LINE * LH * cardPivot.scale.y));
            card.render();
          }
          return;
        }
        press = null;
        if ((p.part === 'rim' || p.part === 'city') && spin !== p.spin0) {
          if (!ctx.isMirror) ctx.setProps({ spin: Math.round(spin * 10) / 10 });
          return;
        }
        if (e.phase !== 'end' || p.moved) return;
        onPart(p);
      },
      update(dt) {
        if (loading) {
          loadT += dt;
          refreshIcon.rotation.z -= dt * 5;
          if (loadT > 10 && loadT - dt <= 10) renderStatus();
        } else if (refreshIcon.rotation.z !== 0) { refreshIcon.rotation.z = 0; renderStatus(); }
        step(dt);
        stepRise(dt);
        if (floorWatch.changed()) layoutFloors();
        if (tipWatch.changed() && hover >= 0) sizeTip();
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        tipBoard?.detach();
        elevBoard?.detach();
        msgBoard?.detach();
        cardBoard?.detach();
        card.clear();
        if (scene) disposeTree(scene);
      },
    };
  },
};

export default definition;
