// fb-tunnel — pure model: tunnel geometry, the wall layout (which entry sits where), path levels and
// the ring plan of a navigation (which ring moves from which depth slot to which). No three.js here, so
// the layout is unit-testable and identical on every client (stable spatial memory per folder).
//
// Coordinates are the entity's local frame: the origin is the viewing MOUTH of the tunnel, +Y up, the
// tunnel recedes along −Z, the viewer stands on the axis at z ≈ +EYE_Z looking down −Z.

export interface Entry { name: string; type: 'dir' | 'file' | 'link'; size: number | null; mtime: number | null; ext: string }

/** Tunnel geometry (meters / radians). */
export const GEO = {
  /** Assumed eye point on the axis (tiles and labels face it). */
  EYE_Z: 0.7,
  /** Cone: radius at the mouth (z = 0) and at the far portal (z = Z_FAR). */
  R_MOUTH: 0.58,
  R_FAR: 0.25,
  Z_FAR: -0.9,
  /** Radius of the current folder's portal disc. */
  R_PORTAL: 0.22,
  /** Tiles sit this far inside the cone (the level rings frame them from outside). */
  INSET: 0.04,
  /** Half-angle of each arc (folders: around the top, files: around the bottom). */
  ARC: (76 * Math.PI) / 180,
  /** Tile size (unscaled) and the minimum center distance between neighbours on a row. */
  TILE_W: 0.17,
  TILE_H: 0.064,
  TILE_D: 0.008,
  PITCH: 0.19,
  /** Wall rows (depth of each, and a mild size boost for farther rows to keep them readable). */
  ROWS: [
    { z: -0.04, s: 1.0 },
    { z: -0.28, s: 1.08 },
  ],
} as const;

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number) => clamp(x, 0, 1);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Radius of the tunnel cone at depth z (extrapolated in front of the mouth / beyond the portal). */
export function coneRadius(z: number): number {
  return Math.max(0.06, GEO.R_MOUTH + (GEO.R_FAR - GEO.R_MOUTH) * (z / GEO.Z_FAR));
}

export interface RowSpec { z: number; r: number; s: number; n: number; step: number }

/** Rows of one arc: depth, radius, tile scale, capacity, angle step. */
export function rowSpecs(): RowSpec[] {
  return GEO.ROWS.map(({ z, s }) => {
    const r = coneRadius(z) - GEO.INSET;
    const span = 2 * GEO.ARC;
    // chord between neighbours ≥ PITCH·s
    const maxStep = 2 * Math.asin(Math.min(1, (GEO.PITCH * s) / (2 * r)));
    const n = Math.max(1, Math.floor(span / maxStep + 1e-9) + 1);
    return { z, r, s, n, step: n > 1 ? span / (n - 1) : 0 };
  });
}

/** Tiles one arc holds per page. */
export function arcCapacity(): number {
  return rowSpecs().reduce((a, r) => a + r.n, 0);
}

export interface Slot {
  /** 0 = upper arc (folders), 1 = lower arc (files). */
  arc: 0 | 1;
  row: number;
  /** Angle along the arc, −ARC (left) … +ARC (right); 0 = top (arc 0) / bottom (arc 1). */
  a: number;
  z: number;
  r: number;
  s: number;
}

/** Slots for `count` items on an arc: rows near → far, each left → right; a partial row is centered. */
export function arcSlots(count: number, arc: 0 | 1, rows = rowSpecs()): Slot[] {
  const out: Slot[] = [];
  let left = Math.max(0, Math.floor(count));
  for (let k = 0; k < rows.length && left > 0; k++) {
    const row = rows[k];
    const m = Math.min(left, row.n);
    for (let j = 0; j < m; j++) out.push({ arc, row: k, a: (j - (m - 1) / 2) * row.step, z: row.z, r: row.r, s: row.s });
    left -= m;
  }
  return out;
}

/** Slot center in local coordinates. */
export function slotPosition(arc: 0 | 1, a: number, r: number, z: number): [number, number, number] {
  return [r * Math.sin(a), (arc === 0 ? 1 : -1) * r * Math.cos(a), z];
}

// ---- entries ----------------------------------------------------------------------------------

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;
const cmp = (a: string, b: string) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/** Split a listing into folders (upper arc) and files (lower arc), each sorted by name (natural order). */
export function splitEntries(entries: Entry[]): { dirs: Entry[]; files: Entry[] } {
  const dirs: Entry[] = [];
  const files: Entry[] = [];
  for (const e of entries) {
    if (!e || typeof e.name !== 'string') continue;
    (e.type === 'dir' ? dirs : files).push(e);
  }
  dirs.sort((a, b) => cmp(a.name, b.name));
  files.sort((a, b) => cmp(a.name, b.name));
  return { dirs, files };
}

/** Number of pages an arc needs for n items. */
export const pageCount = (n: number, cap = arcCapacity()) => Math.max(1, Math.ceil(n / cap));

/**
 * A tile label in at most two lines of `cols` characters: break at a natural point (space, -, _, .)
 * near the end of line 1, keep the extension visible by truncating the middle of line 2.
 */
export function tileLabel(name: string, cols: number): string {
  const s = String(name ?? '');
  if (s.length <= cols) return s;
  let cut = -1;
  for (let i = Math.min(cols, s.length - 1); i >= Math.floor(cols * 0.55); i--) {
    const c = s[i - 1];
    if (c === ' ' || c === '-' || c === '_' || c === '.') { cut = i; break; }
  }
  if (cut < 0) cut = cols;
  const first = s.slice(0, cut).trimEnd();
  let rest = s.slice(cut).trimStart();
  if (rest.length > cols) {
    const tail = Math.ceil((cols - 1) * 0.6);
    rest = rest.slice(0, cols - 1 - tail) + '…' + rest.slice(rest.length - tail);
  }
  return `${first}\n${rest}`;
}

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
export const FOLDER_COLOR = '#e3b341';

/** Lucide icon + color for an entry. */
export function iconFor(e: Pick<Entry, 'type' | 'ext' | 'name'>): [string, string] {
  if (e.type === 'dir') return [e.name === '.git' ? 'folder-git-2' : 'folder', FOLDER_COLOR];
  const ext = (e.ext ?? '').toLowerCase();
  for (const [re, icon, color] of ICONS) if (re.test(ext)) return [icon, color];
  return ['file', '#8b949e'];
}

/** "now", "5m", "3h", "2d", "4mo", "2y". */
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

// ---- paths ------------------------------------------------------------------------------------

const isWin = (p: string) => /^[A-Za-z]:[\\/]?/.test(p) || (p.includes('\\') && !p.includes('/'));

/** Trim whitespace and trailing separators (keeps "/", "~", "C:\"). */
export function normPath(p: string): string {
  let s = String(p ?? '').trim();
  if (!s) return '~';
  while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** dir + name with the dir's separator. */
export function joinPath(dir: string, name: string): string {
  const d = normPath(dir);
  const sep = isWin(d) ? '\\' : '/';
  return /[\\/]$/.test(d) ? d + name : `${d}${sep}${name}`;
}

/** Last segment ("~" and "/" stay themselves). */
export function baseName(p: string): string {
  const s = normPath(p);
  if (s === '/' || s === '~' || /^[A-Za-z]:[\\/]?$/.test(s)) return s;
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Folder title: "Home" for "~", "/" for the root. */
export const folderTitle = (p: string) => (normPath(p) === '~' ? 'Home' : baseName(p));

/**
 * The levels of a (display) path, outermost first, each a full path:
 * "~/a/b" → ["~", "~/a", "~/a/b"]; "/usr/lib" → ["/", "/usr", "/usr/lib"]; "C:\x" → ["C:\", "C:\x"].
 */
export function levels(display: string): string[] {
  const p = normPath(display);
  const win = isWin(p);
  const sep = win ? '\\' : '/';
  let root: string;
  let rest: string;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) { root = '~'; rest = p.slice(1); }
  else if (/^[A-Za-z]:/.test(p)) { root = `${p.slice(0, 2)}\\`; rest = p.slice(2); }
  else if (p.startsWith('/') || p.startsWith('\\')) { root = sep; rest = p; }
  else { root = ''; rest = p; }
  const parts = rest.split(/[\\/]+/).filter(Boolean);
  const out: string[] = root ? [root] : [];
  let cur = root;
  for (const part of parts) {
    cur = !cur ? part : /[\\/]$/.test(cur) ? cur + part : `${cur}${sep}${part}`;
    out.push(cur);
  }
  return out.length ? out : [p];
}

// ---- level rings --------------------------------------------------------------------------------

/**
 * Depth of a level ring by its distance d from the current folder (d = 0: the portal at the far end;
 * d = 1: the parent, … nearer to the viewer). Fractional d interpolates (animations); d < 0 lies
 * beyond the portal (a child being entered / a folder being left), d > 5 passes the mouth.
 */
const RING_Z = [GEO.Z_FAR, -0.66, -0.47, -0.31, -0.18, -0.07, 0.04, 0.16];
export function ringZ(d: number): number {
  if (d <= 0) return GEO.Z_FAR + d * 0.35;
  const i = Math.floor(d);
  if (i >= RING_Z.length - 1) return RING_Z[RING_Z.length - 1] + (d - RING_Z.length + 1) * 0.12;
  return RING_Z[i] + (RING_Z[i + 1] - RING_Z[i]) * (d - i);
}

/** Opacity of a level ring at distance d (fades in beyond the portal and out past the mouth). */
export function ringAlpha(d: number): number {
  if (d < 0) return clamp01(1 + d);
  if (d <= 4) return 1 - d * 0.1;
  return clamp01(0.6 * (6 - d));
}

/** Most ancestor rings shown with a label. */
export const MAX_TAGS = 5;

export interface RingPlan { path: string; from: number; to: number }

/**
 * Which rings animate where when the current folder changes from `oldPath` to `newPath`: every level
 * of either path, with its distance-from-current before (`from`) and after (`to`). Levels shared by
 * both slide by the depth difference; levels only on the old path recede into the portal (going up)
 * or pass the viewer (jumping elsewhere); new levels emerge from beyond the portal.
 */
export function ringPlan(oldPath: string, newPath: string): RingPlan[] {
  const a = levels(oldPath);
  const b = levels(newPath);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const out: RingPlan[] = [];
  const oldCur = a.length - 1;
  const newCur = b.length - 1;
  for (let i = 0; i < a.length; i++) {
    const from = oldCur - i;
    if (i < common) out.push({ path: a[i], from, to: newCur - i });
    // old-only levels: deeper than the new current folder → sink beyond the portal; else pass the viewer
    else out.push({ path: a[i], from, to: common === b.length ? newCur - i : from + b.length - common + 1 });
  }
  for (let i = common; i < b.length; i++) {
    const to = newCur - i;
    // new-only levels emerge from beyond the portal (deeper ones further away)
    out.push({ path: b[i], from: common === a.length ? oldCur - i : to - 1, to });
  }
  return out;
}

/** Kind of motion between two paths, for the tile animation. */
export function navKind(oldPath: string, newPath: string): 'enter' | 'up' | 'jump' | 'same' {
  const a = levels(oldPath);
  const b = levels(newPath);
  if (a.length === b.length && a.every((x, i) => x === b[i])) return 'same';
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  if (common === a.length) return 'enter';
  if (common === b.length) return 'up';
  return 'jump';
}
