// Client-side DRY-RUN of the server's voice fast-path matcher, for the Agent
// panel's phrase tester. POST /api/voice/simulate has no dry-run mode (it runs
// the matched command for real, or hands the text to Claude), so the tester
// replicates the matching rules here.
//
// REPLICA — keep in sync with:
//   apps/server/src/voice/normalize.ts  normalize(), canonicalForms(), parseNumber()
//   apps/server/src/voice/matcher.ts    matchCommand(), contextEntities(), substituteArgs()
//   apps/server/src/voice/commands.ts   compilePattern()  (^(?:p)$, flags 'iu')
// apps/client/test/debug-panels-b-voice.test.ts imports the server modules and
// cross-checks this replica on library/voice/commands.json to catch drift.
// (The server modules can't be imported here: the client bundle must not pull
// in server code; the copy is small.)

import type { VoiceCommand } from '@evolspace/protocol';

// ------------------------------------------------------------------ normalize.ts

const APOSTROPHES = /['‘’ʼ`]/g;
const NON_WORD = /[^\p{L}\p{N}\s]+/gu;

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(APOSTROPHES, '').replace(NON_WORD, ' ').replace(/\s+/g, ' ').trim();
}

const LEADING = [
  'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'okay', 'ok', 'so', 'and', 'alright', 'all right',
  'hey', 'hi', 'yo', 'please', 'claude', 'clod', 'just', 'now', 'can you', 'could you', 'would you', 'will you',
  'i want to', 'i want you to', 'id like to', 'lets', 'let us',
];
const TRAILING = ['please', 'thanks', 'thank you', 'now', 'for me', 'right now', 'claude', 'um', 'uh'];

function trimFillers(text: string): { forms: string[]; final: string } {
  let s = normalize(text);
  const forms: string[] = [];
  const step = (list: readonly string[], strip: (s: string, w: string) => string | null) => {
    for (let changed = true; changed && s;) {
      changed = false;
      for (const w of list) {
        if (s === w) { s = ''; return; }
        const next = strip(s, w);
        if (next !== null) { s = next; if (!forms.includes(s)) forms.push(s); changed = true; break; }
      }
    }
  };
  step(LEADING, (x, w) => (x.startsWith(w + ' ') ? x.slice(w.length + 1) : null));
  step(TRAILING, (x, w) => (x.endsWith(' ' + w) ? x.slice(0, -(w.length + 1)) : null));
  return { forms, final: s };
}

export function canonicalForms(text: string): string[] {
  return trimFillers(text).forms;
}

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

export function parseNumber(s: string): number | undefined {
  const raw = s.trim().toLowerCase();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return Number(raw);
  const t = raw.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  let words = t.split(' ');
  let sign = 1;
  if (words[0] === 'minus' || words[0] === 'negative') { sign = -1; words = words.slice(1); }
  if (words.length === 1 && (words[0] === 'to' || words[0] === 'too')) return sign * 2;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w === 'and') continue;
    if (w in SMALL) { current += SMALL[w]; seen = true; }
    else if (w in TENS) { current += TENS[w]; seen = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; }
    else if (/^\d+$/.test(w)) { current += Number(w); seen = true; }
    else return undefined;
  }
  return seen ? sign * (total + current) : undefined;
}

// ------------------------------------------------------------------ commands.ts + matcher.ts

export function compilePattern(p: string): RegExp {
  return new RegExp(`^(?:${p})$`, 'iu');
}

export interface CompiledVoiceCommand {
  def: VoiceCommand;
  regexes: Array<RegExp | null>;
  /** Pattern compile errors (the server skips such patterns). */
  errors: string[];
}

export function compileCommands(defs: readonly VoiceCommand[]): CompiledVoiceCommand[] {
  return defs.map((def) => {
    const errors: string[] = [];
    const regexes = def.patterns.map((p) => {
      try { return compilePattern(p); } catch (e) { errors.push(`${p}: ${(e as Error).message}`); return null; }
    });
    return { def, regexes, errors };
  });
}

export interface VoiceMatch {
  command: VoiceCommand;
  /** Index into command.patterns. */
  patternIndex: number;
  pattern: string;
  groups: Record<string, string>;
  /** The (normalized, possibly filler-trimmed) text that matched. */
  text: string;
}

export interface MatchTrace {
  match: VoiceMatch | null;
  /** Every form that was tried, in order (normalized first, then filler-trimmed). */
  forms: string[];
}

export function matchVoice(transcript: string, commands: readonly CompiledVoiceCommand[]): MatchTrace {
  const plain = normalize(transcript);
  const forms = [plain, ...canonicalForms(transcript).filter((f) => f !== plain)].filter(Boolean);
  for (const text of forms) {
    for (const c of commands) {
      for (let i = 0; i < c.regexes.length; i++) {
        const re = c.regexes[i];
        if (!re) continue;
        const m = re.exec(text);
        if (!m) continue;
        const groups: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) groups[k] = v.trim();
        return { match: { command: c.def, patternIndex: i, pattern: c.def.patterns[i], groups, text }, forms };
      }
    }
  }
  return { match: null, forms };
}

// ---------------------------------------------------------------- context + substitution

export interface ContextEntities { target?: string; focus?: string; selected?: string; gaze?: string }

type Hit = { entity?: unknown } | null | undefined;
const hitId = (h: Hit): string | undefined => (h && typeof h === 'object' && typeof h.entity === 'string' && h.entity ? h.entity : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function contextEntities(ctx: Record<string, unknown> | undefined): ContextEntities {
  if (!ctx) return {};
  const c = ctx as { focus?: { right?: Hit; left?: Hit }; selected?: unknown; gaze?: Hit; target?: unknown; entity?: unknown };
  const focus = hitId(c.focus?.right) ?? hitId(c.focus?.left);
  const selected = str(c.selected);
  const gaze = hitId(c.gaze);
  const explicit = str(c.target) ?? str(c.entity);
  const target = explicit ?? focus ?? selected ?? gaze;
  return { ...(target ? { target } : {}), ...(focus ? { focus } : {}), ...(selected ? { selected } : {}), ...(gaze ? { gaze } : {}) };
}

export class MissingVariableError extends Error {
  constructor(public readonly variable: string) {
    super(`missing value for $${variable}`);
    this.name = 'MissingVariableError';
  }
}

const VAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)(?::(number|int|slug|bool))?/g;
const EXACT_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)(?::(number|int|slug|bool))?$/;
const CONTEXT_VARS = new Set(['target', 'focus', 'selected', 'gaze']);

export interface SubstitutionVars { groups: Record<string, string>; entities: ContextEntities; text: string; transcript: string }

function lookup(name: string, v: SubstitutionVars): string | undefined {
  if (name in v.groups) return v.groups[name];
  if (CONTEXT_VARS.has(name)) {
    const id = v.entities[name as keyof ContextEntities];
    if (!id) throw new MissingVariableError(name);
    return id;
  }
  if (name === 'text') return v.text;
  if (name === 'transcript') return v.transcript;
  return undefined;
}

function typed(value: string, type: string | undefined, name: string): unknown {
  switch (type) {
    case 'number': {
      const n = parseNumber(value);
      if (n === undefined) throw new MissingVariableError(`${name} (not a number: "${value}")`);
      return n;
    }
    case 'int': {
      const n = parseNumber(value);
      if (n === undefined) throw new MissingVariableError(`${name} (not a number: "${value}")`);
      return Math.round(n);
    }
    case 'slug': return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    case 'bool': return /^(on|yes|true|show|open|enable|enabled|1)$/i.test(value.trim());
    default: return value;
  }
}

const OMIT = Symbol('omit');

function subValue(x: unknown, v: SubstitutionVars): unknown {
  if (typeof x === 'string') {
    const exact = EXACT_RE.exec(x);
    if (exact) {
      const val = lookup(exact[1], v);
      return val === undefined ? OMIT : typed(val, exact[2], exact[1]);
    }
    if (!x.includes('$')) return x;
    return x.replace(VAR_RE, (_m, name: string, type: string | undefined) => {
      const val = lookup(name, v);
      return val === undefined ? '' : String(typed(val, type, name));
    });
  }
  if (Array.isArray(x)) return x.map((e) => subValue(e, v)).filter((e) => e !== OMIT);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(x)) {
      const r = subValue(e, v);
      if (r !== OMIT) out[k] = r;
    }
    return out;
  }
  return x;
}

export function substituteArgs(args: Record<string, unknown> | undefined, vars: SubstitutionVars): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return subValue(args, vars) as Record<string, unknown>;
}

// ------------------------------------------------------------------ dry run (what the server would do)

export type DryRun =
  | { route: 'agent'; forms: string[] }
  | { route: 'fastpath'; match: VoiceMatch; forms: string[]; noop: boolean; run: string; args?: Record<string, unknown> }
  | { route: 'none'; match: VoiceMatch; forms: string[]; error: string };

/** Mirrors voice/index.ts route(): fast path (or 'none' when a $variable is missing), else Claude. */
export function dryRun(text: string, commands: readonly CompiledVoiceCommand[], context?: Record<string, unknown>): DryRun {
  const { match, forms } = matchVoice(text, commands);
  if (!match) return { route: 'agent', forms };
  const def = match.command;
  if (def.command === 'none') return { route: 'fastpath', match, forms, noop: true, run: 'none' };
  try {
    const args = substituteArgs(def.args, { groups: match.groups, entities: contextEntities(context), text: match.text, transcript: text });
    return { route: 'fastpath', match, forms, noop: false, run: def.command, ...(args ? { args } : {}) };
  } catch (e) {
    if (!(e instanceof MissingVariableError)) throw e;
    return { route: 'none', match, forms, error: e.message };
  }
}
