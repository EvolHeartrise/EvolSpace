// fb-treemap — pure layout: squarified treemap, type categories, tile model, hit testing,
// breadcrumbs and size formatting. No three.js here (unit-tested in library/test/fb-treemap.test.ts).

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
 * Squarified treemap (Bruls, Huizing, van Wijk). `values` should be sorted descending and > 0;
 * returns one rect per value (zero-area rects for non-positive values), filling `r` exactly,
 * biggest at the top-left. y grows upwards (y1 = top).
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
      // a column on the left, items top → bottom
      const thick = last ? w : sum / h;
      let y = y1;
      for (let k = i; k < j; k++) {
        const hk = k === j - 1 ? y - (y1 - h) : area(k) / thick;
        out[idx[k]] = { x0, y0: y - hk, x1: x0 + thick, y1: y };
        y -= hk;
      }
      x0 += thick; w -= thick;
    } else {
      // a row at the top, items left → right
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
  folder: { label: 'Sub-folders', color: '#e0a83a', icon: 'folder' },
  code: { label: 'Code', color: '#4f9cf0', icon: 'file-code' },
  config: { label: 'Config', color: '#4fd9d4', icon: 'braces' },
  docs: { label: 'Docs', color: '#b4bfcd', icon: 'file-text' },
  data: { label: 'Data', color: '#a98bff', icon: 'database' },
  image: { label: 'Images', color: '#45d49b', icon: 'file-image' },
  video: { label: 'Video', color: '#ff6f91', icon: 'film' },
  audio: { label: 'Audio', color: '#f2dc5d', icon: 'music' },
  archive: { label: 'Archives', color: '#ff8a5b', icon: 'file-archive' },
  other: { label: 'Other', color: '#7d8796', icon: 'file' },
};

const CAT_EXT: Array<[RegExp, Category]> = [
  [/^(ts|tsx|js|mjs|cjs|jsx|py|pyi|rs|go|c|h|cpp|hpp|cc|cxx|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|cuh|swift|dart|r|jl|sql|sh|bash|zsh|fish|ps1|bat|cmake|mk|zig|scala|ex|exs|hs|ml|html?|css|scss|sass|less|ipynb)$/, 'code'],
  [/^(json|jsonc|ya?ml|toml|ini|cfg|conf|xml|lock|env|properties|gradle|editorconfig|gitignore|plist)$/, 'config'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex|bib|rtf|epub|pptx?|odp)$/, 'docs'],
  [/^(csv|tsv|xlsx?|ods|parquet|arrow|feather|npy|npz|h5|hdf5|pt|pth|ckpt|safetensors|onnx|gguf|bin|pkl|pickle|db|sqlite3?|jsonl|ndjson|tfrecord|mat|nc|zarr|vdb|idx)$/, 'data'],
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|ico|psd|xcf|exr|hdr|raw|cr2|nef|dng|kra)$/, 'image'],
  [/^(mp4|mkv|webm|mov|avi|m4v|wmv|flv|mpg|mpeg|ts_video)$/, 'video'],
  [/^(mp3|wav|flac|ogg|m4a|opus|aac|wma|mid|midi)$/, 'audio'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst|iso|dmg|deb|rpm|appimage|whl|jar|apk|img|vhdx?|vmdk|qcow2)$/, 'archive'],
];

export function categoryOf(n: Pick<TreeNode, 'type' | 'ext'>): Category {
  if (n.type === 'dir') return 'folder';
  const e = (n.ext || '').toLowerCase();
  for (const [re, c] of CAT_EXT) if (re.test(e)) return c;
  return 'other';
}

// ---- tile model ------------------------------------------------------------------------------------

export interface Tile {
  /** Outer rect (gaps already applied). */
  r: Rect;
  /** 1 = child of the shown folder, 2 = grandchild drawn inside a folder tile. */
  level: 1 | 2;
  node: TreeNode | null;
  /** For a merged tail ("other") tile. */
  more?: { count: number; size: number; files: number; skip: number };
  cat: Category;
  /** Level-1 folder tiles with nested tiles: header strip height and the content rect. */
  header: number;
  content: Rect | null;
  /** Level-1 tile: index range of its nested tiles in Layout.tiles. Level-2: index of the parent. */
  first: number;
  last: number;
  parent: number;
}

export interface Layout {
  area: Rect;
  tiles: Tile[];
  /** Number of level-1 tiles (they come first in `tiles`). */
  top: number;
  total: number;
  /** Children not drawn: size 0 (empty files, skipped node_modules/.git/…). */
  empty: number;
  /** Bytes per category over the known leaves (nested level counts where available). */
  byCat: Record<Category, number>;
}

export interface LayoutOptions {
  /** Gap between level-1 tiles (m). */
  gap: number;
  /** Smallest level-1 tile area (m²) before the tail is merged into "+N more". */
  minArea: number;
  maxTiles: number;
  /** Nested tiles inside folder tiles. */
  nested: boolean;
  minInner: number;
  maxInner: number;
  /** Tiles thinner than this (m) are merged into the tail too (level 1 / nested). */
  minSide: number;
  minSideInner: number;
  /** Header strip of folder tiles (m); `headerBig` for big folder tiles (≥ bigW × bigH). */
  header: number;
  headerBig: number;
  bigW: number;
  bigH: number;
  /** A folder tile shows nested tiles when at least this wide/tall (m). */
  nestW: number;
  nestH: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  gap: 0.004, minArea: 0.03 * 0.03, maxTiles: 64, nested: true, minInner: 0.018 * 0.018, maxInner: 36, minSide: 0.024, minSideInner: 0.012,
  header: 0.03, headerBig: 0.044, bigW: 0.28, bigH: 0.2, nestW: 0.07, nestH: 0.075,
};

/** Split sorted children into drawn items and a merged tail (by area threshold and count). */
export function groupChildren(children: TreeNode[], areaM2: number, minArea: number, max: number, skip = 0): { items: TreeNode[]; more: Tile['more'] | null; empty: number } {
  const sorted = children.filter((c) => c && typeof c.size === 'number').slice().sort((a, b) => b.size - a.size);
  const positive = sorted.filter((c) => c.size > 0).slice(skip);
  const empty = sorted.length - skip - positive.length;
  let total = 0;
  for (const c of positive) total += c.size;
  const items: TreeNode[] = [];
  if (total <= 0) return { items, more: null, empty: Math.max(0, empty) };
  let i = 0;
  for (; i < positive.length && items.length < max; i++) {
    const a = (positive[i].size / total) * areaM2;
    if (a < minArea && items.length > 0) break;
    items.push(positive[i]);
  }
  // a tail of exactly one item is shown as itself (a "+1 more" tile would hide its name for nothing)
  if (positive.length - i === 1 && items.length < max) { items.push(positive[i]); i++; }
  if (i >= positive.length) return { items, more: null, empty: Math.max(0, empty) };
  let size = 0, files = 0;
  for (let k = i; k < positive.length; k++) { size += positive[k].size; files += positive[k].files || 0; }
  return { items, more: { count: positive.length - i, size, files, skip: skip + i }, empty: Math.max(0, empty) };
}

/**
 * groupChildren + squarify, then merge any tile thinner than `minSide` (and everything smaller) into
 * the tail as well, so every drawn tile stays a usable target. Returns items, tail and their rects.
 */
export function layoutLevel(children: TreeNode[], r: Rect, minArea: number, max: number, minSide: number, skip = 0) {
  let cap = max;
  for (let iter = 0; ; iter++) {
    const g = groupChildren(children, areaOf(r), minArea, cap, skip);
    const weights = g.items.map((c) => c.size);
    // the "+N more" tile gets a floor area (it is a target, not a measurement) and sorts by it
    let total = 0;
    for (const w of weights) total += w;
    const n = weights.length;
    if (g.more) weights.push(Math.max(g.more.size, (total + g.more.size) * MORE_FLOOR));
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

/** Minimum share of the area for a "+N more" tile. */
export const MORE_FLOOR = 0.015;

const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: Math.max(r.x0 + d, r.x1 - d), y1: Math.max(r.y0 + d, r.y1 - d) });
const areaOf = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

/** Lay out a folder's children into `area` (with an optional tail offset, for "+N more"). */
export function buildLayout(root: TreeNode, area: Rect, o: LayoutOptions = DEFAULT_LAYOUT, skip = 0): Layout {
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const tiles: Tile[] = [];
  const g = layoutLevel(root.children ?? [], area, o.minArea, o.maxTiles, o.minSide, skip);
  const { weights, rects } = g;
  let total = 0;
  for (const w of weights) total += w;
  const top = weights.length;
  for (let i = 0; i < top; i++) {
    const node = i < g.items.length ? g.items[i] : null;
    const r = inset(rects[i], o.gap / 2);
    tiles.push({ r, level: 1, node, more: node ? undefined : g.more!, cat: node ? categoryOf(node) : 'other', header: 0, content: null, first: 0, last: 0, parent: -1 });
  }
  // nested tiles go after all level-1 tiles
  for (let i = 0; i < top; i++) {
    const t = tiles[i];
    t.first = t.last = tiles.length;
    const n = t.node;
    if (!n) { byCat.other += t.more!.size; continue; }
    const w = t.r.x1 - t.r.x0, h = t.r.y1 - t.r.y0;
    const kids = n.type === 'dir' ? n.children ?? [] : [];
    if (!(o.nested && n.type === 'dir' && kids.length && w >= o.nestW && h >= o.nestH)) {
      if (n.type === 'dir' && kids.length) addCats(byCat, n);
      else byCat[t.cat] += n.size;
      continue;
    }
    t.header = w >= o.bigW && h >= o.bigH ? o.headerBig : o.header;
    const c = { x0: t.r.x0 + 0.003, x1: t.r.x1 - 0.003, y0: t.r.y0 + 0.003, y1: t.r.y1 - t.header };
    t.content = c;
    const gi = layoutLevel(kids, c, o.minInner, o.maxInner, o.minSideInner);
    const wi = gi.weights, ri = gi.rects;
    for (let k = 0; k < wi.length; k++) {
      const kn = k < gi.items.length ? gi.items[k] : null;
      const cat = kn ? categoryOf(kn) : 'other';
      tiles.push({ r: inset(ri[k], 0.0012), level: 2, node: kn, more: kn ? undefined : gi.more!, cat, header: 0, content: null, first: 0, last: 0, parent: i });
      if (kn && kn.type === 'dir' && kn.children?.length) addCats(byCat, kn);
      else byCat[cat] += kn ? kn.size : gi.more!.size;
    }
    t.last = tiles.length;
  }
  return { area, tiles, top, total, empty: g.empty, byCat };
}

function addCats(byCat: Record<Category, number>, n: TreeNode): void {
  let known = 0;
  for (const c of n.children ?? []) {
    if (c.type === 'dir' && c.children?.length) addCats(byCat, c);
    else byCat[categoryOf(c)] += c.size;
    known += c.size;
  }
  // children are capped at 200 per folder: the remainder stays "folder"
  if (n.size > known) byCat.folder += n.size - known;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Index of the tile under (x, y): a nested tile wins over its folder tile; -1 for none (gaps count as their folder). */
export function hitTest(l: Layout, x: number, y: number): number {
  for (let i = 0; i < l.top; i++) {
    const t = l.tiles[i];
    if (!inside(t.r, x, y)) continue;
    for (let k = t.first; k < t.last; k++) if (inside(l.tiles[k].r, x, y)) return k;
    return i;
  }
  return -1;
}

/** Where `path` (a descendant of the laid-out folder) sits: the deepest tile on its way, or -1. */
export function tileForPath(l: Layout, path: string): number {
  const under = (p: string) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/');
  for (let i = 0; i < l.top; i++) {
    const n = l.tiles[i].node;
    if (!n || !under(n.path)) continue;
    const t = l.tiles[i];
    for (let k = t.first; k < t.last; k++) { const kn = l.tiles[k].node; if (kn && under(kn.path)) return k; }
    return i;
  }
  return -1;
}

// ---- paths -------------------------------------------------------------------------------------------

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

/** Bytes with binary units up to TB: "812 B", "4.1 KB", "38 MB", "2.31 GB". */
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
