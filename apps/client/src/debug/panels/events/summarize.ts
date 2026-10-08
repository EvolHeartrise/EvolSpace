// Pure helpers of the Events panel (tested in apps/client/test/debug-panels-b-events.test.ts):
// per-type one-line summaries, severity, entity references, filtering and
// stack-trace formatting. Payload shapes follow the server emitters
// (apps/server/src/app.ts, ws/handlers.ts, voice/index.ts, sources/supervisor.ts).

import type { ServerEvent } from '@evolspace/protocol';

export type Severity = 'error' | 'warn' | 'info' | 'dim';

/** Every ServerEventType, in the order the type chips are shown. */
export const EVENT_TYPES = [
  'client.error', 'widget.build', 'source.exit', 'client.log', 'agent.ask', 'voice.utterance', 'pose.event',
  'widget.event', 'gestures.load', 'scene.changed', 'client.connect', 'client.disconnect',
] as const;

/** Chip colors per type (dashboard palette; errors get --neg regardless, see severity()). */
export const TYPE_COLOR: Record<string, string> = {
  'client.error': '#ff5d6c',
  'widget.build': '#45d49b',
  'source.exit': '#ff8a5c',
  'client.log': '#8d99ab',
  'agent.ask': '#a98bff',
  'voice.utterance': '#4fd9d4',
  'pose.event': '#5aa9ff',
  'widget.event': '#4cc3ff',
  'gestures.load': '#e7c75a',
  'scene.changed': '#6b778a',
  'client.connect': '#6b778a',
  'client.disconnect': '#6b778a',
};

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? '#8d99ab';
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const firstLine = (t: string) => { const i = t.indexOf('\n'); return i < 0 ? t : `${t.slice(0, i)} …`; };
const clip = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** How bad an event is: drives the red/amber row styling, the errors-only filter and the badge. */
export function severity(e: ServerEvent): Severity {
  const d = e.data ?? {};
  switch (e.type) {
    case 'client.error': return 'error';
    case 'widget.build': return d.ok === false || s(d.error) ? 'error' : (Array.isArray(d.warnings) && d.warnings.length ? 'warn' : 'info');
    case 'source.exit': return 'error';
    case 'client.log': return d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : 'info';
    case 'gestures.load': return d.errors && Object.keys(obj(d.errors)).length ? 'error' : d.warnings && Object.keys(obj(d.warnings)).length ? 'warn' : 'info';
    case 'voice.utterance': return s(d.error) ? 'error' : d.route === 'none' ? 'dim' : 'info';
    case 'scene.changed': case 'client.connect': case 'client.disconnect': return 'dim';
    default: return 'info';
  }
}

export const isError = (e: ServerEvent) => severity(e) === 'error';

/** A summary as text segments; `entity` segments render as clickable ids. */
export type Seg = string | { entity: string } | { strong: string } | { dim: string } | { tone: Severity; text: string };

export interface Summary {
  segs: Seg[];
  /** Entity ids referenced by the event (first = primary). */
  entities: string[];
}

function ctxOf(d: Record<string, unknown>): Record<string, unknown> {
  return { ...obj(d.context), ...d };
}

/** Entity ids an event refers to (entity, target, selected, focus/gaze hits). */
export function eventEntities(e: ServerEvent): string[] {
  const d = e.type === 'agent.ask' ? ctxOf(e.data ?? {}) : (e.data ?? {});
  const out: string[] = [];
  const add = (v: unknown) => { const id = s(v); if (id && !out.includes(id)) out.push(id); };
  add(d.entity);
  add(d.target);
  add(d.selected);
  const focus = obj(d.focus);
  add(obj(focus.right).entity);
  add(obj(focus.left).entity);
  add(obj(d.gaze).entity);
  return out;
}

/** One compact line per event type. */
export function summarize(e: ServerEvent): Summary {
  const d = e.data ?? {};
  const entities = eventEntities(e);
  const segs: Seg[] = [];
  const ent = (id: string | undefined) => { if (id) segs.push({ entity: id }); };
  switch (e.type) {
    case 'widget.build': {
      segs.push({ strong: String(d.widget ?? '?') }, ' ');
      if (d.ok === false || s(d.error)) segs.push({ tone: 'error', text: 'error' }, ` ${clip(firstLine(String(d.error ?? 'build failed')))}`);
      else {
        segs.push({ tone: 'info', text: 'ok' });
        if (typeof d.ms === 'number') segs.push({ dim: ` ${d.ms} ms` });
        if (s(d.hash)) segs.push({ dim: ` · ${d.hash}` });
        if (Array.isArray(d.warnings) && d.warnings.length) segs.push({ tone: 'warn', text: ` · ${d.warnings.length} warning${d.warnings.length === 1 ? '' : 's'}` });
      }
      break;
    }
    case 'voice.utterance': {
      const text = s(d.text);
      if (text) segs.push(`“${clip(text, 100)}”`);
      else segs.push({ dim: d.reason ? String(d.reason) : '(nothing heard)' });
      segs.push(' → ');
      const route = String(d.route ?? '?');
      segs.push({ tone: route === 'none' ? 'dim' : 'info', text: route === 'fastpath' && d.command ? `fastpath ${String(d.command)}` : route });
      if (s(d.run) && d.run !== 'none' && d.run !== d.command) segs.push({ dim: ` (${String(d.run)})` });
      if (s(d.error)) segs.push(' ', { tone: 'error', text: clip(String(d.error), 80) });
      if (s(d.target)) { segs.push({ dim: ' @ ' }); ent(s(d.target)); }
      if (d.simulated) segs.push({ dim: ' · simulated' });
      break;
    }
    case 'agent.ask': {
      const c = ctxOf(d);
      segs.push(`“${clip(String(d.text ?? c.text ?? ''), 110)}”`);
      const kind = s(c.kind) ?? s(c.source) ?? (s(c.utteranceId) ? 'voice' : undefined);
      if (kind) segs.push({ dim: ` · ${kind}` });
      const target = s(c.target) ?? s(c.entity) ?? s(c.selected);
      if (target) { segs.push({ dim: ' → ' }); ent(target); }
      if (c.simulated) segs.push({ dim: ' · simulated' });
      break;
    }
    case 'pose.event': {
      segs.push({ strong: String(d.pose ?? '?') }, ` ${String(d.hand ?? '')} `, { tone: d.phase === 'start' ? 'info' : 'dim', text: String(d.phase ?? '') });
      if (s(d.binding)) segs.push({ dim: ` · ${d.binding}` });
      if (s(d.target)) { segs.push({ dim: ' → ' }); ent(s(d.target)); }
      break;
    }
    case 'client.error': {
      segs.push({ tone: 'error', text: clip(firstLine(String(d.message ?? 'error')), 160) });
      if (s(d.widget) || s(d.entity)) {
        segs.push({ dim: ' (' });
        if (s(d.widget)) segs.push({ dim: String(d.widget) });
        if (s(d.widget) && s(d.entity)) segs.push({ dim: ' ' });
        ent(s(d.entity));
        segs.push({ dim: ')' });
      }
      break;
    }
    case 'client.log': {
      const lvl = String(d.level ?? 'info');
      segs.push({ tone: lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'dim', text: lvl }, ` ${clip(firstLine(String(d.message ?? '')), 160)}`);
      if (s(d.entity)) { segs.push({ dim: ' · ' }); ent(s(d.entity)); }
      break;
    }
    case 'widget.event': {
      segs.push({ strong: String(d.name ?? '?') }, { dim: ` ${String(d.widget ?? '')} ` });
      ent(s(d.entity));
      if (d.data !== undefined) segs.push({ dim: ` ${clip(safeJson(d.data), 80)}` });
      break;
    }
    case 'source.exit': {
      segs.push({ strong: String(d.id ?? '?') }, ' exited ', { tone: 'error', text: d.signal ? `signal ${String(d.signal)}` : `code ${String(d.code ?? '?')}` });
      if (typeof d.ranMs === 'number') segs.push({ dim: ` after ${fmtDuration(d.ranMs)}` });
      if (d.restarting) segs.push({ tone: 'warn', text: ` · restarting (#${String(d.restarts ?? '?')})` });
      break;
    }
    case 'gestures.load': {
      segs.push(`${String(d.poses ?? 0)} poses · ${String(d.interactions ?? 0)} interaction sets`);
      const ne = Object.keys(obj(d.errors)).length, nw = Object.keys(obj(d.warnings)).length;
      if (ne) segs.push(' · ', { tone: 'error', text: `${ne} error${ne === 1 ? '' : 's'}` });
      if (nw) segs.push(' · ', { tone: 'warn', text: `${nw} warning${nw === 1 ? '' : 's'}` });
      break;
    }
    case 'scene.changed':
      segs.push(`v${String(d.version ?? '?')}`, { dim: ` · ${String(d.source ?? '?')}${typeof d.ops === 'number' ? ` · ${d.ops} op${d.ops === 1 ? '' : 's'}` : ''}` });
      break;
    case 'client.connect':
      segs.push({ strong: String(d.clientId ?? '?') }, ` ${String(d.role ?? '')}`, ...(d.primary ? [{ tone: 'info' as const, text: ' primary' }] : []),
        ...(s(d.userAgent) ? [{ dim: ` · ${clip(String(d.userAgent), 60)}` }] : []));
      break;
    case 'client.disconnect':
      segs.push({ strong: String(d.clientId ?? '?') }, ` ${String(d.role ?? '')}`);
      break;
    default:
      segs.push({ dim: clip(safeJson(d), 160) });
  }
  return { segs, entities };
}

export function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

/** Summary as plain text (search, tooltips). */
export function summaryText(sum: Summary): string {
  return sum.segs.map((g) => (typeof g === 'string' ? g : 'entity' in g ? g.entity : 'strong' in g ? g.strong : 'dim' in g ? g.dim : g.text)).join('');
}

// ------------------------------------------------------------------ filtering

export interface EventFilter {
  /** Types hidden by the type toggles. */
  hidden: ReadonlySet<string>;
  /** Free text (case-insensitive) matched against type, summary and the JSON payload. */
  query: string;
  errorsOnly: boolean;
  /** Hide events at/before this point ("clear view"). */
  clearedAt?: { ts: number; seq: number } | null;
}

const searchCache = new WeakMap<ServerEvent, string>();
/** Lowercased haystack for text search (cached per event object). */
export function searchText(e: ServerEvent): string {
  let t = searchCache.get(e);
  if (t === undefined) {
    t = `${e.type} ${summaryText(summarize(e))} ${safeJson(e.data)}`.toLowerCase();
    searchCache.set(e, t);
  }
  return t;
}

/** After (ts, seq)? ts first: seq restarts with the server. */
export function isAfter(e: ServerEvent, mark: { ts: number; seq: number }): boolean {
  return e.ts > mark.ts || (e.ts === mark.ts && e.seq > mark.seq);
}

export function filterEvents(events: readonly ServerEvent[], f: EventFilter): ServerEvent[] {
  const q = f.query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const out: ServerEvent[] = [];
  for (const e of events) {
    if (f.clearedAt && !isAfter(e, f.clearedAt)) continue;
    if (f.hidden.has(e.type)) continue;
    if (f.errorsOnly && severity(e) !== 'error') continue;
    if (terms.length) {
      const hay = searchText(e);
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    out.push(e);
  }
  return out;
}

/** Error events newer than `mark` (null mark = all). */
export function countErrorsSince(events: readonly ServerEvent[], mark: { ts: number; seq: number } | null): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (mark && !isAfter(e, mark)) break; // the ring buffer is ordered by arrival
    if (isError(e)) n++;
  }
  return n;
}

// ------------------------------------------------------------------ stack traces

export interface StackLine {
  text: string;
  /** "at fn (file:line:col)" frame (vs. message lines). */
  frame: boolean;
  /** Frame inside a widget bundle (/widgets/<id>.js) or library code: the interesting ones. */
  own: boolean;
  /** Frame inside node_modules / vite deps / the runtime internals. */
  vendor: boolean;
}

/**
 * Split a JS stack into lines, shortening URLs to their path (the origin is the
 * same everywhere) and dropping Vite's `?v=hash` / `?t=` query noise.
 */
export function formatStack(stack: string, origin?: string): StackLine[] {
  const lines = stack.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  return lines.map((raw) => {
    let text = raw.trim();
    if (origin) text = text.split(origin).join('');
    text = text.replace(/https?:\/\/[^/\s)]+(?=\/)/g, '').replace(/\?(?:v|t|import)=?[\w.&=-]*(?=:\d)/g, '');
    const frame = /^at\s/.test(text) || /^[\w$.<>\s]*@\S+:\d+:\d+$/.test(text);
    const own = frame && /\/widgets\/|\/library\//.test(text);
    const vendor = frame && /node_modules|\/@vite\/|\/\.vite\/|\/@fs\//.test(text);
    return { text: frame ? `  ${text}` : text, frame, own, vendor };
  });
}
