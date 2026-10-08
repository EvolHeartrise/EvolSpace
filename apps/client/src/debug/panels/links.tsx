// Links panel: every scene link as a row — enabled toggle, readable endpoints
// (entity name.port / #channel; click = select + frame, or open the channel),
// inline-editable transform (compiled while typing, previewed on the live
// value), the live value at the source with a pulse when a value passes,
// transform/runtime errors from the event log, delete. Filter; "New link" form.
// All edits are scene ops (undoable). Live values are polled only while open.

import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Link, PortRef, ServerEvent } from '@evolspace/protocol';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { widgetColor, widgetGlyph } from '../entity.ts';
import { Switch } from '../ui/fields.tsx';
import { fmtAgo, fmtValue } from '../ui/format.ts';
import { copyText, useInterval } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Button, Empty, IconButton, PanelBar, SearchBox } from '../ui/kit.tsx';
import { openMenu, type MenuEntry } from '../ui/menu.tsx';
import { ensureStyle } from './channels/style.ts';
import { focusChannel } from './channels/model.ts';
import { LinkForm, formOpen, openForm } from './links/form.tsx';
import {
  checkTransform, emptyEnd, endpointView, filterLinks, linkErrors, linkText, previewTransform, refRaw, sourceValue,
  type LinkError, type LinkSourcePort,
} from './links/model.ts';
import { LINKS_CSS } from './links/style.ts';

const query = signal('');
const errorsOnly = signal(false);
const errorsClearedAt = signal(0);
const MAX_ROWS = 400;
const POLL_MS = 200;

// ------------------------------------------------------------------ live values

interface Live {
  value: unknown;
  /** Times a new value was seen while the panel was open. */
  n: number;
  at: number;
}

/** Poll the source value of each link; detect new values (identity / channel seq). */
function useLiveValues(ctx: DebugContext, links: readonly Link[]): Map<string, Live> {
  const state = useRef(new Map<string, Live & { seq?: number }>());
  const [, setTick] = useState(0);
  const read = () => {
    const rt = ctx.runtime as unknown as LinkSourcePort | undefined;
    if (!rt?.links) return;
    let changed = false;
    const now = Date.now();
    const seen = new Set<string>();
    for (const l of links) {
      seen.add(l.id);
      let sv: ReturnType<typeof sourceValue>;
      try { sv = sourceValue(rt, l); } catch { continue; }
      const prev = state.current.get(l.id);
      if (!prev) { state.current.set(l.id, { value: sv.value, seq: sv.seq, n: 0, at: sv.value === undefined ? 0 : now }); changed = true; continue; }
      if (sv.value !== prev.value || sv.seq !== prev.seq) {
        state.current.set(l.id, { value: sv.value, seq: sv.seq, n: prev.n + 1, at: now });
        changed = true;
      }
    }
    for (const k of [...state.current.keys()]) if (!seen.has(k)) { state.current.delete(k); changed = true; }
    if (changed) setTick((t) => t + 1);
  };
  useEffect(read, [links]);
  useInterval(read, POLL_MS);
  // Re-render once a second so pulses fade and "ago" stays fresh.
  useInterval(() => setTick((t) => t + 1), 1000);
  return state.current;
}

// ------------------------------------------------------------------ cells

function Endpoint({ ctx, r }: { ctx: DebugContext; r: PortRef }) {
  const v = endpointView(ctx.store.scene.value, r);
  if (v.kind === 'channel') {
    return (
      <span class="dbg-ep ch" title={`channel ${v.label} — click to open in the Channels panel`}
        onClick={() => focusChannel(ctx, (r as { channel: string }).channel)}>
        <span class="ico ch">#</span><span class="en">{v.label.slice(1)}</span>
      </span>
    );
  }
  const e = v.entity;
  const m = e ? ctx.store.catalog.value[e.widget] : undefined;
  const spec = m ? (m.outputs[v.port!] ?? m.inputs[v.port!]) : undefined;
  return (
    <span class={`dbg-ep${v.missing ? ' missing' : ''}`}
      title={`${v.raw}${e ? ` (${e.widget})` : ' — entity missing'}${spec ? `\n${v.port}: ${spec.type}${spec.description ? ` — ${spec.description}` : ''}` : ''}${e ? '\nclick: select · double-click: frame' : ''}`}
      onClick={() => { if (e) ctx.actions.select(e.id); }}
      onDblClick={() => { if (e) { ctx.actions.select(e.id); ctx.actions.frame(e.id); } }}>
      {e ? <span class="ico" style={{ background: widgetColor(e.widget) }}>{widgetGlyph(e.widget)}</span> : <Icon name="alert" size={13} />}
      <span class="en">{v.label}</span>
      <span class="pt">{v.port}</span>
    </span>
  );
}

function valueTitle(v: unknown): string {
  try { return typeof v === 'string' ? v.slice(0, 2000) : (JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && (x as { $tensor?: unknown }).$tensor ? fmtValue(x) : x), 1) ?? String(v)).slice(0, 2000); } catch { return String(v); }
}

function LinkRow({ ctx, l, live, err }: { ctx: DebugContext; l: Link; live?: Live; err?: LinkError }) {
  const [tf, setTf] = useState<string | null>(null); // transform draft while editing
  const check = tf !== null ? checkTransform(tf) : null;
  const has = live && live.value !== undefined;
  const recent = !!live && live.n > 0 && Date.now() - live.at < 900;
  const expr = tf ?? l.transform ?? '';
  // Result of the transform on the current value: preview while editing, else the applied output.
  const pv = expr.trim() && has ? previewTransform(expr, live!.value) : null;
  const commit = (v: string) => {
    setTf(null);
    const t = v.trim();
    if ((l.transform ?? '') === t) return;
    if (t && !checkTransform(t).ok) { ctx.toast(`Transform not applied: ${checkTransform(t).error}`, 'error'); return; }
    void ctx.actions.ops([{ op: 'link.update', id: l.id, patch: { transform: (t || null) as unknown as string } }]);
  };
  const menu = (): MenuEntry[] => {
    const sel = (r: PortRef) => (r.kind === 'port' && ctx.store.scene.value.entities[r.entity] ? r.entity : null);
    const from = sel(l.from), to = sel(l.to);
    return [
      { header: `${l.id} · ${linkText(ctx.store.scene.value, l)}` },
      ...(from ? [{ label: 'Select source', icon: 'crosshair' as const, run: () => { ctx.actions.select(from); ctx.actions.frame(from); } }] : []),
      ...(to ? [{ label: 'Select target', icon: 'crosshair' as const, run: () => { ctx.actions.select(to); ctx.actions.frame(to); } }] : []),
      { label: l.enabled ? 'Disable' : 'Enable', icon: l.enabled ? 'eyeOff' : 'eye', run: () => void ctx.actions.ops([{ op: 'link.update', id: l.id, patch: { enabled: !l.enabled } }]) },
      { label: 'Reverse into new link…', icon: 'refresh', run: () => openForm(ctx, { from: { ...emptyEnd(l.to.kind), ...(l.to.kind === 'port' ? { entity: l.to.entity } : { channel: l.to.channel }) }, to: { ...emptyEnd(l.from.kind), ...(l.from.kind === 'port' ? { entity: l.from.entity } : { channel: l.from.channel }) }, transform: '' }) },
      'separator',
      { label: 'Copy id', icon: 'copy', run: () => void copyText(l.id).then((ok) => ctx.toast(ok ? `Copied ${l.id}` : 'Clipboard unavailable')) },
      { label: 'Copy as text', icon: 'copy', run: () => void copyText(`${refRaw(l.from)} → ${refRaw(l.to)}${l.transform ? ` (${l.transform})` : ''}`).then((ok) => ctx.toast(ok ? 'Copied' : 'Clipboard unavailable')) },
      { label: 'Copy as JSON', icon: 'code', run: () => void copyText(JSON.stringify(l, null, 2)).then((ok) => ctx.toast(ok ? 'Copied' : 'Clipboard unavailable')) },
      ...(err ? [{ label: 'Copy error', icon: 'alert' as const, run: () => void copyText(err.message).then((ok) => ctx.toast(ok ? 'Copied' : 'Clipboard unavailable')) }] : []),
      'separator',
      { label: 'Delete link', icon: 'trash', danger: true, run: () => void ctx.actions.ops([{ op: 'link.remove', id: l.id }]) },
    ];
  };
  return (
    <div class={`dbg-lk-row${l.enabled ? '' : ' off'}${err ? ' err' : ''}`} data-id={l.id} onContextMenu={(e) => openMenu(e, menu())}>
      <Switch checked={l.enabled} title={l.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        onChange={(v) => void ctx.actions.ops([{ op: 'link.update', id: l.id, patch: { enabled: v } }])} />
      <Endpoint ctx={ctx} r={l.from} />
      <span class="dbg-lk-arrow">→</span>
      <Endpoint ctx={ctx} r={l.to} />
      <input type="text" class={`tfx${check && !check.ok ? ' bad' : ''}`} value={tf ?? l.transform ?? ''} spellcheck={false} placeholder="ƒ x — add transform"
        title={check && !check.ok ? check.error : l.transform ? `transform: ${l.transform}\n(Enter applies, Esc reverts, empty clears)` : 'Optional JS expression of x (Enter applies)'}
        onFocus={() => setTf(l.transform ?? '')}
        onInput={(e) => setTf((e.currentTarget as HTMLInputElement).value)}
        onBlur={() => { if (tf !== null) commit(tf); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { (e.currentTarget as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); setTf(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
        }} />
      <span class="dbg-lk-val" title={has ? `${valueTitle(live!.value)}\n\n${live!.at ? `last change ${fmtAgo(live!.at)} ago` : ''}` : 'No value has passed yet (event outputs are not cached)'}>
        <span class={`pulse${recent ? ' on' : ''}`} />
        {tf !== null && check && !check.ok ? <span class="prev bad">{check.error}</span>
          : tf !== null && pv ? <span class={`prev${pv.error ? ' bad' : ''}`}>{pv.error ?? (pv.dropped ? '⇒ (dropped)' : `⇒ ${fmtValue(pv.value, 40)}`)}</span>
            : (
              <>
                <span key={live?.n ?? 0} class={`v${has ? '' : ' none'}${live && live.n > 0 ? ' flash' : ''}`}>{has ? fmtValue(live!.value, 48) : '—'}</span>
                {pv && !pv.error && pv.ran && !pv.dropped && fmtValue(pv.value, 40) !== fmtValue(live!.value, 40) ? <span class="out">{fmtValue(pv.value, 32)}</span> : null}
              </>
            )}
      </span>
      <span class="dbg-lk-acts">
        {err ? <span class="errico" title={`${err.message}\n(${err.count}× · last ${fmtAgo(err.ts)} ago)`}><Icon name="alert" size={13} /></span> : null}
        <IconButton icon="trash" class="sm" danger title="Delete link (undoable)" onClick={() => void ctx.actions.ops([{ op: 'link.remove', id: l.id }])} />
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ panel

function useLinkErrors(ctx: DebugContext): Map<string, LinkError> {
  const events: readonly ServerEvent[] = ctx.store.events.value;
  const since = errorsClearedAt.value;
  return useMemo(() => linkErrors(events, since), [events, since]);
}

function LinksPanel({ ctx }: PanelProps) {
  ensureStyle('dbg-css-links', LINKS_CSS);
  const scene = ctx.store.scene.value;
  const errs = useLinkErrors(ctx);
  const liveErrs = useMemo(() => new Map([...errs].filter(([id]) => scene.links[id])), [errs, scene]);
  const q = query.value;
  const all = Object.keys(scene.links).length;
  const rows = useMemo(() => filterLinks(scene, q, { errors: errorsOnly.value ? liveErrs : null }), [scene, q, errorsOnly.value, liveErrs]);
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  const live = useLiveValues(ctx, shown);
  const disabled = Object.values(scene.links).filter((l) => !l.enabled).length;
  return (
    <div class="dbg-lk">
      <PanelBar>
        <SearchBox value={q} onInput={(v) => { query.value = v; }} placeholder="Filter entity / port / #channel / transform" />
        <span class="dbg-count" style={{ whiteSpace: 'nowrap' }}>{q || errorsOnly.value ? `${rows.length}/` : ''}{all} links{disabled ? ` · ${disabled} off` : ''}</span>
        {liveErrs.size ? (
          <>
            <button type="button" class={`dbg-btn small danger${errorsOnly.value ? ' primary' : ''}`} title="Show only links with errors"
              onClick={() => { errorsOnly.value = !errorsOnly.value; }} style={errorsOnly.value ? { color: '#06121b', background: 'var(--neg)', borderColor: 'var(--neg)' } : undefined}>
              <Icon name="alert" size={12} />{liveErrs.size} error{liveErrs.size === 1 ? '' : 's'}
            </button>
            <IconButton icon="x" class="sm" title="Clear link errors" onClick={() => { errorsClearedAt.value = Date.now(); errorsOnly.value = false; }} />
          </>
        ) : null}
        <Button small primary={!formOpen.value} icon={formOpen.value ? 'x' : 'plus'} title="Create a link (port/channel → port/channel)"
          onClick={() => { if (formOpen.value) formOpen.value = false; else openForm(ctx); }}>
          {formOpen.value ? 'Close' : 'New link'}
        </Button>
      </PanelBar>
      {formOpen.value ? <LinkForm ctx={ctx} /> : null}
      <div class="dbg-scroll">
        {shown.length ? (
          <>
            <div class="dbg-lk-head"><span>On</span><span>From</span><span /><span>To</span><span>Transform</span><span>Value (live)</span><span /></div>
            {shown.map((l) => <LinkRow key={l.id} ctx={ctx} l={l} live={live.get(l.id)} err={liveErrs.get(l.id)} />)}
            {rows.length > shown.length ? <div class="dbg-lk-more">{rows.length - shown.length} more — refine the filter.</div> : null}
          </>
        ) : all ? (
          <Empty icon="search" title="No match">{errorsOnly.value ? 'No link has errors.' : <>Nothing matches “{q}”.</>}</Empty>
        ) : (
          <Empty icon="link" title="No links yet">
            Links move values between widget ports and data channels. Create one with <b>New link</b>, or ask Claude (“link the slider to the number”).
          </Empty>
        )}
      </div>
    </div>
  );
}

export default definePanel({
  id: 'links',
  title: 'Links',
  dock: 'bottom',
  order: 0,
  icon: 'link',
  component: LinksPanel,
  badge: (ctx) => {
    const links = ctx.store.scene.value.links;
    const n = Object.keys(links).length;
    const since = errorsClearedAt.value;
    const errs = [...linkErrors(ctx.store.events.value, since).keys()].filter((id) => links[id]).length;
    return errs ? `!${errs}` : n || null;
  },
});

