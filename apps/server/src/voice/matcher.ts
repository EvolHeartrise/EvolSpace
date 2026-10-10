// Fast-path matcher: transcript → (voice command, resolved args), or null.
//
// Matching: the transcript is normalized (normalize.ts) and each command's
// whole-utterance regexes are tried in file order; first match wins. If nothing
// matches the plain normalized form, each progressively filler-trimmed form is
// tried, least trimmed first ("okay, undo please" → "undo please" → "undo";
// "hide claude please" → "hide claude").
//
// Substitution in args (recursively, through nested objects/arrays):
//   "$group"            named regex group (string). Unmatched optional group → key omitted.
//   "$target"           deictic target: right-hand focus → left-hand focus → selected → gaze
//   "$focus" "$selected" "$gaze"   the individual context entities
//   "$head"             the speaking client's head pose {position, rotation} (whole value only; absent → omitted)
//   "$text"             the normalized utterance;  "$transcript" the raw transcript
//   "$var:number"       typed: number (accepts "3", "three", "twenty one"); also :int, :slug, :bool
// A string that is exactly one "$var" is replaced by the (typed) value; "$var"
// inside a longer string is spliced in as text.
import type { VoiceContext } from '@evolspace/protocol';
import type { CompiledCommand } from './commands.ts';
import { canonicalForms, normalize, parseNumber } from './normalize.ts';

export interface MatchResult {
  command: CompiledCommand;
  /** Named groups that participated in the match. */
  groups: Record<string, string>;
  /** The normalized text that matched (plain or a filler-trimmed form). */
  text: string;
  pattern: string;
}

export function matchCommand(transcript: string, commands: readonly CompiledCommand[]): MatchResult | null {
  const plain = normalize(transcript);
  const forms = [plain, ...canonicalForms(transcript).filter((f) => f !== plain)];
  for (const text of forms) {
    if (!text) continue;
    for (const c of commands) {
      for (let i = 0; i < c.regexes.length; i++) {
        const m = c.regexes[i].exec(text);
        if (!m) continue;
        const groups: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) groups[k] = v.trim();
        return { command: c, groups, text, pattern: c.def.patterns[i] };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- context

type Hit = { entity?: unknown } | null | undefined;
const hitId = (h: Hit): string | undefined =>
  h && typeof h === 'object' && typeof h.entity === 'string' && h.entity ? h.entity : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export interface ContextEntities {
  target?: string;
  focus?: string;
  selected?: string;
  gaze?: string;
}

/**
 * Resolve the deictic entities of a VoiceContext. Also accepts a loose context
 * from /api/voice/simulate: an explicit `target` / `entity` string wins.
 */
export function contextEntities(ctx: VoiceContext | Record<string, unknown> | undefined): ContextEntities {
  if (!ctx) return {};
  const c = ctx as VoiceContext & { target?: unknown; entity?: unknown };
  const focus = hitId(c.focus?.right as Hit) ?? hitId(c.focus?.left as Hit);
  const selected = str(c.selected);
  const gaze = hitId(c.gaze as Hit);
  const explicit = str(c.target) ?? str(c.entity);
  const target = explicit ?? focus ?? selected ?? gaze;
  return {
    ...(target ? { target } : {}),
    ...(focus ? { focus } : {}),
    ...(selected ? { selected } : {}),
    ...(gaze ? { gaze } : {}),
  };
}

// ---------------------------------------------------------------- substitution

/** A $variable the command needs has no value (e.g. "$target" while pointing at nothing). */
export class MissingVariableError extends Error {
  constructor(public readonly variable: string) {
    super(`missing value for $${variable}`);
    this.name = 'MissingVariableError';
  }
}

const VAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)(?::(number|int|slug|bool))?/g;
const EXACT_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)(?::(number|int|slug|bool))?$/;
/** Context variables: absent → error (the command cannot run without them). */
const CONTEXT_VARS = new Set(['target', 'focus', 'selected', 'gaze']);

export interface SubstitutionVars {
  groups: Record<string, string>;
  entities: ContextEntities;
  text: string;
  transcript: string;
  /** Head pose of the client that spoke (VoiceContext.head), for "$head". */
  head?: unknown;
}

function lookup(name: string, v: SubstitutionVars): string | undefined {
  if (name in v.groups) return v.groups[name];
  if (CONTEXT_VARS.has(name)) {
    const id = v.entities[name as keyof ContextEntities];
    if (!id) throw new MissingVariableError(name);
    return id;
  }
  if (name === 'text') return v.text;
  if (name === 'transcript') return v.transcript;
  return undefined; // unmatched optional group / unknown var
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
    case 'slug':
      return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    case 'bool':
      return /^(on|yes|true|show|open|enable|enabled|1)$/i.test(value.trim());
    default:
      return value;
  }
}

const OMIT = Symbol('omit');

function subValue(x: unknown, v: SubstitutionVars): unknown {
  if (typeof x === 'string') {
    if (x === '$head') return v.head && typeof v.head === 'object' ? structuredClone(v.head) : OMIT;
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

/** Substitute $variables in a command's args. Throws MissingVariableError. */
export function substituteArgs(args: Record<string, unknown> | undefined, vars: SubstitutionVars): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return subValue(args, vars) as Record<string, unknown>;
}

/** True if any string in `args` references one of the context variables. */
export function referencesContext(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (x: unknown) => {
    if (typeof x === 'string') { for (const m of x.matchAll(VAR_RE)) if (CONTEXT_VARS.has(m[1])) found.add(m[1]); }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(args);
  return [...found];
}
