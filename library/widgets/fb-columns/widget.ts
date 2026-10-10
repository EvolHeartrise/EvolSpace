// fb-columns — "Files · Columns": Miller columns on an arc (via the `files` source).
//
// Every folder on the current path is a narrow column (folders first, typed Lucide icons, sizes and
// ages); the folder you opened stays highlighted in its parent column, so the path reads left to
// right. Columns sit on a cylinder segment around the viewer (each turned to face the arc's center,
// `radius` m in front of the widget), so a deep path stays readable without walking. Only the last
// `columns` folders are shown; older ones slide out into the rail on the left, where they stay as
// tappable crumbs. Tapping a file opens a preview column at the end (syntax-highlighted text with line
// numbers, or the image).
//
// Expert model: one pinch per level; pinch-drag inside a column scrolls it; a horizontal swipe to the
// right (or the big Back button) goes back one level; tapping a column's header — or a highlighted
// folder, or a crumb — jumps straight back to that level. The path and the previewed file persist in
// the `path` / `file` props.
//
// Requests go to <prefix>.request with per-entity reply channels: <prefix>.fb-columns.<id>.c<depth>
// (one per column depth) and <prefix>.fb-columns.<id>.preview; replies are matched by nonce.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, setColorRanges, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { formatBytes, truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  path: string;
  file: string;
  showHidden: boolean;
  columns: number;
  rows: number;
  radius: number;
  prefix: string;
}

export interface Entry { name: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string }
interface Listing { kind: 'list'; path: string; display: string; parent: string | null; entries: Entry[]; truncated: boolean; error?: string; nonce?: number | null }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string; nonce?: number | null }

/** One column of the model: a folder listing plus what is selected in it. */
interface Col {
  id: number;
  /** Path as requested ("~/…" or absolute). */
  req: string;
  /** Absolute path / display path once a listing arrived. */
  abs: string;
  display: string;
  parent: string | null;
  entries: Entry[] | null;
  truncated: boolean;
  error: string;
  /** Name of the selected entry (the folder opened to the right, or the previewed file). */
  selected: string | null;
  scroll: number;
  nonce: number;
  fresh: boolean;
}

// ---- layout (meters) ---------------------------------------------------------------------------
const PAD = 0.016;
const ROW = 0.036;
const HEAD = 0.062;
const COL_W = 0.34;
const RAIL_W = 0.12;
const PREV_W = 0.58;
const GAP = 0.024;
const NAME = 0.0135;
const META = 0.011;
const CODE = 0.011;
const CODE_LH = 1.3;
const TAP = 0.014; // movement (m) that turns a press into a drag
const SWIPE = 0.07; // horizontal travel (m) that counts as "swipe back"
const MAX_CHAIN = 24;
const CHAR = 0.58; // average glyph advance (em) of the sans font, for truncation

const ICONS: Array<[RegExp, string, string]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic)$/, 'file-image', '#7ee787'],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, 'film', '#d2a8ff'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, 'music', '#ff9bce'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, 'file-archive', '#e3b341'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml|lock)$/, 'braces', '#79c0ff'],
  [/^(csv|tsv|xlsx?|ods|parquet)$/, 'file-spreadsheet', '#7ee787'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, 'file-terminal', '#a5d6ff'],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|swift|dart|r|jl|sql|html?|css|scss)$/, 'file-code', '#79c0ff'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex)$/, 'file-text', '#c9d1d9'],
  [/^(pem|key|crt|cer|p12|pfx)$/, 'file-key', '#ffa198'],
];
const FOLDER_COLOR = '#e3b341';

/** Lucide icon + color for an entry. */
export function iconFor(e: Pick<Entry, 'type' | 'ext'>): [string, string] {
  if (e.type === 'dir') return ['folder', FOLDER_COLOR];
  for (const [re, icon, color] of ICONS) if (re.test(e.ext)) return [icon, color];
  return ['file', '#8b949e'];
}

/** Compact age for narrow columns: "now", "5m", "3h", "2d", "4mo", "2y". */
export function age(mtime: number | null, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** Right-hand row label: "12.3 KB · 3d" for files, "3d  ›" for folders. */
export function metaLabel(e: Entry, now = Date.now()): string {
  const a = age(e.mtime, now);
  if (e.type === 'dir') return a ? `${a}  ›` : '›';
  if (e.type === 'link') return 'broken link';
  const size = e.size != null ? formatBytes(e.size) : '';
  return [size, a].filter(Boolean).join(' · ');
}

const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');

/** dir + name with the dir's separator. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${sepOf(dir)}${name}`;
}

/** Last path segment ("~" and "/" stay themselves). */
export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  if (!s) return p.startsWith('\\') ? '\\' : '/';
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) || s : s;
}

/** Column title: "Home" for "~", else the last segment. */
export function folderTitle(p: string): string {
  return p === '~' ? 'Home' : baseName(p);
}

/** Folder chain from the root to `p`: "~/a/b" → ["~", "~/a", "~/a/b"]; "/x/y" → ["/", "/x", "/x/y"]; "D:\a" → ["D:\", "D:\a"]. */
export function chainFor(p: string): string[] {
  const s = String(p ?? '').trim() || '~';
  const sep = sepOf(s);
  const segs = s.split(/[\\/]+/);
  let cur: string;
  if (segs[0] === '') cur = '/';
  else if (segs[0] === '~') cur = '~';
  else if (/^[A-Za-z]:$/.test(segs[0])) cur = segs[0] + sep;
  else return [s]; // relative path: just that folder
  const out = [cur];
  for (const seg of segs.slice(1)) {
    if (!seg || seg === '.') continue;
    cur = joinPath(cur, seg);
    out.push(cur);
  }
  return out.length > MAX_CHAIN ? out.slice(out.length - MAX_CHAIN) : out;
}

/** Arc placement: arc length `s` along a circle of radius `r` whose center is r m in front (+Z); r ≈ 0 = flat. */
export function arcPlace(s: number, r: number): { x: number; z: number; ry: number } {
  if (!(r > 0.05)) return { x: s, z: 0, ry: 0 };
  const a = s / r;
  return { x: r * Math.sin(a), z: r * (1 - Math.cos(a)), ry: -a };
}

/** Index of the entry for an "open <name>" command: exact, then prefix, then substring (case-insensitive). */
export function findEntry(entries: Entry[], q: string): number {
  const s = q.trim().toLowerCase();
  if (!s) return -1;
  const names = entries.map((e) => e.name.toLowerCase());
  let i = names.indexOf(s);
  if (i < 0) i = names.findIndex((n) => n.startsWith(s));
  if (i < 0) i = names.findIndex((n) => n.includes(s));
  return i;
}

interface ColView {
  g: THREE.Group;
  col: Col | null;
  headIcon: THREE.Mesh;
  title: Text;
  sub: Text;
  underline: THREE.Mesh;
  icons: THREE.Mesh[];
  hits: THREE.Mesh[];
  names: Text;
  metas: Text;
  sel: THREE.Mesh;
  selMat: THREE.MeshBasicMaterial;
  track: THREE.Mesh;
  thumb: THREE.Mesh;
}

const definition: WidgetDefinition<Props> = {
  description:
    "Files · Columns — Miller-column file browser (via the 'files' source) on an arc around the viewer: each folder of the path is a column " +
    '(folders first, typed icons, sizes, ages) and the opened folder stays highlighted; tap a folder to open the next column, a file to preview it ' +
    '(syntax-highlighted text or image). Pinch-drag scrolls a column, swipe right / Back goes up, tap a header or crumb to jump back. ' +
    'Props: path, file (persisted), columns, rows, radius, showHidden. Inputs: path, preview, command ("back", "home", "open <name>", …).',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Deepest open folder ("~" = home); updated as you navigate.' },
    file: { type: 'string', default: '', description: 'Previewed file (absolute or ~/ path), "" = none; updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    columns: { type: 'integer', default: 3, min: 2, max: 5, description: 'Folder columns kept visible; older ones slide into the rail as crumbs.' },
    rows: { type: 'integer', default: 12, min: 6, max: 24, description: 'Visible rows per column.' },
    radius: { type: 'number', default: 1.6, min: 0, max: 6, step: 0.1, description: 'Arc radius (m); the arc center is this far in front of the widget. 0 = flat.' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder (rebuilds the column chain).' },
    preview: { type: 'string', description: 'Preview this file (absolute or ~/ path); its folder chain opens too.' },
    command: { type: 'string', description: '"back" | "home" | "hidden" | "close" | "open <name>" (entry of the deepest column) | "scroll <rows>".' },
  },
  outputs: {
    selected: { type: 'string', description: 'Absolute path of the file last opened for preview.' },
    folder: { type: 'string', description: 'Display path of the deepest open folder (on change).' },
  },
  interactions: [dragBinding('fb-columns-drag', 'drag')],
  size: [1.8, 0.55, 0.3],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const props = ctx.props;
    const prefix = () => String(props.prefix || 'files');
    const chan = (purpose: string) => `${prefix()}.fb-columns.${ctx.entityId}.${purpose}`;
    const nRows = () => Math.max(6, Math.min(24, Math.round(Number(props.rows) || 12)));
    const nCols = () => Math.max(2, Math.min(5, Math.round(Number(props.columns) || 3)));
    const H = () => HEAD + nRows() * ROW + 2 * PAD;

    let nonce = Math.floor(Math.random() * 1e9);
    let colSeq = 0;
    let cols: Col[] = [];
    let preview: Preview | null = null;
    let pvWanted = ''; // requested preview path ('' = none)
    let pvNonce = 0;
    let textScroll = 0;
    let dirty = true;
    let lastFolder = '';

    // animated arc state: column shift (index of the first visible column) and centering offset
    let shCur = 0, cCur = 0;
    let snap = true;

    const pathColor = mixHex(theme.surface, theme.accent, 0.28);
    const fileColor = mixHex(theme.surface, theme.accent, 0.5);

    // ---- requests --------------------------------------------------------------------------------

    const subs = new Map<number, () => void>();
    let pvOff: (() => void) | null = null;

    function requestList(depth: number): void {
      const c = cols[depth];
      if (!c) return;
      c.nonce = ++nonce;
      c.fresh = false;
      ensureSub(depth);
      ctx.channels.publish(`${prefix()}.request`, { cmd: 'list', path: c.abs || c.req, hidden: !!props.showHidden, reply: chan(`c${depth}`), nonce: c.nonce } as never);
    }

    function ensureSub(depth: number): void {
      if (subs.has(depth)) return;
      subs.set(depth, ctx.channels.subscribe(chan(`c${depth}`), (v: ChannelValue) => onListing(depth, v)));
    }

    function onListing(depth: number, v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as Listing).kind !== 'list') return;
      const l = v as Listing;
      const c = cols[depth];
      if (!c) return;
      // ours (nonce), or any reply for this same folder: another client of this entity (headset, mirror,
      // dashboard) asked too, or the channel retained it from an earlier session — the path is the truth
      const mine = l.nonce === c.nonce || l.display === c.req || l.path === c.req || (!!c.abs && l.path === c.abs);
      if (!mine) return;
      c.entries = Array.isArray(l.entries) ? l.entries.filter((e) => e && typeof e.name === 'string') : [];
      c.abs = typeof l.path === 'string' ? l.path : c.abs;
      c.display = typeof l.display === 'string' ? l.display : c.display;
      c.parent = l.parent ?? null;
      c.truncated = !!l.truncated;
      c.error = l.error ? String(l.error) : '';
      c.fresh = true;
      revealSelected(c);
      if (depth === cols.length - 1) persist();
      dirty = true;
    }

    function requestPreview(p: string): void {
      pvWanted = p;
      pvNonce = ++nonce;
      preview = null;
      textScroll = 0;
      if (!pvOff) pvOff = ctx.channels.subscribe(chan('preview'), onPreview);
      ctx.channels.publish(`${prefix()}.request`, { cmd: 'preview', path: p, reply: chan('preview'), nonce: pvNonce } as never);
      dirty = true;
    }

    function onPreview(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || Array.isArray(v) || (v as Preview).kind !== 'preview' || !pvWanted) return;
      const p = v as Preview;
      const same = p.path === pvWanted || (pvWanted.startsWith('~/') && typeof p.path === 'string' && p.path.endsWith(pvWanted.slice(1)));
      if (p.nonce !== pvNonce && !(same && !preview)) return;
      preview = p;
      textScroll = 0;
      dirty = true;
    }

    // ---- navigation ------------------------------------------------------------------------------

    function makeCol(req: string, selected: string | null): Col {
      return { id: ++colSeq, req, abs: '', display: req, parent: null, entries: null, truncated: false, error: '', selected, scroll: 0, nonce: 0, fresh: false };
    }

    const last = () => cols[cols.length - 1];
    const currentFolder = () => (last() ? last().display || last().req : '~');

    function persist(): void {
      const folder = currentFolder();
      const file = pvWanted ? previewDisplayPath() : '';
      if (folder !== lastFolder) { lastFolder = folder; ctx.emit('folder', folder); }
      if (ctx.isMirror) return;
      const patch: Record<string, unknown> = {};
      if (folder !== props.path) patch.path = folder;
      if (file !== props.file) patch.file = file;
      if (Object.keys(patch).length) ctx.setProps(patch);
    }

    /** The previewed file as "<deepest display>/<name>" (keeps "~/…" when the folder is under home). */
    function previewDisplayPath(): string {
      const c = last();
      if (c?.selected && pvWanted && baseName(pvWanted) === c.selected) return joinPath(c.display || c.req, c.selected);
      return pvWanted;
    }

    /** Rebuild the whole chain for a folder (and optionally select + preview a file in it). */
    function setChain(folder: string, fileName: string | null = null): void {
      const chain = chainFor(folder);
      cols = chain.map((p, i) => makeCol(p, i + 1 < chain.length ? baseName(chain[i + 1]) : fileName));
      closePreview(false);
      cols.forEach((_, i) => requestList(i));
      if (fileName) requestPreview(joinPath(chain[chain.length - 1], fileName));
      snap = true;
      persist();
      dirty = true;
    }

    function closePreview(clearSelection = true): void {
      if (clearSelection && pvWanted && last()?.selected && baseName(pvWanted) === last().selected) last().selected = null;
      pvWanted = '';
      preview = null;
      dirty = true;
    }

    /** Make column i the deepest (its selection cleared). */
    function goTo(i: number): void {
      if (!cols[i]) return;
      cols.length = i + 1;
      cols[i].selected = null;
      closePreview(false);
      persist();
      dirty = true;
    }

    function back(): void {
      if (pvWanted) { closePreview(); persist(); return; }
      if (cols.length > 1) {
        cols.pop(); // the folder we came from stays highlighted in its parent
        persist();
        dirty = true;
        return;
      }
      const root = cols[0];
      if (root?.parent) {
        const from = baseName(root.abs || root.req);
        cols = [makeCol(root.parent, from)];
        requestList(0);
        persist();
        dirty = true;
      }
    }

    function tapEntry(i: number, e: Entry): void {
      const c = cols[i];
      if (!c) return;
      if (e.type === 'dir') {
        // tapping the folder already open to the right jumps back to it
        if (c.selected === e.name && cols[i + 1]) { goTo(i + 1); return; }
        c.selected = e.name;
        cols.length = i + 1;
        closePreview(false);
        cols.push(makeCol(joinPath(c.abs || c.req, e.name), null));
        requestList(cols.length - 1);
        persist();
      } else {
        const full = joinPath(c.abs || c.req, e.name);
        if (c.selected === e.name && pvWanted && i === cols.length - 1) { closePreview(); persist(); return; }
        cols.length = i + 1;
        c.selected = e.name;
        ctx.emit('selected', full);
        requestPreview(full);
        persist();
      }
      dirty = true;
    }

    function revealSelected(c: Col): void {
      if (!c.entries || !c.selected) return;
      const idx = c.entries.findIndex((e) => e.name === c.selected);
      const n = nRows();
      if (idx >= 0 && (idx < c.scroll || idx >= c.scroll + n)) c.scroll = Math.max(0, Math.min(c.entries.length - n, idx - Math.floor(n / 3)));
    }

    function command(raw: string): void {
      const s = raw.trim();
      const [verb, ...rest] = s.split(/\s+/);
      const arg = rest.join(' ');
      switch (verb.toLowerCase()) {
        case 'back': case 'up': back(); break;
        case 'home': setChain('~'); break;
        case 'hidden': toggleHidden(); break;
        case 'close': if (pvWanted) { closePreview(); persist(); } break;
        case 'open': {
          const c = last();
          const idx = c?.entries ? findEntry(c.entries, arg) : -1;
          if (idx >= 0) tapEntry(cols.length - 1, c.entries![idx]);
          else if (arg) ctx.event('fb-columns.notfound', { query: arg, folder: currentFolder() });
          break;
        }
        case 'scroll': {
          const n = Number(arg);
          const c = last();
          if (c?.entries && Number.isFinite(n)) { c.scroll = Math.max(0, Math.min(c.entries.length - nRows(), Math.round(c.scroll) + n)); dirty = true; }
          break;
        }
        default: if (s) ctx.event('fb-columns.unknown-command', { command: s });
      }
    }

    function toggleHidden(): void {
      if (!ctx.isMirror) ctx.setProps({ showHidden: !props.showHidden });
      else props.showHidden = !props.showHidden;
      cols.forEach((_, i) => requestList(i));
      dirty = true;
    }

    // ---- scene -----------------------------------------------------------------------------------

    let arc: THREE.Group | null = null;
    let views: ColView[] = [];
    let hover: THREE.Mesh | null = null;
    let hoverMat: THREE.MeshBasicMaterial, activeMat: THREE.MeshBasicMaterial;
    let hovered = '';

    // rail
    let rail: THREE.Group;
    let backHit: THREE.Mesh, homeHit: THREE.Mesh, hiddenHit: THREE.Mesh, hiddenIcon: THREE.Mesh;
    let crumbLabel: Text, hint: Text;
    let crumbs: Array<{ g: THREE.Group; hit: THREE.Mesh; icon: THREE.Mesh; text: Text }> = [];
    let crumbMap: number[] = [];

    // preview column
    let pv: THREE.Group;
    let pvIcon: THREE.Mesh, pvTitle: Text, pvMeta: Text, pvBody: Text, pvNums: Text, pvMsg: Text, pvImg: THREE.Mesh, pvImgMat: THREE.MeshBasicMaterial;
    let pvHit: THREE.Mesh, pvTrack: THREE.Mesh, pvThumb: THREE.Mesh;
    let imageTex: THREE.Texture | null = null;
    let previewKey = '';
    let hlLines: string[] = [], hlSpans: Span[][] = [], hlLang = '';
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;
    const textInt = hexToInt(theme.text);

    function hitBox(w: number, h: number, name: string): THREE.Mesh {
      const m = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      m.scale.set(w, h, 0.012);
      m.name = name;
      ctx.interactive(m);
      return m;
    }

    function plane(color: string, w: number, h: number, opacity = 1): THREE.Mesh {
      const m = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, color, { opacity }));
      m.scale.set(w, h, 1);
      m.raycast = () => {};
      return m;
    }

    function build(): void {
      if (arc) disposeTree(arc);
      views = [];
      crumbs = [];
      hovered = '';
      const a = (arc = new T.Group());
      const h = H();
      hoverMat = ownMaterial(T, theme.text, { opacity: 0.09 });
      activeMat = ownMaterial(T, theme.accent, { opacity: 0.3 });
      hover = new T.Mesh(sharedGeometry(T, 'plane'), hoverMat);
      hover.raycast = () => {};
      hover.visible = false;
      a.add(hover);
      buildRail(h);
      a.add(rail);
      for (let v = 0; v < nCols() + 1; v++) { const cv = buildView(v, h); views.push(cv); a.add(cv.g); }
      buildPreview(h);
      a.add(pv);
      ctx.root.add(a);
      previewKey = '';
      snap = true;
      dirty = true;
    }

    function buildRail(h: number): void {
      const g = (rail = new T.Group());
      g.add(ctx.ui.panel(RAIL_W, h));
      const top = h / 2 - PAD, iw = RAIL_W - 2 * 0.01;
      // Back: the big one
      const bh = 0.07;
      const bp = ctx.ui.panel(iw, bh, { color: theme.surface, radius: 0.012 });
      bp.position.set(0, top - bh / 2, STYLE.zContent);
      bp.raycast = () => {};
      const bi = makeIcon(ctx, 'arrow-left', { size: 0.026, color: theme.text });
      bi.position.set(0, top - bh / 2 + 0.011, STYLE.zText);
      const bl = makeText(ctx, 'Back', { size: 0.011, color: theme.text, anchorX: 'center', anchorY: 'middle' });
      bl.position.set(0, top - bh / 2 - 0.018, STYLE.zText);
      backHit = hitBox(iw, bh, 'rail:back');
      backHit.position.set(0, top - bh / 2, 0.004);
      g.add(bp, bi, bl, backHit);
      // Home + hidden toggle
      const sq = (iw - 0.006) / 2, sy = top - bh - 0.008 - sq / 2;
      const square = (x: number, icon: string, name: string): [THREE.Mesh, THREE.Mesh] => {
        const p = ctx.ui.panel(sq, sq, { color: theme.surface, radius: 0.012 });
        p.position.set(x, sy, STYLE.zContent);
        p.raycast = () => {};
        const ic = makeIcon(ctx, icon, { size: 0.022, color: theme.text });
        ic.position.set(x, sy, STYLE.zText);
        const hit = hitBox(sq, sq, name);
        hit.position.set(x, sy, 0.004);
        g.add(p, ic, hit);
        return [hit, ic];
      };
      [homeHit] = square(-iw / 2 + sq / 2, 'house', 'rail:home');
      [hiddenHit, hiddenIcon] = square(iw / 2 - sq / 2, props.showHidden ? 'eye' : 'eye-off', 'rail:hidden');
      // crumbs of the folders that slid out on the left
      const cy0 = sy - sq / 2 - 0.016;
      crumbLabel = makeText(ctx, '', { size: 0.0095, color: theme.textDim, anchorX: 'left', anchorY: 'middle', weight: 'semibold' });
      crumbLabel.position.set(-iw / 2 + 0.004, cy0 - 0.006, STYLE.zText);
      g.add(crumbLabel);
      const hintH = 0.07;
      const room = cy0 - 0.016 - (-h / 2 + PAD + hintH);
      const nCrumbs = Math.max(1, Math.min(7, Math.floor(room / ROW)));
      for (let k = 0; k < nCrumbs; k++) {
        const cg = new T.Group();
        cg.position.set(0, cy0 - 0.016 - (k + 0.5) * ROW, 0);
        const icon = makeIcon(ctx, 'folder', { size: 0.016, color: FOLDER_COLOR });
        icon.position.set(-iw / 2 + 0.01, 0, STYLE.zText);
        const text = makeText(ctx, '', { size: 0.011, color: theme.text, anchorX: 'left', anchorY: 'middle', whiteSpace: 'nowrap' });
        text.position.set(-iw / 2 + 0.023, 0, STYLE.zText);
        const hit = hitBox(iw, ROW - 0.002, `rail:crumb:${k}`);
        hit.position.z = 0.004;
        cg.add(icon, text, hit);
        cg.visible = false;
        g.add(cg);
        crumbs.push({ g: cg, hit, icon, text });
      }
      hint = makeText(ctx, 'Pinch a folder to open\nDrag to scroll\nSwipe → to go back', { size: 0.0092, color: theme.textDim, anchorX: 'center', anchorY: 'bottom', textAlign: 'center', lineHeight: 1.3 });
      hint.position.set(0, -h / 2 + PAD, STYLE.zText);
      g.add(hint);
    }

    function buildView(v: number, h: number): ColView {
      const g = new T.Group();
      g.visible = false;
      g.add(ctx.ui.panel(COL_W, h));
      const x0 = -COL_W / 2 + PAD, x1 = COL_W / 2 - PAD, top = h / 2 - PAD;
      const headIcon = makeIcon(ctx, 'folder', { size: 0.02, color: FOLDER_COLOR });
      headIcon.position.set(x0 + 0.011, top - 0.016, STYLE.zText);
      const title = makeText(ctx, '', { size: 0.015, color: theme.text, anchorX: 'left', anchorY: 'middle', weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.028, top - 0.016, STYLE.zText);
      const sub = makeText(ctx, '', { size: META, color: theme.textDim, anchorX: 'left', anchorY: 'middle', whiteSpace: 'nowrap' });
      sub.position.set(x0 + 0.028, top - 0.039, STYLE.zText);
      const headHit = hitBox(COL_W - 2 * PAD, HEAD - 0.008, `head:${v}`);
      headHit.position.set(0, top - (HEAD - 0.008) / 2 + 0.004, 0.004);
      const underline = plane(theme.accent, COL_W - 2 * PAD, 0.003);
      underline.position.set(0, top - HEAD + 0.006, STYLE.zContent);
      const divider = plane(theme.border, COL_W - 2 * PAD, 0.0012);
      divider.position.set(0, top - HEAD + 0.006, STYLE.zContent * 0.5);
      g.add(headIcon, title, sub, headHit, divider, underline);
      const listTop = top - HEAD;
      const selMat = ownMaterial(T, pathColor);
      const sel = new T.Mesh(sharedGeometry(T, 'plane'), selMat);
      sel.scale.set(COL_W - 2 * PAD + 0.008, ROW - 0.004, 1);
      sel.raycast = () => {};
      sel.visible = false;
      g.add(sel);
      const icons: THREE.Mesh[] = [], hits: THREE.Mesh[] = [];
      for (let r = 0; r < nRows(); r++) {
        const y = listTop - (r + 0.5) * ROW;
        const icon = makeIcon(ctx, 'file', { size: 0.019, color: theme.textDim });
        icon.position.set(x0 + 0.011, y, STYLE.zText);
        icon.visible = false;
        const hit = hitBox(COL_W - 2 * PAD + 0.008, ROW, `row:${v}:${r}`);
        hit.position.set(0, y, 0.004);
        hit.visible = false;
        g.add(icon, hit);
        icons.push(icon);
        hits.push(hit);
      }
      // all names / all metas of a column are one text each (line height = row pitch)
      const names = makeText(ctx, '', { size: NAME, color: theme.text, anchorX: 'left', anchorY: 'top', whiteSpace: 'nowrap', lineHeight: ROW / NAME });
      names.position.set(x0 + 0.028, listTop, STYLE.zText);
      const metas = makeText(ctx, '', { size: META, color: theme.textDim, anchorX: 'right', anchorY: 'top', whiteSpace: 'nowrap', lineHeight: ROW / META, textAlign: 'right' });
      metas.position.set(x1 - 0.006, listTop, STYLE.zText);
      const rh = nRows() * ROW;
      const track = plane(theme.border, 0.003, rh);
      track.position.set(COL_W / 2 - PAD * 0.4, listTop - rh / 2, STYLE.zContent);
      const thumb = plane(theme.textDim, 0.003, 0.02);
      thumb.position.set(track.position.x, 0, STYLE.zOverlay);
      g.add(names, metas, track, thumb);
      return { g, col: null, headIcon, title, sub, underline, icons, hits, names, metas, sel, selMat, track, thumb };
    }

    function buildPreview(h: number): void {
      const g = (pv = new T.Group());
      g.visible = false;
      g.add(ctx.ui.panel(PREV_W, h));
      const x0 = -PREV_W / 2 + PAD, x1 = PREV_W / 2 - PAD, top = h / 2 - PAD;
      pvIcon = makeIcon(ctx, 'file', { size: 0.02, color: theme.textDim });
      pvIcon.position.set(x0 + 0.011, top - 0.016, STYLE.zText);
      pvTitle = makeText(ctx, '', { size: 0.015, color: theme.text, anchorX: 'left', anchorY: 'middle', weight: 'semibold', whiteSpace: 'nowrap' });
      pvTitle.position.set(x0 + 0.028, top - 0.016, STYLE.zText);
      pvMeta = makeText(ctx, '', { size: META, color: theme.textDim, anchorX: 'left', anchorY: 'middle', whiteSpace: 'nowrap' });
      pvMeta.position.set(x0 + 0.028, top - 0.039, STYLE.zText);
      g.add(pvIcon, pvTitle, pvMeta);
      const btn = (id: string, icon: string, x: number) => {
        const d = 0.036;
        const p = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        p.position.set(x, top - 0.024, STYLE.zContent);
        p.raycast = () => {};
        const ic = makeIcon(ctx, icon, { size: d * 0.5, color: theme.text });
        ic.position.set(x, top - 0.024, STYLE.zText);
        const hit = hitBox(d, d, `pv:${id}`);
        hit.position.set(x, top - 0.024, 0.004);
        g.add(p, ic, hit);
      };
      btn('close', 'x', x1 - 0.018);
      btn('ask', 'message-square', x1 - 0.062);
      const divider = plane(theme.border, PREV_W - 2 * PAD, 0.0012);
      divider.position.set(0, top - HEAD + 0.006, STYLE.zContent * 0.5);
      g.add(divider);
      const bodyTop = top - HEAD, bodyH = h - 2 * PAD - HEAD;
      pvNums = makeText(ctx, '', { size: CODE, color: theme.textDim, anchorX: 'right', anchorY: 'top', font: 'mono', lineHeight: CODE_LH, textAlign: 'right' });
      pvNums.position.set(x0 + 0.03, bodyTop - 0.004, STYLE.zText);
      pvBody = makeText(ctx, '', { size: CODE, color: theme.text, anchorX: 'left', anchorY: 'top', font: 'mono', whiteSpace: 'nowrap', lineHeight: CODE_LH });
      pvBody.position.set(x0 + 0.038, bodyTop - 0.004, STYLE.zText);
      pvMsg = makeText(ctx, '', { size: 0.013, color: theme.textDim, anchorX: 'center', anchorY: 'middle', maxWidth: PREV_W - 0.08, textAlign: 'center' });
      pvMsg.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
      pvImgMat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
      pvImg = new T.Mesh(sharedGeometry(T, 'plane'), pvImgMat);
      pvImg.raycast = () => {};
      pvImg.visible = false;
      pvImg.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
      pvHit = hitBox(PREV_W - 2 * PAD, bodyH, 'pv:text');
      pvHit.position.set(0, bodyTop - bodyH / 2, 0.004);
      pvTrack = plane(theme.border, 0.003, bodyH - 0.01);
      pvTrack.position.set(PREV_W / 2 - PAD * 0.4, bodyTop - bodyH / 2, STYLE.zContent);
      pvThumb = plane(theme.textDim, 0.003, 0.02);
      pvThumb.position.set(pvTrack.position.x, 0, STYLE.zOverlay);
      g.add(pvNums, pvBody, pvMsg, pvImg, pvHit, pvTrack, pvThumb);
    }

    const pvLines = () => Math.max(4, Math.floor((H() - 2 * PAD - HEAD - 0.008) / (CODE * CODE_LH)));

    // ---- rendering -------------------------------------------------------------------------------

    function firstVisible(): number { return Math.max(0, cols.length - nCols()); }

    function totalLength(sh: number, withPreview: boolean): number {
      const n = cols.length - sh;
      return RAIL_W + GAP + n * (COL_W + GAP) + (withPreview ? PREV_W : -GAP);
    }

    function place(o: THREE.Object3D, s: number): void {
      const p = arcPlace(s, Math.max(0, Number(props.radius) || 0));
      o.position.set(p.x, 0, p.z);
      o.rotation.set(0, p.ry, 0);
    }

    /** Positions (every animated frame) + view binding. */
    function layout(): void {
      if (!arc) return;
      const c = cCur;
      place(rail, RAIL_W / 2 - c);
      // which columns are on screen (the one sliding out collapses as it goes)
      const lo = Math.max(0, cols.length - views.length, Math.floor(shCur - 0.7) + 1);
      for (const v of views) if (v.col && (cols.indexOf(v.col) < lo)) unbind(v);
      for (let i = lo; i < cols.length; i++) {
        const col = cols[i];
        let v = views.find((x) => x.col === col);
        if (!v) { v = views.find((x) => !x.col); if (!v) continue; v.col = col; renderView(v); }
        const k = i - shCur;
        // sliding out: collapse against the rail (its left edge stays put) while the next one slides in
        const sx = k < 0 ? Math.max(0.001, 1 + k / 0.7) : 1;
        v.g.visible = true;
        v.g.scale.set(sx, 1, 1);
        place(v.g, (k < 0 ? RAIL_W + GAP + (sx * COL_W) / 2 : RAIL_W + GAP + k * (COL_W + GAP) + COL_W / 2) - c);
      }
      pv.visible = !!pvWanted;
      if (pvWanted) place(pv, RAIL_W + GAP + (cols.length - shCur) * (COL_W + GAP) + PREV_W / 2 - c);
      if (hover && hovered) placeHover(hovered);
    }

    function unbind(v: ColView): void {
      v.col = null;
      v.g.visible = false;
      if (hovered.startsWith(`row:${views.indexOf(v)}:`) || hovered === `head:${views.indexOf(v)}`) setHover('');
    }

    function renderView(v: ColView): void {
      const c = v.col;
      if (!c) return;
      const i = cols.indexOf(c);
      const deepest = i === cols.length - 1;
      const n = nRows();
      v.title.set(truncate(folderTitle(c.display || c.req), Math.floor((COL_W - 2 * PAD - 0.03) / (0.015 * CHAR))));
      const count = c.entries ? c.entries.length : 0;
      v.sub.set(!c.fresh && !c.entries ? 'loading…' : c.error ? 'unavailable' : `${count}${c.truncated ? '+' : ''} item${count === 1 ? '' : 's'}`);
      setIcon(T, v.headIcon, deepest ? 'folder-open' : 'folder');
      (v.headIcon.material as THREE.MeshBasicMaterial).color.set(deepest ? theme.accent : FOLDER_COLOR);
      v.underline.visible = deepest;
      const list = c.entries ?? [];
      const msg = !c.entries ? 'Loading…' : c.error ? c.error : list.length ? '' : 'Empty folder';
      c.scroll = Math.max(0, Math.min(Math.max(0, list.length - n), c.scroll));
      const first = Math.round(c.scroll);
      const nameChars = Math.floor((COL_W - 2 * PAD - 0.03 - 0.085) / (NAME * CHAR));
      let names = '', metas = '';
      const now = Date.now();
      let selRow = -1;
      for (let r = 0; r < n; r++) {
        const e = msg ? undefined : list[first + r];
        v.icons[r].visible = v.hits[r].visible = !!e;
        if (!e) continue;
        const [icon, color] = iconFor(e);
        setIcon(T, v.icons[r], icon);
        (v.icons[r].material as THREE.MeshBasicMaterial).color.set(color);
        names += (r ? '\n' : '') + truncate(e.name, nameChars);
        metas += (r ? '\n' : '') + metaLabel(e, now);
        if (c.selected === e.name) selRow = r;
      }
      if (msg) names = truncate(msg, nameChars + 8);
      v.names.set(names);
      (v.names as unknown as { color: string }).color = msg ? theme.textDim : theme.text;
      v.metas.set(metas);
      const listTop = H() / 2 - PAD - HEAD;
      v.sel.visible = selRow >= 0;
      if (selRow >= 0) {
        const selEntry = list[first + selRow];
        v.selMat.color.set(selEntry?.type === 'dir' ? pathColor : fileColor);
        v.sel.position.set(0, listTop - (selRow + 0.5) * ROW, STYLE.zContent);
      }
      const over = list.length > n && !msg;
      v.track.visible = v.thumb.visible = over;
      if (over) {
        const rh = n * ROW, th = Math.max(0.02, (rh * n) / list.length);
        v.thumb.scale.y = th;
        v.thumb.position.y = listTop - th / 2 - (first / (list.length - n)) * (rh - th);
      }
    }

    function renderRail(): void {
      setIcon(T, hiddenIcon, props.showHidden ? 'eye' : 'eye-off');
      const hiddenCols = firstVisible();
      const shown = Math.min(hiddenCols, crumbs.length);
      const from = hiddenCols - shown;
      crumbLabel.set(hiddenCols ? (from ? `PATH  +${from}` : 'PATH') : '');
      crumbMap = [];
      for (let k = 0; k < crumbs.length; k++) {
        const ci = from + k;
        const on = k < shown;
        crumbs[k].g.visible = on;
        if (!on) continue;
        crumbMap[k] = ci;
        crumbs[k].text.set(truncate(folderTitle(cols[ci].display || cols[ci].req), Math.floor((RAIL_W - 0.045) / (0.011 * CHAR))));
      }
    }

    function renderPreview(): void {
      const key = pvWanted ? `${pvWanted}|${preview?.type ?? ''}|${preview?.src ?? ''}|${preview?.text?.length ?? 0}|${preview?.error ?? ''}` : '';
      if (key !== previewKey) {
        previewKey = key;
        imageTex?.dispose();
        imageTex = null;
        pvImgMat.map = null;
        pvImgMat.needsUpdate = true;
        pvImg.visible = false;
        const name = preview?.name ?? baseName(pvWanted);
        const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
        const [icon, color] = iconFor({ type: 'file', ext });
        setIcon(T, pvIcon, icon);
        (pvIcon.material as THREE.MeshBasicMaterial).color.set(color);
        pvTitle.set(truncate(name, Math.floor((PREV_W - 2 * PAD - 0.13) / (0.015 * CHAR))));
        const p = preview;
        pvMeta.set(!p ? 'loading…' : [p.size != null ? formatBytes(p.size) : '', p.mtime ? `${age(p.mtime)} ago`.replace('now ago', 'just now') : '',
          p.type === 'text' ? `${p.lines ?? 0} lines${p.truncated ? ' (first 64 KB)' : ''}` : '', p.type === 'text' ? languageFor(name)?.id ?? 'text' : p.type].filter(Boolean).join(' · '));
        if (p?.type === 'text') {
          const lang = languageFor(name);
          hlLines = (p.text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
          hlSpans = highlight(hlLines.join('\n'), lang);
          hlLang = lang?.id ?? '';
        } else { hlLines = []; hlSpans = []; hlLang = ''; }
        const msg = !p ? 'Loading…' : p.type === 'text' ? '' : p.type === 'binary' ? 'Binary file: no preview'
          : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? (p.src && typeof document !== 'undefined' ? '' : 'Image preview appears in the headset')
            : (p.error ?? 'No preview');
        pvMsg.set(msg);
        pvMsg.visible = !!msg;
        if (p?.type === 'image' && p.src && typeof document !== 'undefined') loadImage(p.src);
      }
      const isText = preview?.type === 'text';
      pvBody.visible = pvNums.visible = isText;
      const visible = pvLines();
      const over = isText && hlLines.length > visible;
      pvTrack.visible = pvThumb.visible = over;
      if (!isText) { pvBody.set(''); pvNums.set(''); return; }
      const from = Math.min(Math.max(0, Math.round(textScroll)), Math.max(0, hlLines.length - visible));
      textScroll = Math.min(textScroll, Math.max(0, hlLines.length - visible));
      const shownLines = hlLines.slice(from, from + visible);
      const maxCh = Math.floor((PREV_W - 2 * PAD - 0.045) / (CODE * 0.6));
      const shown = shownLines.map((l) => (l.length > maxCh ? l.slice(0, maxCh - 1) + '…' : l));
      pvBody.set(shown.join('\n'));
      const clips = shown.map((l, i) => (l.length < shownLines[i].length ? l.length - 1 : l.length));
      setColorRanges(pvBody, hlLang ? colorRanges(hlSpans.slice(from, from + visible), shown.map((l) => l.length), syntaxInts, textInt, clips) : null);
      pvNums.set(shownLines.map((_, i) => String(from + i + 1)).join('\n'));
      if (over) {
        const rh = pvTrack.scale.y, th = Math.max(0.02, (rh * visible) / hlLines.length);
        pvThumb.scale.y = th;
        pvThumb.position.y = pvTrack.position.y + rh / 2 - th / 2 - (from / (hlLines.length - visible)) * (rh - th);
      }
    }

    function loadImage(src: string): void {
      const bodyH = H() - 2 * PAD - HEAD - 0.01, bw = PREV_W - 2 * PAD;
      const tex = new T.TextureLoader().load(src, (t) => {
        if (imageTex !== t) return;
        t.colorSpace = T.SRGBColorSpace;
        const im = t.image as { width: number; height: number };
        const a = im.width / Math.max(1, im.height);
        const sw = a > bw / bodyH ? bw : bodyH * a, sh = a > bw / bodyH ? bw / a : bodyH;
        pvImg.scale.set(sw, sh, 1);
        pvImgMat.map = t;
        pvImgMat.needsUpdate = true;
        pvImg.visible = true;
      }, undefined, () => { if (imageTex === tex) { pvMsg.set('Could not load the image'); pvMsg.visible = true; } });
      imageTex = tex;
    }

    function render(): void {
      for (const v of views) if (v.col && !cols.includes(v.col)) unbind(v);
      for (const v of views) if (v.col) renderView(v);
      renderRail();
      if (pvWanted) renderPreview();
      else previewKey = '';
    }

    // ---- hover feedback --------------------------------------------------------------------------

    function partMesh(name: string): THREE.Mesh | null {
      if (name === 'rail:back') return backHit;
      if (name === 'rail:home') return homeHit;
      if (name === 'rail:hidden') return hiddenHit;
      if (name.startsWith('rail:crumb:')) return crumbs[Number(name.slice(11))]?.hit ?? null;
      const m = /^(row|head):(\d+)(?::(\d+))?$/.exec(name);
      if (m) {
        const v = views[Number(m[2])];
        if (!v?.col) return null;
        return m[1] === 'head' ? (v.g.children.find((c) => c.name === name) as THREE.Mesh) ?? null : v.hits[Number(m[3])] ?? null;
      }
      if (name === 'pv:close' || name === 'pv:ask') return (pv.children.find((c) => c.name === name) as THREE.Mesh) ?? null;
      return null;
    }

    function placeHover(name: string): void {
      const m = partMesh(name);
      if (!hover || !m || !m.visible || !m.parent?.visible) { if (hover) hover.visible = false; return; }
      if (hover.parent !== m.parent) m.parent.add(hover);
      hover.position.set(m.position.x, m.position.y, STYLE.zContent + 0.0006);
      hover.scale.set(m.scale.x, m.scale.y - 0.002, 1);
      hover.visible = true;
    }

    function setHover(name: string): void {
      hovered = name;
      if (!name) { if (hover) hover.visible = false; return; }
      placeHover(name);
    }

    // ---- interaction -----------------------------------------------------------------------------

    let press: { hand: string; part: string; x0: number; y0: number; scroll0: number; mode: 'none' | 'scroll' | 'swipe'; col: Col | null } | null = null;

    function colOfPart(part: string): Col | null {
      const m = /^(?:row|head):(\d+)/.exec(part);
      return m ? views[Number(m[1])]?.col ?? null : null;
    }

    function tap(part: string): void {
      if (part.startsWith('row:')) {
        const [, v, r] = part.split(':').map(Number);
        const c = views[v]?.col;
        if (!c?.entries) return;
        const e = c.entries[Math.round(c.scroll) + r];
        if (e) tapEntry(cols.indexOf(c), e);
      } else if (part.startsWith('head:')) {
        const c = colOfPart(part);
        if (c) goTo(cols.indexOf(c));
      } else if (part === 'rail:back') back();
      else if (part === 'rail:home') setChain('~');
      else if (part === 'rail:hidden') toggleHidden();
      else if (part.startsWith('rail:crumb:')) {
        const ci = crumbMap[Number(part.slice(11))];
        if (ci !== undefined) goTo(ci);
      } else if (part === 'pv:close') { closePreview(); persist(); }
      else if (part === 'pv:ask' && pvWanted) ctx.askAgent(`Take a look at this file and tell me about it: ${preview?.path ?? pvWanted}`);
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    build();
    {
      const folder = String(props.path || '~');
      const file = String(props.file || '');
      const fileInFolder = file && (file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))) === folder.replace(/[\\/]+$/, ''));
      setChain(folder, fileInFolder ? baseName(file) : null);
    }

    return {
      onProps(p, prev) {
        if (p.rows !== prev.rows || p.columns !== prev.columns) build();
        if (p.prefix !== prev.prefix) {
          for (const off of subs.values()) off();
          subs.clear();
          pvOff?.();
          pvOff = null;
          setChain(currentFolder());
        } else if (p.path !== prev.path && p.path !== currentFolder()) setChain(String(p.path || '~'));
        else if (p.showHidden !== prev.showHidden) cols.forEach((_, i) => requestList(i));
        if (p.file !== prev.file && p.file !== (pvWanted ? previewDisplayPath() : '')) {
          const f = String(p.file || '');
          if (!f) closePreview();
          else {
            const dir = f.slice(0, Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')));
            if (dir && dir !== currentFolder()) setChain(dir, baseName(f));
            else { if (last()) last().selected = baseName(f); requestPreview(f); }
          }
        }
        if (p.radius !== prev.radius) snap = true;
        dirty = true;
      },
      onInput(port, v) {
        if (typeof v !== 'string' || !v.trim()) return;
        const s = v.trim();
        if (port === 'path') setChain(s);
        else if (port === 'preview') {
          const dir = s.slice(0, Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')));
          if (dir && dir !== currentFolder()) setChain(dir, baseName(s));
          else { if (last()) last().selected = baseName(s); requestPreview(s); }
          ctx.emit('selected', s);
        } else if (port === 'command') command(s);
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') {
          if (e.phase === 'start' || e.phase === 'move') { if (part !== hovered || (hover && !hover.visible)) setHover(part); }
          else if (part === hovered || !part) setHover('');
          return;
        }
        const x = e.localPoint?.[0] ?? 0, y = e.localPoint?.[1] ?? 0;
        if (e.phase === 'start') {
          if (press || !part) return;
          const col = colOfPart(part);
          press = { hand: e.hand, part, x0: x, y0: y, scroll0: part === 'pv:text' ? textScroll : col?.scroll ?? 0, mode: 'none', col };
          setHover(part);
          if (hover) hover.material = activeMat;
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          const dx = x - press.x0, dy = y - press.y0;
          if (press.mode === 'none' && Math.hypot(dx, dy) > TAP) {
            press.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
            if (hover) hover.material = hoverMat;
          }
          if (press.mode === 'scroll') {
            if (press.part.startsWith('row:') && press.col?.entries) {
              const c = press.col;
              const s = Math.min(Math.max(0, c.entries!.length - nRows()), Math.max(0, press.scroll0 + dy / ROW));
              if (Math.round(s) !== Math.round(c.scroll)) dirty = true;
              c.scroll = s;
            } else if (press.part === 'pv:text') {
              const s = Math.max(0, press.scroll0 + dy / (CODE * CODE_LH));
              if (Math.round(s) !== Math.round(textScroll)) dirty = true;
              textScroll = s;
            }
          }
          return;
        }
        const p = press;
        press = null;
        if (hover) hover.material = hoverMat;
        if (e.phase !== 'end') return; // cancelled: never act
        if (p.mode === 'none') tap(p.part);
        else if (p.mode === 'swipe') {
          const dx = x - p.x0, dy = y - p.y0;
          if (dx > SWIPE && Math.abs(dx) > 1.5 * Math.abs(dy)) back();
        }
      },
      update(dt) {
        const wasDirty = dirty;
        if (dirty) { dirty = false; render(); }
        const shT = firstVisible();
        const cT = totalLength(shT, !!pvWanted) / 2;
        if (snap) { shCur = shT; cCur = cT; snap = false; layout(); return; }
        if (shCur === shT && cCur === cT) { if (wasDirty) layout(); return; }
        const k = 1 - Math.exp(-Math.min(0.1, Math.max(0, dt || 0)) * 10);
        shCur += (shT - shCur) * k;
        cCur += (cT - cCur) * k;
        if (Math.abs(shT - shCur) < 0.002) shCur = shT;
        if (Math.abs(cT - cCur) < 0.0005) cCur = cT;
        layout();
      },
      dispose() {
        for (const off of subs.values()) off();
        subs.clear();
        pvOff?.();
        imageTex?.dispose();
        if (arc) disposeTree(arc);
      },
    };
  },
};

export default definition;
