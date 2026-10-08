// Channels panel: the data bus. Live list (polled only while this tab is open:
// useNeed 'channels') with type, size, seq, publish rate, age and producer;
// filter; select a channel → detail pane with its live value (WS subscription
// through the runtime, released on close), tensor stats + heatmap/sparkline,
// rolling history for scalars, quick controls, JSON publish, copy, delete.

import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChannelInfo } from '@evolspace/protocol';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { fmtAgo, fmtBytes } from '../ui/format.ts';
import { copyText, useNeed } from '../ui/hooks.ts';
import { Empty, IconButton, PanelBar, SearchBox } from '../ui/kit.tsx';
import { openMenu, promptText } from '../ui/menu.tsx';
import { ChannelDetail } from './channels/detail.tsx';
import {
  RateTracker, channelQuery, channelType, draftChannels, filterChannels, fmtRate, selectedChannel, validateChannelName,
} from './channels/model.ts';
import { CHANNELS_CSS, ensureStyle } from './channels/style.ts';
import { VirtualList } from './channels/vlist.tsx';

const ROW_H = 24;
const rates = new RateTracker();
const listWidth = signal<number | null>(null);

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function rowMenu(ctx: DebugContext, c: ChannelInfo) {
  return [
    { header: c.name },
    { label: 'Copy name', icon: 'copy' as const, run: () => void copyText(c.name).then((ok) => ctx.toast(ok ? `Copied ${c.name}` : 'Clipboard unavailable')) },
    { label: 'Copy #ref (for props/links)', icon: 'link' as const, run: () => void copyText(`#${c.name}`).then((ok) => ctx.toast(ok ? `Copied #${c.name}` : 'Clipboard unavailable')) },
    'separator' as const,
    {
      label: 'Delete channel', icon: 'trash' as const, danger: true,
      run: () => void ctx.api.deleteChannel(c.name).then(() => {
        ctx.toast(`Deleted channel ${c.name}`);
        if (selectedChannel.value === c.name) selectedChannel.value = null;
        void ctx.store.refresh('channels').catch(() => {});
      }, (e: Error) => ctx.toast(e.message, 'error')),
    },
  ];
}

function Splitter({ host }: { host: { current: HTMLDivElement | null } }) {
  const [active, setActive] = useState(false);
  return (
    <div class={`dbg-ch-split${active ? ' active' : ''}`} title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setActive(true);
        document.body.classList.add('dbg-resizing', 'dbg-resizing-x');
      }}
      onPointerMove={(e) => {
        if (!active || !host.current) return;
        const r = host.current.getBoundingClientRect();
        listWidth.value = Math.max(260, Math.min(r.width * 0.7, e.clientX - r.left));
      }}
      onPointerUp={() => { setActive(false); document.body.classList.remove('dbg-resizing', 'dbg-resizing-x'); }}
      onDblClick={() => { listWidth.value = null; }} />
  );
}

function ChannelsPanel({ ctx }: PanelProps) {
  ensureStyle('dbg-css-channels', CHANNELS_CSS);
  useNeed(ctx, 'channels');
  const all = ctx.store.channels.value;
  const q = channelQuery.value.trim().toLowerCase();
  const sel = selectedChannel.value;
  const host = useRef<HTMLDivElement>(null);
  // Rates/flash from seq deltas between polls (the poll re-renders us ~1 Hz, which also refreshes "age").
  const fresh = useMemo(() => { rates.update(all); return rates.fresh; }, [all]);
  const drafts = draftChannels.value.filter((n) => !all.some((c) => c.name === n));
  const rows = useMemo(() => filterChannels(all, q), [all, q]);
  const selIndex = sel ? rows.findIndex((c) => c.name === sel) : -1;
  const info = sel ? all.find((c) => c.name === sel) : undefined;
  const tensors = all.filter((c) => c.kind === 'tensor').length;
  const now = Date.now();

  // Keyboard: ↑/↓ moves the selection in the list.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    e.preventDefault();
    if (!rows.length) return;
    const i = selIndex < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    selectedChannel.value = rows[i].name;
  };

  const newChannel = async () => {
    const name = await promptText({ title: 'Publish to a channel', label: 'Channel name (existing or new)', value: sel ?? '', ok: 'Open', validate: validateChannelName });
    if (!name) return;
    if (!all.some((c) => c.name === name) && !draftChannels.value.includes(name)) draftChannels.value = [...draftChannels.value, name];
    selectedChannel.value = name;
  };

  useEffect(() => {
    // A drafted channel that never got a value is forgotten when deselected.
    if (sel === null && draftChannels.value.length) draftChannels.value = draftChannels.value.filter((n) => all.some((c) => c.name === n));
  }, [sel]);

  return (
    <>
      <PanelBar>
        <SearchBox value={channelQuery.value} onInput={(v) => { channelQuery.value = v; }} placeholder="Filter name / producer / dtype" />
        <span class="dbg-count" style={{ whiteSpace: 'nowrap' }}>{q ? `${rows.length}/` : ''}{all.length} channels · {tensors} tensors</span>
        <IconButton icon="plus" class="sm" title="Publish to a new channel…" onClick={() => void newChannel()} />
        <IconButton icon="refresh" class="sm" title="Refresh now" onClick={() => void ctx.store.refresh('channels').catch((e: Error) => ctx.toast(e.message, 'error'))} />
      </PanelBar>
      <div ref={host} class={`dbg-ch${sel ? ' has-detail' : ''}`} onKeyDown={onKeyDown} tabIndex={-1}
        style={listWidth.value ? { '--ch-list-w': `${listWidth.value}px` } as Record<string, string> : undefined}>
        <div class="dbg-ch-list">
          <div class="dbg-ch-head">
            <span>Name</span><span>Type</span><span>Size</span><span>Seq</span><span>Rate</span><span>Age</span><span>Producer</span>
          </div>
          {drafts.length ? drafts.map((n) => (
            <div key={n} class={`dbg-ch-row${n === sel ? ' sel' : ''}`} style={{ position: 'relative' }} onClick={() => { selectedChannel.value = n; }}>
              <span class="nm">{n}</span><span class="ty json">new</span><span /><span /><span /><span /><span class="pr">debug</span>
            </div>
          )) : null}
          {rows.length ? (
            <VirtualList items={rows} rowHeight={ROW_H} scrollTo={selIndex} render={(c, _i, top) => (
              <div key={c.name} class={`dbg-ch-row${c.name === sel ? ' sel' : ''}${fresh.has(c.name) ? ' fresh' : ''}`} style={{ top: `${top}px` }}
                title={`${c.name}${c.description ? `\n${c.description}` : ''}`}
                onClick={() => { selectedChannel.value = c.name === sel ? null : c.name; }}
                onContextMenu={(e) => openMenu(e, rowMenu(ctx, c))}>
                <span class="nm"><Highlight text={c.name} q={q} /></span>
                <span class={`ty${c.kind === 'json' ? ' json' : ''}`}>{channelType(c)}</span>
                <span class="n">{fmtBytes(c.size)}</span>
                <span class="n seq" key={`${c.name}:${c.seq}`}>{c.seq}</span>
                <span class="n rate">{fmtRate(rates.rate(c.name))}</span>
                <span class="n">{c.updatedAt ? fmtAgo(c.updatedAt, now) : ''}</span>
                <span class="pr">{c.producer ?? ''}</span>
              </div>
            )} />
          ) : (
            <div class="dbg-vlist">
              {all.length
                ? <Empty icon="search" title="No match">Nothing matches “{channelQuery.value}”.</Empty>
                : <Empty icon="radio" title="No channels yet">Publish from Python / HTTP (<span class="dbg-mono">PUT /api/channels/name</span>), a port→channel link, or the + button.</Empty>}
            </div>
          )}
        </div>
        {sel ? <Splitter host={host} /> : null}
        {sel ? <ChannelDetail key={sel} ctx={ctx} name={sel} info={info} /> : null}
      </div>
    </>
  );
}

export default definePanel({
  id: 'channels',
  title: 'Channels',
  dock: 'bottom',
  order: 10,
  icon: 'radio',
  component: ChannelsPanel,
});
