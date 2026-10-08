// Sources panel: supervised data-driver processes (library/sources/<id>/source.json).
// List with status, pid, restarts, last exit, autostart; start / stop / restart;
// the selected source's log tail (monospace, error lines highlighted, follows
// the end unless you scroll up) refreshed while the panel is visible
// (store.need('sources') polling); its recent source.exit events on top.

import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { fmtAgo, fmtTime } from '../ui/format.ts';
import { copyText, useNeed } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Dot, Empty, IconButton, PanelBar, Scroll, SearchBox } from '../ui/kit.tsx';
import { showEvents } from './events.tsx';
import { ensureCss } from './events/css.ts';
import { fmtDuration, isAfter } from './events/summarize.ts';
import { exitLabel, exitsFor, lineClass, type SourceInfo } from './sources/model.ts';
import { SOURCES_CSS } from './sources/styles.ts';

const selected = signal<string | null>(null);
const filter = signal('');
const busy = signal<Record<string, string>>({});
/** Last event seen with the panel open: the badge counts source exits after it. */
const seen = signal<{ ts: number; seq: number } | null>(null);

async function act(ctx: DebugContext, id: string, what: 'start' | 'stop' | 'restart') {
  busy.value = { ...busy.value, [id]: what };
  try {
    if (what === 'start') await ctx.api.startSource(id);
    else if (what === 'stop') await ctx.api.stopSource(id);
    else await ctx.api.restartSource(id);
    ctx.toast(`${id}: ${what === 'stop' ? 'stopped' : what === 'start' ? 'started' : 'restarted'}`);
  } catch (e) {
    ctx.toast(`${id}: ${what} failed — ${(e as Error).message}`, 'error');
  } finally {
    const next = { ...busy.value };
    delete next[id];
    busy.value = next;
    void ctx.store.refresh('sources').catch(() => {});
  }
}

function SourceRow({ ctx, s, sel, recentExit }: { ctx: DebugContext; s: SourceInfo; sel: boolean; recentExit: boolean }) {
  const b = busy.value[s.id];
  const exit = s.lastExit;
  const badExit = exit && exit.code !== 0;
  return (
    <div class={`dbg-src-row${sel ? ' sel' : ''}${recentExit ? ' exited' : ''}`} onClick={() => { selected.value = s.id; }} data-src={s.id}>
      <Dot kind={b ? 'busy' : s.error ? 'error' : s.running ? 'ok' : badExit ? 'warn' : 'off'}
        title={b ? `${b}…` : s.error ? s.error : s.running ? 'running' : 'stopped'} />
      <div class="m">
        <div class="l1">
          <span class="id">{s.id}</span>
          {s.running ? <Badge kind="ok">running</Badge> : <Badge kind="dim">stopped</Badge>}
          {s.autostart ? <Badge kind="info" title="autostart: started with the server">auto</Badge> : null}
          <span class="ds" title={s.description}>{s.description}</span>
        </div>
        <div class="l2">
          <span title="process id">pid {s.pid ?? '—'}</span>
          <span class={s.restarts ? 'bad' : ''} title="restarts after crashes">↻ {s.restarts}</span>
          {exit ? <span class={badExit ? 'bad' : ''} title={new Date(exit.at).toLocaleString()}>last exit {exit.code ?? 'signal'} · {fmtAgo(exit.at)} ago</span> : <span>no exits</span>}
        </div>
        {s.error ? <div class="err" title={s.error}>{s.error}</div> : null}
      </div>
      <div class="acts">
        {s.running
          ? <IconButton icon="stop" class="sm" title="Stop" disabled={!!b} onClick={() => void act(ctx, s.id, 'stop')} />
          : <IconButton icon="play" class="sm" title="Start" disabled={!!b} onClick={() => void act(ctx, s.id, 'start')} />}
        <IconButton icon="refresh" class="sm" title="Restart" disabled={!!b} onClick={() => void act(ctx, s.id, 'restart')} />
      </div>
    </div>
  );
}

function LogView({ ctx, s }: { ctx: DebugContext; s: SourceInfo }) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [follow, setFollow] = useState(true);
  const lines = s.logTail ?? [];
  const exits = exitsFor(ctx.store.events.value, s.id, 6);
  const lastLine = lines.at(-1);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, lastLine, s.id]);
  useLayoutEffect(() => { stick.current = true; setFollow(true); }, [s.id]);
  return (
    <div class="dbg-src-log">
      <div class="hd">
        <Icon name="code" size={13} />
        <span class="t">{s.id}</span>
        <span class="dbg-count">log tail · {lines.length} lines</span>
        <span style={{ flex: 1 }} />
        <IconButton icon={follow ? 'stop' : 'play'} class="sm" active={follow} title={follow ? 'Following the end — click to pause' : 'Paused — click to follow'}
          onClick={() => { stick.current = !follow; setFollow(!follow); if (!follow && box.current) box.current.scrollTop = box.current.scrollHeight; }} />
        <IconButton icon="list" class="sm" title="Show this source's exits in the Events panel" onClick={() => showEvents(ctx, `source.exit ${s.id}`)} />
        <IconButton icon="copy" class="sm" title="Copy the log tail" onClick={() => void copyText(lines.join('\n')).then((ok) => ctx.toast(ok ? 'Log copied' : 'Clipboard unavailable', ok ? 'info' : 'warn'))} />
      </div>
      {exits.length ? (
        <div class="dbg-src-exits">
          {exits.map((x) => (
            <div key={`${x.ts}:${x.seq}`} class={`dbg-src-exit${x.code === 0 && !x.signal ? ' ok' : ''}`}>
              <Icon name="alert" size={11} />
              <span class="tm">{fmtTime(x.ts).slice(0, 8)}</span>
              exited {exitLabel(x)}{x.ranMs !== undefined ? ` after ${fmtDuration(x.ranMs)}` : ''}{x.restarting ? ` · restarting (#${x.restarts ?? '?'})` : ''}
            </div>
          ))}
        </div>
      ) : null}
      <pre class="dbg-src-lines" ref={box} onScroll={() => {
        const el = box.current!;
        const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
        stick.current = atEnd;
        if (atEnd !== follow) setFollow(atEnd);
      }}>
        {lines.length ? lines.map((l, i) => <div key={i} class={lineClass(l)}><span class="n">{i + 1}</span>{l}</div>)
          : <div style={{ color: 'var(--faint)', padding: '8px 10px' }}>{s.running ? 'No output yet.' : 'Not running — no output.'}</div>}
      </pre>
    </div>
  );
}

function SourcesPanel({ ctx }: PanelProps) {
  ensureCss('sources', SOURCES_CSS);
  useNeed(ctx, 'sources');
  const list = ctx.store.sources.value as SourceInfo[];
  const q = filter.value.trim().toLowerCase();
  const shown = q ? list.filter((s) => `${s.id} ${s.description ?? ''}`.toLowerCase().includes(q)) : list;
  const sel = list.find((s) => s.id === selected.value) ?? shown[0] ?? null;
  const events = ctx.store.events.value;
  const now = Date.now();
  const recent = new Set(events.filter((e) => e.type === 'source.exit' && now - e.ts < 8000).map((e) => String(e.data.id)));
  const running = list.filter((s) => s.running).length;
  useEffect(() => { const l = events.at(-1); seen.value = l ? { ts: l.ts, seq: l.seq } : null; }, [events]);
  return (
    <>
      <PanelBar>
        <SearchBox value={filter.value} onInput={(v) => { filter.value = v; }} placeholder="Filter sources" />
        <span class="dbg-count">{running}/{list.length} running</span>
        <IconButton icon="refresh" class="sm" title="Refresh now" onClick={() => void ctx.store.refresh('sources').catch((e: Error) => ctx.toast(e.message, 'error'))} />
      </PanelBar>
      {!list.length ? (
        <Empty icon="cpu" title="No sources">Add a long-running driver in <span class="dbg-mono">library/sources/&lt;id&gt;/source.json</span>.</Empty>
      ) : (
        <div class="dbg-src">
          <div class="dbg-src-list">
            <Scroll>
              {shown.map((s) => <SourceRow key={s.id} ctx={ctx} s={s} sel={s.id === sel?.id} recentExit={recent.has(s.id)} />)}
              {!shown.length ? <Empty icon="search" title="No match" /> : null}
            </Scroll>
          </div>
          {sel ? <LogView ctx={ctx} s={sel} /> : <div />}
        </div>
      )}
    </>
  );
}

export default definePanel({
  id: 'sources',
  title: 'Sources',
  dock: 'bottom',
  order: 40,
  icon: 'cpu',
  component: SourcesPanel,
  badge: (ctx) => {
    // Source exits not seen yet (from the event log — no polling needed for the badge).
    const mark = seen.value;
    const n = ctx.store.events.value.filter((e) => e.type === 'source.exit' && (!mark || isAfter(e, mark))).length;
    return n ? `!${n}` : null;
  },
});
