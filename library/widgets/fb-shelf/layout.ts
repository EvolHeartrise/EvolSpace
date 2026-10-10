// fb-shelf — pure layout: file categories (spine color / book height), book thickness ∝ log(size),
// folder boxes ∝ log(recursive size), the bookcase's shelf geometry, and filling shelves
// left→right, top→bottom (folders first, on their own shelves), page by page.
// No three.js here, so tests can check placements directly.

import { mixHex } from '../../shared/color.ts';

export interface Entry { name: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string }

export type Category = 'folder' | 'code' | 'doc' | 'data' | 'image' | 'video' | 'audio' | 'archive' | 'shell' | 'key' | 'other';

/** Spine color, nominal book height (m) and Lucide icon per category. */
export const CATS: Record<Category, { color: string; height: number; icon: string; label: string }> = {
  folder: { color: '#c39a5f', height: 0.235, icon: 'folder', label: 'folder' },
  code: { color: '#5fa8e8', height: 0.215, icon: 'file-code', label: 'code' },
  doc: { color: '#ddd5c4', height: 0.24, icon: 'file-text', label: 'text' },
  data: { color: '#58c4c4', height: 0.198, icon: 'braces', label: 'data' },
  image: { color: '#72d08c', height: 0.25, icon: 'file-image', label: 'image' },
  video: { color: '#b592f2', height: 0.255, icon: 'film', label: 'video' },
  audio: { color: '#f08fc0', height: 0.2, icon: 'music', label: 'audio' },
  archive: { color: '#e2b24c', height: 0.184, icon: 'file-archive', label: 'archive' },
  shell: { color: '#97b8dc', height: 0.205, icon: 'file-terminal', label: 'script' },
  key: { color: '#f2897f', height: 0.172, icon: 'file-key', label: 'key' },
  other: { color: '#8f99a8', height: 0.19, icon: 'file', label: 'file' },
};

const RULES: Array<[RegExp, Category]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|ico)$/, 'image'],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, 'video'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, 'audio'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst|whl|deb)$/, 'archive'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml|csv|tsv|xlsx?|ods|parquet|lock|npz|npy|pt|safetensors)$/, 'data'],
  [/^(sh|bash|zsh|fish|ps1|bat|cmd)$/, 'shell'],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|cuh|swift|dart|r|jl|sql|css|scss|html?)$/, 'code'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex|bib)$/, 'doc'],
  [/^(pem|key|crt|cer|p12|pfx|pub)$/, 'key'],
];

export function categoryOf(e: Pick<Entry, 'type' | 'ext' | 'name'>): Category {
  if (e.type === 'dir') return 'folder';
  const ext = (e.ext || '').toLowerCase();
  for (const [re, c] of RULES) if (re.test(ext)) return c;
  if (/^(readme|license|changelog|notes)/i.test(e.name)) return 'doc';
  if (/^(dockerfile|makefile|\.gitignore|\.npmrc)$/i.test(e.name)) return 'data';
  return 'other';
}

/** Stable hash of a string → [0, 1). */
export function hash01(s: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0) / 4294967296;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Spine thickness (m): 2 cm for an empty file … ~6.5 cm at 1 GB (log scale). */
export function bookThickness(size: number | null): number {
  const t = clamp01(Math.log10(Math.max(1, size ?? 1)) / 9);
  return 0.02 + t * 0.045;
}

/** Folder box width (m) from the recursive size: 6 cm (≤ 1 KB) … 16 cm (≥ 1 GB); 9 cm while unknown. */
export function boxWidth(size: number | null | undefined): number {
  if (size == null) return 0.09;
  return 0.06 + 0.1 * boxT(size);
}

/** 0 (≤ 1 KB) … 1 (≥ 1 GB) on a log scale. */
export function boxT(size: number): number {
  return clamp01((Math.log10(Math.max(1, size)) - 3) / 6);
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null || !(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** "5 min ago", "3 h ago", "2 d ago", or a date. */
export function ageText(mtime: number | null | undefined, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(mtime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- case geometry --------------------------------------------------------------------------

export const SIDE = 0.026;   // side board thickness
export const PLINTH = 0.07;  // bottom plinth height
export const TOP = 0.03;     // top board
export const BOARD = 0.02;   // shelf board thickness
export const BACK = 0.012;   // back panel
export const INSET = 0.008;  // gap between side boards and the first/last item

export interface CaseDims { width: number; height: number; depth: number; shelves: number }

export function shelvesFor(height: number): number {
  return Math.max(2, Math.min(9, Math.round((height - 0.1) / 0.3)));
}

export function caseDims(width: number, height: number, depth = 0.3): CaseDims {
  return { width, height, depth, shelves: shelvesFor(height) };
}

/** Shelf pitch, clear height, and the base (top surface) y of shelf k (0 = top shelf). */
export function shelfGeometry(d: CaseDims) {
  const pitch = (d.height - TOP - PLINTH) / d.shelves;
  const clear = pitch - BOARD;
  const x0 = -d.width / 2 + SIDE + INSET, x1 = d.width / 2 - SIDE - INSET;
  const base = (k: number) => PLINTH + (d.shelves - 1 - k) * pitch;
  return { pitch, clear, x0, x1, base, front: d.depth / 2 - 0.012 };
}

// ---- sorting + filling --------------------------------------------------------------------------

export type SortMode = 'name' | 'recent';

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;
const cmpName = (a: Entry, b: Entry) => (collator ? collator.compare(a.name, b.name) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Folders first; then by name (A→Z) or by modification time (newest first). */
export function sortEntries(entries: Entry[], mode: SortMode): Entry[] {
  const out = entries.slice();
  out.sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1, db = b.type === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    if (mode === 'recent') { const d = (b.mtime ?? 0) - (a.mtime ?? 0); if (d) return d; }
    return cmpName(a, b);
  });
  return out;
}

export interface Slot {
  /** Index into the sorted entries. */
  i: number;
  name: string;
  folder: boolean;
  cat: Category;
  page: number;
  shelf: number;
  /** Center x, width (thickness), height, depth (m, case coordinates). */
  x: number; w: number; h: number; d: number;
  /** Spine color (hex). */
  color: string;
  /** Recursive size for folders (if known), file size otherwise. */
  size: number | null;
}

export interface CaseLayout { slots: Slot[]; pages: number; pageStart: number[] }

const BOOK_GAP = 0.0025;
const BOX_GAP = 0.01;

/** Spine color with a stable per-name shade so neighbours of one type stay distinguishable. */
export function spineColor(cat: Category, name: string): string {
  const base = CATS[cat].color;
  const t = (hash01(name, 0x9e3779b9) - 0.5) * 0.3;
  return t < 0 ? mixHex(base, '#000000', -t) : mixHex(base, '#ffffff', t * 0.6);
}

/**
 * Fill the case: folder boxes from the top-left, then books starting on a fresh shelf; a shelf
 * that is full wraps to the next, a full case continues on the next page. Sizes of folders come
 * from `folderSizes` (name → recursive bytes) when known.
 */
export function layoutCase(sorted: Entry[], dims: CaseDims, folderSizes?: Map<string, number>): CaseLayout {
  const g = shelfGeometry(dims);
  const slots: Slot[] = [];
  const pageStart = [0];
  let page = 0, shelf = 0, x = g.x0, prevFolder: boolean | null = null;
  const newShelf = () => {
    shelf++;
    x = g.x0;
    if (shelf >= dims.shelves) { page++; shelf = 0; pageStart.push(slots.length); }
  };
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const folder = e.type === 'dir';
    // books start on their own shelf below the folder boxes
    if (prevFolder === true && !folder && x > g.x0) newShelf();
    prevFolder = folder;
    const cat = categoryOf(e);
    const size = folder ? (folderSizes?.get(e.name) ?? null) : e.size;
    const jitter = hash01(e.name) - 0.5;
    const w = folder ? boxWidth(folderSizes ? folderSizes.get(e.name) : undefined) : bookThickness(e.size);
    const fs = folder ? folderSizes?.get(e.name) : undefined;
    const h = Math.min(g.clear - 0.026, folder ? (fs == null ? 0.215 : 0.185 + 0.06 * boxT(fs)) : CATS[cat].height + jitter * 0.016);
    const d = folder ? Math.min(dims.depth - 0.05, 0.24) : Math.min(dims.depth - 0.06, 0.165 + jitter * 0.03);
    const gap = folder ? BOX_GAP : BOOK_GAP;
    if (x + w > g.x1 + 1e-6 && x > g.x0) newShelf();
    slots.push({ i, name: e.name, folder, cat, page, shelf, x: x + w / 2, w, h, d, color: folder ? spineColor('folder', e.name) : spineColor(cat, e.name), size });
    x += w + gap;
  }
  return { slots, pages: page + 1, pageStart };
}

/** Slots of one page (a contiguous run of the layout). */
export function pageSlots(l: CaseLayout, page: number): Slot[] {
  const a = l.pageStart[page] ?? l.slots.length;
  const b = l.pageStart[page + 1] ?? l.slots.length;
  return l.slots.slice(a, b);
}

/**
 * The slot under a point (case coordinates) on a page: the shelf whose clear space contains y,
 * then the slot whose [x ± (w + gap) / 2] contains x (or the nearest within 1.5 cm).
 */
export function slotAt(slots: Slot[], dims: CaseDims, x: number, y: number): Slot | null {
  const g = shelfGeometry(dims);
  let shelf = -1;
  for (let k = 0; k < dims.shelves; k++) {
    const b = g.base(k);
    if (y >= b - BOARD && y < b + g.pitch - BOARD) { shelf = k; break; }
  }
  if (shelf < 0) return null;
  let best: Slot | null = null, bestD = 0.015;
  for (const s of slots) {
    if (s.shelf !== shelf) continue;
    const half = s.w / 2 + (s.folder ? BOX_GAP : BOOK_GAP) / 2;
    const dx = Math.abs(x - s.x) - half;
    if (dx <= 0) return s;
    if (dx < bestD) { bestD = dx; best = s; }
  }
  return best;
}

/** Up to n slot indices (into `slots`) of kind `folder` (null = any), nearest to a focus point first. */
export function nearestSlots(slots: Slot[], dims: CaseDims, folder: boolean | null, fx: number, fy: number, n: number): number[] {
  const g = shelfGeometry(dims);
  const idx: number[] = [];
  const dist: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (folder !== null && s.folder !== folder) continue;
    idx.push(i);
    const dy = g.base(s.shelf) + s.h / 2 - fy;
    dist[i] = (s.x - fx) * (s.x - fx) + dy * dy * 2.5;
  }
  idx.sort((a, b) => dist[a] - dist[b]);
  return idx.slice(0, n);
}

/** Characters that fit a vertical spine label of length `len` at font size `size`. */
export function spineChars(len: number, size: number): number {
  return Math.max(3, Math.floor(len / (size * 0.56)));
}

/** Path helpers (POSIX-style absolute paths from the files source). */
export function parentOf(p: string): string | null {
  if (!p || p === '/') return null;
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return null;
  return i === 0 ? '/' : s.slice(0, i);
}

export function baseName(p: string): string {
  if (p === '/') return '/';
  const s = p.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/** The chain [p, parent, grandparent, …] with at most `n` entries. */
export function pathChain(p: string, n: number): string[] {
  const out: string[] = [];
  for (let c: string | null = p; c && out.length < n; c = parentOf(c)) out.push(c);
  return out;
}
