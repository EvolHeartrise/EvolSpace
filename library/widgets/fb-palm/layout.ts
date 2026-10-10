// fb-palm — pure helpers: fan geometry, card labels, path matching, entry icons.
// Fan coordinates: meters, origin = the "deck" (hub) above the palm, +Y = up on the user's
// screen, +Z = toward the user's eyes. Cards fan out above the hub on one or two arcs.

/** Card (chip) size: portrait like a playing card; ≥ 2.5 cm both ways. */
export const CARD_W = 0.046;
export const CARD_H = 0.062;
/** Arc radii (inner / outer tier, single tier) around the hub, and the arc spacing between cards. */
export const R_IN = 0.105;
export const R_OUT = 0.172;
export const R_ONE = 0.12;
export const SPACING = 0.054;
/** Fraction of the arc angle a card is tilted by (1 = radial like real fanned cards; less reads better). */
export const TILT = 0.45;
/** Round control chips on the base row (up / recents on the thumb side, page / home on the pinky side). */
export const CHIP_D = 0.032;
export const CHIP_X = [0.07, 0.108] as const;

export interface Slot {
  x: number;
  y: number;
  /** Z rotation (radians) of the card. */
  rot: number;
  /** Arc angle from straight up (radians, + = right). */
  angle: number;
  tier: number;
}

/** Cards per tier: up to 5 on one arc, else ~40 % inner / 60 % outer. */
export function tierSplit(n: number): number[] {
  if (!(n > 0)) return [];
  if (n <= 5) return [n];
  const a = Math.floor(n * 0.4);
  return [a, n - a];
}

/** Slot poses for n cards, left to right (inner tier first). */
export function fanSlots(n: number): Slot[] {
  const tiers = tierSplit(n);
  const radii = tiers.length === 1 ? [R_ONE] : [R_IN, R_OUT];
  const out: Slot[] = [];
  tiers.forEach((c, tier) => {
    const r = radii[tier];
    const step = SPACING / r;
    for (let i = 0; i < c; i++) {
      const a = (i - (c - 1) / 2) * step;
      out.push({ x: r * Math.sin(a), y: r * Math.cos(a), rot: -a * TILT, angle: a, tier });
    }
  });
  return out;
}

/** Top edge (fan coords) of the highest card for n cards. */
export function fanTop(n: number): number {
  return (tierSplit(n).length > 1 ? R_OUT : R_ONE) + CARD_H / 2;
}

/** Rough advance of a character in ems (sans): enough to keep labels inside a card. */
export function charEm(c: string): number {
  if ('MW@%mw'.includes(c)) return 0.85;
  if ('iljtfrI.,:;\'!|-_ ()[]'.includes(c)) return 0.32;
  if (/[A-Z0-9]/.test(c)) return 0.66;
  return 0.54;
}
export const textEm = (s: string): number => { let w = 0; for (const c of s) w += charEm(c); return w; };

/** Longest prefix of s (in chars) that fits `budget` ems. */
function fitPrefix(s: string, budget: number): number {
  let w = 0, i = 0;
  for (; i < s.length; i++) { w += charEm(s[i]); if (w > budget) break; }
  return i;
}

/**
 * Up to two lines that fit a card `budget` ems wide: "widget.ts" stays whole; long names break after
 * . - _ space or a camelCase hump, and an overlong second line keeps its tail (the extension):
 * "very-long-component-name.tsx" → "very-long-\ncomp…e.tsx".
 */
export function cardLabel(name: string, budget = 5.4): string {
  const s = String(name ?? '');
  if (textEm(s) <= budget * 1.08) return s; // a single line may use the card's side margin
  const max = Math.max(1, fitPrefix(s, budget));
  let b = -1;
  for (let i = Math.min(max, s.length - 1); i >= 3; i--) {
    const c = s[i - 1], d = s[i];
    if ('.-_ '.includes(c) || (/[a-z0-9]/.test(c) && /[A-Z]/.test(d))) { b = i; break; }
  }
  if (b < 0) b = max;
  const first = s.slice(0, b);
  let rest = s.slice(b);
  if (textEm(rest) > budget) {
    const dot = rest.lastIndexOf('.');
    let keep = Math.max(3, Math.min(6, dot >= 0 ? rest.length - dot + 1 : 4));
    while (keep > 1 && textEm(rest.slice(rest.length - keep)) > budget * 0.6) keep--;
    const tail = rest.slice(rest.length - keep);
    const head = fitPrefix(rest, budget - textEm(tail) - 0.6);
    rest = rest.slice(0, head) + '…' + tail;
  }
  return `${first}\n${rest}`;
}

export const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

/** Last path segment ("~" and "/" stay as they are). */
export function baseName(p: string): string {
  const s = String(p ?? '').replace(/\/+$/, '');
  if (!s) return '/';
  if (s === '~') return '~';
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) || '/' : s;
}

/** Does a reply ({path: absolute, display: "~/…"}) answer a request for `want` (absolute or ~ form)? */
export function samePath(want: string, got: { path?: unknown; display?: unknown }): boolean {
  const norm = (s: unknown) => (typeof s === 'string' && s.length > 1 ? s.replace(/\/+$/, '') : s);
  const w = norm(want);
  return w === norm(got.path) || w === norm(got.display);
}

/** Does a preview reply's absolute path answer a request for `want` ("~/x" matches "/home/u/x")? */
export function sameFile(want: string, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  return got === want || (want.startsWith('~/') && got.endsWith(want.slice(1)));
}

const ICONS: Array<[RegExp, string, string]> = [
  [/^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic)$/, 'file-image', '#7ee787'],
  [/^(mp4|mkv|webm|mov|avi|m4v)$/, 'film', '#d2a8ff'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, 'music', '#ff9bce'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, 'file-archive', '#e3b341'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml)$/, 'braces', '#79c0ff'],
  [/^(csv|tsv|xlsx?|ods|parquet)$/, 'file-spreadsheet', '#7ee787'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, 'file-terminal', '#a5d6ff'],
  [/^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|cu|swift|dart|r|jl|sql)$/, 'file-code', '#79c0ff'],
  [/^(md|markdown|txt|rst|log|pdf|docx?|odt|tex)$/, 'file-text', '#c9d1d9'],
  [/^(pem|key|crt|cer|p12|pfx)$/, 'file-key', '#ffa198'],
];

/** Lucide icon + accent color for an entry. */
export function iconFor(e: { type: string; ext?: string; name?: string }): [string, string] {
  if (e.type === 'dir') return e.name === '.git' ? ['folder-git-2', '#e3b341'] : ['folder', '#e3b341'];
  const ext = e.ext ?? '';
  for (const [re, icon, color] of ICONS) if (re.test(ext)) return [icon, color];
  return ['file', '#8b949e'];
}

/** "5m", "3h", "2d", "4mo", "2y" (compact ages for the hub read-out). */
export function shortAge(mtime: number | null | undefined, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 730) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}
