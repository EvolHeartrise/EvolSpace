// Widgets panel: the widget catalog (ctx.store.catalog, pushed over WS).
// Search; each row = thumbnail, id, version, instance count, build status,
// description. Expand a row for details: build error (expandable), actions
// (Spawn in front of the camera + select, Rebuild, render thumbnail, copy
// source path), props / inputs / outputs, instances, recent errors from the
// event log. Tab badge = widgets whose latest build failed.

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { WidgetManifest } from '@evolspace/protocol';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel, widgetColor, widgetGlyph } from '../entity.ts';
import { fmtTime } from '../ui/format.ts';
import { copyText } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Button, Empty, IconButton, PanelBar, Scroll, SearchBox } from '../ui/kit.tsx';
import { openMenu, type MenuEntry } from '../ui/menu.tsx';
import { ensureStyle } from './channels/style.ts';
import {
  buildErrorCount, filterWidgets, fmtDefault, instanceCounts, instancesOf, portsSummary, sourcePath, widgetErrors, widgetList,
} from './widgets/model.ts';
import { WIDGETS_CSS } from './widgets/style.ts';

const query = signal('');
const errorsOnly = signal(false);
const openId = signal<string | null>(null);
/** Explicitly rendered thumbnails (object URLs) and cache-busters, per widget. */
const thumbs = signal<Record<string, string>>({});
const buildResults = signal<Record<string, { ok: boolean; error?: string; at: number }>>({});
const busy = signal<Record<string, 'build' | 'thumb' | 'spawn'>>({});

function setBusy(id: string, what: 'build' | 'thumb' | 'spawn' | null) {
  const next = { ...busy.value };
  if (what) next[id] = what; else delete next[id];
  busy.value = next;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const t = q.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!t) return <>{text}</>;
  const i = text.toLowerCase().indexOf(t);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + t.length)}</mark>{text.slice(i + t.length)}</>;
}

function Thumb({ ctx, m, big }: { ctx: DebugContext; m: WidgetManifest; big?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const rendered = thumbs.value[m.id];
  const src = rendered ?? (m.hasThumbnail ? `${ctx.api.widgetThumbnailUrl(m.id)}?h=${encodeURIComponent(m.hash || '0')}` : null);
  return (
    <span class={`dbg-thumb${big ? ' big' : ''}`}>
      {src && failed !== src
        ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />
        : <span class="g" style={{ background: widgetColor(m.id) }}>{widgetGlyph(m.id)}</span>}
    </span>
  );
}

async function spawn(ctx: DebugContext, id: string) {
  setBusy(id, 'spawn');
  try {
    const eid = await ctx.actions.spawn(id);
    if (eid) ctx.toast(`Spawned ${id} → ${eid}`);
  } finally { setBusy(id, null); }
}

async function rebuild(ctx: DebugContext, id: string) {
  setBusy(id, 'build');
  const t0 = performance.now();
  try {
    const r = await ctx.api.buildWidget(id);
    buildResults.value = { ...buildResults.value, [id]: { ok: r.ok, ...(r.error ? { error: r.error } : {}), at: Date.now() } };
    ctx.toast(r.ok ? `${id} rebuilt (${Math.round(performance.now() - t0)} ms)` : `${id} build failed`, r.ok ? 'info' : 'error');
  } catch (e) {
    buildResults.value = { ...buildResults.value, [id]: { ok: false, error: (e as Error).message, at: Date.now() } };
    ctx.toast((e as Error).message, 'error');
  } finally { setBusy(id, null); }
}

async function renderThumb(ctx: DebugContext, id: string) {
  setBusy(id, 'thumb');
  try {
    const blob = await ctx.api.widgetThumbnail(id);
    const old = thumbs.value[id];
    if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
    thumbs.value = { ...thumbs.value, [id]: URL.createObjectURL(blob) };
    ctx.toast(`Thumbnail saved: library/widgets/${id}/thumbnail.png`);
  } catch (e) {
    ctx.toast(`Thumbnail failed: ${(e as Error).message}`, 'error');
  } finally { setBusy(id, null); }
}

function copyPath(ctx: DebugContext, id: string) {
  const p = sourcePath(id);
  void copyText(p).then((ok) => ctx.toast(ok ? `Copied ${p}` : 'Clipboard unavailable'));
}

function rowMenu(ctx: DebugContext, m: WidgetManifest): MenuEntry[] {
  return [
    { header: `${m.id}${m.version ? ` ${m.version}` : ''}` },
    { label: 'Spawn in front of the camera', icon: 'plus', run: () => void spawn(ctx, m.id) },
    { label: 'Rebuild', icon: 'refresh', run: () => void rebuild(ctx, m.id) },
    { label: 'Render thumbnail', icon: 'image', run: () => void renderThumb(ctx, m.id) },
    'separator',
    { label: 'Copy source path', icon: 'copy', run: () => copyPath(ctx, m.id) },
    { label: 'Copy id', icon: 'copy', run: () => void copyText(m.id).then((ok) => ctx.toast(ok ? `Copied ${m.id}` : 'Clipboard unavailable')) },
    { label: 'Copy manifest JSON', icon: 'code', run: () => void copyText(JSON.stringify(m, null, 2)).then((ok) => ctx.toast(ok ? 'Copied' : 'Clipboard unavailable')) },
  ];
}

const errOpen = signal<Record<string, boolean>>({});
const descOpen = signal<Record<string, boolean>>({});

function Details({ ctx, m }: { ctx: DebugContext; m: WidgetManifest }) {
  const b = busy.value[m.id];
  const res = buildResults.value[m.id];
  const scene = ctx.store.scene.value;
  const inst = instancesOf(scene, m.id);
  const errs = widgetErrors(ctx.store.events.value, m.id, scene, 8);
  const props = Object.entries(m.props ?? {});
  const ins = Object.entries(m.inputs ?? {});
  const outs = Object.entries(m.outputs ?? {});
  const eopen = !!errOpen.value[m.id];
  return (
    <div class="dbg-wdet">
      {m.hasThumbnail || thumbs.value[m.id] ? <Thumb ctx={ctx} m={m} big /> : null}
      {m.description ? <div class={`desc${descOpen.value[m.id] ? ' open' : ''}`} title={descOpen.value[m.id] ? 'Click to collapse' : 'Click to expand'} onClick={() => { descOpen.value = { ...descOpen.value, [m.id]: !descOpen.value[m.id] }; }}>{m.description}</div> : null}
      {m.error ? (
        <div class={`errbox${eopen ? ' open' : ''}`} title={eopen ? undefined : 'Click to expand'}
          onClick={() => { if (!eopen) errOpen.value = { ...errOpen.value, [m.id]: true }; }}>
          {m.error}
        </div>
      ) : null}
      <div class="acts">
        <Button small primary icon="plus" disabled={!!b || !m.hash} title={m.hash ? 'Add an instance ~1.2 m in front of the camera and select it' : 'Not built'} onClick={() => void spawn(ctx, m.id)}>
          {b === 'spawn' ? 'Spawning…' : 'Spawn'}
        </Button>
        <Button small icon="refresh" disabled={!!b} title="POST /api/widgets/:id/build (force rebuild)" onClick={() => void rebuild(ctx, m.id)}>{b === 'build' ? 'Building…' : 'Rebuild'}</Button>
        <Button small icon="image" disabled={!!b || !m.hash} title="Render with the mirror and save library/widgets/:id/thumbnail.png" onClick={() => void renderThumb(ctx, m.id)}>{b === 'thumb' ? 'Rendering…' : 'Thumbnail'}</Button>
      </div>
      {res ? (
        <div class={`res ${res.ok ? 'ok' : 'bad'}`}>
          <Icon name={res.ok ? 'check' : 'alert'} size={12} />{res.ok ? `rebuilt ok · ${fmtTime(res.at)}` : `${res.error ?? 'build failed'}`}
        </div>
      ) : null}
      <div class="path" title="Copy source path" onClick={() => copyPath(ctx, m.id)}><span>{sourcePath(m.id)}</span><Icon name="copy" size={11} /></div>
      <div class="meta">
        {m.version ? <span>v{m.version}</span> : null}
        {m.hash ? <span title="bundle content hash">#{m.hash.slice(0, 10)}</span> : <span>not built</span>}
        {m.size ? <span title="approx size at scale 1 (m)">{m.size.map((x) => +x.toFixed(3)).join('×')} m</span> : null}
        {m.interactions?.length ? <span>{m.interactions.length} interaction{m.interactions.length === 1 ? '' : 's'}</span> : null}
      </div>
      {props.length ? (
        <div>
          <div class="dbg-sub">Props</div>
          <table class="dbg-ports"><tbody>
            {props.map(([n, s]) => (
              <tr key={n} title={`${n}: ${s.type}${s.description ? ` — ${s.description}` : ''}${s.min !== undefined || s.max !== undefined ? `\nrange ${s.min ?? '−∞'} … ${s.max ?? '∞'}${s.step ? ` step ${s.step}` : ''}` : ''}${s.options ? `\noptions: ${s.options.join(', ')}` : ''}`}>
                <td class="n">{n}</td><td class="t">{s.type}</td><td class="d">{fmtDefault(s.default)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ) : null}
      {ins.length || outs.length ? (
        <div>
          {ins.length ? <><div class="dbg-sub">Inputs</div>
            <table class="dbg-ports"><tbody>{ins.map(([n, s]) => <tr key={n} title={`${n}: ${s.type}${s.description ? ` — ${s.description}` : ''}`}><td class="n">{n}</td><td class="t">{s.type}</td><td class="ds">{s.description ?? ''}</td></tr>)}</tbody></table></> : null}
          {outs.length ? <><div class="dbg-sub">Outputs</div>
            <table class="dbg-ports"><tbody>{outs.map(([n, s]) => <tr key={n} title={`${n}: ${s.type}${s.description ? ` — ${s.description}` : ''}`}><td class="n">{n}</td><td class="t">{s.type}</td><td class="ds">{s.description ?? ''}</td></tr>)}</tbody></table></> : null}
        </div>
      ) : null}
      {inst.length ? (
        <div>
          <div class="dbg-sub">Instances ({inst.length})</div>
          <div class="chips">
            {inst.slice(0, 40).map((e) => (
              <span key={e.id} class="chip" title="Select + frame" onClick={() => { ctx.actions.select(e.id); ctx.actions.frame(e.id); }}>
                {entityLabel(e)}<span class="i">{e.id}</span>
              </span>
            ))}
            {inst.length > 40 ? <span class="dbg-count">+{inst.length - 40}</span> : null}
          </div>
        </div>
      ) : null}
      {errs.length ? (
        <div>
          <div class="dbg-sub">Recent errors</div>
          <div class="evs">
            {errs.map((x, i) => (
              <div key={i} class="ev"><span class="t">{fmtTime(x.ts).slice(0, 8)}</span><span class="m">{x.kind === 'build' ? 'build: ' : x.entity ? `${x.entity}: ` : ''}{x.message}</span></div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WidgetsPanel({ ctx }: PanelProps) {
  ensureStyle('dbg-css-widgets', WIDGETS_CSS);
  const catalog = ctx.store.catalog.value;
  const all = widgetList(catalog);
  const q = query.value;
  const rows = filterWidgets(all, q, errorsOnly.value);
  const counts = instanceCounts(ctx.store.scene.value);
  const nErr = buildErrorCount(catalog);
  const open = openId.value;
  return (
    <>
      <PanelBar>
        <SearchBox value={q} onInput={(v) => { query.value = v; }} placeholder="Search id / description / port" />
        <IconButton icon="alert" class="sm" active={errorsOnly.value} title={errorsOnly.value ? 'Showing widgets with build errors — click to show all' : 'Only widgets with build errors'}
          onClick={() => { errorsOnly.value = !errorsOnly.value; }} />
      </PanelBar>
      <Scroll>
        <div class="dbg-wl">
          {rows.map((m) => {
            const isOpen = open === m.id;
            const n = counts.get(m.id) ?? 0;
            return (
              <div key={m.id} class={`dbg-witem${isOpen ? ' open' : ''}${m.error ? ' bad' : ''}`}>
                <div class="dbg-wrow" title={`${m.id} — ${portsSummary(m)}\nclick: details · double-click: spawn`}
                  onClick={(e) => { openId.value = isOpen ? null : m.id; if (!isOpen) { const row = (e.currentTarget as HTMLElement).parentElement; requestAnimationFrame(() => row?.scrollIntoView({ block: 'nearest' })); } }}
                  onDblClick={() => void spawn(ctx, m.id)}
                  onContextMenu={(e) => openMenu(e, rowMenu(ctx, m))}>
                  <Thumb ctx={ctx} m={m} />
                  <span class="tx">
                    <span class="l1">
                      <span class="id"><Highlight text={m.id} q={q} /></span>
                      {m.version ? <span class="ver">{m.version}</span> : null}
                      {n ? <span class="n" title={`${n} instance${n === 1 ? '' : 's'} in the scene`}>×{n}</span> : null}
                      {m.error ? <span class="er" title={`build failed: ${m.error.split('\n')[0]}`}><Icon name="alert" size={13} /></span> : null}
                    </span>
                    <span class="ds">{m.description ? <Highlight text={m.description} q={q} /> : <i>{portsSummary(m)}</i>}</span>
                  </span>
                  <IconButton icon="plus" class="sm add" title="Spawn in front of the camera" disabled={!m.hash || !!busy.value[m.id]} onClick={() => void spawn(ctx, m.id)} />
                </div>
                {isOpen ? <Details ctx={ctx} m={m} /> : null}
              </div>
            );
          })}
        </div>
        {!rows.length ? (
          all.length
            ? <Empty icon="search" title="No match">{errorsOnly.value && !q ? 'No widget has a build error.' : <>Nothing matches “{q}”.</>}</Empty>
            : <Empty icon="box" title="No widgets">The catalog is empty (is the server connected?). Widgets live in library/widgets/&lt;id&gt;/widget.ts.</Empty>
        ) : null}
      </Scroll>
      <PanelBar class="foot">
        <span class="dbg-count">{q || errorsOnly.value ? `${rows.length}/` : ''}{all.length} widgets</span>
        <span class="grow" />
        {nErr ? <Badge kind="error" title="Widgets whose latest build failed (the last good bundle stays served)">{nErr} build error{nErr === 1 ? '' : 's'}</Badge> : <Badge kind="ok">all built</Badge>}
      </PanelBar>
    </>
  );
}

export default definePanel({
  id: 'widgets',
  title: 'Widgets',
  dock: 'left',
  order: 10,
  icon: 'box',
  component: WidgetsPanel,
  badge: (ctx) => {
    const n = buildErrorCount(ctx.store.catalog.value);
    return n ? `!${n}` : null;
  },
});
