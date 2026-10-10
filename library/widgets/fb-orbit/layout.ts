// fb-orbit layout: pure functions (no THREE) that turn a `files` tree node into orbital bodies.
//
//   distance from the sun  = recency (absolute log-time scale: 1 h … 1 d … 1 w … 1 mo … 1 y)
//   orbital plane          = type group (folders in the main plane, code / docs / data / media / other tilted)
//   body radius            = log(size) on an absolute scale (100 B … 10 GB), folders bigger than files
//   phase                  = hash of the name (deterministic: the same folder always looks the same)

export interface TNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  files?: number;
  mtime: number | null;
  ext?: string;
  skipped?: boolean;
  children?: TNode[];
}

export interface TypeInfo {
  /** Orbital plane group (index into PLANES). */
  plane: number;
  label: string;
  color: string;
  icon: string;
}

/** Orbital planes: [inclination°, longitude of ascending node°]. 0 = folders (the main plane). */
export const PLANES: Array<[number, number]> = [
  [0, 0],     // folders
  [30, 20],   // code
  [30, 140],  // documents
  [30, 260],  // data / config
  [58, 80],   // media
  [58, 200],  // other
];

const FOLDER: TypeInfo = { plane: 0, label: 'folder', color: '#f2c14e', icon: 'folder' };
const TYPES: Array<[RegExp, TypeInfo]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|ico)$/, { plane: 4, label: 'image', color: '#45d49b', icon: 'file-image' }],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, { plane: 4, label: 'video', color: '#a98bff', icon: 'film' }],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, { plane: 4, label: 'audio', color: '#ff6f91', icon: 'music' }],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, { plane: 5, label: 'archive', color: '#ff8a5b', icon: 'file-archive' }],
  [/^(pem|key|crt|cer|p12|pfx)$/, { plane: 5, label: 'key', color: '#ff5d6c', icon: 'file-key' }],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml|lock|env)$/, { plane: 3, label: 'config', color: '#4fd9d4', icon: 'braces' }],
  [/^(csv|tsv|xlsx?|ods|parquet|npy|npz|pt|safetensors|h5|db|sqlite)$/, { plane: 3, label: 'data', color: '#9ad85a', icon: 'file-spreadsheet' }],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, { plane: 1, label: 'script', color: '#a5d6ff', icon: 'file-terminal' }],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|swift|dart|r|jl|sql|html?|css|scss)$/, { plane: 1, label: 'code', color: '#4cc3ff', icon: 'file-code' }],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex|bib)$/, { plane: 2, label: 'text', color: '#d5dbe4', icon: 'file-text' }],
];
const OTHER: TypeInfo = { plane: 5, label: 'file', color: '#8d99ab', icon: 'file' };

export function typeOf(n: Pick<TNode, 'type' | 'ext' | 'name'>): TypeInfo {
  if (n.type === 'dir') return FOLDER;
  const ext = (n.ext || (n.name.includes('.') ? n.name.split('.').pop()! : '')).toLowerCase();
  for (const [re, t] of TYPES) if (re.test(ext)) return t;
  return OTHER;
}

/** Deterministic 0..1 hash of a string (FNV-1a). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const LOG_SPAN = Math.log10(1 + 24 * 365 * 2); // 2 years in hours

/** Orbit radius for a modification time: recent = close to the sun; unknown = outermost. */
export function orbitRadius(mtime: number | null | undefined, now: number, rMin: number, rMax: number): number {
  if (!mtime || !Number.isFinite(mtime)) return rMax;
  const hours = Math.max(0, now - mtime) / 3.6e6;
  const f = Math.min(1, Math.log10(1 + hours) / LOG_SPAN);
  return rMin + (rMax - rMin) * f;
}

/** Guide ring ages (hours) and their labels. */
export const GUIDES: Array<[number, string]> = [[1, '1h'], [24, '1d'], [24 * 7, '1w'], [24 * 30, '1mo'], [24 * 365, '1y']];

/** Visual radius (m, before the radius-prop scale) from a byte size: absolute log scale. */
export function bodyRadius(size: number, kind: 'planet' | 'file' | 'moon'): number {
  const n = Math.max(0, Math.min(1, (Math.log10(Math.max(0, size) + 1) - 2) / 8));
  if (kind === 'planet') return 0.011 + 0.026 * n;
  if (kind === 'file') return 0.0055 + 0.0125 * n;
  return 0.0032 + 0.0065 * n;
}

/** Latest file mtime in a subtree (folders carry none of their own in tree replies). */
export function latestMtime(n: TNode): number | null {
  if (n.type === 'file' || !n.children) return n.mtime ?? null;
  let best: number | null = n.mtime ?? null;
  for (const c of n.children) {
    const m = latestMtime(c);
    if (m != null && (best == null || m > best)) best = m;
  }
  return best;
}

export interface BodySpec {
  node: TNode;
  kind: 'planet' | 'file' | 'moon';
  /** Index of the planet a moon circles (−1 for top-level bodies). */
  parent: number;
  /** Visual radius (m). */
  r: number;
  /** Hit-sphere radius (m): never below 1.25 cm (2.5 cm targets). */
  hitR: number;
  orbit: number;
  type: TypeInfo;
  phase: number;
  /** rad/s */
  omega: number;
  /** Moon plane: [inclination, node] in radians (top-level bodies use PLANES[type.plane]). */
  tilt: [number, number];
  mtime: number | null;
}

export interface LayoutOptions {
  radius: number;
  maxBodies: number;
  maxMoons: number;
  now: number;
}

export const SUN_R = 0.05;
export const MIN_HIT = 0.0125;

/** Bodies for a folder node (top-level first, then moons; a moon's parent always precedes it). */
export function layoutSystem(root: TNode, o: LayoutOptions): { bodies: BodySpec[]; hidden: number; scale: number } {
  const u = Math.max(0.2, o.radius / 0.45);
  const rMin = 0.12 * u, rMax = o.radius;
  const kids = (root.children ?? []).filter((k) => k && typeof k.name === 'string');
  const max = Math.max(1, Math.floor(o.maxBodies));
  // The most recent files always get a place (close to the sun = what you were just working on);
  // the rest by size (tree replies are biggest first).
  const pick = new Set<TNode>();
  const recent = kids.filter((k) => k.type === 'file' && k.mtime).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  for (const f of recent.slice(0, Math.min(8, Math.floor(max / 3)))) pick.add(f);
  for (const k of kids) { if (pick.size >= max) break; pick.add(k); }
  const top = kids.filter((k) => pick.has(k));
  const bodies: BodySpec[] = [];
  for (const node of top) {
    const kind = node.type === 'dir' ? 'planet' : 'file';
    const r = bodyRadius(node.size, kind) * u;
    const mtime = latestMtime(node);
    const jitter = (hash01(node.name, 7) - 0.5) * 0.014 * u;
    const floor = SUN_R * u + r + (kind === 'planet' ? 0.035 : 0.02) * u;
    // unknown recency (folders holding only subfolders at this depth): spread over an outer band
    const base = mtime ? orbitRadius(mtime, o.now, rMin, rMax) + jitter : rMax - (0.012 + 0.07 * hash01(node.name, 11)) * u;
    const orbit = Math.max(floor, base);
    bodies.push({
      node, kind, parent: -1, r, hitR: Math.max(MIN_HIT, r * 1.35), orbit, type: typeOf(node),
      phase: hash01(node.name, 1) * Math.PI * 2,
      omega: 0.045 * Math.pow(rMin / orbit, 1.5),
      tilt: [0, 0], mtime,
    });
  }
  let moons = 0;
  const nTop = bodies.length;
  for (let i = 0; i < nTop && moons < o.maxMoons; i++) {
    const p = bodies[i];
    if (p.kind !== 'planet' || !p.node.children?.length) continue;
    const cs = p.node.children.slice(0, Math.min(5, o.maxMoons - moons));
    cs.forEach((c, j) => {
      const r = bodyRadius(c.size, 'moon') * u;
      bodies.push({
        node: c, kind: 'moon', parent: i, r, hitR: Math.max(MIN_HIT, r * 1.6),
        orbit: p.r + (0.015 + j * 0.0085) * u, type: typeOf(c),
        phase: hash01(c.name, 3) * Math.PI * 2,
        omega: 0.32 / (1 + j * 0.35),
        tilt: [(0.35 + 0.8 * hash01(c.name, 5)) * (j % 2 ? -1 : 1), hash01(p.node.name + c.name, 9) * Math.PI * 2],
        mtime: latestMtime(c),
      });
      moons++;
    });
  }
  return { bodies, hidden: Math.max(0, kids.length - nTop), scale: u };
}

/** Ancestor folders of an absolute path, nearest first (["/a/b", "/a", "/"] for "/a/b/c"). */
export function ancestorsOf(abs: string): string[] {
  const parts = abs.split('/').filter(Boolean);
  const out: string[] = [];
  for (let k = parts.length - 1; k >= 0; k--) out.push('/' + parts.slice(0, k).join('/'));
  return out;
}

/** Display name of a folder path ("~" for home, "/" for the root). */
export function folderName(abs: string, home: string | null): string {
  if (home && abs === home) return '~';
  if (abs === '/' || abs === '') return '/';
  return abs.slice(abs.lastIndexOf('/') + 1);
}

/** "5m", "3h", "2d", "4mo", "2y" (empty for unknown). */
export function ageShort(mtime: number | null | undefined, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}
