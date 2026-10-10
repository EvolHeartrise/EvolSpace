// fb-launcher — pure logic (no three.js): result types, type filters, match highlighting, completions,
// next-key prediction, control-channel parsing. Kept separate so tests can exercise it directly.

export type Filter = 'all' | 'code' | 'docs' | 'images' | 'media' | 'folders';

export const FILTERS: Array<{ id: Filter; label: string; icon: string }> = [
  { id: 'all', label: 'All', icon: 'layout-list' },
  { id: 'code', label: 'Code', icon: 'file-code' },
  { id: 'docs', label: 'Docs', icon: 'file-text' },
  { id: 'images', label: 'Images', icon: 'file-image' },
  { id: 'media', label: 'Media', icon: 'film' },
  { id: 'folders', label: 'Folders', icon: 'folder' },
];

/** One search result / recent file / pin, as the `files` source reports it. */
export interface Hit {
  name: string;
  /** Absolute path. */
  path: string;
  /** "~/…" display path. */
  display: string;
  type: 'dir' | 'file' | 'link';
  size: number | null;
  mtime: number | null;
  ext: string;
}

/** Keyboard layout: one string per key row, '\b' = backspace. */
export const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl\b', 'zxcvbnm.-_'];

const CODE = /^(ts|tsx|js|mjs|cjs|jsx|py|rs|go|c|h|cpp|hpp|cc|java|kt|cs|rb|php|lua|svelte|vue|gd|glsl|wgsl|hlsl|cu|cuh|swift|dart|r|jl|sql|sh|bash|zsh|fish|ps1|bat|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|cmake|mk|gradle|lock|ipynb)$/;
const DOCS = /^(md|markdown|txt|rst|log|pdf|docx?|odt|tex|bib|csv|tsv|xlsx?|ods|pptx?|odp|epub)$/;
const IMAGES = /^(png|jpe?g|webp|gif|bmp|tiff?|svg|avif|heic|ico|exr|hdr)$/;
const MEDIA = /^(mp4|mkv|webm|mov|avi|m4v|mp3|wav|flac|ogg|m4a|opus|aac)$/;

/** The filter category a hit belongs to ('all' = none of the specific ones). */
export function categoryOf(h: Pick<Hit, 'type' | 'ext'>): Filter {
  if (h.type === 'dir') return 'folders';
  const e = (h.ext || '').toLowerCase();
  if (CODE.test(e)) return 'code';
  if (DOCS.test(e)) return 'docs';
  if (IMAGES.test(e)) return 'images';
  if (MEDIA.test(e)) return 'media';
  return 'all';
}

export function passes(h: Pick<Hit, 'type' | 'ext'>, f: Filter): boolean {
  return f === 'all' || categoryOf(h) === f;
}

export function isFilter(v: unknown): v is Filter {
  return typeof v === 'string' && FILTERS.some((f) => f.id === v);
}

const ICONS: Array<[RegExp, string, string]> = [
  [IMAGES, 'file-image', '#7ee787'],
  [MEDIA, 'film', '#d2a8ff'],
  [/^(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/, 'file-archive', '#e3b341'],
  [/^(json|jsonl|ya?ml|toml|ini|cfg|conf|xml)$/, 'braces', '#79c0ff'],
  [/^(csv|tsv|xlsx?|ods|parquet)$/, 'file-spreadsheet', '#7ee787'],
  [/^(sh|bash|zsh|fish|ps1|bat)$/, 'file-terminal', '#a5d6ff'],
  [CODE, 'file-code', '#79c0ff'],
  [DOCS, 'file-text', '#c9d1d9'],
  [/^(pem|key|crt|cer|p12|pfx)$/, 'file-key', '#ffa198'],
];

/** Lucide icon + color for a hit. */
export function iconFor(h: Pick<Hit, 'type' | 'ext'>): [string, string] {
  if (h.type === 'dir') return ['folder', '#e3b341'];
  const e = (h.ext || '').toLowerCase();
  if (/^(mp3|wav|flac|ogg|m4a|opus|aac)$/.test(e)) return ['music', '#ff9bce'];
  for (const [re, icon, color] of ICONS) if (re.test(e)) return [icon, color];
  return ['file', '#8b949e'];
}

export const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** "now", "5m", "3h", "2d", "Mar 4" (this year) or "Mar 4 '24". */
export function ageLabel(mtime: number | null | undefined, now = Date.now()): string {
  if (!mtime) return '';
  const s = Math.max(0, (now - mtime) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  const d = new Date(mtime);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md} '${String(d.getFullYear()).slice(2)}`;
}

/**
 * Character positions of `q` in `name` the way the files source matches: a substring if there is one,
 * else the greedy subsequence. Empty array = no match / empty query.
 */
export function matchIndices(name: string, q: string): number[] {
  const n = name.toLowerCase();
  q = q.toLowerCase();
  if (!q) return [];
  const i = n.indexOf(q);
  if (i >= 0) return Array.from({ length: q.length }, (_, k) => i + k);
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < n.length && j < q.length; k++) if (n[k] === q[j]) { out.push(k); j++; }
  return j === q.length ? out : [];
}

/** troika colorRanges coloring `indices` (sorted) in `hi`, the rest `base`; indices ≥ clip are dropped. */
export function highlightRanges(indices: number[], base: number, hi: number, clip = Infinity): Record<number, number> | null {
  const r: Record<number, number> = {};
  let any = false;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i >= clip) break;
    if (k === 0 || indices[k - 1] !== i - 1) r[i] = hi;
    if (k === indices.length - 1 || indices[k + 1] !== i + 1) r[i + 1] = base;
    any = true;
  }
  if (!any) return null;
  if (r[0] === undefined) r[0] = base;
  return r;
}

const WORD = /[a-z0-9]/;

/**
 * Query completions from result names: the matched word extended to its end ("wid" → "widget"),
 * and short whole-name tails ("widget" → "widget.ts"). Most frequent first; at most `max`.
 */
export function completions(names: string[], q: string, max = 4): string[] {
  q = q.toLowerCase();
  if (!q) return [];
  const count = new Map<string, number>();
  const add = (s: string, w: number) => { if (s.length > q.length && s.length <= 28) count.set(s, (count.get(s) ?? 0) + w); };
  for (let r = 0; r < names.length && r < 40; r++) {
    const n = names[r].toLowerCase();
    const i = n.indexOf(q);
    if (i < 0) continue;
    const w = 1 + (40 - r) / 40; // better-ranked names weigh more
    let j = i + q.length;
    while (j < n.length && WORD.test(n[j])) j++;
    add(n.slice(i, j), w);
    if (n.length - i <= 24) add(n.slice(i), w * 0.9);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, max).map(([s]) => s);
}

/** Likely next characters after `q` in the (substring-)matching names — keys to glow on the keyboard. */
export function nextKeys(names: string[], q: string, max = 5): string[] {
  q = q.toLowerCase();
  if (!q) return [];
  const count = new Map<string, number>();
  for (let r = 0; r < names.length && r < 40; r++) {
    const n = names[r].toLowerCase();
    const i = n.indexOf(q);
    if (i < 0 || i + q.length >= n.length) continue;
    const c = n[i + q.length];
    if (/[a-z0-9.\-_]/.test(c)) count.set(c, (count.get(c) ?? 0) + 1 + (40 - r) / 40);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c);
}

/** Normalize a scope path: trimmed, no trailing slash (except "/"), "~" when empty. */
export function normScope(s: unknown): string {
  let p = typeof s === 'string' ? s.trim() : '';
  if (!p) return '~';
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Parent of a display path ("~/a/b" → "~/a"; "~" → "~/.." which the source resolves to the home's parent). */
export function parentOf(p: string): string {
  p = normScope(p);
  if (p === '/') return '/';
  if (p === '~') return '~/..';
  const i = p.lastIndexOf('/');
  if (i < 0) return '~';
  if (i === 0) return '/';
  return p.slice(0, i);
}

/** Folder of `display` relative to the scope ("~/s/a/b.ts" in "~/s" → "a"); "" at the scope root. */
export function relFolder(display: string, scope: string): string {
  const i = display.lastIndexOf('/');
  const dir = i > 0 ? display.slice(0, i) : '';
  const s = normScope(scope);
  if (dir === s) return '';
  if (dir.startsWith(s + '/')) return dir.slice(s.length + 1);
  return dir;
}

/** Long paths keep their tail: "…/library/widgets". */
export function tail(p: string, max: number): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

/** Normalize a spoken/typed query: lowercase, "dot" → ".", trailing STT punctuation and spaces removed. */
export function normQuery(v: unknown, spoken = false): string {
  let s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  s = s.toLowerCase();
  if (spoken) {
    s = s.replace(/\s+dot\s+/g, '.').replace(/^\s*dot\s+/, '.').replace(/[\s.?!,;:]+$/, '').replace(/^["'“”]+|["'“”]+$/g, '');
    s = s.replace(/\s+/g, '');
  }
  return s.trim().slice(0, 64);
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, top: 1 };

export function toIndex(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (/^\d+$/.test(s)) return Number(s);
    if (NUMBER_WORDS[s]) return NUMBER_WORDS[s];
  }
  return null;
}

export type Ctl =
  | { cmd: 'query'; text: string; entity?: string }
  | { cmd: 'append'; text: string; entity?: string }
  | { cmd: 'backspace'; entity?: string }
  | { cmd: 'clear'; entity?: string }
  | { cmd: 'open'; index: number; entity?: string }
  | { cmd: 'pin'; index: number; entity?: string }
  | { cmd: 'scope'; path: string; entity?: string }
  | { cmd: 'pop'; entity?: string }
  | { cmd: 'filter'; filter: Filter; entity?: string }
  | { cmd: 'close'; entity?: string }
  | { cmd: 'scroll'; by: number; entity?: string }
  | { cmd: 'ask'; entity?: string };

const FILTER_ALIASES: Record<string, Filter> = {
  all: 'all', any: 'all', everything: 'all', none: 'all', code: 'code', source: 'code', doc: 'docs', docs: 'docs', documents: 'docs', text: 'docs',
  image: 'images', images: 'images', pictures: 'images', photos: 'images', media: 'media', video: 'media', videos: 'media', audio: 'media', music: 'media',
  folder: 'folders', folders: 'folders', directories: 'folders', dirs: 'folders',
};

/** Parse a control-channel value; a bare string is a query. null = not a command. */
export function parseCtl(v: unknown): Ctl | null {
  if (typeof v === 'string') return { cmd: 'query', text: normQuery(v, true) };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const entity = typeof o.entity === 'string' ? o.entity : undefined;
  const cmd = typeof o.cmd === 'string' ? o.cmd.toLowerCase() : '';
  switch (cmd) {
    case 'query': case 'find': case 'search': return { cmd: 'query', text: normQuery(o.text ?? o.query ?? '', true), entity };
    case 'append': case 'type': return { cmd: 'append', text: normQuery(o.text ?? '', true), entity };
    case 'backspace': return { cmd: 'backspace', entity };
    case 'clear': case 'reset': return { cmd: 'clear', entity };
    case 'open': case 'pin': {
      const index = toIndex(o.index ?? o.n ?? o.text);
      return index != null && index >= 1 ? { cmd, index, entity } : null;
    }
    case 'scope': case 'in': {
      const path = typeof o.path === 'string' ? o.path : typeof o.text === 'string' ? o.text : '';
      return path.trim() ? { cmd: 'scope', path: normScope(path), entity } : null;
    }
    case 'pop': case 'up': case 'back': return { cmd: 'pop', entity };
    case 'filter': {
      const f = FILTER_ALIASES[String(o.filter ?? o.type ?? o.text ?? '').trim().toLowerCase()];
      return f ? { cmd: 'filter', filter: f, entity } : null;
    }
    case 'close': return { cmd: 'close', entity };
    case 'scroll': {
      const by = typeof o.by === 'number' ? o.by : Number(o.by);
      return Number.isFinite(by) ? { cmd: 'scroll', by, entity } : null;
    }
    case 'ask': return { cmd: 'ask', entity };
    default: return null;
  }
}

/** A pin as stored in the `pins` prop. */
export interface Pin { path: string; display: string; name: string; type: 'dir' | 'file' }

export function readPins(v: unknown): Pin[] {
  if (!Array.isArray(v)) return [];
  const out: Pin[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (typeof o.path !== 'string' || !o.path) continue;
    const name = typeof o.name === 'string' && o.name ? o.name : o.path.split('/').filter(Boolean).pop() ?? o.path;
    out.push({ path: o.path, display: typeof o.display === 'string' && o.display ? o.display : o.path, name, type: o.type === 'dir' ? 'dir' : 'file' });
    if (out.length >= 24) break;
  }
  return out;
}

export function readHistory(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 8) : [];
}

export function pinToHit(p: Pin): Hit {
  return { name: p.name, path: p.path, display: p.display, type: p.type, size: null, mtime: null, ext: p.type === 'file' ? extOf(p.name) : '' };
}
