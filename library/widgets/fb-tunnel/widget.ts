// fb-tunnel — "Files · Tunnel": navigate the file system by moving THROUGH DEPTH (via the `files` source).
//
// The entity origin is the viewing mouth of a tunnel that recedes away from you (−Z). At its far end
// floats the PORTAL of the current folder (name, counts, up / home / hidden buttons). The folder's
// entries are cards on the tunnel wall around your line of sight, facing you: folders on the upper
// arc, files on the lower arc, sorted, nearest row first, left → right (a stable arrangement per
// folder → spatial memory). Every ancestor is a ring of the tunnel between you and the portal —
// the parent nearest the portal, older ones closer to you, each with a name tag on its side — so
// depth = level and the whole path is visible at a glance.
//
//   pinch a folder card ......... it becomes the portal you fly into: the rings slide toward and past
//                                 you, the old cards rush by, the new folder's cards fan out of the portal
//   pinch-drag a card AWAY ...... the same, scrubbed by your hand (release past ~9 cm to commit)
//   pinch-drag TOWARD yourself .. on any card / the portal / a ring tag: back out to the parent
//                                 (everything recedes; release past ~9 cm to commit, else it springs back)
//   pinch a ring tag ............ jump straight back to that ancestor
//   pinch a file card ........... a preview pane extrudes from the card toward you (syntax-highlighted
//                                 text or the image); pinch the card again or ✕ to retract it
//   drag a card sideways ........ page that arc when a folder has more entries than fit (or tap ›)
//
// Requests go to <prefix>.request with reply channels <prefix>.fb-tunnel.<entityId>.list / .preview;
// several clients share them, so replies are matched by path. The path (and the previewed file) persist.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import {
  GEO, age, arcCapacity, arcSlots, baseName, clamp, clamp01, coneRadius, easeInOut, easeOut, folderTitle, iconFor,
  joinPath, levels, MAX_TAGS, navKind, normPath, pageCount, ringAlpha, ringPlan, ringZ, rowSpecs, slotPosition,
  splitEntries, tileLabel, type Entry, type RingPlan, type Slot,
} from './model.ts';

interface Props extends Record<string, unknown> {
  path: string;
  file: string;
  showHidden: boolean;
  prefix: string;
}

interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Entry[]; truncated: boolean; error?: string }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }

// ---- tuning ------------------------------------------------------------------------------------
const TAP = 0.015; // hand travel (m) that turns a press into a drag
const PULL = 0.09; // depth travel (m) that commits a push / pull
const PREVIEW_P = 0.4; // how far (nav progress) an uncommitted depth drag scrubs the transition
const PAGE_DIST = 0.07; // sideways travel (m) that pages an arc
const NAV_DUR = 0.5;
const TILE_IN_DUR = 0.34;
const PAGE_HALF = 0.17;
const PV_DUR = 0.32;
const RING_N = 8;
const NAME_SIZE = 0.0145;
const TAG_SIZE = 0.023;
const NAME_COLS = 16;
const PV_W = 0.7;
const PV_H = 0.48;
const PV_Z = -0.16;
const PV_PAD = 0.018;
const CODE = 0.0112;
const CODE_LH = 1.3;
const CODE_COLS = Math.floor((PV_W - 2 * PV_PAD - 0.036) / (CODE * 0.6));
const PV_LINES = Math.floor((PV_H - 2 * PV_PAD - 0.062) / (CODE * CODE_LH));

interface Tile {
  g: THREE.Group;
  icon: THREE.Mesh;
  name: Text;
  hit: THREE.Mesh;
  arc: 0 | 1;
  /** index within its arc's page */
  j: number;
  entry: Entry | null;
  slot: Slot | null;
}

interface RingVis {
  g: THREE.Group;
  ring: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  tag: THREE.Group;
  plate: THREE.Mesh;
  plateMat: THREE.MeshBasicMaterial;
  icon: THREE.Mesh;
  text: Text;
  plan: RingPlan | null;
  side: number;
}

interface Nav {
  kind: 'enter' | 'up' | 'jump';
  from: string;
  to: string;
  plan: RingPlan[];
  p: number;
  committed: boolean;
  /** −1 while an uncommitted scrub retracts. */
  dir: 1 | -1;
  /** Ring distance the new current folder starts from / the old one goes to. */
  toFrom: number;
  fromTo: number;
  /** Folder card the portal flies out of (enter by pinch). */
  fromTile: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number } | null;
}

const definition: WidgetDefinition<Props> = {
  description:
    "3D file browser (via the 'files' source): a tunnel receding from its mouth (the entity origin). The current folder is a portal at the far " +
    'end; its entries are cards on the tunnel wall facing you (folders on the upper arc, files on the lower arc); every ancestor is a ring with a ' +
    'name tag between you and the portal (depth = level). Pinch a folder (or push it away) to fly in; pinch-drag toward yourself or pinch a ring tag ' +
    'to back out; pinch a file to extrude a preview (syntax-highlighted text / image); drag a card sideways to page. Props: path, file, showHidden.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    file: { type: 'string', default: '', description: 'File whose preview is open ("" = none); updated as you open/close previews.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Fly to this folder (absolute, "~" or "~/…").' },
    preview: { type: 'string', description: 'Preview this file (absolute or ~/ path).' },
  },
  outputs: {
    path: { type: 'string', description: 'Current folder (display path), on every navigation.' },
    selected: { type: 'string', description: 'Path of the file last pinched.' },
  },
  interactions: [dragBinding('fb-tunnel-drag', 'drag')],
  size: [1.2, 1.2, 1.0],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const prefix = () => String(ctx.props.prefix || 'files');
    const listCh = () => `${prefix()}.fb-tunnel.${ctx.entityId}.list`;
    const previewCh = () => `${prefix()}.fb-tunnel.${ctx.entityId}.preview`;

    // ---- preallocated math (no per-frame allocation) ---------------------------------------------
    const EYE = new T.Vector3(0, 0, GEO.EYE_Z);
    const UP = new T.Vector3(0, 1, 0);
    const _p = new T.Vector3();
    const _p2 = new T.Vector3();
    const _q = new T.Quaternion();
    const _s = new T.Vector3();
    const _m = new T.Matrix4();
    const _look = new T.Matrix4();
    const ID_Q = new T.Quaternion();
    const PORTAL_HOME = new T.Vector3(0, 0, GEO.Z_FAR);
    const PV_HOME = new T.Vector3(0, 0, PV_Z);
    const _c = new T.Color();

    /** Orientation that turns +Z toward the eye point. */
    function faceEye(pos: THREE.Vector3, out: THREE.Quaternion): void {
      _look.lookAt(EYE, pos, UP);
      out.setFromRotationMatrix(_look);
    }

    // ---- state ---------------------------------------------------------------------------------
    let current = '';
    let curLevels: string[] = [];
    let hasParent = false;
    let want = '';
    let statusDirty = true;
    /** Folder the wall shows (display form) — to tell which card is the previewed file. */
    let wallDir = '';
    let listing: Listing | null = null; // shown on the wall
    let incoming: Listing | null = null; // arrived for `current`, waiting for the tiles to swap
    let error = '';
    const cache = new Map<string, Listing>();
    let nonce = 0;
    let dirs: Entry[] = [];
    let files: Entry[] = [];
    const page: [number, number] = [0, 0];
    const cap = arcCapacity();
    const rows = rowSpecs();
    let nav: Nav | null = null;
    let tilePhase: 'idle' | 'out' | 'wait' | 'in' = 'wait';
    let tileKind: 'enter' | 'up' = 'enter';
    let tileE = 0;
    const arcShift: [number, number] = [0, 0];
    const pg = [{ phase: 'idle' as 'idle' | 'out' | 'in', e: 0, dir: 1 }, { phase: 'idle' as 'idle' | 'out' | 'in', e: 0, dir: 1 }];
    let hoverPart = '';
    let press: {
      hand: string; part: string; lp0: [number, number, number]; hand0: THREE.Vector3; toHead: THREE.Vector3;
      mode: '' | 'depth' | 'arc' | 'scroll' | 'none'; depth: number; dx: number; scroll0: number; arc: 0 | 1;
    } | null = null;
    let dirty = true;
    let disposed = false;
    const offs: Array<() => void> = [];

    // ---- static scene: rails, mouth, plates ------------------------------------------------------
    const group = new T.Group();
    ctx.root.add(group);

    const ringGeo = new T.RingGeometry(0.985, 1, 96);
    const mouthGeo = new T.RingGeometry(0.965, 1, 128);
    const rimGeo = new T.RingGeometry(0.93, 1, 96);

    {
      const n = 16;
      const pts = new Float32Array(n * 6);
      for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2 + Math.PI / n;
        pts.set([GEO.R_MOUTH * Math.cos(th), GEO.R_MOUTH * Math.sin(th), 0, GEO.R_FAR * Math.cos(th), GEO.R_FAR * Math.sin(th), GEO.Z_FAR], k * 6);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pts, 3));
      const rails = new T.LineSegments(g, new T.LineBasicMaterial({ color: theme.border, transparent: true, opacity: 0.45 }));
      rails.name = 'rails';
      rails.raycast = () => {};
      group.add(rails);
      // the mouth: a solid lip you can grab the tunnel by
      const mouth = new T.Mesh(mouthGeo, ownMaterial(T, mixHex(theme.border, theme.accent, 0.35), { doubleSide: true }));
      mouth.scale.setScalar(GEO.R_MOUTH);
      mouth.name = 'mouth';
      group.add(mouth);
    }

    const plateMat = ownMaterial(T, '#ffffff', { shaded: true });
    const plates = new FittedInstances(T, shadedGeometry(T, 'box'), plateMat, 2 * cap);
    plates.mesh.name = 'plates';
    plates.mesh.raycast = () => {}; // cards are hit through their own hit boxes
    plates.fit(-0.8, -0.8, -1.4, 0.8, 0.8, 0.6);
    group.add(plates.mesh);
    const COLORS = {
      file: new T.Color(theme.surface),
      dir: new T.Color(mixHex(theme.surface, '#e3b341', 0.22)),
      hover: new T.Color(mixHex(theme.surface, theme.accent, 0.4)),
      open: new T.Color(mixHex(theme.surface, theme.accent, 0.65)),
    };

    // ---- tiles (pooled) ------------------------------------------------------------------------
    const tiles: Tile[] = [];
    for (let i = 0; i < 2 * cap; i++) {
      const g = new T.Group();
      const icon = makeIcon(ctx, 'file', { size: 0.024, color: theme.textDim });
      icon.position.set(-GEO.TILE_W / 2 + 0.021, 0, GEO.TILE_D + 0.002);
      const name = makeText(ctx, '', { size: NAME_SIZE, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap', lineHeight: 1.15 });
      name.position.set(-GEO.TILE_W / 2 + 0.04, 0, GEO.TILE_D + 0.003);
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(GEO.TILE_W, GEO.TILE_H, 0.03);
      hit.name = `tile:${i}`;
      ctx.interactive(hit);
      g.add(icon, name, hit);
      g.visible = false;
      group.add(g);
      tiles.push({ g, icon, name, hit, arc: i < cap ? 0 : 1, j: i < cap ? i : i - cap, entry: null, slot: null });
    }

    // ---- level rings (pooled) --------------------------------------------------------------------
    const ringVis: RingVis[] = [];
    for (let i = 0; i < RING_N; i++) {
      const g = new T.Group();
      const mat = ownMaterial(T, mixHex(theme.border, theme.accent, 0.5), { opacity: 0.5, doubleSide: true });
      const ring = new T.Mesh(ringGeo, mat);
      ring.raycast = () => {};
      g.add(ring);
      const tag = new T.Group();
      const plateM = ownMaterial(T, theme.surface, { opacity: 0.94 });
      const plate = new T.Mesh(sharedGeometry(T, 'plane'), plateM);
      plate.name = `ring:${i}`;
      ctx.interactive(plate);
      const icon = makeIcon(ctx, 'folder', { size: 0.024, color: '#e3b341' });
      const text = makeText(ctx, '', { size: TAG_SIZE, anchorX: 'left', anchorY: 'middle', color: theme.text, whiteSpace: 'nowrap' });
      tag.add(plate, icon, text);
      tag.visible = false;
      g.visible = false;
      group.add(g, tag);
      ringVis.push({ g, ring, mat, tag, plate, plateMat: plateM, icon, text, plan: null, side: 1 });
    }

    // ---- portal (the current folder, at the far end) ---------------------------------------------
    const portal = new T.Group();
    const disc = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, theme.background, { opacity: 0.93 }));
    disc.scale.setScalar(2 * GEO.R_PORTAL);
    disc.name = 'portal';
    ctx.interactive(disc);
    const rim = new T.Mesh(rimGeo, ownMaterial(T, theme.accent, { doubleSide: true }));
    rim.scale.setScalar(GEO.R_PORTAL);
    rim.position.z = 0.001;
    rim.raycast = () => {};
    const title = makeText(ctx, '', { size: 0.044, anchorX: 'center', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    title.position.set(0, 0.085, 0.004);
    const sub = makeText(ctx, '', { size: 0.021, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: 2 * GEO.R_PORTAL * 0.86, textAlign: 'center' });
    sub.position.set(0, 0.03, 0.004);
    portal.add(disc, rim, title, sub);
    const buttons: Record<string, { disc: THREE.Mesh; mat: THREE.MeshBasicMaterial; icon: THREE.Mesh }> = {};
    const BTN = 0.062;
    for (const [id, iconName, x] of [['up', 'corner-left-up', -0.085], ['home', 'house', 0], ['hidden', 'eye-off', 0.085]] as const) {
      const mat = ownMaterial(T, theme.surface);
      const b = new T.Mesh(sharedGeometry(T, 'disc'), mat);
      b.scale.setScalar(BTN);
      b.position.set(x, -0.088, 0.003);
      b.name = `btn:${id}`;
      ctx.interactive(b);
      const ic = makeIcon(ctx, iconName, { size: 0.03, color: theme.text });
      ic.position.set(x, -0.088, 0.005);
      portal.add(b, ic);
      buttons[id] = { disc: b, mat, icon: ic };
    }
    group.add(portal);

    // ---- pagers (one per arc, at its right end) --------------------------------------------------
    const pagers = ([0, 1] as const).map((arc) => {
      const g = new T.Group();
      const mat = ownMaterial(T, theme.surface, { opacity: 0.94 });
      const plate = new T.Mesh(sharedGeometry(T, 'plane'), mat);
      plate.scale.set(0.085, 0.04, 1);
      plate.name = `pager:${arc}`;
      ctx.interactive(plate);
      const text = makeText(ctx, '', { size: 0.016, anchorX: 'center', anchorY: 'middle', color: theme.text });
      text.position.set(-0.012, 0, 0.002);
      const ic = makeIcon(ctx, 'chevron-right', { size: 0.02, color: theme.accent });
      ic.position.set(0.026, 0, 0.002);
      g.add(plate, text, ic);
      g.visible = false;
      const a = GEO.ARC + (10 * Math.PI) / 180;
      const [x, y, z] = slotPosition(arc, a, rows[0].r, rows[0].z);
      g.position.set(x, y, z);
      faceEye(g.position, g.quaternion);
      group.add(g);
      return { g, mat, text };
    });

    // ---- data ---------------------------------------------------------------------------------
    function request(cmd: 'list' | 'preview', p: string): void {
      ctx.channels.publish(`${prefix()}.request`, { cmd, path: p, hidden: !!ctx.props.showHidden, reply: cmd === 'list' ? listCh() : previewCh(), nonce: ++nonce } as never);
    }

    const matches = (l: { path?: string; display?: string }, p: string) => !!p && (normPath(l.display ?? '') === p || normPath(l.path ?? '') === p);

    function setCurrent(p: string): void {
      current = p;
      curLevels = levels(p);
      hasParent = parentOf(p) !== null;
      title.set(truncate(folderTitle(p), 17));
      statusDirty = true;
    }

    function cachePut(l: Listing): void {
      if (l.error) return;
      for (const k of [normPath(l.display), normPath(l.path)]) {
        cache.delete(k);
        cache.set(k, l);
      }
      while (cache.size > 64) cache.delete(cache.keys().next().value as string);
    }

    function signature(l: Listing | null): string {
      if (!l) return '';
      let s = `${l.path}|${l.error ?? ''}|`;
      for (const e of l.entries) s += `${e.type[0]}${e.name}/`;
      return s;
    }

    function onList(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as Listing).kind !== 'list') return;
      const l = v as Listing;
      if (typeof l.path !== 'string' || !Array.isArray(l.entries)) { ctx.error('fb-tunnel: malformed listing'); return; }
      cachePut(l);
      if (want && matches(l, want)) {
        want = '';
        adopt(l);
      } else if (!want && matches(l, current) && signature(l) !== signature(listing) && tilePhase === 'idle' && !nav) {
        showListing(l, true); // background refresh of the folder on the wall
      }
    }

    /** A reply for the folder we're in: canonical path, persist, and get it onto the wall. */
    function adopt(l: Listing): void {
      const canon = normPath(l.display || l.path);
      if (canon !== current) {
        setCurrent(canon);
        if (!nav) assignRings(staticPlan());
      }
      error = l.error ?? '';
      statusDirty = true;
      if (current !== ctx.props.path && !ctx.isMirror) ctx.setProps({ path: current });
      incoming = l;
      if (tilePhase === 'wait') swapIn();
      else if (tilePhase === 'idle' || tilePhase === 'in') {
        // the wall already shows this folder (from the cache): refresh only if it changed
        if (signature(l) !== signature(listing)) showListing(l, tilePhase === 'idle');
        else { listing = l; incoming = null; }
      }
      // 'out': the tiles swap to it halfway through the flight
      dirty = true;
    }

    /** Put a listing's entries on the tile pool (current pages). */
    function showListing(l: Listing, keepPages: boolean): void {
      listing = l;
      incoming = null;
      error = l.error ?? '';
      wallDir = normPath(l.display || l.path);
      statusDirty = true;
      const split = splitEntries(l.entries);
      dirs = split.dirs;
      files = split.files;
      if (!keepPages) { page[0] = 0; page[1] = 0; }
      for (const arc of [0, 1] as const) page[arc] = Math.min(page[arc], pageCount(arc === 0 ? dirs.length : files.length, cap) - 1);
      fillArc(0);
      fillArc(1);
      dirty = true;
    }

    function fillArc(arc: 0 | 1): void {
      const list = arc === 0 ? dirs : files;
      const from = page[arc] * cap;
      const n = Math.max(0, Math.min(cap, list.length - from));
      const slots = arcSlots(n, arc, rows);
      for (let j = 0; j < cap; j++) {
        const t = tiles[arc * cap + j];
        const e = j < n ? list[from + j] : null;
        t.entry = e;
        t.slot = e ? slots[j] : null;
        t.g.visible = !!e;
        if (!e) continue;
        const [icon, color] = iconFor(e);
        setIcon(T, t.icon, icon);
        (t.icon.material as THREE.MeshBasicMaterial).color.set(color);
        t.name.set(tileLabel(e.name, NAME_COLS));
      }
      const pages = pageCount(list.length, cap);
      pagers[arc].g.visible = pages > 1;
      pagers[arc].text.set(`${page[arc] + 1}/${pages}`);
    }

    function swapIn(): void {
      if (!incoming) { tilePhase = 'wait'; hideTiles(); return; }
      showListing(incoming, false);
      tilePhase = 'in';
      tileE = 0;
    }

    function hideTiles(): void {
      for (const t of tiles) t.g.visible = false;
    }

    // ---- navigation ------------------------------------------------------------------------------
    function staticPlan(): RingPlan[] {
      const lv = levels(current);
      return lv.map((p, i) => ({ path: p, from: lv.length - 1 - i, to: lv.length - 1 - i }));
    }

    function assignRings(plan: RingPlan[]): void {
      const useful = plan
        .filter((r) => Math.min(r.from, r.to) <= 6.5 && Math.max(r.from, r.to) >= -1.5)
        .sort((a, b) => Math.min(Math.abs(a.from), Math.abs(a.to)) - Math.min(Math.abs(b.from), Math.abs(b.to)))
        .slice(0, RING_N);
      const free = ringVis.filter((v) => !v.plan || !useful.some((u) => u.path === v.plan!.path));
      for (const v of free) { v.plan = null; v.g.visible = false; v.tag.visible = false; }
      for (const u of useful) {
        let v = ringVis.find((r) => r.plan && r.plan.path === u.path);
        if (!v) {
          v = free.shift();
          if (!v) continue;
          v.text.set(truncate(folderTitle(u.path), 18));
          const w = Math.min(18, folderTitle(u.path).length) * TAG_SIZE * 0.56 + 0.062;
          v.plate.scale.set(w, 0.05, 1);
          v.icon.position.set(-w / 2 + 0.022, 0, 0.002);
          v.text.position.set(-w / 2 + 0.041, 0, 0.002);
        }
        v.plan = u;
        v.side = (levels(u.path).length - 1) % 2 === 0 ? -1 : 1;
      }
    }

    function parentOf(p: string): string | null {
      const lv = levels(p);
      if (lv.length >= 2) return lv[lv.length - 2];
      const par = listing && matches(listing, p) ? listing.parent : null;
      return par ? normPath(par) : null;
    }

    function makeNav(to: string): Nav {
      const k = navKind(current, to);
      const plan = ringPlan(current, to);
      const toFrom = plan.find((r) => r.path === to)?.from ?? -1;
      const fromTo = plan.find((r) => r.path === current)?.to ?? 1;
      return { kind: k === 'same' ? 'jump' : k, from: current, to, plan, p: 0, committed: false, dir: 1, toFrom, fromTo, fromTile: null };
    }

    /** Begin (or commit a scrubbed) flight to folder `to`. */
    function navigate(to: string, opts: { tile?: Tile; scrub?: Nav } = {}): void {
      to = normPath(to);
      if (!to) return;
      if (to === current && !opts.scrub) { want = current; request('list', current); return; }
      const n = opts.scrub ?? makeNav(to);
      n.committed = true;
      n.dir = 1;
      if (opts.tile) {
        const pos = opts.tile.g.position.clone();
        n.fromTile = { pos, quat: opts.tile.g.quaternion.clone(), scale: (GEO.TILE_W * opts.tile.g.scale.x) / (2 * GEO.R_PORTAL) };
      }
      nav = n;
      assignRings(n.plan);
      tileKind = n.kind === 'up' ? 'up' : 'enter';
      if (tilePhase !== 'out') { tilePhase = 'out'; }
      closePreview(true);
      hoverPart = '';
      setCurrent(to);
      want = to;
      error = '';
      incoming = cache.get(to) ?? null;
      request('list', to);
      if (to !== ctx.props.path && !ctx.isMirror) ctx.setProps({ path: to });
      ctx.emit('path', to);
      dirty = true;
    }

    /** Start (or re-aim) an uncommitted scrub of a flight toward `to`. */
    function scrub(to: string | null, p: number): void {
      if (!to) return;
      if (!nav || nav.committed || nav.to !== to) {
        if (nav && nav.committed) return;
        nav = makeNav(to);
        assignRings(nav.plan);
        tileKind = nav.kind === 'up' ? 'up' : 'enter';
      }
      nav.p = clamp(p, 0, PREVIEW_P);
      nav.dir = 1;
      tilePhase = 'out';
      dirty = true;
    }

    // ---- preview ---------------------------------------------------------------------------------
    let pv: {
      path: string; dir: string; base: string; data: Preview | null; e: number; closing: boolean;
      from: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number };
      g: THREE.Group; body: Text | null; nums: Text | null; scroll: number; tex: THREE.Texture | null;
      lines: string[]; spans: Span[][]; lang: string;
    } | null = null;
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;

    function openPreview(path: string, tile: Tile | null): void {
      if (pv) { disposePv(); }
      const from = tile
        ? { pos: tile.g.position.clone(), quat: tile.g.quaternion.clone(), scale: (GEO.TILE_W * tile.g.scale.x) / PV_W }
        : { pos: new T.Vector3(0, -0.3, -0.2), quat: new T.Quaternion(), scale: 0.2 };
      const g = new T.Group();
      g.name = 'preview';
      group.add(g);
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      pv = { path, dir: cut > 0 ? normPath(path.slice(0, cut)) : '', base: baseName(path), data: null, e: 0, closing: false, from, g, body: null, nums: null, scroll: 0, tex: null, lines: [], spans: [], lang: '' };
      buildPreview();
      request('preview', path);
      if (path !== ctx.props.file && !ctx.isMirror) ctx.setProps({ file: path });
      dirty = true;
    }

    function closePreview(instant = false): void {
      if (!pv) return;
      if (instant) disposePv();
      else pv.closing = true;
      if (ctx.props.file && !ctx.isMirror) ctx.setProps({ file: '' });
      dirty = true;
    }

    function disposePv(): void {
      if (!pv) return;
      pv.tex?.dispose();
      disposeTree(pv.g);
      pv = null;
    }

    function buildPreview(): void {
      if (!pv) return;
      const g = pv.g;
      for (const c of [...g.children]) disposeTree(c);
      pv.body = pv.nums = null;
      pv.tex?.dispose();
      pv.tex = null;
      const p = pv.data;
      const name = p?.name ?? baseName(pv.path);
      const x0 = -PV_W / 2 + PV_PAD, x1 = PV_W / 2 - PV_PAD, top = PV_H / 2 - PV_PAD;
      const card = ctx.ui.panel(PV_W, PV_H, { color: theme.background, opacity: 0.96 });
      g.add(card);
      const back = new T.Mesh(shadedGeometry(T, 'box'), ownMaterial(T, theme.surface, { shaded: true }));
      back.scale.set(PV_W + 0.012, PV_H + 0.012, 0.012);
      back.position.z = -0.008;
      back.raycast = () => {};
      g.add(back);
      const [icon, color] = iconFor({ type: 'file', ext: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '', name });
      const ic = makeIcon(ctx, icon, { size: 0.024, color });
      ic.position.set(x0 + 0.012, top - 0.015, 0.003);
      const ttl = makeText(ctx, truncate(name, 46), { size: 0.017, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      ttl.position.set(x0 + 0.032, top - 0.012, 0.003);
      const metaStr = p
        ? [p.size != null ? formatBytes(p.size) : '', p.mtime ? `modified ${age(p.mtime)} ago` : '', p.type === 'text' ? `${p.lines ?? 0} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join(' · ')
        : 'loading…';
      const meta = makeText(ctx, metaStr, { size: 0.011, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.032, top - 0.034, 0.003);
      g.add(ic, ttl, meta);
      const btn = (id: string, iconName: string, x: number) => {
        const d = 0.036;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, top - 0.018, 0.002);
        b.name = `pv:${id}`;
        ctx.interactive(b);
        const bi = makeIcon(ctx, iconName, { size: d * 0.5, color: theme.text });
        bi.position.z = 0.002;
        b.add(bi);
        g.add(b);
      };
      btn('close', 'x', x1 - 0.018);
      btn('ask', 'message-square', x1 - 0.062);
      const bodyTop = top - 0.058, bodyH = PV_H - 2 * PV_PAD - 0.058;
      if (p?.type === 'text') {
        pv.lines = (p.text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
        const lang = languageFor(name);
        pv.spans = highlight(pv.lines.join('\n'), lang);
        pv.lang = lang?.id ?? '';
        pv.nums = makeText(ctx, '', { size: CODE, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: CODE_LH });
        pv.nums.position.set(x0 + 0.026, bodyTop, 0.003);
        pv.body = makeText(ctx, '', { size: CODE, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: CODE_LH });
        pv.body.position.set(x0 + 0.034, bodyTop, 0.003);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(PV_W - PV_PAD, bodyH, 0.01);
        hit.position.set(0, bodyTop - bodyH / 2, 0.004);
        hit.name = 'pv:text';
        ctx.interactive(hit);
        g.add(pv.nums, pv.body, hit);
        renderPreviewText();
      } else if (p?.type === 'image' && p.src && typeof document !== 'undefined') {
        const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        img.raycast = () => {};
        img.visible = false;
        img.position.set(0, bodyTop - bodyH / 2, 0.002);
        g.add(img);
        const owner = pv;
        const tex = new T.TextureLoader().load(p.src, (t) => {
          if (disposed || pv !== owner || owner.tex !== t) return;
          t.colorSpace = T.SRGBColorSpace;
          const im = t.image as { width: number; height: number };
          const a = im.width / Math.max(1, im.height), bw = PV_W - 2 * PV_PAD, bh = bodyH;
          img.scale.set(a > bw / bh ? bw : bh * a, a > bw / bh ? bw / a : bh, 1);
          mat.map = t;
          mat.needsUpdate = true;
          img.visible = true;
        }, undefined, () => { if (!disposed) ctx.error(`fb-tunnel: could not load ${p.src}`); });
        pv.tex = tex;
      } else {
        const msg = !p ? 'Loading…' : p.type === 'binary' ? 'Binary file: no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
        const t = makeText(ctx, msg, { size: 0.015, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: PV_W - 0.08, textAlign: 'center' });
        t.position.set(0, bodyTop - bodyH / 2, 0.003);
        g.add(t);
      }
    }

    function renderPreviewText(): void {
      if (!pv || !pv.body || !pv.nums) return;
      const lines = pv.lines;
      const from = Math.min(Math.max(0, Math.round(pv.scroll)), Math.max(0, lines.length - PV_LINES));
      pv.scroll = Math.min(pv.scroll, Math.max(0, lines.length - PV_LINES));
      const shownLines = lines.slice(from, from + PV_LINES);
      const shown = shownLines.map((l) => (l.length > CODE_COLS ? l.slice(0, CODE_COLS - 1) + '…' : l));
      pv.body.set(shown.join('\n'));
      const clips = shown.map((l, i) => (l.length < shownLines[i].length ? l.length - 1 : l.length));
      setColorRanges(pv.body, pv.lang ? colorRanges(pv.spans.slice(from, from + PV_LINES), shown.map((l) => l.length), syntaxInts, hexToInt(theme.text), clips) : null);
      pv.nums.set(shownLines.map((_, i) => String(from + i + 1)).join('\n'));
    }

    function onPreview(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as Preview).kind !== 'preview') return;
      const p = v as Preview;
      if (!pv || pv.data || typeof p.path !== 'string') return;
      const target = pv.path;
      const ok = p.path === target || (target.startsWith('~') && p.path.endsWith(target.slice(1)));
      if (!ok) return;
      pv.data = p;
      pv.scroll = 0;
      buildPreview();
      dirty = true;
    }

    // ---- rendering -------------------------------------------------------------------------------
    function tilePose(t: Tile, order: number, count: number): number {
      const s = t.slot!;
      let a = s.a + arcShift[s.arc];
      let z = s.z;
      let rm = 1;
      let sc = s.s;
      // page slide
      const P = pg[s.arc];
      if (P.phase === 'out') { a -= P.dir * 0.55 * easeInOut(P.e); sc *= 1 - P.e; }
      else if (P.phase === 'in') { a += P.dir * 0.55 * (1 - easeOut(P.e)); sc *= P.e; }
      // flight
      let e = -1;
      if (tilePhase === 'out') e = clamp01((nav ? nav.p : 1) / 0.45);
      else if (tilePhase === 'in') e = tileE;
      if (e >= 0) {
        const lag = count > 1 ? order / (count - 1) : 0;
        const ei = clamp01(e * 1.4 - 0.4 * lag);
        const k = tilePhase === 'out' ? easeInOut(ei) : 1 - easeOut(ei); // 0 = at rest, 1 = fully away
        const towardViewer = (tilePhase === 'out') === (tileKind === 'enter');
        if (towardViewer) { z += 0.34 * k; rm *= 1 + 0.28 * k; } // rushing past the viewer
        else { z -= 0.5 * k; rm *= 1 - 0.6 * k; } // sinking into the portal
        sc *= 1 - k;
      }
      const r = s.r * rm;
      const [x, y] = slotPosition(s.arc, a, r, z);
      _p.set(x, y, z);
      faceEye(_p, _q);
      const hovered = hoverPart === t.hit.name;
      if (hovered) {
        _p2.subVectors(EYE, _p).normalize().multiplyScalar(0.018);
        _p.add(_p2);
        sc *= 1.06;
      }
      t.g.position.copy(_p);
      t.g.quaternion.copy(_q);
      t.g.scale.setScalar(Math.max(1e-4, sc));
      return sc;
    }

    function renderTiles(): void {
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (!t.entry || !t.slot || tilePhase === 'wait') {
          t.g.visible = false;
          _m.makeScale(0, 0, 0);
          plates.setMatrixAt(i, _m);
          continue;
        }
        const count = t.arc === 0 ? Math.min(cap, dirs.length - page[0] * cap) : Math.min(cap, files.length - page[1] * cap);
        const sc = tilePose(t, t.j, count);
        t.g.visible = sc > 0.01;
        const isDir = t.entry.type === 'dir';
        const d = (isDir ? 2 : 1) * GEO.TILE_D;
        _s.set(GEO.TILE_W * sc, GEO.TILE_H * sc, d * sc);
        _p2.set(0, 0, -d / 2 + GEO.TILE_D).multiplyScalar(sc).applyQuaternion(t.g.quaternion).add(t.g.position);
        _m.compose(_p2, t.g.quaternion, _s);
        plates.setMatrixAt(i, _m);
        const open = !!pv && !pv.closing && pv.base === t.entry.name && pv.dir === wallDir;
        _c.copy(hoverPart === t.hit.name ? COLORS.hover : open ? COLORS.open : isDir ? COLORS.dir : COLORS.file);
        plates.setColorAt(i, _c);
      }
      plates.commit(tiles.length);
    }

    function renderRings(): void {
      const p = nav ? easeInOut(nav.p) : 1;
      for (const v of ringVis) {
        const u = v.plan;
        if (!u) continue;
        const d = nav ? u.from + (u.to - u.from) * p : u.to;
        const alpha = ringAlpha(d);
        const z = ringZ(d);
        const r = coneRadius(z);
        v.g.visible = alpha > 0.01;
        v.g.position.set(0, 0, z);
        v.g.scale.setScalar(r);
        v.mat.opacity = 0.18 + 0.5 * alpha;
        const tagOn = d > 0.5 && d < MAX_TAGS + 0.6 && alpha > 0.05;
        v.tag.visible = tagOn;
        if (tagOn) {
          v.tag.position.set(v.side * r, 0, z);
          faceEye(v.tag.position, v.tag.quaternion);
          v.tag.scale.setScalar(clamp01(Math.min(alpha * 1.5, (d - 0.5) * 3)));
          const isParent = Math.round(u.to) === 1 && (!nav || nav.committed || nav.p < 0.05);
          setIcon(T, v.icon, isParent ? 'corner-left-up' : 'folder');
          v.plateMat.color.set(hoverPart === v.plate.name ? COLORS.hover : COLORS.file);
        }
      }
    }

    function renderPortal(): void {
      // pose
      if (nav && nav.committed) {
        const k = easeInOut(nav.p);
        if (nav.fromTile) {
          _p.copy(nav.fromTile.pos).lerp(PORTAL_HOME, k);
          portal.quaternion.copy(nav.fromTile.quat).slerp(ID_Q, k);
          portal.scale.setScalar(nav.fromTile.scale + (1 - nav.fromTile.scale) * k);
        } else {
          const d = nav.toFrom * (1 - k);
          _p.set(0, 0, ringZ(d));
          portal.quaternion.identity();
          portal.scale.setScalar((coneRadius(ringZ(d)) / GEO.R_FAR) * (d < 0 ? clamp01(1 + d) : 1));
        }
        portal.position.copy(_p);
      } else if (nav) {
        const d = nav.fromTo * easeInOut(nav.p);
        portal.position.set(0, 0, ringZ(d));
        portal.quaternion.identity();
        portal.scale.setScalar((coneRadius(ringZ(d)) / GEO.R_FAR) * (d < 0 ? clamp01(1 + d) : 1));
      } else {
        portal.position.copy(PORTAL_HOME);
        portal.quaternion.identity();
        portal.scale.setScalar(1);
      }
      for (const id of Object.keys(buttons)) buttons[id].mat.color.set(hoverPart === `btn:${id}` ? COLORS.hover : COLORS.file);
      for (const arc of [0, 1] as const) pagers[arc].mat.color.set(hoverPart === `pager:${arc}` ? COLORS.hover : COLORS.file);
      if (!statusDirty) return;
      statusDirty = false;
      // status line: hovered entry > error > loading > counts
      let line = '';
      const ht = hoverPart.startsWith('tile:') ? tiles[Number(hoverPart.slice(5))]?.entry : null;
      if (ht) {
        const bits = [ht.type === 'file' && ht.size != null ? formatBytes(ht.size) : ht.type === 'dir' ? 'folder' : '', age(ht.mtime)].filter(Boolean).join(' · ');
        line = `${truncate(ht.name, 34)}\n${bits}`;
      } else if (error) line = error;
      else if (want || tilePhase === 'wait') line = 'loading…';
      else if (listing) {
        const nd = dirs.length, nf = files.length;
        line = nd + nf === 0 ? 'Empty folder' : `${nd} folder${nd === 1 ? '' : 's'} · ${nf} file${nf === 1 ? '' : 's'}${listing.truncated ? ' +' : ''}\nlevel ${curLevels.length - 1}`;
      }
      sub.set(line);
      setIcon(T, buttons.hidden.icon, ctx.props.showHidden ? 'eye' : 'eye-off');
      buttons.up.disc.visible = buttons.up.icon.visible = hasParent;
    }

    function renderPreviewPose(): void {
      if (!pv) return;
      const k = easeInOut(pv.e);
      pv.g.position.copy(pv.from.pos).lerp(PV_HOME, k);
      pv.g.quaternion.copy(pv.from.quat).slerp(ID_Q, k);
      pv.g.scale.setScalar(Math.max(1e-3, pv.from.scale + (1 - pv.from.scale) * k));
    }

    function render(): void {
      renderRings();
      renderPortal();
      renderTiles();
      renderPreviewPose();
    }

    // ---- per-frame animation -----------------------------------------------------------------------
    function step(dt: number): boolean {
      let active = false;
      if (nav) {
        if (nav.committed) {
          nav.p = Math.min(1, nav.p + dt / NAV_DUR);
          if (tilePhase === 'out' && nav.p >= 0.5) swapIn();
          if (nav.p >= 1) {
            nav = null;
            assignRings(staticPlan());
          }
          active = true;
        } else if (nav.dir < 0) {
          nav.p = Math.max(0, nav.p - dt / (NAV_DUR * 0.6));
          if (nav.p <= 0) { nav = null; tilePhase = 'idle'; assignRings(staticPlan()); }
          active = true;
        }
      }
      if (tilePhase === 'in') {
        tileE = Math.min(1, tileE + dt / TILE_IN_DUR);
        if (tileE >= 1) tilePhase = 'idle';
        active = true;
      }
      for (const arc of [0, 1] as const) {
        const P = pg[arc];
        if (P.phase === 'out') {
          P.e = Math.min(1, P.e + dt / PAGE_HALF);
          if (P.e >= 1) {
            const pages = pageCount(arc === 0 ? dirs.length : files.length, cap);
            page[arc] = (page[arc] + P.dir + pages) % pages;
            fillArc(arc);
            P.phase = 'in';
            P.e = 0;
          }
          active = true;
        } else if (P.phase === 'in') {
          P.e = Math.min(1, P.e + dt / PAGE_HALF);
          if (P.e >= 1) P.phase = 'idle';
          active = true;
        }
        if (arcShift[arc] !== 0 && !(press && press.mode === 'arc' && press.arc === arc)) {
          arcShift[arc] *= Math.exp(-dt * 16);
          if (Math.abs(arcShift[arc]) < 1e-3) arcShift[arc] = 0;
          active = true;
        }
      }
      if (pv) {
        if (pv.closing) {
          pv.e = Math.max(0, pv.e - dt / PV_DUR);
          if (pv.e <= 0) disposePv();
          active = true;
        } else if (pv.e < 1) {
          pv.e = Math.min(1, pv.e + dt / PV_DUR);
          active = true;
        }
      }
      return active;
    }

    // ---- interaction ---------------------------------------------------------------------------------
    function tileOf(part: string): Tile | null {
      if (!part.startsWith('tile:')) return null;
      const t = tiles[Number(part.slice(5))];
      return t && t.entry && t.g.visible ? t : null;
    }

    function folderPathOf(t: Tile): string {
      return joinPath(listing?.display || current, t.entry!.name);
    }

    function tap(part: string): void {
      const t = tileOf(part);
      if (t) {
        const full = folderPathOf(t);
        if (t.entry!.type === 'dir') { navigate(full, { tile: t }); return; }
        ctx.emit('selected', full);
        if (pv && !pv.closing && pv.path === full) closePreview();
        else openPreview(full, t);
        return;
      }
      if (part.startsWith('ring:')) {
        const v = ringVis[Number(part.slice(5))];
        if (v?.plan && v.tag.visible) navigate(v.plan.path);
      } else if (part === 'btn:up') navigate(parentOf(current) ?? current);
      else if (part === 'btn:home') navigate('~');
      else if (part === 'btn:hidden') {
        if (!ctx.isMirror) ctx.setProps({ showHidden: !ctx.props.showHidden });
        else ctx.props.showHidden = !ctx.props.showHidden;
        cache.clear();
        want = current;
        request('list', current);
      } else if (part.startsWith('pager:')) pageArc(Number(part.slice(6)) as 0 | 1, 1);
      else if (part === 'portal') {
        if (pv && !pv.closing) closePreview();
        else { want = current; request('list', current); }
      } else if (part === 'pv:close') closePreview();
      else if (part === 'pv:ask' && pv) ctx.askAgent(`Take a look at this file and tell me about it: ${pv.path}`);
      dirty = true;
    }

    function pageArc(arc: 0 | 1, dir: 1 | -1, fromShift = 0): void {
      const pages = pageCount(arc === 0 ? dirs.length : files.length, cap);
      if (pages <= 1 || pg[arc].phase !== 'idle' || tilePhase !== 'idle') return;
      pg[arc].phase = 'out';
      pg[arc].dir = dir;
      pg[arc].e = clamp01(Math.abs(fromShift) / 0.55);
      arcShift[arc] = 0;
      hoverPart = '';
      dirty = true;
    }

    const handVec = (e: InteractionEvent, out: THREE.Vector3) => {
      const pp = e.pointer?.position ?? e.point ?? e.localPoint;
      return out.set(pp[0], pp[1], pp[2]);
    };
    const _h = new T.Vector3();

    function onPress(e: InteractionEvent): void {
      const part = e.objectName ?? '';
      const lp = e.localPoint;
      if (e.phase === 'start') {
        if (press) return;
        const hand0 = handVec(e, new T.Vector3());
        const head = ctx.user?.head?.position;
        const toHead = new T.Vector3();
        if (head) toHead.set(head[0] - hand0.x, head[1] - hand0.y, head[2] - hand0.z);
        if (toHead.lengthSq() < 1e-6) toHead.set(0, 0, 1); else toHead.normalize();
        const t = tileOf(part);
        press = { hand: e.hand, part, lp0: [lp[0], lp[1], lp[2]], hand0, toHead, mode: '', depth: 0, dx: 0, scroll0: pv?.scroll ?? 0, arc: t ? t.arc : 0 };
        return;
      }
      if (!press || e.hand !== press.hand) return;
      const pr = press;
      if (e.phase === 'move') {
        handVec(e, _h).sub(pr.hand0);
        const depth = _h.dot(pr.toHead); // + = toward the viewer
        const lateral = Math.sqrt(Math.max(0, _h.lengthSq() - depth * depth));
        const dx = lp[0] - pr.lp0[0], dy = lp[1] - pr.lp0[1];
        if (!pr.mode) {
          const planar = Math.max(lateral, Math.hypot(dx, dy) * 0.5);
          if (Math.abs(depth) < TAP && planar < TAP) return;
          if (pr.part === 'pv:text') pr.mode = 'scroll';
          else if (pr.part.startsWith('pv:') || pr.part.startsWith('btn:') || pr.part.startsWith('pager:')) pr.mode = 'none';
          else if (Math.abs(depth) >= planar * 0.9) pr.mode = 'depth';
          else pr.mode = tileOf(pr.part) ? 'arc' : 'none';
        }
        if (pr.mode === 'depth') {
          pr.depth = depth;
          const o = clamp01(Math.abs(depth) / PULL) * PREVIEW_P;
          const t = tileOf(pr.part);
          if (depth > 0) scrub(parentOf(current), o);
          else if (t && t.entry!.type === 'dir') scrub(folderPathOf(t), o);
          else if (nav && !nav.committed) nav.dir = -1;
        } else if (pr.mode === 'arc') {
          pr.dx = dx;
          arcShift[pr.arc] = clamp(dx / rows[0].r, -0.5, 0.5);
          dirty = true;
        } else if (pr.mode === 'scroll' && pv) {
          pv.scroll = Math.max(0, pr.scroll0 + dy / (CODE * CODE_LH));
          renderPreviewText();
        }
        return;
      }
      // end / cancel
      press = null;
      const done = e.phase === 'end';
      if (pr.mode === 'depth') {
        if (nav && !nav.committed) {
          if (done && Math.abs(pr.depth) >= PULL) {
            const t = tileOf(pr.part);
            navigate(nav.to, { scrub: nav, tile: pr.depth < 0 && t ? t : undefined });
          } else nav.dir = -1;
        }
      } else if (pr.mode === 'arc') {
        if (done && Math.abs(pr.dx) >= PAGE_DIST) pageArc(pr.arc, pr.dx < 0 ? 1 : -1, arcShift[pr.arc]);
      } else if (!pr.mode && done) tap(pr.part);
      dirty = true;
    }

    function onHover(e: InteractionEvent): void {
      const part = e.objectName ?? '';
      if (e.phase === 'end') { if (hoverPart === part || !part) hoverPart = ''; }
      else if (part !== hoverPart) hoverPart = part;
      else return;
      statusDirty = true;
      dirty = true;
    }

    // ---- lifecycle ----------------------------------------------------------------------------------
    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(listCh(), onList));
      offs.push(ctx.channels.subscribe(previewCh(), onPreview));
    }

    setCurrent(normPath(String(ctx.props.path || '~')));
    want = current;
    assignRings(staticPlan());
    subscribe();
    request('list', current);
    ctx.emit('path', current);
    if (ctx.props.file) openPreview(normPath(String(ctx.props.file)), null);
    render();

    return {
      onProps(p, prev) {
        if (p.prefix !== prev.prefix) { subscribe(); want = current; request('list', current); }
        else if (p.showHidden !== prev.showHidden) { cache.clear(); want = current; request('list', current); }
        const np = normPath(String(p.path || '~'));
        if (p.path !== prev.path && np !== current && np !== want) navigate(np);
        const nf = String(p.file || '');
        if (p.file !== prev.file && nf !== (pv && !pv.closing ? pv.path : '')) {
          if (nf) openPreview(normPath(nf), null);
          else closePreview();
        }
        dirty = true;
      },
      onInput(port, v) {
        if (typeof v !== 'string' || !v.trim()) return;
        if (port === 'path') navigate(v.trim());
        else if (port === 'preview') openPreview(normPath(v.trim()), null);
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') onHover(e);
        else if (e.handler === 'drag' || e.handler === 'press') onPress(e);
      },
      update(dt) {
        const d = Math.min(0.1, Number.isFinite(dt) ? dt : 0.016);
        const active = step(d);
        if (!active && !dirty) return;
        dirty = false;
        render();
      },
      dispose() {
        disposed = true;
        for (const o of offs.splice(0)) o();
        pv?.tex?.dispose();
        disposeTree(group);
      },
    };
  },
};

export default definition;
