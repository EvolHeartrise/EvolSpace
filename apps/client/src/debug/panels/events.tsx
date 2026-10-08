// Events panel: the server event log (ctx.store.events, a long-polled ring
// buffer of ServerEvent) as a live, windowed list. One compact summary line per
// event (summaries per type in events/summarize.ts), errors in red, click a row
// to expand JSON details / formatted stack traces / build errors / log tails.
// Filters: type chips (click toggles, Alt+click solos), text search, errors
// only, clear view; follows the tail until you scroll up (or pause it).
// Entity ids are clickable (select + frame). Tab badge = unseen errors.

import { signal } from '@preact/signals';
import type { ServerEvent } from '@evolspace/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { fmtTime, prettyJson } from '../ui/format.ts';
import { copyText } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Empty, IconButton, PanelBar, SearchBox } from '../ui/kit.tsx';
import { ensureCss } from './events/css.ts';
import { EVENTS_CSS } from './events/styles.ts';
import {
  EVENT_TYPES, countErrorsSince, filterEvents, formatStack, isAfter, severity, summarize, typeColor, type Seg,
} from './events/summarize.ts';

type Mark = { ts: number; seq: number };

// Module-level: survives tab switches.
const query = signal('');
const hidden = signal<ReadonlySet<string>>(new Set());
const errorsOnly = signal(false);
const follow = signal(true);
const clearedAt = signal<Mark | null>(null);
const expanded = signal<ReadonlySet<string>>(new Set());
/** Last event the user has seen (panel open) — the badge counts errors after it. */
const seen = signal<Mark | null>(null);

const SHORT: Record<string, string> = {
  'client.error': 'error', 'widget.build': 'build', 'source.exit': 'exit', 'client.log': 'log', 'agent.ask': 'ask',
  'voice.utterance': 'voice', 'pose.event': 'pose', 'widget.event': 'widget', 'gestures.load': 'gestures',
  'scene.changed': 'scene', 'client.connect': 'connect', 'client.disconnect': 'disconnect',
};

const keyOf = (e: ServerEvent) => `${e.ts}:${e.seq}`;
const markOf = (e: ServerEvent | undefined): Mark | null => (e ? { ts: e.ts, seq: e.seq } : null);

/** Open the Events panel filtered by `q` (used by other panels, e.g. Sources → its exits). */
export function showEvents(ctx: DebugContext, q: string, opts: { errorsOnly?: boolean } = {}): void {
  query.value = q;
  errorsOnly.value = !!opts.errorsOnly;
  hidden.value = new Set();
  follow.value = true;
  ctx.layout.show('events');
}

function toggleType(t: string, solo: boolean, present: string[]) {
  if (solo) {
    const only = hidden.value.size === present.length - 1 && !hidden.value.has(t);
    hidden.value = only ? new Set() : new Set(present.filter((x) => x !== t));
    return;
  }
  const next = new Set(hidden.value);
  if (next.has(t)) next.delete(t); else next.add(t);
  hidden.value = next;
}

function toggleExpanded(k: string) {
  const next = new Set(expanded.value);
  if (next.has(k)) next.delete(k); else next.add(k);
  expanded.value = next;
}

// ------------------------------------------------------------------ rows

function EntityRef({ ctx, id }: { ctx: DebugContext; id: string }) {
  const exists = !!ctx.store.scene.value.entities[id];
  return (
    <span class={`dbg-ev-ent${exists ? '' : ' gone'}`} title={exists ? `${id} — click to select & frame` : `${id} (no longer in the scene)`}
      onClick={(ev) => {
        ev.stopPropagation();
        if (!exists) { ctx.toast(`${id} is no longer in the scene`, 'warn'); return; }
        ctx.actions.select(id);
        ctx.actions.frame(id);
      }}>{id}</span>
  );
}

function Segs({ ctx, segs }: { ctx: DebugContext; segs: Seg[] }) {
  return (
    <>
      {segs.map((g, i) => {
        if (typeof g === 'string') return <span key={i}>{g}</span>;
        if ('entity' in g) return <EntityRef key={i} ctx={ctx} id={g.entity} />;
        if ('strong' in g) return <b key={i}>{g.strong}</b>;
        if ('dim' in g) return <span key={i} class="dm">{g.dim}</span>;
        return <span key={i} class={`t-${g.tone}`}>{g.text}</span>;
      })}
    </>
  );
}

function Stack({ stack }: { stack: string }) {
  const lines = formatStack(stack, typeof location !== 'undefined' ? location.origin : undefined);
  return (
    <pre class="dbg-ev-stack">
      {lines.map((l, i) => <div key={i} class={l.frame ? `fr${l.own ? ' own' : ''}${l.vendor ? ' vendor' : ''}` : 'msg'}>{l.text}</div>)}
    </pre>
  );
}

function Details({ ctx, e }: { ctx: DebugContext; e: ServerEvent }) {
  const d = e.data ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const stack = e.type === 'client.error' ? str(d.stack) : null;
  const buildErr = e.type === 'widget.build' ? str(d.error) : null;
  const logTail = e.type === 'source.exit' && Array.isArray(d.logTail) ? (d.logTail as unknown[]).map(String) : null;
  const gErrors = e.type === 'gestures.load' && d.errors && typeof d.errors === 'object' ? Object.entries(d.errors as Record<string, string>) : [];
  const gWarn = e.type === 'gestures.load' && d.warnings && typeof d.warnings === 'object' ? Object.entries(d.warnings as Record<string, string[]>) : [];
  const message = e.type === 'client.error' || e.type === 'client.log' ? str(d.message) : null;
  return (
    <div class="dbg-ev-det" onClick={(ev) => ev.stopPropagation()}>
      {stack ? <Stack stack={message && !stack.includes(message.split('\n')[0]) ? `${message}\n${stack}` : stack} />
        : message && message.includes('\n') ? <pre class="dbg-ev-stack"><div class="msg">{message}</div></pre> : null}
      {buildErr ? <pre class="dbg-ev-stack"><div class="msg">{buildErr}</div></pre> : null}
      {gErrors.length || gWarn.length ? (
        <pre class="dbg-ev-log">
          {gErrors.map(([f, m]) => <div key={`e${f}`} style={{ color: 'var(--neg)' }}>{f}: {m}</div>)}
          {gWarn.map(([f, ws]) => <div key={`w${f}`} style={{ color: 'var(--accent2)' }}>{f}: {Array.isArray(ws) ? ws.join('; ') : String(ws)}</div>)}
        </pre>
      ) : null}
      {logTail?.length ? (<><div class="lbl">Log tail</div><pre class="dbg-ev-log">{logTail.join('\n')}</pre></>) : null}
      <pre class="dbg-pre">{prettyJson(e.data)}</pre>
      <div class="acts">
        <span class="dbg-count">#{e.seq} · {new Date(e.ts).toLocaleString()}</span>
        <span style={{ flex: 1 }} />
        <IconButton icon="copy" class="sm" label="JSON" title="Copy the event as JSON"
          onClick={() => void copyText(JSON.stringify(e, null, 2)).then((ok) => ctx.toast(ok ? 'Event copied' : 'Clipboard unavailable', ok ? 'info' : 'warn'))} />
        {stack ? <IconButton icon="copy" class="sm" label="stack" title="Copy the stack trace"
          onClick={() => void copyText(stack).then((ok) => ctx.toast(ok ? 'Stack copied' : 'Clipboard unavailable', ok ? 'info' : 'warn'))} /> : null}
      </div>
    </div>
  );
}

function EventRow({ ctx, e, open }: { ctx: DebugContext; e: ServerEvent; open: boolean }) {
  const sev = severity(e);
  const sum = useMemo(() => summarize(e), [e]);
  const cid = typeof e.data?.clientId === 'string' ? e.data.clientId : null;
  const k = keyOf(e);
  return (
    <div class={`dbg-ev-row ${sev}${open ? ' open' : ''}`} data-k={k}>
      <div class="l" onClick={() => toggleExpanded(k)}>
        <span class="tw"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /></span>
        <span class="tm">{fmtTime(e.ts)}</span>
        <span class="dbg-ev-type" title={e.type}><span class="d" style={{ background: sev === 'error' ? 'var(--neg)' : typeColor(e.type) }} />{e.type}</span>
        <span class="sum"><Segs ctx={ctx} segs={sum.segs} /></span>
        {cid ? <span class="cid" title="client id">{cid}</span> : null}
        <span class="seq">#{e.seq}</span>
      </div>
      {open ? <Details ctx={ctx} e={e} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ windowed list

const ROW_H = 25; // 24px line + 1px border
const OVERSCAN = 400; // px

function EventList({ ctx, rows }: { ctx: DebugContext; rows: ServerEvent[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(300);
  const heights = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const open = expanded.value;
  const following = follow.value;
  const programmatic = useRef(false);

  // Row offsets (expanded rows use their measured height).
  const offsets = useMemo(() => {
    const o = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(rows[i]);
      o[i + 1] = o[i] + (open.has(k) ? heights.current.get(k) ?? ROW_H * 8 : ROW_H);
    }
    return o;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, open, measureTick]);
  const total = offsets[rows.length];

  // Visible window.
  const lo = Math.max(0, scrollTop - OVERSCAN), hi = scrollTop + viewH + OVERSCAN;
  let start = 0, a = 0, b = rows.length;
  while (a < b) { const m = (a + b) >> 1; if (offsets[m + 1] <= lo) a = m + 1; else b = m; }
  start = a;
  let end = start;
  while (end < rows.length && offsets[end] < hi) end++;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure expanded rows after render.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let changed = false;
    for (const row of el.querySelectorAll<HTMLElement>('.dbg-ev-row.open')) {
      const k = row.dataset.k!;
      const h = row.offsetHeight;
      if (h && heights.current.get(k) !== h) { heights.current.set(k, h); changed = true; }
    }
    if (changed) setMeasureTick((t) => t + 1);
  });

  // Follow the tail.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !following) return;
    const target = Math.max(0, total - el.clientHeight);
    if (Math.abs(el.scrollTop - target) > 1) {
      programmatic.current = true;
      el.scrollTop = target;
      setScrollTop(el.scrollTop);
    }
  }, [total, following, viewH]);

  // Scrolling UP pauses following; reaching the end resumes it (layout changes such as
  // expanding a row never pause it).
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    setScrollTop(top);
    const up = top < lastTop.current - 2;
    lastTop.current = top;
    if (programmatic.current) { programmatic.current = false; return; }
    const atBottom = el.scrollHeight - top - el.clientHeight < 8;
    if (atBottom && !follow.peek()) follow.value = true;
    else if (up && !atBottom && follow.peek()) follow.value = false;
  };

  return (
    <div ref={scroller} class="dbg-scroll dbg-ev-list" onScroll={onScroll} role="log" aria-live="off">
      <div style={{ height: `${total}px`, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: `${offsets[start]}px` }}>
          {rows.slice(start, end).map((e) => { const k = keyOf(e); return <EventRow key={k} ctx={ctx} e={e} open={open.has(k)} />; })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ panel

function EventsPanel({ ctx }: PanelProps) {
  ensureCss('events', EVENTS_CSS);
  const events = ctx.store.events.value;
  const f = { hidden: hidden.value, query: query.value, errorsOnly: errorsOnly.value, clearedAt: clearedAt.value };
  const rows = useMemo(() => filterEvents(events, f), [events, f.hidden, f.query, f.errorsOnly, f.clearedAt]);
  const visible = useMemo(() => (f.clearedAt ? events.filter((e) => isAfter(e, f.clearedAt!)) : events), [events, f.clearedAt]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of visible) c.set(e.type, (c.get(e.type) ?? 0) + 1);
    return c;
  }, [visible]);
  const errorCount = useMemo(() => countErrorsSince(visible, null), [visible]);
  const present = EVENT_TYPES.filter((t) => counts.has(t) || hidden.value.has(t)) as string[];
  for (const t of counts.keys()) if (!present.includes(t)) present.push(t);

  // While the panel is open, everything is seen.
  useEffect(() => { seen.value = markOf(events.at(-1)); }, [events]);

  // New rows since the user stopped following.
  const pausedAt = useRef<Mark | null>(null);
  if (follow.value) pausedAt.current = null;
  else if (!pausedAt.current) pausedAt.current = markOf(rows.at(-1));
  const newSince = !follow.value && pausedAt.current ? rows.filter((e) => isAfter(e, pausedAt.current!)).length : 0;

  return (
    <>
      <PanelBar class="dbg-ev-bar">
        <SearchBox value={query.value} onInput={(v) => { query.value = v; }} placeholder="Search events…" />
        <button type="button" class={`dbg-ev-chip err${errorsOnly.value ? ' on' : ''}`} title="Show errors only (client errors, failed builds, source exits, error logs)"
          onClick={() => { errorsOnly.value = !errorsOnly.value; }}>
          <Icon name="alert" size={12} />errors<span class="n">{errorCount}</span>
        </button>
        <span class="dbg-tsep" style={{ margin: '0 2px', height: '16px' }} />
        <div class="dbg-ev-chips">
          {present.map((t) => (
            <button key={t} type="button" class={`dbg-ev-chip${hidden.value.has(t) ? ' off' : ''}`}
              title={`${t} — click to ${hidden.value.has(t) ? 'show' : 'hide'}, Alt+click to show only this type`}
              onClick={(ev) => toggleType(t, ev.altKey, present)}>
              <span class="d" style={{ background: typeColor(t) }} />{SHORT[t] ?? t}<span class="n">{counts.get(t) ?? 0}</span>
            </button>
          ))}
          {hidden.value.size ? <button type="button" class="dbg-ev-chip" title="Show all types" onClick={() => { hidden.value = new Set(); }}>all</button> : null}
        </div>
        <span class="dbg-count" title="shown / in buffer">{rows.length}/{events.length}</span>
        <IconButton icon={follow.value ? 'stop' : 'play'} class="sm" active={follow.value}
          title={follow.value ? 'Following new events — click to pause autoscroll' : 'Paused — click to follow new events'}
          onClick={() => { follow.value = !follow.value; }} />
        <IconButton icon="trash" class="sm" title="Clear view (hides events received so far; the server log is untouched)"
          onClick={() => { clearedAt.value = markOf(events.at(-1)); expanded.value = new Set(); follow.value = true; }} />
        {clearedAt.value ? <IconButton icon="undo" class="sm" title="Show cleared events again" onClick={() => { clearedAt.value = null; }} /> : null}
      </PanelBar>
      <div class="dbg-ev-wrap">
        {rows.length ? <EventList ctx={ctx} rows={rows} /> : (
          events.length && (query.value || errorsOnly.value || hidden.value.size || clearedAt.value)
            ? <Empty icon="search" title="No matching events">{clearedAt.value && !visible.length ? 'View cleared — new events appear here.' : 'Nothing matches the current filters.'}</Empty>
            : <Empty icon="list" title="No events yet">Widget builds, client errors, voice utterances, asks to Claude, pose events, source exits… appear here live.</Empty>
        )}
        {!follow.value && rows.length ? (
          <button type="button" class="dbg-ev-follow" onClick={() => { follow.value = true; }}>
            <Icon name="chevronDown" size={13} />{newSince ? `${newSince} new` : 'Follow'}
          </button>
        ) : null}
      </div>
    </>
  );
}

export default definePanel({
  id: 'events',
  title: 'Events',
  dock: 'bottom',
  order: 20,
  icon: 'list',
  component: EventsPanel,
  badge: (ctx) => {
    const events = ctx.store.events.value;
    const n = countErrorsSince(events, seen.value);
    return n ? `!${n}` : null;
  },
});

/** Tests only. */
export const __eventsState = { query, hidden, errorsOnly, follow, clearedAt, expanded, seen };
