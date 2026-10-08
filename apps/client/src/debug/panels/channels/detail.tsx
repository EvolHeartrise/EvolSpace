// Channel detail: live value (WS subscription through the runtime's ChannelHub,
// SSE fallback, one-off GET if nothing arrives), tensor stats + heatmap /
// sparkline, rolling history of scalar values, quick controls, JSON editor,
// copy / delete.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { isTensor, type ChannelInfo, type TensorValue } from '@evolspace/protocol';
import type { DebugContext } from '../../types.ts';
import { ApiError } from '../../api.ts';
import { NumberField, SliderField, Switch, TextField, type EditInfo } from '../../ui/fields.tsx';
import { fmtAgo, fmtBytes, fmtNum, prettyJson } from '../../ui/format.ts';
import { copyText } from '../../ui/hooks.ts';
import { Icon } from '../../ui/icons.tsx';
import { Badge, Dot, Empty, IconButton } from '../../ui/kit.tsx';
import { JsonTree } from './JsonTree.tsx';
import { History, channelType, draftChannels, selectedChannel } from './model.ts';
import {
  colorScale, guessRange, slice2d, stats, tensorFloats, tensorLabel, tensorStats, valueKind, type Stats,
} from './tensor.ts';
import { Heatmap, Sparkline } from './viz.tsx';

// ------------------------------------------------------------------ live value

export interface LiveValue {
  value: unknown;
  /** Something arrived (null is a value). */
  has: boolean;
  at: number;
  count: number;
  via: 'ws' | 'sse' | 'http' | null;
  missing: boolean;
  history: History;
}

/** Subscribe to a channel while mounted / while `name` is set. UI updates are throttled to ~15 Hz. */
export function useChannelValue(ctx: DebugContext, name: string | null): LiveValue {
  const hist = useRef(new History(300));
  const latest = useRef<LiveValue>({ value: undefined, has: false, at: 0, count: 0, via: null, missing: false, history: hist.current });
  const [, setTick] = useState(0);
  useEffect(() => {
    hist.current = new History(300);
    latest.current = { value: undefined, has: false, at: 0, count: 0, via: null, missing: false, history: hist.current };
    setTick((t) => t + 1);
    if (!name) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPaint = 0;
    const paint = () => {
      timer = null;
      if (!alive) return;
      lastPaint = performance.now();
      setTick((t) => t + 1);
    };
    const onValue = (via: LiveValue['via']) => (v: unknown) => {
      if (!alive) return;
      const L = latest.current;
      latest.current = { ...L, value: v, has: true, at: Date.now(), count: L.count + 1, via, missing: false };
      hist.current.push(v);
      const wait = 66 - (performance.now() - lastPaint);
      if (wait <= 0 && !timer) paint();
      else if (!timer) timer = setTimeout(paint, Math.max(0, wait));
    };
    let off: () => void;
    const hub = (ctx.runtime as unknown as { channels?: { subscribe?(n: string, cb: (v: unknown) => void): () => void } } | undefined)?.channels;
    if (hub?.subscribe) off = hub.subscribe(name, onValue('ws'));
    else off = ctx.api.channelEvents(name, onValue('sse'));
    // The server sends the current value on subscribe; fall back to a GET if nothing came.
    const fallback = setTimeout(() => {
      if (!alive || latest.current.has) return;
      ctx.api.channel(name).then((v) => { if (alive && !latest.current.has) onValue('http')(v); }).catch((e: unknown) => {
        if (alive && e instanceof ApiError && e.status === 404) { latest.current = { ...latest.current, missing: true }; paint(); }
      });
    }, 500);
    return () => {
      alive = false;
      off();
      clearTimeout(fallback);
      if (timer) clearTimeout(timer);
    };
  }, [ctx, name]);
  return latest.current;
}

// ------------------------------------------------------------------ value views

const sliceState = new Map<string, number[]>();

export function StatsRow({ s, extra }: { s: Stats; extra?: string }) {
  return (
    <div class="dbg-stats">
      <span><b>min</b>{fmtNum(s.min)}</span>
      <span><b>max</b>{fmtNum(s.max)}</span>
      <span><b>mean</b>{fmtNum(s.mean)}</span>
      <span><b>std</b>{fmtNum(s.std)}</span>
      <span class={s.nan ? 'bad' : undefined}><b>NaN</b>{s.nan}</span>
      {s.inf ? <span class="bad"><b>inf</b>{s.inf}</span> : null}
      <span><b>n</b>{s.count}</span>
      {extra ? <span>{extra}</span> : null}
    </div>
  );
}

export function TensorView({ name, t, maxH = 170 }: { name: string; t: TensorValue; maxH?: number }) {
  const st = useMemo(() => tensorStats(t), [t]);
  const rank = t.shape.length;
  const [lead, setLead] = useState<number[]>(() => sliceState.get(name) ?? []);
  useEffect(() => { setLead(sliceState.get(name) ?? []); }, [name]);
  const setAxis = (a: number, i: number) => {
    const next = lead.slice();
    next[a] = i;
    sliceState.set(name, next);
    setLead(next);
  };
  const grid = useMemo(() => (rank >= 2 ? slice2d(t, lead) : null), [t, rank, lead.join(',')]);
  // One color scale over the whole tensor (so slices are comparable).
  const scale = useMemo(() => colorScale(st), [st]);
  let viz;
  if (t.data.length === 0) viz = <div class="dbg-dim">Empty tensor.</div>;
  else if (rank === 0 || t.data.length === 1) viz = <div class="dbg-big">{fmtNum(tensorFloats(t)[0])}<span class="u">{tensorLabel(t)}</span></div>;
  else if (rank === 1 || (rank === 2 && t.shape[0] === 1)) viz = <Sparkline values={tensorFloats(t)} height={90} label={(i) => `[${i}]`} />;
  else viz = grid ? <Heatmap grid={grid} scale={scale} height={Math.max(60, rank >= 3 ? maxH - 26 : maxH)} rowLabel={`ax${rank - 2}`} colLabel={`ax${rank - 1}`} /> : null;
  return (
    <>
      <StatsRow s={st} />
      {rank >= 3 ? (
        <div class="dbg-slices" title="Leading axes: pick the slice to show (the heatmap is the last two axes)">
          {t.shape.slice(0, -2).map((n, a) => (
            <label key={a} class="ax">
              <span>ax{a}</span>
              <input type="range" min={0} max={Math.max(0, n - 1)} step={1} value={Math.min(lead[a] ?? 0, n - 1)}
                onInput={(e) => setAxis(a, Number((e.currentTarget as HTMLInputElement).value))} />
              <span class="i">{Math.min(lead[a] ?? 0, n - 1)}/{n - 1}</span>
            </label>
          ))}
        </div>
      ) : null}
      {viz}
    </>
  );
}

function NumberView({ ctx, name, v, live }: { ctx: DebugContext; name: string; v: number; live: LiveValue }) {
  const h = live.history;
  const hs = h.length ? stats(h.v) : null;
  const range = guessRange(v, hs && Number.isFinite(hs.min) ? { min: hs.min, max: hs.max } : null);
  const publish = (x: number, info?: EditInfo) => void publishValue(ctx, name, x, info ? !info.final : false);
  return (
    <>
      <div class="dbg-big">{fmtNum(v, 6)}<span class="u">number</span></div>
      {h.length > 1 ? <Sparkline values={h.v} height={56} label={(i) => `-${((Date.now() - h.t[i]) / 1000).toFixed(1)}s`} /> : (
        <div class="dbg-dim" style={{ fontSize: '11.5px' }}>History builds up while this channel is open.</div>
      )}
      <div class="dbg-quick">
        <span class="lbl">set</span>
        <SliderField value={v} min={range.min} max={range.max} step={range.step} onChange={publish} />
      </div>
    </>
  );
}

function BoolView({ ctx, name, v, live }: { ctx: DebugContext; name: string; v: boolean; live: LiveValue }) {
  return (
    <>
      <div class="dbg-quick">
        <div class="dbg-big">{String(v)}</div>
        <Switch checked={v} title="Publish the opposite value" onChange={(x) => void publishValue(ctx, name, x)} />
      </div>
      {live.history.length > 1 ? <Sparkline values={live.history.v} height={40} step label={(i) => `-${((Date.now() - live.history.t[i]) / 1000).toFixed(1)}s`} /> : null}
    </>
  );
}

function StringView({ ctx, name, v }: { ctx: DebugContext; name: string; v: string }) {
  return (
    <>
      <div class="dbg-quick" style={{ flexWrap: 'nowrap' }}>
        <span class="lbl">set</span>
        <TextField value={v} mono onCommit={(x) => void publishValue(ctx, name, x)} title="Enter to publish" />
      </div>
      <JsonTree value={v} />
    </>
  );
}

export function ValueView({ ctx, name, live, maxH }: { ctx: DebugContext; name: string; live: LiveValue; maxH?: number }) {
  const v = live.value;
  switch (valueKind(v)) {
    case 'tensor': return <TensorView name={name} t={v as TensorValue} maxH={maxH} />;
    case 'number': return <NumberView ctx={ctx} name={name} v={v as number} live={live} />;
    case 'boolean': return <BoolView ctx={ctx} name={name} v={v as boolean} live={live} />;
    case 'string': return <StringView ctx={ctx} name={name} v={v as string} />;
    case 'numarray': {
      const arr = v as number[];
      return (
        <>
          <StatsRow s={stats(arr)} />
          <Sparkline values={arr} height={70} />
          <JsonTree value={v} open={1} />
        </>
      );
    }
    case 'null': return <JsonTree value={null} />;
    default: return <JsonTree value={v} open={2} />;
  }
}

// ------------------------------------------------------------------ publish / editor

export async function publishValue(ctx: DebugContext, name: string, value: unknown, quiet = false): Promise<boolean> {
  try {
    await ctx.api.publish(name, value, { producer: 'debug' });
    if (draftChannels.value.includes(name)) draftChannels.value = draftChannels.value.filter((n) => n !== name);
    return true;
  } catch (e) {
    if (!quiet) ctx.toast((e as Error).message, 'error');
    return false;
  }
}

/** Parse editor text: JSON, or an unquoted string is rejected with the JSON error. */
export function parseEditor(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'empty — type a JSON value (e.g. 0.5, true, "text", {"a": 1})' };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

function Editor({ ctx, name, value, onClose }: { ctx: DebugContext; name: string; value: unknown; onClose(): void }) {
  const [text, setText] = useState(() => (value === undefined ? '' : prettyJson(value)));
  const [busy, setBusy] = useState(false);
  const p = parseEditor(text);
  const send = async () => {
    if (!p.ok || busy) return;
    setBusy(true);
    const ok = await publishValue(ctx, name, p.value);
    setBusy(false);
    if (ok) ctx.toast(`Published ${name}`);
  };
  return (
    <div class={`dbg-edit${p.ok || !text.trim() ? '' : ' invalid'}`}>
      <div class="bar">
        <span class="dbg-sub" style={{ margin: 0 }}>Publish JSON</span>
        <span style={{ flex: 1 }} />
        <button type="button" class="dbg-btn small" title="Reset to the current value" onClick={() => setText(value === undefined ? '' : prettyJson(value))}>Reset</button>
        <button type="button" class="dbg-btn small primary" disabled={!p.ok || busy} onClick={() => void send()} title="PUT /api/channels/:name (Ctrl+Enter)">
          <Icon name="radio" size={12} />Publish
        </button>
        <IconButton icon="x" class="sm" title="Close editor" onClick={onClose} />
      </div>
      <textarea rows={Math.min(10, Math.max(3, text.split('\n').length))} spellcheck={false} value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        }} />
      {!p.ok && text.trim() ? <div class="err">{p.error}</div> : <div class="hint">Ctrl+Enter to publish · Esc to close</div>}
    </div>
  );
}

// ------------------------------------------------------------------ detail pane

function useHeight(ref: { current: HTMLElement | null }): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return h;
}

export function ChannelDetail({ ctx, name, info }: { ctx: DebugContext; name: string; info?: ChannelInfo }) {
  const live = useChannelValue(ctx, name);
  const draft = draftChannels.value.includes(name) && !info;
  const [editing, setEditing] = useState(draft);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setEditing(draftChannels.peek().includes(name)); setConfirm(false); }, [name]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const tensor = isTensor(live.value);
  const body = useRef<HTMLDivElement>(null);
  const bodyH = useHeight(body);
  const del = async () => {
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    try {
      await ctx.api.deleteChannel(name);
      ctx.toast(`Deleted channel ${name}`);
      selectedChannel.value = null;
      void ctx.store.refresh('channels').catch(() => {});
    } catch (e) { ctx.toast((e as Error).message, 'error'); }
  };
  const age = info?.updatedAt ? fmtAgo(info.updatedAt) : live.at ? fmtAgo(live.at) : null;
  return (
    <div class="dbg-ch-detail">
      <div class="dbg-ch-dhead">
        <Icon name="radio" size={14} style={{ color: 'var(--accent)' }} />
        <span class="t" title={name}>{name}</span>
        {info ? <Badge kind={info.kind === 'tensor' ? 'info' : 'dim'}>{channelType(info)}</Badge> : draft ? <Badge kind="warn">new</Badge> : null}
        <span style={{ flex: 1 }} />
        <span class="live" title={live.via ? `live via ${live.via === 'ws' ? 'WebSocket (runtime ChannelHub)' : live.via === 'sse' ? 'Server-sent events' : 'HTTP GET'}` : 'waiting for a value'}>
          <Dot kind={live.has ? 'ok' : live.missing ? 'off' : 'busy'} />{live.has ? `${live.count} msg` : live.missing ? 'no value' : '…'}
        </span>
        <IconButton icon="copy" class="sm" title="Copy channel name" onClick={() => void copyText(name).then((ok) => ctx.toast(ok ? `Copied ${name}` : 'Clipboard unavailable'))} />
        <IconButton icon="code" class="sm" active={editing} disabled={tensor} title={tensor ? 'Tensor channels are published from code (HTTP binary / Python SDK)' : 'Edit & publish JSON'} onClick={() => setEditing(!editing)} />
        <button type="button" class={`dbg-ibtn sm danger${confirm ? ' dbg-confirm' : ''}`} disabled={!info} title={confirm ? 'Click again to delete' : 'Delete channel'}
          onClick={() => void del()} style={confirm ? { padding: '0 6px', width: 'auto' } : undefined}>
          <Icon name="trash" size={13} />{confirm ? <span style={{ fontSize: '11px' }}>delete?</span> : null}
        </button>
        <IconButton icon="x" class="sm" title="Close" onClick={() => { selectedChannel.value = null; }} />
      </div>
      <div class="dbg-ch-body" ref={body}>
        <div class="dbg-ch-meta">
          {info?.producer ? <Badge kind="dim" title="producer">{info.producer}</Badge> : null}
          {info ? <span>seq {info.seq}</span> : null}
          {info ? <span>· {fmtBytes(info.size)}</span> : null}
          {age ? <span>· updated {age} ago</span> : null}
          {info?.description ? <span class="desc">{info.description}</span> : null}
        </div>
        {editing && !tensor ? <Editor key={name} ctx={ctx} name={name} value={live.value} onClose={() => setEditing(false)} /> : null}
        {live.has ? <ValueView ctx={ctx} name={name} live={live} maxH={bodyH ? Math.min(320, bodyH - 96) : 170} />
          : live.missing || draft ? <Empty icon="radio" title="No value yet">{draft ? 'Type a JSON value above and publish to create the channel.' : 'This channel has no value (deleted?).'}</Empty>
            : <div class="dbg-dim" style={{ fontSize: '12px' }}>Subscribing…</div>}
      </div>
    </div>
  );
}
