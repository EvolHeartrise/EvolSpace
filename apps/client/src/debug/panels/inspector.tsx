// Inspector: everything about the selected entity — identity, widget + status,
// transform, props (from the manifest's PropSpecs), ports with live values,
// links touching it, entity settings (parent, anchor, tags, visibility, lock,
// interactions) and the raw JSON. All edits are scene ops (undoable).

import { signal } from '@preact/signals';
import type { AnchorRef, Entity, Link, PortRef } from '@evolspace/protocol';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel, entityMenu, reparentPatch, widgetColor, widgetGlyph } from '../entity.ts';
import { JsonField, SelectField, Switch, TextField } from '../ui/fields.tsx';
import { prettyJson } from '../ui/format.ts';
import { copyText } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Empty, IconButton, Row, Scroll, Section } from '../ui/kit.tsx';
import { openMenu } from '../ui/menu.tsx';
import { ExtraProps, PortsTable, PropEditor, TransformEditor } from './inspector/editors.tsx';
import { isSelfOrDescendant } from './scene/tree.ts';

const STATUS_KIND: Record<string, 'ok' | 'info' | 'warn' | 'error' | 'dim'> = { ready: 'ok', loading: 'info', pending: 'dim', error: 'error', missing: 'error' };

function Header({ ctx, e }: { ctx: DebugContext; e: Entity }) {
  const m = ctx.store.catalog.value[e.widget];
  const st = ctx.store.widgetStatus.value[e.id];
  const err = ctx.store.entityErrors.value[e.id];
  return (
    <div class="dbg-insp-head">
      <div class="l1">
        <span class="ico" style={{ background: widgetColor(e.widget) }}>{widgetGlyph(e.widget)}</span>
        <div class="nm">
          <TextField value={e.name ?? ''} placeholder={e.widget} title="Name (Enter to apply; empty clears)"
            onCommit={(v) => void ctx.actions.update(e.id, { name: v.trim() ? v.trim() : null as unknown as string })} />
        </div>
        <IconButton icon="target" title="Frame (F)" onClick={() => ctx.actions.frame(e.id)} />
        <IconButton icon="more" title="More…" onClick={(ev) => openMenu(ev.currentTarget as HTMLElement, entityMenu(ctx, e))} />
      </div>
      <div class="l2">
        <span class="dbg-idchip" title="Copy id" onClick={() => void copyText(e.id).then((ok) => ctx.toast(ok ? `Copied ${e.id}` : 'Clipboard unavailable'))}>
          {e.id}<Icon name="copy" size={11} />
        </span>
        <Badge kind="info" title={m?.description}>{e.widget}{m?.version ? ` ${m.version}` : ''}</Badge>
        {st ? <Badge kind={STATUS_KIND[st.status] ?? 'dim'} title="widget instance status in this tab">{st.status}</Badge> : null}
        {e.locked ? <Badge kind="warn">locked</Badge> : null}
        {!e.visible ? <Badge kind="dim">hidden</Badge> : null}
        {e.anchor && e.anchor.kind !== 'space' ? <Badge kind="dim">anchor: {anchorValue(e.anchor)}</Badge> : null}
      </div>
      {m?.description ? <Description text={m.description} /> : !m ? <div class="desc">Widget '{e.widget}' is not in the catalog.</div> : null}
      {err ? <div class="errbox">{err.source === 'event' ? 'client.error: ' : ''}{err.message}</div> : null}
    </div>
  );
}

const descOpen = signal(false);
function Description({ text }: { text: string }) {
  const open = descOpen.value;
  return (
    <div class={`desc${open ? ' open' : ''}`} title={open ? 'Click to collapse' : 'Click to expand'} onClick={() => { descOpen.value = !open; }}>{text}</div>
  );
}

function anchorValue(a: AnchorRef | undefined): string {
  if (!a || a.kind === 'space') return 'space';
  if (a.kind === 'head') return a.lazy ? 'head-lazy' : 'head';
  return `hand-${a.hand}${a.joint && a.joint !== 'wrist' ? `:${a.joint}` : ''}`;
}

function anchorFrom(v: string): AnchorRef | null {
  if (v === 'space') return null;
  if (v === 'head') return { kind: 'head' };
  if (v === 'head-lazy') return { kind: 'head', lazy: true };
  if (v === 'hand-left') return { kind: 'hand', hand: 'left' };
  if (v === 'hand-right') return { kind: 'hand', hand: 'right' };
  return null;
}

function EntitySettings({ ctx, e }: { ctx: DebugContext; e: Entity }) {
  const ents = ctx.store.scene.value.entities;
  const parents = Object.values(ents).filter((x) => !isSelfOrDescendant(ents, e.id, x.id));
  const up = (patch: Parameters<DebugContext['actions']['update']>[1]) => void ctx.actions.update(e.id, patch);
  const anchor = anchorValue(e.anchor);
  return (
    <>
      <Row label="Parent">
        <SelectField value={e.parent ?? '__root'} title="Reparent (placement in space is kept)"
          options={[{ value: '__root', label: '(root)' }, ...parents.map((p) => ({ value: p.id, label: `${entityLabel(p)} · ${p.id}` }))]}
          onChange={(v) => up(reparentPatch(ctx, e.id, v === '__root' ? null : v))} />
        {e.parent ? <IconButton icon="crosshair" class="sm" title="Select parent" onClick={() => ctx.actions.select(e.parent)} /> : null}
      </Row>
      <Row label="Anchor" title="What a root entity's transform is relative to">
        <SelectField value={['space', 'head', 'head-lazy', 'hand-left', 'hand-right'].includes(anchor) ? anchor : 'space'} disabled={!!e.parent}
          options={[
            { value: 'space', label: 'space (origin)' }, { value: 'head', label: 'head (rigid)' }, { value: 'head-lazy', label: 'head (lazy follow)' },
            { value: 'hand-left', label: 'left hand (wrist)' }, { value: 'hand-right', label: 'right hand (wrist)' },
          ]}
          onChange={(v) => up({ anchor: anchorFrom(v) as AnchorRef })} />
      </Row>
      <Row label="Visible"><Switch checked={e.visible} onChange={(v) => up({ visible: v })} /></Row>
      <Row label="Locked" title="Locked entities ignore grab/scale"><Switch checked={!!e.locked} onChange={(v) => up({ locked: v ? true : null as unknown as boolean })} /></Row>
      <Row label="Tags">
        <TextField value={(e.tags ?? []).join(', ')} placeholder="comma, separated" onCommit={(v) => {
          const tags = v.split(',').map((s) => s.trim()).filter(Boolean);
          up({ tags: tags.length ? tags : null as unknown as string[] });
        }} />
      </Row>
      <Row label="Interactions" class="top" title="Entity-scoped InteractionBinding[] (override widget defaults and globals)">
        <JsonField value={e.interactions ?? []} rows={8} onCommit={(v) => {
          if (v !== undefined && !Array.isArray(v)) { ctx.toast('interactions must be an array of bindings', 'error'); return; }
          up({ interactions: (Array.isArray(v) && v.length ? v : null) as Entity['interactions'] });
        }} />
      </Row>
    </>
  );
}

function refLabel(ctx: DebugContext, r: PortRef, self: string) {
  if (r.kind === 'channel') return <span class="ref" title="channel">#{r.channel}</span>;
  const other = ctx.store.scene.value.entities[r.entity];
  const name = r.entity === self ? 'this' : other ? entityLabel(other) : r.entity;
  return (
    <span class="ref" title={`${r.entity}.${r.port}${r.entity === self ? '' : ' — click to select'}`} onClick={() => { if (r.entity !== self) ctx.actions.select(r.entity); }}>
      {name}.{r.port}
    </span>
  );
}

function LinksList({ ctx, e }: { ctx: DebugContext; e: Entity }) {
  const links = Object.values(ctx.store.scene.value.links).filter((l: Link) =>
    (l.from.kind === 'port' && l.from.entity === e.id) || (l.to.kind === 'port' && l.to.entity === e.id));
  if (!links.length) return <div class="dbg-dim" style={{ fontSize: '12px', padding: '2px 0' }}>No links.</div>;
  return (
    <div>
      {links.map((l) => (
        <div key={l.id} class="dbg-linkrow" style={l.enabled ? undefined : { opacity: 0.5 }}>
          <Switch checked={l.enabled} title={l.enabled ? 'Disable link' : 'Enable link'}
            onChange={(v) => void ctx.actions.ops([{ op: 'link.update', id: l.id, patch: { enabled: v } }])} />
          {refLabel(ctx, l.from, e.id)}
          <span class="arrow">→</span>
          {refLabel(ctx, l.to, e.id)}
          {l.transform ? <span class="tf" title={`transform: ${l.transform}`}>ƒ {l.transform}</span> : null}
          <span style={{ flex: 1 }} />
          <span class="dbg-mono dim">{l.id}</span>
          <IconButton icon="trash" class="sm" danger title="Remove link" onClick={() => void ctx.actions.ops([{ op: 'link.remove', id: l.id }])} />
        </div>
      ))}
    </div>
  );
}

function InspectorPanel({ ctx }: PanelProps) {
  const e = ctx.store.selectedEntity.value;
  if (!e) {
    return (
      <Empty icon="sliders" title="Nothing selected">
        Click an entity in the Scene tree, or <span class="dbg-kbd">Ctrl</span>+click it in the 3D view.
      </Empty>
    );
  }
  const m = ctx.store.catalog.value[e.widget];
  const specs = Object.entries(m?.props ?? {});
  const nLinks = Object.values(ctx.store.scene.value.links).filter((l) =>
    (l.from.kind === 'port' && l.from.entity === e.id) || (l.to.kind === 'port' && l.to.entity === e.id)).length;
  const nPorts = Object.keys(m?.inputs ?? {}).length + Object.keys(m?.outputs ?? {}).length;
  return (
    <Scroll>
      <Header ctx={ctx} e={e} />
      <Section id="insp.transform" title="Transform">
        <TransformEditor ctx={ctx} e={e} />
      </Section>
      <Section id="insp.props" title="Props" count={specs.length || undefined}>
        {specs.map(([name, spec]) => <PropEditor key={`${e.id}.${name}`} ctx={ctx} e={e} name={name} spec={spec} />)}
        <ExtraProps ctx={ctx} e={e} manifest={m} />
        {!specs.length && !Object.keys(e.props).length ? <div class="dbg-dim" style={{ fontSize: '12px' }}>No props.</div> : null}
      </Section>
      <Section id="insp.ports" title="Ports" count={nPorts || undefined}>
        <PortsTable ctx={ctx} e={e} manifest={m} />
      </Section>
      <Section id="insp.links" title="Links" count={nLinks || undefined}>
        <LinksList ctx={ctx} e={e} />
      </Section>
      <Section id="insp.entity" title="Entity">
        <EntitySettings ctx={ctx} e={e} />
      </Section>
      <Section id="insp.raw" title="Raw JSON" defaultOpen={false}
        actions={<IconButton icon="copy" class="sm" title="Copy JSON" onClick={() => void copyText(JSON.stringify(e, null, 2)).then((ok) => ctx.toast(ok ? 'Copied' : 'Clipboard unavailable'))} />}>
        <pre class="dbg-pre">{prettyJson(e)}</pre>
      </Section>
    </Scroll>
  );
}

export default definePanel({
  id: 'inspector',
  title: 'Inspector',
  dock: 'right',
  order: 0,
  icon: 'sliders',
  component: InspectorPanel,
});
