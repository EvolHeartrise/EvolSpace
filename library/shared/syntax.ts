// Lightweight syntax highlighting for text previews: a per-line scanner with carried state (block
// comments, multi-line strings, fenced code) for the common code / config / markup formats, producing
// token spans that become troika colorRanges. Not a parser — fast, allocation-light, good enough to
// read code at a glance. Pure TS, no three.js.
//
//   const lang = languageFor('widget.ts');              // 'ts' language config or null
//   const lines = highlight(text, lang);                // Span[] per line: [start, end, kind]
//   setColorRanges(mesh, colorRanges(lines, shownLineIndices, palette, base, maxCols));

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'constant' | 'key' | 'tag' | 'attr' | 'heading' | 'emphasis' | 'punct';
export type Span = [start: number, end: number, kind: TokenKind];

/** GitHub-dark-like colors for each token kind (hex). */
export const SYNTAX_COLORS: Record<TokenKind, string> = {
  comment: '#8b949e', string: '#a5d6ff', number: '#79c0ff', keyword: '#ff7b72', type: '#ffa657', function: '#d2a8ff',
  constant: '#79c0ff', key: '#7ee787', tag: '#7ee787', attr: '#79c0ff', heading: '#79c0ff', emphasis: '#ffa657', punct: '#8b949e',
};

export interface Language {
  id: string;
  line?: string[];                       // line comment starts
  block?: Array<[string, string]>;       // block comments
  quotes?: string[];                     // single-line string quotes
  multi?: Array<[string, string]>;       // multi-line strings (python ''' """, js template `)
  keywords?: Set<string>;
  types?: Set<string>;
  constants?: Set<string>;
  caseInsensitive?: boolean;             // SQL
  capsAreTypes?: boolean;                // Capitalized identifiers → type
  mode?: 'code' | 'json' | 'yaml' | 'ini' | 'markdown' | 'markup' | 'css' | 'shell';
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_TYPES = words('void int long short char float double bool boolean byte string String usize isize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 auto size_t');
const JS_KW = words('break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as implements interface package private protected public readonly type enum declare namespace module abstract keyof satisfies get set');
const JS_CONST = words('true false null undefined NaN Infinity');
const JS_TYPES = words('string number boolean any unknown never object symbol bigint void Array Record Promise Map Set Partial Readonly');
const PY_KW = words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls');
const PY_CONST = words('True False None NotImplemented Ellipsis');
const PY_TYPES = words('int float str bool bytes list dict set tuple object type Exception');
const RS_KW = words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while');
const GO_KW = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var');
const C_KW = words('auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual override new delete this using try catch throw nullptr constexpr noexcept operator friend final import package extends implements interface abstract synchronized throws instanceof var val fun when object companion data sealed lateinit is in out override suspend');
const C_CONST = words('true false null NULL nullptr nil');
const SH_KW = words('if then else elif fi for while until do done case esac in function return local export readonly declare set unset shift exit break continue source alias echo cd');
const SQL_KW = words('select from where and or not insert into values update set delete create table drop alter add index view join left right inner outer on group by order having limit offset as distinct union all case when then else end is null like in between exists primary key foreign references default');
const LUA_KW = words('and break do else elseif end for function goto if in local not or repeat return then until while');
const GD_KW = words('if elif else for while match break continue pass return class class_name extends is in as self tool signal func static const enum var onready export setget breakpoint preload await yield and or not');

const LANGS: Record<string, Language> = {
  ts: { id: 'ts', line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], multi: [['`', '`']], keywords: JS_KW, types: JS_TYPES, constants: JS_CONST, capsAreTypes: true },
  py: { id: 'py', line: ['#'], quotes: ['"', "'"], multi: [['"""', '"""'], ["'''", "'''"]], keywords: PY_KW, types: PY_TYPES, constants: PY_CONST, capsAreTypes: true },
  rs: { id: 'rs', line: ['//'], block: [['/*', '*/']], quotes: ['"'], keywords: RS_KW, types: C_LIKE_TYPES, constants: C_CONST, capsAreTypes: true },
  go: { id: 'go', line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], multi: [['`', '`']], keywords: GO_KW, types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any'), constants: C_CONST, capsAreTypes: true },
  c: { id: 'c', line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], keywords: C_KW, types: C_LIKE_TYPES, constants: C_CONST, capsAreTypes: true },
  sh: { id: 'sh', line: ['#'], quotes: ['"', "'"], keywords: SH_KW, constants: words('true false'), mode: 'shell' },
  sql: { id: 'sql', line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], keywords: SQL_KW, types: words('int integer bigint text varchar char boolean real float double date timestamp json jsonb serial'), constants: words('true false null'), caseInsensitive: true },
  lua: { id: 'lua', line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"], keywords: LUA_KW, constants: words('true false nil') },
  gd: { id: 'gd', line: ['#'], quotes: ['"', "'"], multi: [['"""', '"""']], keywords: GD_KW, types: words('int float bool String Vector2 Vector3 Color Array Dictionary Node'), constants: words('true false null PI TAU INF NAN'), capsAreTypes: true },
  json: { id: 'json', quotes: ['"'], constants: words('true false null'), mode: 'json', line: ['//'] },
  yaml: { id: 'yaml', line: ['#'], quotes: ['"', "'"], constants: words('true false null yes no on off ~'), mode: 'yaml' },
  ini: { id: 'ini', line: ['#', ';'], quotes: ['"', "'"], constants: words('true false'), mode: 'ini' },
  md: { id: 'md', mode: 'markdown' },
  html: { id: 'html', block: [['<!--', '-->']], quotes: ['"', "'"], mode: 'markup' },
  css: { id: 'css', block: [['/*', '*/']], quotes: ['"', "'"], mode: 'css', keywords: words('important media import supports keyframes font-face from to and not only') },
  docker: { id: 'docker', line: ['#'], quotes: ['"', "'"], keywords: words('FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'), mode: 'shell' },
  conf: { id: 'conf', line: ['#'], quotes: ['"', "'"] },
};

const EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', svelte: 'ts', vue: 'ts',
  py: 'py', pyi: 'py', rs: 'rs', go: 'go',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cu: 'c', cuh: 'c', java: 'c', kt: 'c', kts: 'c', cs: 'c', swift: 'c', dart: 'c', scala: 'c', glsl: 'c', wgsl: 'c', hlsl: 'c', zig: 'c',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'sh', env: 'sh',
  sql: 'sql', lua: 'lua', gd: 'gd',
  json: 'json', jsonl: 'json', jsonc: 'json', geojson: 'json', ipynb: 'json', lock: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  md: 'md', markdown: 'md', mdx: 'md',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', plist: 'html', xaml: 'html',
  css: 'css', scss: 'css', less: 'css',
  gitignore: 'conf', dockerignore: 'conf',
};
const NAMES: Record<string, string> = { dockerfile: 'docker', makefile: 'sh', '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.gitignore': 'conf', 'cmakelists.txt': 'conf' };

/** Language for a file name, or null (plain text). */
export function languageFor(fileName: string): Language | null {
  const lower = fileName.toLowerCase();
  if (NAMES[lower]) return LANGS[NAMES[lower]];
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  return LANGS[EXT[ext] ?? ''] ?? null;
}

interface State { block: string | null; blockKind: TokenKind; fence: boolean }

const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;
const ID_RE = /^[A-Za-z_$][\w$]*/;

/** Token spans per line (tabs should already be expanded so offsets match what is displayed). */
export function highlight(text: string, lang: Language | null): Span[][] {
  const lines = text.split('\n');
  if (!lang) return lines.map(() => []);
  const st: State = { block: null, blockKind: 'comment', fence: false };
  return lines.map((l) => scanLine(l, lang, st));
}

function scanLine(s: string, L: Language, st: State): Span[] {
  const out: Span[] = [];
  const mode = L.mode ?? 'code';
  if (mode === 'markdown') return markdownLine(s, st);
  let i = 0;
  const n = s.length;
  const push = (a: number, b: number, k: TokenKind) => { if (b > a) out.push([a, b, k]); };

  // line-level forms
  if (mode === 'yaml') {
    const m = /^(\s*(?:-\s+)?)((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(?=\s|$)/.exec(s);
    if (m) { push(m[1].length, m[1].length + m[2].length, 'key'); i = m[1].length + m[2].length + m[3].length; }
    else if (/^\s*-\s/.test(s)) { const k = s.indexOf('-'); push(k, k + 1, 'punct'); i = k + 1; }
  } else if (mode === 'ini') {
    const sec = /^\s*\[[^\]]*\]/.exec(s);
    if (sec) { push(0, sec[0].length, 'type'); i = sec[0].length; }
    const kv = /^(\s*)([\w.\-"' ]+?)(\s*[=:])/.exec(s);
    if (!sec && kv && !/^\s*[#;]/.test(s)) { push(kv[1].length, kv[1].length + kv[2].length, 'key'); i = kv[0].length; }
  }

  while (i < n) {
    // inside a block comment / multi-line string
    if (st.block) {
      const end = s.indexOf(st.block, i);
      if (end < 0) { push(i, n, st.blockKind); return out; }
      push(i, end + st.block.length, st.blockKind);
      i = end + st.block.length;
      st.block = null;
      continue;
    }
    const rest = s.slice(i);
    const ch = s[i];
    // comments
    const lc = L.line?.find((t) => rest.startsWith(t) && (mode !== 'shell' || t !== '#' || i === 0 || /\s/.test(s[i - 1])));
    const bc = L.block?.find(([a]) => rest.startsWith(a));
    if (bc) { st.block = bc[1]; st.blockKind = 'comment'; const end = s.indexOf(bc[1], i + bc[0].length); if (end >= 0) { push(i, end + bc[1].length, 'comment'); i = end + bc[1].length; st.block = null; } else { push(i, n, 'comment'); return out; } continue; }
    if (lc) { push(i, n, 'comment'); return out; }
    // markup tags
    if (mode === 'markup' && ch === '<') {
      const m = /^<\/?([\w:.-]+)/.exec(rest);
      if (m) { push(i, i + 1 + (rest[1] === '/' ? 1 : 0), 'punct'); push(i + m[0].length - m[1].length, i + m[0].length, 'tag'); i += m[0].length; continue; }
    }
    if (mode === 'markup' && /[\w:-]/.test(ch) && out.length && out[out.length - 1][2] !== 'string') {
      const m = /^[\w:-]+(?==)/.exec(rest);
      if (m) { push(i, i + m[0].length, 'attr'); i += m[0].length; continue; }
    }
    // multi-line strings
    const ml = L.multi?.find(([a]) => rest.startsWith(a));
    if (ml) {
      const end = s.indexOf(ml[1], i + ml[0].length);
      if (end >= 0) { push(i, end + ml[1].length, 'string'); i = end + ml[1].length; }
      else { push(i, n, 'string'); st.block = ml[1]; st.blockKind = 'string'; return out; }
      continue;
    }
    // strings
    if (L.quotes?.includes(ch) && !(mode === 'markup' && !isInTag(s, i))) {
      let j = i + 1;
      while (j < n && s[j] !== ch) j += s[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      const isKey = (mode === 'json' && /^\s*:/.test(s.slice(j)));
      push(i, j, isKey ? 'key' : 'string');
      i = j;
      continue;
    }
    // shell variables
    if (mode === 'shell' && ch === '$') {
      const m = /^\$(\{[^}]*\}|\w+|[@#?*!$0-9])/.exec(rest);
      if (m) { push(i, i + m[0].length, 'type'); i += m[0].length; continue; }
    }
    // css: hex colors, property names
    if (mode === 'css') {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(rest);
      if (hex) { push(i, i + hex[0].length, 'number'); i += hex[0].length; continue; }
      const prop = /^[\w-]+(?=\s*:(?!:))/.exec(rest);
      if (prop && /^\s*$/.test(s.slice(0, i).replace(/.*[{;]/, ''))) { push(i, i + prop[0].length, 'key'); i += prop[0].length; continue; }
    }
    // decorators / annotations
    if (ch === '@' && (L.id === 'py' || L.id === 'ts' || L.id === 'c')) {
      const m = /^@[\w.]+/.exec(rest);
      if (m) { push(i, i + m[0].length, 'function'); i += m[0].length; continue; }
    }
    // numbers (not inside identifiers)
    if (/[\d.]/.test(ch) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
      const m = NUM_RE.exec(rest);
      if (m && m[0] !== '.' && /\d/.test(m[0])) { push(i, i + m[0].length, 'number'); i += m[0].length; continue; }
    }
    // identifiers
    const id = ID_RE.exec(rest);
    if (id) {
      const w = id[0];
      const key = L.caseInsensitive ? w.toLowerCase() : w;
      const after = s.slice(i + w.length);
      let kind: TokenKind | null = null;
      if (L.keywords?.has(key) || (L.id === 'docker' && L.keywords?.has(w.toUpperCase()) && i === s.search(/\S/))) kind = 'keyword';
      else if (L.constants?.has(key)) kind = 'constant';
      else if (L.types?.has(key)) kind = 'type';
      else if (/^\s*\(/.test(after) && mode !== 'json') kind = 'function';
      else if (L.capsAreTypes && /^[A-Z][a-z0-9]/.test(w)) kind = 'type';
      else if (mode === 'css' && after.startsWith('(')) kind = 'function';
      if (kind) push(i, i + w.length, kind);
      i += w.length;
      continue;
    }
    i++;
  }
  return out;
}

/** Is position i inside a <tag …> (for markup strings)? */
function isInTag(s: string, i: number): boolean {
  const lt = s.lastIndexOf('<', i), gt = s.lastIndexOf('>', i);
  return lt > gt;
}

function markdownLine(s: string, st: State): Span[] {
  const out: Span[] = [];
  if (/^\s*(```|~~~)/.test(s)) { st.fence = !st.fence; return [[0, s.length, 'comment']]; }
  if (st.fence) return [[0, s.length, 'string']];
  const h = /^#{1,6}\s/.exec(s);
  if (h) return [[0, s.length, 'heading']];
  const li = /^(\s*)([-*+]|\d+[.)])\s/.exec(s);
  if (li) out.push([li[1].length, li[1].length + li[2].length, 'keyword']);
  if (/^\s*>/.test(s)) out.push([0, s.length, 'comment']);
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)]+\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push([m.index, m.index + m[0].length, m[1] ? 'string' : m[2] ? 'emphasis' : 'function']);
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * troika colorRanges ({charIndex: color}) for a block of displayed lines joined with '\n'.
 * `lineSpans[i]` are the spans of displayed line i, `lineLengths[i]` its displayed length; `clips[i]`
 * (optional) stops coloring earlier, e.g. before a truncation ellipsis.
 */
export function colorRanges(lineSpans: Span[][], lineLengths: number[], colors: Record<TokenKind, number>, base: number, clips?: number[]): Record<number, number> | null {
  const r: Record<number, number> = { 0: base };
  let off = 0, any = false;
  for (let li = 0; li < lineSpans.length; li++) {
    const len = Math.min(lineLengths[li], clips?.[li] ?? Infinity);
    for (const [a, b, k] of lineSpans[li]) {
      const s = Math.min(a, len), e = Math.min(b, len);
      if (e <= s) continue;
      r[off + s] = colors[k];
      if (r[off + e] === undefined) r[off + e] = base;
      any = true;
    }
    off += lineLengths[li] + 1;
  }
  return any ? r : null;
}
