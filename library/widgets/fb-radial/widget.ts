// fb-radial — "Files · Radial": a marking-menu file browser built for muscle memory.
//
// The current folder's entries sit as wedges on a ring around a central hub, always in the same
// order (folders first, then files, A→Z — the source's order), slot 0 at 12 o'clock, clockwise.
// Up to 8 entries use the 8 compass directions; bigger folders use `slots` (default 12) per page,
// so an entry keeps its direction as long as the folder doesn't change.
//
//   tap a wedge (or its label)       folder → the ring re-forms for it (zooms out of the hub);
//                                    file   → preview card beside the ring (syntax-highlighted text / image)
//   tap the hub                      up one folder (the folder you came from is highlighted)
//   pinch the hub, flick, release    marking-menu gesture: opens the wedge in the flick direction —
//                                    chain flicks (hub→NE, hub→S, …) to walk a path without reading
//   pinch a wedge and turn the rim   next / previous page (clockwise = next); ‹ › buttons do the same
//   top row                          home · recent files (ring of the most recently modified files
//                                    under this folder) · show hidden · breadcrumb trail (tap to jump)
//
// Data: the `files` source. Requests go to files.request with reply channels
// files.fb-radial.<entityId>.{list,preview,recent}. The current folder persists in the `path` prop.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  slots: number;
}

export interface Item { name: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string; full: string; display?: string }
interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Array<Omit<Item, 'full'>>; truncated: boolean; error?: string }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }
interface SearchResult { kind: 'search'; path: string; results: Array<{ name: string; path: string; display?: string; type: 'dir' | 'file'; size: number | null; mtime: number | null; ext: string }>; error?: string }

// ---- geometry (meters) ------------------------------------------------------------------------
const W = 0.68;
const H = 0.55;
const PAD = 0.016;
const RC = -0.004;          // ring center (y)
const R_HUB = 0.062;
const R_IN = 0.074;
const R_OUT = 0.172;
const R_LABEL = 0.184;
const LABEL = 0.0125;       // label em height
const GAP = 0.025;          // half the angular gap between wedges (rad)
const MOVE = 0.012;         // tap vs drag threshold
const PAGE_TURN = 0.38;     // rim rotation (rad) that turns a page
const TOP_Y = H / 2 - PAD - 0.017;
const BOT_Y = -H / 2 + PAD + 0.017;
const BTN = 0.032;
const PREVIEW_W = 0.52;
const CODE = 0.011;
const MAX_CRUMBS = 4;

const ICONS: Array<[RegExp, string, string]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic)$/, 'file-image', '#7ee787'],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, 'film', '#d2a8ff'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, 'music', '#ff9bce'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, 'file-archive', '#e3b341'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml|lock)$/, 'braces', '#79c0ff'],
  [/^(csv|tsv|xlsx?|ods|parquet)$/, 'file-spreadsheet', '#7ee787'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, 'file-terminal', '#a5d6ff'],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|cu|swift|dart|r|jl|sql|html|css)$/, 'file-code', '#79c0ff'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex)$/, 'file-text', '#c9d1d9'],
  [/^(pem|key|crt|cer|p12|pfx)$/, 'file-key', '#ffa198'],
];
const FOLDER = '#e3b341';

/** Lucide icon + color for an entry. */
export function iconFor(e: Pick<Item, 'type' | 'ext'>): [string, string] {
  if (e.type === 'dir') return ['folder', FOLDER];
  for (const [re, icon, color] of ICONS) if (re.test(e.ext)) return [icon, color];
  return ['file', '#8b949e'];
}

/** Slots on the ring for n entries: the 8 compass directions when they fit, else `max` per page. */
export function slotCount(n: number, max: number): number {
  const m = Math.max(8, Math.min(16, Math.round(max) || 12));
  return n <= 8 ? 8 : m;
}

/** Angle of (x, y) clockwise from 12 o'clock, in [0, 2π). */
export function clockAngle(x: number, y: number): number {
  const a = Math.atan2(x, y);
  return a < 0 ? a + Math.PI * 2 : a;
}

/** Slot under direction (x, y) from the ring center (slot 0 at 12 o'clock, clockwise). */
export function slotAt(x: number, y: number, slots: number): number {
  return Math.round(clockAngle(x, y) / ((Math.PI * 2) / slots)) % slots;
}

/** Wrap an angle difference into (−π, π]. */
function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Breadcrumbs of a display path: "~/a/b" → ~, ~/a, ~/a/b; "/usr/lib" → /, /usr, /usr/lib. */
export function crumbs(display: string): Array<{ label: string; path: string }> {
  const d = (display || '~').replace(/\/+$/, '') || '/';
  if (d === '/') return [{ label: '/', path: '/' }];
  const out: Array<{ label: string; path: string }> = [];
  let acc = '';
  d.split('/').forEach((p, i) => {
    if (i === 0) {
      acc = p === '' ? '/' : p;
      out.push({ label: acc, path: acc });
      return;
    }
    if (!p) return;
    acc = acc.endsWith('/') ? acc + p : `${acc}/${p}`;
    out.push({ label: p, path: acc });
  });
  return out;
}

/** "5m", "3h", "2d", or a short date for older files. */
export function ageLabel(mtime: number | null, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

interface Slot { wedge: THREE.Mesh; mat: THREE.MeshBasicMaterial; icon: THREE.Mesh; label: Text; hit: THREE.Mesh; sin: number; cos: number; anchor: 'left' | 'right' | 'center'; maxChars: number; base: number; hot: number }
interface Button { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; icon: THREE.Mesh }

const definition: WidgetDefinition<Props> = {
  description:
    "Radial file browser (marking menu, via the 'files' source): the folder's entries are wedges around a hub, folders first, always in the same " +
    'direction. Tap a wedge to open a folder or preview a file (syntax-highlighted text / image card beside the ring); tap the hub to go up, or ' +
    'pinch the hub and flick toward a wedge to open it; turn the rim (or ‹ ›) to page big folders. Top row: home, recent files, hidden files, ' +
    'breadcrumbs. Props: path (persisted), showHidden, slots. Inputs: path, open (entry name / 1-based slot / ".."), page, preview.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    slots: { type: 'integer', default: 12, min: 8, max: 16, description: 'Wedges per page for folders with more than 8 entries.' },
  },
  inputs: {
    path: { type: 'event', description: 'Open this folder (a path string). Event inputs are commands: never replayed on reload.' },
    open: { type: 'event', description: 'Activate an entry of the current ring: its name, a 1-based slot number (clockwise from 12 o\'clock), or ".." for up.' },
    page: { type: 'event', description: '"next", "prev" or a 1-based page number.' },
    preview: { type: 'event', description: 'Preview this file (absolute or ~/ path).' },
  },
  outputs: {
    selected: { type: 'string', description: 'Absolute path of the file last opened for preview.' },
    folder: { type: 'string', description: 'Display path of the folder shown.' },
  },
  interactions: [dragBinding('fb-radial-drag', 'drag')],
  size: [W, H, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const ch = (purpose: string) => `files.fb-radial.${ctx.entityId}.${purpose}`;

    // ---- state ---------------------------------------------------------------------------------
    let listing: Listing | null = null;
    let folderItems: Item[] = [];
    let recentItems: Item[] = [];
    let mode: 'folder' | 'recent' = 'folder';
    let current = String(ctx.props.path || '~');
    let loading = true;
    let recentLoading = false;
    let page = 0;
    let S = 8;
    let focusName = '';          // the folder we came up from (highlighted)
    let selectedPath = '';       // previewed file
    let pendingPreview = '';
    let preview: Preview | null = null;
    let pendingAnim: 'in' | 'out' | 'jump' = 'jump';
    let nonce = 0;
    let lastFolderEmit = '';
    let dirty = true;
    let highlightDirty = true;
    const hoverByHand: Record<string, string> = { left: '', right: '' };
    let hoverPart = '';
    let aim = -1;
    let press: { hand: string; part: string; x0: number; y0: number; a0: number; moved: boolean; scroll0: number } | null = null;
    let dragRot = 0;
    const anim = { on: false, t: 0, dur: 0.24, s0: 1, r0: 0 };
    const offs: Array<() => void> = [];

    const items = (): Item[] => (mode === 'recent' ? recentItems : folderItems);
    const pages = () => Math.max(1, Math.ceil(items().length / S));
    const itemAt = (slot: number): Item | undefined => (slot >= 0 && slot < S ? items()[page * S + slot] : undefined);

    // ---- static card -----------------------------------------------------------------------------
    const card = new T.Group();
    card.add(ctx.ui.panel(W, H));
    ctx.root.add(card);
    const surfaceInt = hexToInt(theme.surface);
    const hoverInt = hexToInt(mixHex(theme.surface, theme.accent, 0.3));
    const activeInt = hexToInt(mixHex(theme.surface, theme.accent, 0.55));

    function button(id: string, icon: string, x: number, y: number, parent: THREE.Object3D, d = BTN): Button {
      const mat = ownMaterial(T, theme.surface);
      const mesh = new T.Mesh(sharedGeometry(T, 'disc'), mat);
      mesh.scale.set(d, d, 1);
      mesh.position.set(x, y, STYLE.zContent);
      mesh.name = `btn:${id}`;
      ctx.interactive(mesh);
      const ic = makeIcon(ctx, icon, { size: d * 0.56, color: theme.text });
      ic.scale.set((d * 0.56) / d, (d * 0.56) / d, 1); // child of a d-scaled disc
      ic.position.z = 0.002;
      mesh.add(ic);
      parent.add(mesh);
      return { mesh, mat, icon: ic };
    }
    const btnX = (k: number) => -W / 2 + PAD + BTN / 2 + k * (BTN + 0.008);
    const buttons: Record<string, Button> = {
      home: button('home', 'house', btnX(0), TOP_Y, card),
      recent: button('recent', 'clock', btnX(1), TOP_Y, card),
      hidden: button('hidden', ctx.props.showHidden ? 'eye' : 'eye-off', btnX(2), TOP_Y, card),
      prev: button('prev', 'chevron-left', -W / 2 + PAD + BTN / 2, BOT_Y, card),
      next: button('next', 'chevron-right', W / 2 - PAD - BTN / 2, BOT_Y, card),
    };

    // breadcrumb trail (pooled)
    const crumbX0 = btnX(2) + BTN / 2 + 0.016;
    const crumbTexts: Text[] = [];
    const crumbHits: THREE.Mesh[] = [];
    const crumbSeps: THREE.Mesh[] = [];
    const crumbHover = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, mixHex(theme.surface, theme.accent, 0.25)));
    crumbHover.raycast = () => {};
    crumbHover.visible = false;
    card.add(crumbHover);
    let crumbPaths: string[] = [];
    for (let i = 0; i < MAX_CRUMBS + 1; i++) {
      const t = makeText(ctx, '', { size: 0.0125, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      t.position.set(0, TOP_Y, STYLE.zText);
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.name = `crumb:${i}`;
      ctx.interactive(hit);
      const sep = makeIcon(ctx, 'chevron-right', { size: 0.014, color: theme.textDim });
      card.add(t, hit, sep);
      crumbTexts.push(t);
      crumbHits.push(hit);
      crumbSeps.push(sep);
    }
    const crumbWatch = new MeasureWatch(crumbTexts);

    // hub
    const hub = new T.Group();
    hub.position.set(0, RC, 0);
    const hubMat = ownMaterial(T, theme.surface);
    const hubDisc = new T.Mesh(sharedGeometry(T, 'disc'), hubMat);
    hubDisc.scale.set(R_HUB * 2, R_HUB * 2, 1);
    hubDisc.position.z = STYLE.zContent;
    hubDisc.name = 'hub';
    ctx.interactive(hubDisc);
    const hubRing = new T.Mesh(new T.RingGeometry(R_HUB - 0.0025, R_HUB, 64), ownMaterial(T, theme.border));
    hubRing.position.z = STYLE.zOverlay;
    hubRing.raycast = () => {};
    const hubIcon = makeIcon(ctx, 'corner-left-up', { size: 0.024, color: theme.text });
    hubIcon.position.set(0, 0.029, STYLE.zText);
    const hubName = makeText(ctx, '', { size: 0.0135, anchorX: 'center', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
    hubName.position.set(0, 0.002, STYLE.zText);
    const hubSub = makeText(ctx, '', { size: 0.011, anchorX: 'center', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
    hubSub.position.set(0, -0.024, STYLE.zText);
    hub.add(hubDisc, hubRing, hubIcon, hubName, hubSub);
    card.add(hub);

    // info line (hover details / hints / errors)
    const info = makeText(ctx, '', { size: 0.011, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: W - 2 * PAD - 2 * BTN - 0.03, textAlign: 'center' });
    info.position.set(0, BOT_Y, STYLE.zText);
    card.add(info);

    // ---- ring (rebuilt when the slot count changes) ----------------------------------------------
    let ring: THREE.Group | null = null;
    const slots: Slot[] = [];

    function buildRing(n: number): void {
      if (ring) disposeTree(ring);
      slots.length = 0;
      S = n;
      ring = new T.Group();
      ring.position.set(0, RC, 0);
      const step = (Math.PI * 2) / S;
      const rMid = (R_IN + R_OUT) / 2;
      for (let i = 0; i < S; i++) {
        const theta = i * step;                       // clockwise from 12 o'clock
        const phi = Math.PI / 2 - theta;              // three.js angle (CCW from +X)
        const sin = Math.sin(theta), cos = Math.cos(theta);
        const mat = ownMaterial(T, theme.surface, { doubleSide: true });
        const wedge = new T.Mesh(new T.RingGeometry(R_IN, R_OUT, 12, 1, phi - step / 2 + GAP, step - 2 * GAP), mat);
        wedge.position.z = STYLE.zContent;
        wedge.name = `w:${i}`;
        const icon = makeIcon(ctx, 'file', { size: 0.032, color: theme.textDim });
        icon.position.set(rMid * sin, rMid * cos, STYLE.zText);
        const anchor: Slot['anchor'] = sin > 0.25 ? 'left' : sin < -0.25 ? 'right' : 'center';
        const label = makeText(ctx, '', {
          size: LABEL, color: theme.text, whiteSpace: 'nowrap', anchorX: anchor,
          anchorY: anchor !== 'center' ? 'middle' : cos > 0 ? 'bottom' : 'top',
        });
        label.position.set(R_LABEL * sin, R_LABEL * cos, STYLE.zText);
        const room = anchor === 'center' ? 0.13 : W / 2 - PAD - Math.abs(R_LABEL * sin) - 0.004;
        const maxChars = Math.max(6, Math.floor(room / (LABEL * 0.56)));
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.name = `w:${i}`;
        ring.add(wedge, icon, label, hit);
        ctx.interactive(wedge);
        ctx.interactive(hit);
        slots.push({ wedge, mat, icon, label, hit, sin, cos, anchor, maxChars, base: surfaceInt, hot: hoverInt });
      }
      card.add(ring);
    }

    // ---- render (content changes) ----------------------------------------------------------------

    function render(): void {
      const list = items();
      const want = slotCount(mode === 'recent' ? Math.max(9, list.length) : list.length, ctx.props.slots);
      if (want !== S || !ring) buildRing(want);
      page = Math.min(page, pages() - 1);
      const empty = hexToInt(mixHex(theme.background, theme.surface, 0.45));
      for (let i = 0; i < S; i++) {
        const s = slots[i], it = itemAt(i);
        s.icon.visible = s.label.visible = !!it;
        s.hit.visible = !!it;
        if (!it) {
          s.base = s.hot = empty;
          s.label.set('');
          continue;
        }
        const [icon, color] = iconFor(it);
        setIcon(T, s.icon, icon);
        (s.icon.material as THREE.MeshBasicMaterial).color.set(color);
        s.base = hexToInt(mixHex(theme.surface, color, it.type === 'dir' ? 0.2 : 0.1));
        s.hot = hexToInt(mixHex(theme.surface, color, 0.42));
        const text = truncate(it.name, s.maxChars);
        s.label.set(text);
        // label hit box (estimated width), so pointing at the name works like pointing at the wedge
        const w = Math.max(0.03, text.length * LABEL * 0.56);
        s.hit.scale.set(w + 0.01, 0.028, 0.006);
        const lx = R_LABEL * s.sin, ly = R_LABEL * s.cos;
        s.hit.position.set(s.anchor === 'left' ? lx + w / 2 : s.anchor === 'right' ? lx - w / 2 : lx,
          s.anchor !== 'center' ? ly : s.cos > 0 ? ly + 0.009 : ly - 0.009, STYLE.zContent);
      }
      // hub
      const cr = crumbs(listing?.display ?? current);
      const here = cr[cr.length - 1]?.label ?? current;
      setIcon(T, hubIcon, mode === 'recent' ? 'folder-open' : listing && !listing.parent ? 'hard-drive' : 'corner-left-up');
      const n = list.length;
      const busy = mode === 'recent' ? recentLoading : loading;
      hubSub.set(busy ? 'loading…' : pages() > 1 ? `${page + 1} / ${pages()}  ·  ${pageRange()}` : mode === 'folder' && listing?.error ? 'error' : n ? `${n} item${n === 1 ? '' : 's'}` : 'empty');
      // pager
      buttons.prev.mesh.visible = buttons.next.mesh.visible = pages() > 1;
      setIcon(T, buttons.hidden.icon, ctx.props.showHidden ? 'eye' : 'eye-off');
      layoutCrumbs(cr);
      hubLabel(mode === 'recent' ? 'Recent' : here);
      highlightDirty = true;
    }

    /** Initial letters covered by this page ("a–c"), so a big folder's pages read like an index. */
    function pageRange(): string {
      const list = items();
      const a = list[page * S]?.name ?? '', b = list[Math.min(list.length, (page + 1) * S) - 1]?.name ?? '';
      const ia = (a.replace(/^[._-]+/, '')[0] ?? '?').toLowerCase(), ib = (b.replace(/^[._-]+/, '')[0] ?? '?').toLowerCase();
      return ia === ib ? ia : `${ia}–${ib}`;
    }

    let hubBase = '';
    function hubLabel(s: string): void {
      hubBase = s;
      hubName.set(truncate(s, 13));
    }

    let crumbKey = '';
    function layoutCrumbs(cr: Array<{ label: string; path: string }>, force = false): void {
      const shown = cr.length > MAX_CRUMBS ? [{ label: '…', path: cr[cr.length - MAX_CRUMBS - 1].path }, ...cr.slice(-MAX_CRUMBS)] : cr;
      const key = shown.map((c) => c.path).join('|');
      if (key === crumbKey && !force) return;
      crumbKey = key;
      crumbPaths = shown.map((c) => c.path);
      const xMax = W / 2 - PAD;
      let x = crumbX0;
      for (let i = 0; i < crumbTexts.length; i++) {
        const t = crumbTexts[i], hit = crumbHits[i], sep = crumbSeps[i];
        const c = shown[i];
        t.visible = hit.visible = !!c;
        sep.visible = !!c && i < shown.length - 1;
        if (!c) continue;
        const last = i === shown.length - 1;
        const label = truncate(c.label, last ? 26 : 13);
        t.set(label);
        (t as unknown as { color: unknown }).color = last ? theme.text : theme.textDim;
        const w = Math.min(xMax - x, textSize(t, { text: label, size: 0.0125 }).width);
        t.position.x = x;
        hit.scale.set(w + 0.012, 0.032, 0.006);
        hit.position.set(x + w / 2, TOP_Y, STYLE.zContent);
        sep.position.set(x + w + 0.011, TOP_Y, STYLE.zText);
        x += w + 0.022;
      }
      highlightDirty = true;
    }

    // ---- highlight state (hover / aim / selection): colors only, no allocation ----------------

    function applyHighlights(): void {
      const hs = hoverPart.startsWith('w:') ? Number(hoverPart.slice(2)) : -1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i], it = itemAt(i);
        const sel = !!it && ((selectedPath !== '' && it.full === selectedPath) || (focusName !== '' && mode === 'folder' && it.name === focusName && it.type === 'dir'));
        const isAim = i === aim;
        const hot = !!it && (i === hs || isAim);
        s.mat.color.setHex(isAim ? activeInt : hot ? s.hot : sel ? hoverInt : s.base);
        const k = hot ? 1.045 : 1;
        s.wedge.scale.set(k, k, 1);
        (s.label as unknown as { color: unknown }).color = sel || isAim ? theme.accent : theme.text;
      }
      hubMat.color.setHex(press?.part === 'hub' ? activeInt : hoverPart === 'hub' ? hoverInt : surfaceInt);
      for (const [id, b] of Object.entries(buttons)) {
        const on = id === 'recent' ? mode === 'recent' : id === 'hidden' ? !!ctx.props.showHidden : false;
        b.mat.color.setHex(hoverPart === `btn:${id}` ? hoverInt : on ? hexToInt(mixHex(theme.surface, theme.accent, 0.4)) : surfaceInt);
      }
      if (previewButtons) for (const [id, b] of Object.entries(previewButtons)) b.mat.color.setHex(hoverPart === `btn:${id}` ? hoverInt : surfaceInt);
      const ci = hoverPart.startsWith('crumb:') ? Number(hoverPart.slice(6)) : -1;
      crumbHover.visible = ci >= 0 && crumbHits[ci]?.visible === true;
      if (crumbHover.visible) {
        const h = crumbHits[ci];
        crumbHover.position.set(h.position.x, TOP_Y, STYLE.zContent);
        crumbHover.scale.set(h.scale.x, 0.03, 1);
      }
      // hub label: the flick target while aiming
      const a = itemAt(aim);
      hubName.set(a ? truncate(a.name, 13) : truncate(hubBase, 13));
      info.set(infoText(hs));
    }

    function infoText(hs: number): string {
      const a = itemAt(aim);
      if (a) return `Release to open ${a.name}${a.type === 'dir' ? '/' : ''}`;
      const it = itemAt(hs);
      if (it) {
        const parts = [it.type === 'dir' ? `${it.name}/` : it.name];
        if (mode === 'recent' && it.display) parts[0] = it.display;
        if (it.type === 'file' && it.size != null) parts.push(formatBytes(it.size));
        if (it.mtime) parts.push(ageLabel(it.mtime));
        return parts.join('  ·  ');
      }
      if (hoverPart === 'hub') return mode === 'recent' ? 'Back to the folder' : listing?.parent ? `Up to ${baseName(listing.parent) || '/'}  ·  or pinch here and flick toward a wedge` : 'Top of the file system';
      if (hoverPart.startsWith('crumb:')) return `Jump to ${crumbPaths[Number(hoverPart.slice(6))] ?? ''}`;
      if (hoverPart === 'btn:home') return 'Home folder';
      if (hoverPart === 'btn:recent') return mode === 'recent' ? 'Back to the folder' : 'Recently modified files in this folder';
      if (hoverPart === 'btn:hidden') return ctx.props.showHidden ? 'Hide dot files' : 'Show dot files';
      if (hoverPart === 'btn:prev' || hoverPart === 'btn:next') return `Page ${page + 1} of ${pages()}  ·  or pinch a wedge and turn the rim`;
      if (hoverPart === 'btn:close') return 'Close the preview';
      if (hoverPart === 'btn:ask') return 'Ask Claude about this file';
      if (mode === 'folder' && listing?.error) return listing.error;
      if (mode === 'folder' && !listing && !loading) return "Start the 'files' source";
      if (!items().length) return (mode === 'recent' ? recentLoading : loading) ? 'Loading…' : mode === 'recent' ? 'No recent files here' : 'Empty folder';
      return pages() > 1 ? 'Pinch a wedge to open  ·  turn the rim for more  ·  hub = up' : 'Pinch a wedge to open  ·  hub = up, or pinch it and flick';
    }

    // ---- navigation --------------------------------------------------------------------------------

    function request(cmd: string, path: string, purpose: string, extra: Record<string, unknown> = {}): void {
      ctx.channels.publish('files.request', { cmd, path, hidden: !!ctx.props.showHidden, reply: ch(purpose), nonce: ++nonce, ...extra } as never);
    }

    function open(p: string, how: 'in' | 'out' | 'jump'): void {
      current = p;
      loading = true;
      pendingAnim = how;
      if (how !== 'out') focusName = '';
      if (mode === 'recent') mode = 'folder';
      request('list', p, 'list');
      dirty = true;
    }

    function goUp(): void {
      if (mode === 'recent') { mode = 'folder'; page = pageOfFocus(); startAnim(1.3, 0); dirty = true; return; }
      if (!listing?.parent) return;
      const from = baseName(listing.path);
      open(listing.parent, 'out');
      focusName = from;
    }

    function showRecent(): void {
      if (mode === 'recent') { goUp(); return; }
      mode = 'recent';
      recentLoading = true;
      recentItems = [];
      page = 0;
      request('search', listing?.path ?? current, 'recent', { query: '', limit: 32 });
      startAnim(0.6, 0);
      dirty = true;
    }

    function showPreview(path: string): void {
      selectedPath = path;
      pendingPreview = path;
      ctx.emit('selected', path);
      request('preview', path, 'preview');
      highlightDirty = true;
    }

    function activate(slot: number): void {
      const it = itemAt(slot);
      if (!it) return;
      if (it.type === 'dir') open(it.full, 'in');
      else showPreview(it.full);
    }

    function turnPage(dir: number): void {
      if (pages() <= 1) { startAnim(1, -dragRot); return; }
      page = (page + dir + pages()) % pages();
      dirty = true;
      startAnim(0.96, dir * 0.5);
    }

    function pageOfFocus(): number {
      if (!focusName) return 0;
      const i = folderItems.findIndex((it) => it.name === focusName);
      return i < 0 ? 0 : Math.floor(i / slotCount(folderItems.length, ctx.props.slots));
    }

    function startAnim(s0: number, r0: number): void {
      anim.on = true;
      anim.t = 0;
      anim.s0 = s0;
      anim.r0 = r0;
      if (ring) { ring.scale.set(s0, s0, 1); ring.rotation.z = r0; }
    }

    // ---- preview card ------------------------------------------------------------------------------

    let previewGroup: THREE.Group | null = null;
    let previewButtons: Record<string, Button> | null = null;
    let previewKey = '';
    let previewBody: Text | null = null, previewNums: Text | null = null;
    let imageTex: THREE.Texture | null = null;
    let textScroll = 0;
    let hlLines: string[] = [];
    let hlSpans: Span[][] = [];
    let hlLang = '';
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
    const previewLines = () => Math.max(5, Math.floor((H - 2 * PAD - 0.07) / (CODE * 1.25)));

    function renderPreview(): void {
      const key = preview ? `${preview.path}|${preview.type}|${preview.src ?? ''}|${preview.text?.length ?? 0}` : '';
      if (key !== previewKey) {
        previewKey = key;
        if (previewGroup) disposeTree(previewGroup);
        previewGroup = null;
        previewButtons = null;
        previewBody = previewNums = null;
        imageTex?.dispose();
        imageTex = null;
        if (preview) buildPreview(preview);
        if (preview?.type === 'text') {
          const lang = languageFor(preview.name);
          hlLines = (preview.text ?? '').replace(/\t/g, '  ').split('\n');
          hlSpans = highlight(hlLines.join('\n'), lang);
          hlLang = lang?.id ?? '';
        } else { hlLines = []; hlSpans = []; hlLang = ''; }
        highlightDirty = true;
      }
      if (preview?.type === 'text' && previewBody && previewNums) {
        const visible = previewLines();
        const from = Math.min(Math.max(0, Math.round(textScroll)), Math.max(0, hlLines.length - visible));
        textScroll = from;
        const lines = hlLines.slice(from, from + visible);
        const cols = Math.floor((PREVIEW_W - 0.085) / (CODE * 0.6));
        const shown = lines.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
        previewBody.set(shown.join('\n'));
        const clips = shown.map((l, i) => (l.length < lines[i].length ? l.length - 1 : l.length));
        setColorRanges(previewBody, hlLang ? colorRanges(hlSpans.slice(from, from + visible), shown.map((l) => l.length), syntaxInts, hexToInt(theme.text), clips) : null);
        previewNums.set(lines.map((_, i) => String(from + i + 1)).join('\n'));
      }
    }

    function buildPreview(p: Preview): void {
      const g = (previewGroup = new T.Group());
      const w = PREVIEW_W, h = H;
      g.position.set(W / 2 + 0.014 + w / 2, 0, 0);
      g.add(ctx.ui.panel(w, h));
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD, top = h / 2 - PAD;
      const [icon, color] = iconFor({ type: 'file', ext: p.name.includes('.') ? p.name.split('.').pop()!.toLowerCase() : '' });
      const ic = makeIcon(ctx, icon, { size: 0.022, color });
      ic.position.set(x0 + 0.011, top - 0.016, STYLE.zText);
      const title = makeText(ctx, truncate(p.name, 40), { size: 0.0145, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.03, top - 0.01, STYLE.zText);
      const meta = makeText(ctx, [p.size != null ? formatBytes(p.size) : '', p.mtime ? `modified ${ageLabel(p.mtime)}` : '', p.type === 'text' ? `${p.lines} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join('  ·  '),
        { size: 0.011, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.03, top - 0.03, STYLE.zText);
      g.add(ic, title, meta);
      previewButtons = {
        close: button('close', 'x', x1 - BTN / 2, top - BTN / 2 + 0.002, g),
        ask: button('ask', 'message-square', x1 - BTN * 1.5 - 0.008, top - BTN / 2 + 0.002, g),
      };
      const bodyTop = top - 0.056, bodyH = h - 2 * PAD - 0.056;
      if (p.type === 'text') {
        previewNums = makeText(ctx, '', { size: CODE, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: 1.25 });
        previewNums.position.set(x0 + 0.028, bodyTop, STYLE.zText);
        previewBody = makeText(ctx, '', { size: CODE, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: 1.25 });
        previewBody.position.set(x0 + 0.037, bodyTop, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(w - PAD, bodyH, 0.01);
        hit.position.set(0, bodyTop - bodyH / 2, 0.004);
        hit.name = 'preview-text';
        ctx.interactive(hit);
        g.add(previewNums, previewBody, hit);
      } else if (p.type === 'image' && p.src && typeof document !== 'undefined') {
        const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        img.raycast = () => {};
        img.visible = false;
        img.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
        g.add(img);
        imageTex = new T.TextureLoader().load(p.src, (tex) => {
          if (imageTex !== tex) return;
          tex.colorSpace = T.SRGBColorSpace;
          const im = tex.image as { width: number; height: number };
          const a = im.width / im.height, bw = w - 2 * PAD, bh = bodyH;
          const sw = a > bw / bh ? bw : bh * a, sh = a > bw / bh ? bw / a : bh;
          img.scale.set(sw, sh, 1);
          mat.map = tex;
          mat.needsUpdate = true;
          img.visible = true;
        }, undefined, () => ctx.error(`fb-radial: could not load ${p.src}`));
      } else {
        const msg = p.type === 'binary' ? 'Binary file: no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
        const t = makeText(ctx, msg, { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
        t.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
        g.add(t);
      }
      ctx.root.add(g);
    }

    function closePreview(): void {
      preview = null;
      pendingPreview = '';
      selectedPath = '';
      dirty = true;
    }

    // ---- data -----------------------------------------------------------------------------------------

    const isObj = (v: ChannelValue): v is Record<string, unknown> & ChannelValue => !!v && typeof v === 'object' && !isTensor(v) && !Array.isArray(v);

    offs.push(ctx.channels.subscribe(ch('list'), (v: ChannelValue) => {
      if (!isObj(v) || v.kind !== 'list' || !Array.isArray(v.entries)) return;
      const l = v as unknown as Listing;
      // keep the one for the folder we're in (other clients may ask too; the path is the truth)
      if (listing && !loading && l.path !== listing.path) return;
      listing = l;
      loading = false;
      folderItems = l.entries.filter((e) => e && typeof e.name === 'string').map((e) => ({ ...e, full: joinPath(l.path, e.name) }));
      const display = l.display || l.path;
      current = display;
      if (display !== ctx.props.path && !ctx.isMirror) ctx.setProps({ path: display });
      if (display !== lastFolderEmit) { lastFolderEmit = display; ctx.emit('folder', display); }
      if (mode === 'folder') {
        page = pageOfFocus();
        const how = pendingAnim;
        pendingAnim = 'jump';
        startAnim(how === 'in' ? 0.55 : how === 'out' ? 1.3 : 0.85, 0);
      }
      dirty = true;
    }));
    offs.push(ctx.channels.subscribe(ch('recent'), (v: ChannelValue) => {
      if (!isObj(v) || v.kind !== 'search' || !Array.isArray(v.results)) return;
      const r = v as unknown as SearchResult;
      recentLoading = false;
      recentItems = r.results.filter((e) => e && typeof e.path === 'string').map((e) => ({
        name: e.name, type: e.type, size: e.size, mtime: e.mtime, ext: e.ext ?? '', full: e.path, display: e.display,
      }));
      dirty = true;
    }));
    offs.push(ctx.channels.subscribe(ch('preview'), (v: ChannelValue) => {
      if (!isObj(v) || v.kind !== 'preview') return;
      const got = String(v.path ?? '');
      if (!pendingPreview || (got !== pendingPreview && !(pendingPreview.startsWith('~') && got.endsWith(pendingPreview.slice(1))))) return;
      preview = v as unknown as Preview;
      selectedPath = got;
      textScroll = 0;
      dirty = true;
    }));

    function openByName(arg: string): void {
      const s = arg.trim();
      if (!s) return;
      if (s === '..' || s.toLowerCase() === 'up') { goUp(); return; }
      if (/^\d+$/.test(s)) { activate(Number(s) - 1); return; }
      const list = items();
      const lower = s.toLowerCase();
      const i = list.findIndex((it) => it.name === s) >= 0 ? list.findIndex((it) => it.name === s)
        : list.findIndex((it) => it.name.toLowerCase() === lower) >= 0 ? list.findIndex((it) => it.name.toLowerCase() === lower)
          : list.findIndex((it) => it.name.toLowerCase().startsWith(lower));
      if (i < 0) { ctx.error(`fb-radial: no entry "${s}" here`); return; }
      page = Math.floor(i / S);
      const it = list[i];
      if (it.type === 'dir') open(it.full, 'in');
      else { dirty = true; showPreview(it.full); }
    }

    // ---- hover + gestures ------------------------------------------------------------------------------

    function onHover(e: InteractionEvent): void {
      const part = e.phase === 'end' ? '' : e.objectName ?? '';
      if (hoverByHand[e.hand] === part && e.phase === 'move') return;
      hoverByHand[e.hand] = part;
      const next = part || hoverByHand[e.hand === 'left' ? 'right' : 'left'] || '';
      if (next !== hoverPart) { hoverPart = next; highlightDirty = true; }
    }

    function setAim(s: number): void {
      if (s !== aim) { aim = s; highlightDirty = true; }
    }

    render();
    request('list', current, 'list');

    return {
      onProps(p, prev) {
        if (p.showHidden !== prev.showHidden) { if (mode === 'recent') showRecent(); open(listing?.path ?? current, 'jump'); }
        else if (p.path !== prev.path && p.path !== (listing?.display ?? current)) open(String(p.path || '~'), 'jump');
        dirty = true;
      },
      onInput(port, v) {
        const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
        if (port === 'path' && s) open(s, 'jump');
        else if (port === 'preview' && s) showPreview(s);
        else if (port === 'open' && s) openByName(s);
        else if (port === 'page' && s) {
          if (s === 'next' || s === 'prev') turnPage(s === 'next' ? 1 : -1);
          else if (/^\d+$/.test(s)) { page = Math.max(0, Math.min(pages() - 1, Number(s) - 1)); dirty = true; }
        } else if (v != null && v !== '' && (port === 'path' || port === 'preview' || port === 'open' || port === 'page')) ctx.error(`fb-radial: bad ${port} input`);
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') { onHover(e); return; }
        const x = e.localPoint[0], y = e.localPoint[1] - RC;
        if (e.phase === 'start') {
          if (press) return;
          press = { hand: e.hand, part: e.objectName ?? '', x0: x, y0: y, a0: clockAngle(x, y), moved: false, scroll0: textScroll };
          if (press.part === 'hub') highlightDirty = true;
          return;
        }
        if (!press || e.hand !== press.hand) return;
        const p = press;
        if (e.phase === 'move') {
          if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > MOVE) p.moved = true;
          if (p.part === 'hub') {
            // marking menu: past the hub's edge, the direction picks the wedge
            const s = Math.hypot(x, y) > R_IN * 0.9 ? slotAt(x, y, S) : -1;
            setAim(itemAt(s) ? s : -1);
          } else if (p.part.startsWith('w:') && p.moved && ring) {
            const d = wrap(clockAngle(x, y) - p.a0);
            dragRot = pages() > 1 ? Math.max(-1.2, Math.min(1.2, d)) : Math.max(-0.12, Math.min(0.12, d * 0.2));
            anim.on = false;
            ring.rotation.z = -dragRot;
            ring.scale.set(1, 1, 1);
          } else if (p.part === 'preview-text' && p.moved) {
            textScroll = Math.max(0, p.scroll0 + (y - p.y0) / (CODE * 1.25));
            dirty = true;
          }
          return;
        }
        // end / cancel
        press = null;
        const aimed = aim;
        setAim(-1);
        highlightDirty = true;
        const rot = dragRot;
        dragRot = 0;
        if (p.part.startsWith('w:') && p.moved && ring) {
          if (e.phase === 'end' && pages() > 1 && Math.abs(rot) > PAGE_TURN) turnPage(rot > 0 ? 1 : -1);
          else startAnim(1, -rot); // spring back
          return;
        }
        if (e.phase !== 'end') return; // never act on a cancelled press
        if (p.part === 'hub') { if (aimed >= 0) activate(aimed); else if (!p.moved) goUp(); return; }
        if (p.moved) return;
        if (p.part.startsWith('w:')) activate(Number(p.part.slice(2)));
        else if (p.part.startsWith('crumb:')) { const to = crumbPaths[Number(p.part.slice(6))]; if (to && to !== (listing?.display ?? current)) open(to, 'out'); else if (mode === 'recent') goUp(); }
        else if (p.part === 'btn:home') open('~', 'jump');
        else if (p.part === 'btn:recent') showRecent();
        else if (p.part === 'btn:hidden') { if (!ctx.isMirror) ctx.setProps({ showHidden: !ctx.props.showHidden }); if (mode === 'recent') { mode = 'folder'; } open(listing?.path ?? current, 'jump'); }
        else if (p.part === 'btn:prev') turnPage(-1);
        else if (p.part === 'btn:next') turnPage(1);
        else if (p.part === 'btn:close') closePreview();
        else if (p.part === 'btn:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
      },
      update(dt) {
        if (anim.on && ring) {
          anim.t += dt;
          const k = Math.min(1, anim.t / anim.dur), ease = 1 - (1 - k) * (1 - k) * (1 - k);
          const s = anim.s0 + (1 - anim.s0) * ease;
          ring.scale.set(s, s, 1);
          ring.rotation.z = anim.r0 * (1 - ease);
          if (k >= 1) anim.on = false;
        }
        if (crumbWatch.changed()) layoutCrumbs(crumbs(listing?.display ?? current), true);
        if (dirty) { dirty = false; render(); renderPreview(); }
        if (highlightDirty) { highlightDirty = false; applyHighlights(); }
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        imageTex?.dispose();
        if (previewGroup) disposeTree(previewGroup);
        if (ring) disposeTree(ring);
        disposeTree(card);
      },
    };
  },
};

export default definition;
