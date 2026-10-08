// "New link" form: from (entity + output port, or #channel) → to (entity +
// input port, or #channel), optional transform with a live preview on the
// source's current value; loose type check; creates via the link.add scene op.

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { Entity } from '@evolspace/protocol';
import type { DebugContext } from '../../types.ts';
import { SelectField } from '../../ui/fields.tsx';
import { fmtValue } from '../../ui/format.ts';
import { useNeed } from '../../ui/hooks.ts';
import { Icon } from '../../ui/icons.tsx';
import { IconButton } from '../../ui/kit.tsx';
import {
  checkDraft, checkTransform, emptyEnd, entityName, previewTransform, sourceValue, type EndDraft, type LinkDraft, type LinkSourcePort,
} from './model.ts';

/** Module-level: the half-filled form survives tab switches. */
export const formOpen = signal(false);
export const draft = signal<LinkDraft>({ from: emptyEnd(), to: emptyEnd(), transform: '' });

export function openForm(ctx: DebugContext, preset?: Partial<LinkDraft>): void {
  const sel = ctx.store.selection.peek();
  const cur = draft.peek();
  const fresh = !formOpen.peek();
  draft.value = {
    from: preset?.from ?? (fresh && !cur.from.entity && sel ? { ...emptyEnd('port', sel) } : cur.from),
    to: preset?.to ?? cur.to,
    transform: preset?.transform ?? cur.transform,
  };
  formOpen.value = true;
}

let dlSeq = 0;

function EndEditor({ ctx, side, end, onChange }: { ctx: DebugContext; side: 'from' | 'to'; end: EndDraft; onChange(e: EndDraft): void }) {
  const [listId] = useState(() => `dbg-lk-ch-${++dlSeq}`);
  const ents = Object.values(ctx.store.scene.value.entities) as Entity[];
  const catalog = ctx.store.catalog.value;
  const e = end.entity ? ctx.store.scene.value.entities[end.entity] : undefined;
  const m = e ? catalog[e.widget] : undefined;
  const ports = Object.entries((side === 'from' ? m?.outputs : m?.inputs) ?? {});
  const sel = ctx.store.selection.value;
  const sorted = ents.slice().sort((a, b) => entityName(a).localeCompare(entityName(b)));
  return (
    <div class="end">
      <span class="side">{side}</span>
      <div class="dbg-seg" role="group">
        <button type="button" class={end.kind === 'port' ? 'on' : ''} onClick={() => onChange({ ...end, kind: 'port' })}>Port</button>
        <button type="button" class={end.kind === 'channel' ? 'on' : ''} onClick={() => onChange({ ...end, kind: 'channel' })}>Channel</button>
      </div>
      {end.kind === 'port' ? (
        <>
          <SelectField value={end.entity} placeholder="entity…" title="Entity"
            options={sorted.map((x) => ({ value: x.id, label: `${entityName(x)} · ${x.id}` }))}
            onChange={(v) => {
              const nm = ctx.store.catalog.peek()[ctx.store.scene.peek().entities[v]?.widget ?? '']?.[side === 'from' ? 'outputs' : 'inputs'] ?? {};
              const names = Object.keys(nm);
              onChange({ ...end, entity: v, port: names.includes(end.port) ? end.port : names.length === 1 ? names[0] : '' });
            }} />
          <SelectField value={end.port} placeholder={e ? (ports.length ? `${side === 'from' ? 'output' : 'input'}…` : `no ${side === 'from' ? 'outputs' : 'inputs'}`) : 'port…'}
            disabled={!e || !ports.length} title={side === 'from' ? 'Output port' : 'Input port'}
            options={ports.map(([n, s]) => ({ value: n, label: `${n} : ${s.type}` }))} onChange={(v) => onChange({ ...end, port: v })} />
          <IconButton icon="crosshair" class="sm" title={sel ? 'Use the selected entity' : 'Select an entity first'} disabled={!sel}
            onClick={() => sel && onChange({ ...end, entity: sel, port: '' })} />
        </>
      ) : (
        <>
          <ChannelList ctx={ctx} id={listId} />
          <input type="text" class="dbg-text mono" list={listId} value={end.channel} placeholder="channel.name" spellcheck={false}
            onInput={(ev) => onChange({ ...end, channel: (ev.currentTarget as HTMLInputElement).value.replace(/^#/, '') })} />
        </>
      )}
    </div>
  );
}

function ChannelList({ ctx, id }: { ctx: DebugContext; id: string }) {
  useNeed(ctx, 'channels');
  return <datalist id={id}>{ctx.store.channels.value.map((c) => <option key={c.name} value={c.name}>{c.kind === 'tensor' ? `${c.dtype}[${(c.shape ?? []).join('×')}]` : 'json'}</option>)}</datalist>;
}

export function LinkForm({ ctx }: { ctx: DebugContext }) {
  const d = draft.value;
  const [busy, setBusy] = useState(false);
  const usesChannels = d.from.kind === 'channel' || d.to.kind === 'channel';
  const check = checkDraft(d, {
    scene: ctx.store.scene.value,
    catalog: ctx.store.catalog.value,
    ...(usesChannels ? { channels: ctx.store.channels.value } : {}),
  });
  const tf = checkTransform(d.transform);
  // Preview on the source's current value (port output cache / channel cache).
  let sample: unknown;
  if (d.from.kind === 'port' && d.from.entity && d.from.port) {
    sample = sourceValue(ctx.runtime as unknown as LinkSourcePort, { from: { kind: 'port', entity: d.from.entity, port: d.from.port } }).value;
  }
  const pv = d.transform.trim() && tf.ok ? previewTransform(d.transform, sample) : null;
  const set = (patch: Partial<LinkDraft>) => { draft.value = { ...draft.value, ...patch }; };
  const create = async () => {
    if (!check.op || busy) return;
    setBusy(true);
    const r = await ctx.actions.ops([check.op]);
    setBusy(false);
    if (r) {
      ctx.toast(`Linked ${r.ids[0] ?? ''} (Ctrl+Z to undo)`);
      draft.value = { from: emptyEnd(), to: emptyEnd(), transform: '' };
      formOpen.value = false;
    }
  };
  const firstErr = check.errors[0];
  const hard = firstErr && !/^(From|To): (pick|channel name required)/.test(firstErr);
  return (
    <div class="dbg-lk-form" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); formOpen.value = false; }
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void create(); }
    }}>
      <div class="ln">
        <EndEditor ctx={ctx} side="from" end={d.from} onChange={(from) => set({ from })} />
        <span class="arrow"><Icon name="chevronRight" size={14} /></span>
        <EndEditor ctx={ctx} side="to" end={d.to} onChange={(to) => set({ to })} />
      </div>
      <div class="ln">
        <div class="tf">
          <span class="f" title="Optional JS expression of x (the incoming value); returning undefined drops the value">ƒ(x)</span>
          <input type="text" class={`dbg-text mono${tf.ok ? '' : ' bad'}`} value={d.transform} spellcheck={false}
            placeholder="optional transform, e.g. Math.round(x * 10) or x > 0.5"
            onInput={(e) => set({ transform: (e.currentTarget as HTMLInputElement).value })} />
        </div>
        <div class="msgs">
          {firstErr ? <span class={`e${hard ? ' hard' : ''}`}>{firstErr}</span> : null}
          {check.warnings.map((w) => <span key={w} class="w">⚠ {w}</span>)}
          {pv && pv.ran ? (
            <span class={pv.error ? 'e hard' : 'ok'}>
              {pv.error ? `preview: ${pv.error}` : pv.dropped ? `preview: ${fmtValue(sample, 30)} ⇒ (dropped)` : `preview: ${fmtValue(sample, 30)} ⇒ ${fmtValue(pv.value, 40)}`}
            </span>
          ) : null}
          {!firstErr && !check.warnings.length && !(pv && pv.ran) ? <span class="ok">Ready — creates an undoable link.add</span> : null}
        </div>
        <div class="btns">
          <button type="button" class="dbg-btn small" onClick={() => { formOpen.value = false; }}>Cancel</button>
          <button type="button" class="dbg-btn small primary" disabled={!check.op || busy} onClick={() => void create()}>
            <Icon name="link" size={12} />Create link
          </button>
        </div>
      </div>
    </div>
  );
}
