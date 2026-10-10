// fb-city — pure model: squarified treemap (copied from fb-treemap/layout.ts), type categories,
// recency → height, the 3-level city layout (districts, blocks, buildings, "+N" lots), hit testing,
// breadcrumbs and formatting. No three.js here (unit-tested in library/test/fb-city.test.ts).
//
// Coordinates: 2-D "map" space (u, v) in meters, centered on the table. The widget maps it to 3-D as
// x = u, z = −v (v grows away from the user), y = height above the city ground.

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** A node of the files source's `tree` reply. */
export interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  files: number;
  mtime: number | null;
  ext: string;
  children?: TreeNode[];
  skipped?: boolean;
}

export interface TreeReply { kind: 'tree'; path: string; display: string; root: TreeNode | null; partial: boolean; error?: string; nonce?: number }

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). `values` sorted descending and > 0; one rect per
 * value (zero-area rects for non-positive values), filling `r` exactly, biggest at the top-left.
 */
export function squarify(values: ArrayLike<number>, r: Rect): Rect[] {
  const n = values.length;
  const out: Rect[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) if (values[i] > 0) total += values[i];
  const W0 = r.x1 - r.x0, H0 = r.y1 - r.y0;
  for (let i = 0; i < n; i++) out[i] = { x0: r.x0, y0: r.y1, x1: r.x0, y1: r.y1 };
  if (!(total > 0) || !(W0 > 0) || !(H0 > 0)) return out;
  const scale = (W0 * H0) / total;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (values[i] > 0) idx.push(i);
  const area = (k: number) => values[idx[k]] * scale;
  let x0 = r.x0, y1 = r.y1, w = W0, h = H0;
  let i = 0;
  while (i < idx.length) {
    const side = Math.min(w, h);
    let j = i, sum = 0, best = Infinity;
    while (j < idx.length) {
      const s = sum + area(j);
      const big = area(i), small = area(j);
      const worst = Math.max((side * side * big) / (s * s), (s * s) / (side * side * small));
      if (j > i && worst > best) break;
      best = worst; sum = s; j++;
    }
    const last = j >= idx.length;
    if (w >= h) {
      const thick = last ? w : sum / h;
      let y = y1;
      for (let k = i; k < j; k++) {
        const hk = k === j - 1 ? y - (y1 - h) : area(k) / thick;
        out[idx[k]] = { x0, y0: y - hk, x1: x0 + thick, y1: y };
        y -= hk;
      }
      x0 += thick; w -= thick;
    } else {
      const thick = last ? h : sum / w;
      let x = x0;
      for (let k = i; k < j; k++) {
        const wk = k === j - 1 ? x0 + w - x : area(k) / thick;
        out[idx[k]] = { x0: x, y0: y1 - thick, x1: x + wk, y1 };
        x += wk;
      }
      y1 -= thick; h -= thick;
    }
    i = j;
  }
  return out;
}

// ---- categories ----------------------------------------------------------------------------------

export const CATEGORIES = ['folder', 'code', 'config', 'docs', 'data', 'image', 'video', 'audio', 'archive', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_INFO: Record<Category, { label: string; color: string; icon: string }> = {
  folder: { label: 'Folder', color: '#e0a83a', icon: 'folder' },
  code: { label: 'Code', color: '#4f9cf0', icon: 'file-code' },
  config: { label: 'Config', color: '#4fd9d4', icon: 'braces' },
  docs: { label: 'Docs', color: '#c3ccd8', icon: 'file-text' },
  data: { label: 'Data', color: '#a98bff', icon: 'database' },
  image: { label: 'Image', color: '#45d49b', icon: 'file-image' },
  video: { label: 'Video', color: '#ff6f91', icon: 'film' },
  audio: { label: 'Audio', color: '#f2dc5d', icon: 'music' },
  archive: { label: 'Archive', color: '#ff8a5b', icon: 'file-archive' },
  other: { label: 'Other', color: '#8a94a3', icon: 'file' },
};

const CAT_EXT: Array<[RegExp, Category]> = [
  [/^(ts|tsx|js|mjs|cjs|jsx|py|pyi|rs|go|c|h|cpp|hpp|cc|cxx|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|cuh|swift|dart|r|jl|sql|sh|bash|zsh|fish|ps1|bat|cmake|mk|zig|scala|ex|exs|hs|ml|html?|css|scss|sass|less|ipynb)$/, 'code'],
  [/^(json|jsonc|ya?ml|toml|ini|cfg|conf|xml|lock|env|properties|gradle|editorconfig|gitignore|plist)$/, 'config'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex|bib|rtf|epub|pptx?|odp)$/, 'docs'],
  [/^(csv|tsv|xlsx?|ods|parquet|arrow|feather|npy|npz|h5|hdf5|pt|pth|ckpt|safetensors|onnx|gguf|bin|pkl|pickle|db|sqlite3?|jsonl|ndjson|tfrecord|mat|nc|zarr|vdb|idx)$/, 'data'],
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|ico|psd|xcf|exr|hdr|raw|cr2|nef|dng|kra)$/, 'image'],
  [/^(mp4|mkv|webm|mov|avi|m4v|wmv|flv|mpg|mpeg)$/, 'video'],
  [/^(mp3|wav|flac|ogg|m4a|opus|aac|wma|mid|midi)$/, 'audio'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst|iso|dmg|deb|rpm|appimage|whl|jar|apk|img|vhdx?|vmdk|qcow2)$/, 'archive'],
];

export function categoryOf(n: Pick<TreeNode, 'type' | 'ext'>): Category {
  if (n.type === 'dir') return 'folder';
  const e = (n.ext || '').toLowerCase();
  for (const [re, c] of CAT_EXT) if (re.test(e)) return c;
  return 'other';
}

// ---- height ----------------------------------------------------------------------------------------

export const HEIGHT_MODES = ['recency', 'size', 'flat'] as const;
export type HeightMode = (typeof HEIGHT_MODES)[number];

/** Two years in hours: anything older is ground level. */
const OLD_H = 24 * 365 * 2;

/**
 * 0..1 from a modification time: 1 = just now, ~0.87 an hour ago, ~0.45 a day, ~0.22 a week,
 * ~0.11 a month, ~0 a year (squared log scale: today's work towers over the rest of the week, even
 * in a repo where everything is "recent").
 */
export function recency(mtime: number | null | undefined, now: number): number {
  if (!(typeof mtime === 'number' && mtime > 0)) return 0;
  const hours = Math.max(0, now - mtime) / 3.6e6;
  const k = 1 - Math.min(1, Math.max(0, Math.log10(1 + hours) / Math.log10(1 + OLD_H)));
  return k * k;
}

/** Newest known file mtime in a subtree (dirs have none of their own); null when unknown. */
export function newestOf(n: TreeNode): number | null {
  if (n.type !== 'dir') return typeof n.mtime === 'number' ? n.mtime : null;
  let best: number | null = null;
  for (const c of n.children ?? []) {
    const m = newestOf(c);
    if (m != null && (best == null || m > best)) best = m;
  }
  return best;
}

export function heightScore(n: TreeNode, mode: HeightMode, now: number): number {
  if (mode === 'flat') return 0.12;
  if (mode === 'size') return Math.min(1, Math.max(0, Math.log10(1 + Math.max(0, n.size)) / 10)); // 10 GB → 1
  return recency(n.mtime, now);
}

// ---- city layout ---------------------------------------------------------------------------------

export type TileKind = 'district' | 'block' | 'building' | 'lot';

export interface Tile {
  /** Footprint (map space). */
  r: Rect;
  level: 1 | 2 | 3;
  kind: TileKind;
  node: TreeNode | null;
  /** For a merged tail ("+N" lot). */
  more?: { count: number; size: number; files: number; skip: number };
  cat: Category;
  /** Base height above the city ground and solid height (m). */
  y0: number;
  h: number;
  /** Label strip depth along the near edge (map y0 side); 0 = none. */
  header: number;
  /** Where the children stand (null: closed district/block). */
  content: Rect | null;
  /** Range of direct children in City.tiles; parent index (-1 for level 1). */
  first: number;
  last: number;
  parent: number;
  /** Newest file below (dirs) or own mtime (files). */
  newest: number | null;
}

export interface City {
  area: Rect;
  tiles: Tile[];
  /** Number of level-1 tiles (they come first). */
  top: number;
  /** Children not drawn: size 0 (empty files, skipped node_modules/.git/…). */
  empty: number;
  /** Newest file in the whole folder (known part). */
  newest: number | null;
}

export interface LevelOptions {
  gap: number;
  minArea: number;
  max: number;
  minSide: number;
  /** Plinth height of a folder with children shown / of a closed folder. */
  plinth: number;
  closed: number;
  /** Label strip depth (0: none) and when a folder is big enough to get one. */
  header: number;
  headerW: number;
  headerH: number;
  /** A folder shows its children when at least this wide/deep. */
  nestW: number;
  nestH: number;
}

export interface CityOptions {
  levels: [LevelOptions, LevelOptions, LevelOptions];
  /** Building height range (m). */
  minHeight: number;
  maxHeight: number;
  /** Height is at most this × the building's smaller side (no needles). */
  maxAspect: number;
  heightBy: HeightMode;
  /** Footprint area ∝ size^gamma (1 = proportional; 0.5 = balanced: small folders stay visible). */
  gamma: number;
  /** Deepest level drawn (1–3). */
  depth: number;
  /** Instance budget. */
  maxTiles: number;
}

export const DEFAULT_CITY: CityOptions = {
  levels: [
    { gap: 0.012, minArea: 0.034 * 0.034, max: 48, minSide: 0.032, plinth: 0.012, closed: 0.026, header: 0.04, headerW: 0.12, headerH: 0.09, nestW: 0.09, nestH: 0.09 },
    { gap: 0.006, minArea: 0.024 * 0.024, max: 30, minSide: 0.022, plinth: 0.008, closed: 0.016, header: 0.024, headerW: 0.075, headerH: 0.07, nestW: 0.07, nestH: 0.07 },
    { gap: 0.003, minArea: 0.013 * 0.013, max: 16, minSide: 0.011, plinth: 0.005, closed: 0.008, header: 0, headerW: Infinity, headerH: Infinity, nestW: Infinity, nestH: Infinity },
  ],
  minHeight: 0.008, maxHeight: 0.16, maxAspect: 7, heightBy: 'recency', gamma: 0.5, depth: 3, maxTiles: 1800,
};

/** Minimum share of the area for a "+N" lot. */
export const MORE_FLOOR = 0.015;
/** …and at most this share of the drawn items' weight (a tail of many small items isn't a landmark). */
export const MORE_CAP = 0.12;

/** Split sorted children into drawn items and a merged tail (by area threshold and count). */
export function groupChildren(children: TreeNode[], areaM2: number, minArea: number, max: number, skip = 0, gamma = 1): { items: TreeNode[]; more: Tile['more'] | null; moreWeight: number; empty: number } {
  const wt = (n: TreeNode) => (gamma === 1 ? n.size : Math.pow(n.size, gamma));
  const sorted = children.filter((c) => c && typeof c.size === 'number').slice().sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const positive = sorted.filter((c) => c.size > 0).slice(skip);
  const empty = sorted.length - skip - positive.length;
  let total = 0;
  for (const c of positive) total += wt(c);
  const items: TreeNode[] = [];
  if (total <= 0) return { items, more: null, moreWeight: 0, empty: Math.max(0, empty) };
  let i = 0;
  for (; i < positive.length && items.length < max; i++) {
    const a = (wt(positive[i]) / total) * areaM2;
    if (a < minArea && items.length > 0) break;
    items.push(positive[i]);
  }
  if (positive.length - i === 1 && items.length < max) { items.push(positive[i]); i++; }
  if (i >= positive.length) return { items, more: null, moreWeight: 0, empty: Math.max(0, empty) };
  let size = 0, files = 0, moreWeight = 0;
  for (let k = i; k < positive.length; k++) { size += positive[k].size; files += positive[k].files || 0; moreWeight += wt(positive[k]); }
  return { items, more: { count: positive.length - i, size, files, skip: skip + i }, moreWeight, empty: Math.max(0, empty) };
}

/** groupChildren + squarify; tiles thinner than `minSide` (and everything smaller) join the tail. */
export function layoutLevel(children: TreeNode[], r: Rect, minArea: number, max: number, minSide: number, skip = 0, gamma = 1) {
  let cap = max;
  for (let iter = 0; ; iter++) {
    const g = groupChildren(children, areaOf(r), minArea, cap, skip, gamma);
    const weights = g.items.map((c) => (gamma === 1 ? c.size : Math.pow(c.size, gamma)));
    let total = 0;
    for (const w of weights) total += w;
    const n = weights.length;
    if (g.more) weights.push(Math.max(Math.min(g.moreWeight, total * MORE_CAP), (total + g.moreWeight) * MORE_FLOOR));
    const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
    const sorted = squarify(order.map((i) => weights[i]), r);
    const rects: Rect[] = new Array(weights.length);
    order.forEach((i, k) => { rects[i] = sorted[k]; });
    let thin = -1;
    for (let i = 1; i < rects.length; i++) {
      const q = rects[i];
      if (Math.min(q.x1 - q.x0, q.y1 - q.y0) < minSide) { thin = i; break; }
    }
    if (thin < 0 || iter >= 12 || n <= 1) return { ...g, weights, rects };
    cap = Math.max(1, Math.min(thin, n - 1));
  }
}

export const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: Math.max(r.x0 + d, r.x1 - d), y1: Math.max(r.y0 + d, r.y1 - d) });
export const areaOf = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
export const minSideOf = (r: Rect) => Math.min(r.x1 - r.x0, r.y1 - r.y0);

/**
 * Lay out a folder as a city in `area`: level-1 children are districts (folders) and buildings
 * (files); folders big enough show their children on a raised plinth (blocks and buildings), down to
 * `depth` levels. `skip` shows the tail of the folder (the "+N" lot). Deterministic: the same tree
 * gives the same city (biggest first, ties by name).
 */
export function buildCity(root: TreeNode, area: Rect, o: CityOptions = DEFAULT_CITY, skip = 0, now = Date.now()): City {
  const tiles: Tile[] = [];
  const city: City = { area, tiles, top: 0, empty: 0, newest: null };
  const depth = Math.max(1, Math.min(3, Math.round(o.depth) || 3));
  const g = place(root.children ?? [], area, 1, 0, -1, skip);
  city.top = tiles.length;
  city.empty = g.empty;
  // children of each tile go in one contiguous range (breadth first per parent)
  const queue: number[] = [];
  for (let i = 0; i < city.top; i++) queue.push(i);
  while (queue.length) {
    const i = queue.shift()!;
    const t = tiles[i];
    t.first = t.last = tiles.length;
    if (!t.content || !t.node || t.level >= depth) { if (t.content && t.level >= depth) closeTile(t); continue; }
    if (tiles.length >= o.maxTiles) { closeTile(t); continue; }
    place(t.node.children ?? [], t.content, (t.level + 1) as 2 | 3, t.y0 + t.h, i, 0);
    t.last = tiles.length;
    if (t.last === t.first) { closeTile(t); continue; }
    for (let k = t.first; k < t.last; k++) queue.push(k);
  }
  let newest: number | null = null;
  for (const c of root.children ?? []) { const m = newestOf(c); if (m != null && (newest == null || m > newest)) newest = m; }
  city.newest = newest;
  return city;

  function closeTile(t: Tile): void {
    const L = o.levels[t.level - 1];
    t.content = null;
    t.h = t.kind === 'district' || t.kind === 'block' ? L.closed : t.h;
  }

  function place(children: TreeNode[], r: Rect, level: 1 | 2 | 3, base: number, parent: number, sk: number) {
    const L = o.levels[level - 1];
    const lv = layoutLevel(children, r, L.minArea, L.max, L.minSide, sk, o.gamma);
    for (let k = 0; k < lv.rects.length; k++) {
      const node = k < lv.items.length ? lv.items[k] : null;
      const rr = inset(lv.rects[k], L.gap / 2);
      const w = rr.x1 - rr.x0, d = rr.y1 - rr.y0;
      if (!(w > 0 && d > 0)) continue;
      const tile: Tile = { r: rr, level, kind: 'lot', node, cat: node ? categoryOf(node) : 'other', y0: base, h: L.plinth, header: 0, content: null, first: 0, last: 0, parent, newest: null };
      if (!node) {
        tile.more = lv.more!;
        tile.h = L.plinth * 0.6;
      } else if (node.type === 'dir') {
        tile.kind = level === 1 ? 'district' : 'block';
        tile.newest = newestOf(node);
        const kids = node.children ?? [];
        if (kids.length && level < 3 && w >= L.nestW && d >= L.nestH) {
          tile.header = w >= L.headerW && d >= L.headerH ? L.header : 0;
          const pad = level === 1 ? 0.006 : 0.004;
          tile.content = { x0: rr.x0 + pad, x1: rr.x1 - pad, y0: rr.y0 + pad + tile.header, y1: rr.y1 - pad };
          if (tile.content.x1 - tile.content.x0 < 0.02 || tile.content.y1 - tile.content.y0 < 0.02) { tile.content = null; tile.header = 0; }
        }
        tile.h = tile.content ? L.plinth : L.closed;
      } else {
        tile.kind = 'building';
        tile.newest = typeof node.mtime === 'number' ? node.mtime : null;
        // a sidewalk around each building
        const side = Math.min(w, d);
        tile.r = inset(rr, Math.min(0.004, side * 0.12));
        const s = minSideOf(tile.r);
        const score = heightScore(node, o.heightBy, now);
        tile.h = Math.max(o.minHeight * 0.5, Math.min(o.minHeight + (o.maxHeight - o.minHeight) * score, Math.max(o.minHeight, s * o.maxAspect)));
      }
      tiles.push(tile);
    }
    return lv;
  }
}

// ---- hit testing -----------------------------------------------------------------------------------

const within = (r: Rect, x: number, y: number, e: number) => x >= r.x0 - e && x <= r.x1 + e && y >= r.y0 - e && y <= r.y1 + e;

/**
 * Tile under map point (u, v) at height y (null: any height): the deepest tile containing the point
 * whose solid spans y (hits on a building's side resolve to it, hits on a plinth to the plinth);
 * falls back to the deepest containing tile. -1: none (gaps between districts).
 */
export function hitTest(c: City, u: number, v: number, y: number | null = null, eps = 0.002): number {
  const chain: number[] = [];
  let lo = 0, hi = c.top;
  for (;;) {
    let found = -1;
    for (let i = lo; i < hi; i++) if (within(c.tiles[i].r, u, v, eps)) { found = i; break; }
    if (found < 0) break;
    chain.push(found);
    const t = c.tiles[found];
    if (t.last <= t.first) break;
    lo = t.first; hi = t.last;
  }
  if (!chain.length) return -1;
  if (y != null) {
    for (let k = chain.length - 1; k >= 0; k--) {
      const t = c.tiles[chain[k]];
      if (y >= t.y0 - 0.004 && y <= t.y0 + t.h + 0.004) return chain[k];
    }
  }
  return chain[chain.length - 1];
}

/**
 * What a pinch on tile `i` should act on: small level-3 tiles (< `minTarget`) stand for their block,
 * so two-level jumps stay easy targets.
 */
export function actionTile(c: City, i: number, minTarget = 0.024): number {
  let t = c.tiles[i];
  while (t && t.level === 3 && t.parent >= 0 && minSideOf(t.r) < minTarget) { i = t.parent; t = c.tiles[i]; }
  return i;
}

/** Where `path` (a descendant of the laid-out folder) sits: the deepest tile on its way, or -1. */
export function tileForPath(c: City, path: string): number {
  const under = (p: string) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/');
  let lo = 0, hi = c.top, best = -1;
  for (;;) {
    let found = -1;
    for (let i = lo; i < hi; i++) { const n = c.tiles[i].node; if (n && under(n.path)) { found = i; break; } }
    if (found < 0) return best;
    best = found;
    const t = c.tiles[found];
    if (t.last <= t.first) return best;
    lo = t.first; hi = t.last;
  }
}

// ---- paths / formatting ------------------------------------------------------------------------------

export interface Crumb { label: string; path: string }

/** "~/a/b" → ~, a, b; "/usr/lib" → /, usr, lib (paths in the same display form). */
export function crumbsOf(display: string): Crumb[] {
  const d = (display || '~').replace(/\/+$/, '') || '/';
  const out: Crumb[] = [];
  let parts: string[], acc: string;
  if (d === '~' || d.startsWith('~/')) { out.push({ label: '~', path: '~' }); acc = '~'; parts = d.slice(2).split('/'); }
  else { out.push({ label: '/', path: '/' }); acc = ''; parts = d.slice(1).split('/'); }
  for (const p of parts) {
    if (!p) continue;
    acc = `${acc}/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}

/** True when `child` is `parent` itself or below it. */
export function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent === '/' ? '/' : parent + '/');
}

/** Bytes with binary units: "812 B", "4.10 KB", "38.0 MB", "2.31 GB". */
export function fmtSize(n: number): string {
  if (!(n >= 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${v} B`;
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}

export function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** "just now", "12 min ago", "3 h ago", "5 d ago", "Mar 4, 2024". */
export function fmtAge(mtime: number | null | undefined, now = Date.now()): string {
  if (!(typeof mtime === 'number' && mtime > 0)) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 45) return `${Math.floor(s / 86400)} d ago`;
  return new Date(mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
