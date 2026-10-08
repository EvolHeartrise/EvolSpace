// Scene panel: entity hierarchy. Filter, click = select (two-way with the
// runtime selection / Ctrl+click in the view), double-click = frame, eye/lock
// toggles, context menu, drag a row onto another to reparent (placement kept;
// drop on empty space = root), ↑/↓/←/→/Enter keyboard navigation, error badges.

import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel, entityMenu, reparentPatch, widgetColor, widgetGlyph } from '../entity.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Empty, IconButton, PanelBar, Scroll, SearchBox } from '../ui/kit.tsx';
import { openMenu } from '../ui/menu.tsx';
import { ancestorsOf, flattenTree, isSelfOrDescendant, type FlatRow } from './scene/tree.ts';

// Module-level: survives tab switches.
const query = signal('');
const collapsed = signal<ReadonlySet<string>>(new Set());
const DRAG_MIME = 'text/x-evol-entity';
const INDENT = 14;

function setCollapsed(id: string, c: boolean) {
  const next = new Set(collapsed.value);
  if (c) next.add(id); else next.delete(id);
  collapsed.value = next;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

interface RowProps {
  ctx: DebugContext;
  row: FlatRow;
  selected: boolean;
  error?: string;
  q: string;
  dropTarget: boolean;
  onDragTarget(id: string | null): void;
}

function TreeRow({ ctx, row, selected, error, q, dropTarget, onDragTarget }: RowProps) {
  const e = row.node.entity;
  const a = ctx.actions;
  const label = entityLabel(e);
  return (
    <div class={`dbg-trow${selected ? ' sel' : ''}${e.visible ? '' : ' hidden-e'}${dropTarget ? ' drop' : ''}`} data-id={e.id}
      role="treeitem" aria-selected={selected} aria-level={row.depth + 1} aria-expanded={row.hasChildren ? row.expanded : undefined}
      tabIndex={selected ? 0 : -1}
      style={{ paddingLeft: `${6 + row.depth * INDENT}px` }}
      draggable
      onDragStart={(ev) => { ev.dataTransfer?.setData(DRAG_MIME, e.id); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(ev) => {
        if (!ev.dataTransfer?.types.includes(DRAG_MIME)) return;
        ev.preventDefault();
        ev.stopPropagation();
        onDragTarget(e.id);
      }}
      onDrop={(ev) => {
        const id = ev.dataTransfer?.getData(DRAG_MIME);
        ev.preventDefault();
        ev.stopPropagation();
        onDragTarget(null);
        if (!id) return;
        const ents = ctx.store.scene.value.entities;
        if (isSelfOrDescendant(ents, id, e.id)) { ctx.toast('Cannot move an entity into itself or its own child', 'warn'); return; }
        if (ents[id]?.parent === e.id) return;
        setCollapsed(e.id, false);
        void a.update(id, reparentPatch(ctx, id, e.id));
      }}
      onClick={() => a.select(e.id)}
      onDblClick={() => { a.select(e.id); a.frame(e.id); }}
      onContextMenu={(ev) => { a.select(e.id); openMenu(ev, entityMenu(ctx, e)); }}>
      {row.depth > 0 ? Array.from({ length: row.depth }, (_, i) => <span key={i} class="dbg-guide" style={{ left: `${13 + i * INDENT}px` }} />) : null}
      <span class="tw" onClick={(ev) => { ev.stopPropagation(); if (row.hasChildren && !q) setCollapsed(e.id, row.expanded); }}>
        {row.hasChildren ? <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={12} /> : null}
      </span>
      <span class="ico" style={{ background: widgetColor(e.widget) }}>{widgetGlyph(e.widget)}</span>
      <span class="name"><Highlight text={label} q={q} /></span>
      {e.name ? <span class="wid"><Highlight text={e.widget} q={q} /></span> : null}
      <span class="sp" />
      {error ? <span class="err" title={error}><Icon name="alert" size={13} /></span> : null}
      <span class="id"><Highlight text={e.id} q={q} /></span>
      <button type="button" class={`tg${e.locked ? ' set' : ''}`} title={e.locked ? 'Locked (no grab/scale) — click to unlock' : 'Lock'}
        onClick={(ev) => { ev.stopPropagation(); void a.update(e.id, { locked: e.locked ? null as unknown as boolean : true }); }}>
        <Icon name={e.locked ? 'lock' : 'unlock'} size={13} />
      </button>
      <button type="button" class={`tg${e.visible ? '' : ' set'}`} title={e.visible ? 'Hide' : 'Show'}
        onClick={(ev) => { ev.stopPropagation(); void a.update(e.id, { visible: !e.visible }); }}>
        <Icon name={e.visible ? 'eye' : 'eyeOff'} size={13} />
      </button>
    </div>
  );
}

function ScenePanel({ ctx }: PanelProps) {
  const tree = ctx.store.tree.value;
  const scene = ctx.store.scene.value;
  const sel = ctx.store.selection.value;
  const errors = ctx.store.entityErrors.value;
  const q = query.value.trim().toLowerCase();
  const rows = useMemo(() => flattenTree(tree, collapsed.value, q), [tree, collapsed.value, q]);
  const [dropId, setDropId] = useState<string | null>(null);
  const [dropRoot, setDropRoot] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const entityCount = Object.keys(scene.entities).length;
  const linkCount = Object.keys(scene.links).length;
  const errorCount = Object.keys(errors).filter((id) => scene.entities[id]).length;

  // Selection from elsewhere (view Ctrl+click, inspector, voice): reveal + scroll into view.
  useEffect(() => {
    if (!sel) return;
    const anc = ancestorsOf(ctx.store.scene.peek().entities, sel);
    if (anc.some((id) => collapsed.value.has(id))) {
      const next = new Set(collapsed.value);
      for (const id of anc) next.delete(id);
      collapsed.value = next;
    }
    requestAnimationFrame(() => {
      const el = list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }, [sel]);

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.node.id === sel);
    const go = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      ctx.actions.select(r.node.id);
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(r.node.id)}"]`)?.focus());
    };
    if (ev.key === 'ArrowDown') { ev.preventDefault(); go(i + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(i < 0 ? 0 : i - 1); }
    else if (ev.key === 'ArrowRight' && i >= 0) {
      ev.preventDefault();
      const r = rows[i];
      if (r.hasChildren && !r.expanded) setCollapsed(r.node.id, false); else if (r.hasChildren) go(i + 1);
    } else if (ev.key === 'ArrowLeft' && i >= 0) {
      ev.preventDefault();
      const r = rows[i];
      if (r.hasChildren && r.expanded && !q) setCollapsed(r.node.id, true);
      else if (r.node.entity.parent) ctx.actions.select(r.node.entity.parent);
    } else if (ev.key === 'Enter' && sel) { ev.preventDefault(); ctx.actions.frame(sel); }
  };

  const allParents = (): string[] => {
    const out: string[] = [];
    const walk = (ns: typeof tree) => { for (const n of ns) { if (n.children.length) { out.push(n.id); walk(n.children); } } };
    walk(tree);
    return out;
  };

  return (
    <>
      <PanelBar>
        <SearchBox value={query.value} onInput={(v) => { query.value = v; }} placeholder="Filter name / widget / id" />
        <IconButton icon="chevronDown" class="sm" title="Expand all" onClick={() => { collapsed.value = new Set(); }} />
        <IconButton icon="chevronRight" class="sm" title="Collapse all" onClick={() => { collapsed.value = new Set(allParents()); }} />
      </PanelBar>
      <Scroll class={`dbg-tree${dropRoot ? ' drop-root' : ''}`}
        onClick={(ev) => { if (ev.target === ev.currentTarget) ctx.actions.select(null); }}
        onDragOver={(ev) => {
          if (!ev.dataTransfer?.types.includes(DRAG_MIME)) return;
          ev.preventDefault();
          setDropId(null);
          setDropRoot(true);
        }}
        onDragLeave={(ev) => { if (ev.target === ev.currentTarget) setDropRoot(false); }}
        onDrop={(ev) => {
          const id = ev.dataTransfer?.getData(DRAG_MIME);
          ev.preventDefault();
          setDropRoot(false);
          setDropId(null);
          if (!id || !ctx.store.scene.value.entities[id]?.parent) return;
          void ctx.actions.update(id, reparentPatch(ctx, id, null));
        }}>
        <div ref={list} role="tree" onKeyDown={onKeyDown}>
          {rows.map((r) => (
            <TreeRow key={r.node.id} ctx={ctx} row={r} q={q} selected={r.node.id === sel} error={errors[r.node.id]?.message}
              dropTarget={dropId === r.node.id} onDragTarget={(id) => { setDropRoot(false); setDropId(id); }} />
          ))}
        </div>
        {!rows.length ? (
          entityCount
            ? <Empty icon="search" title="No match">Nothing matches “{query.value}”.</Empty>
            : <Empty icon="layers" title="The scene is empty">Spawn widgets from the Widgets panel, or ask Claude.</Empty>
        ) : null}
      </Scroll>
      <PanelBar class="foot">
        <span class="dbg-count">{entityCount} entities · {linkCount} links</span>
        <span class="grow" />
        {errorCount ? (
          <button type="button" class="dbg-btn small danger" title="Entities whose widget failed to build/run or reported client errors. Click to clear event errors."
            onClick={() => ctx.store.clearErrors()}>
            <Icon name="alert" size={12} />{errorCount} error{errorCount === 1 ? '' : 's'}
          </button>
        ) : <Badge kind="ok">no errors</Badge>}
      </PanelBar>
    </>
  );
}

export default definePanel({
  id: 'scene',
  title: 'Scene',
  dock: 'left',
  order: 0,
  icon: 'layers',
  component: ScenePanel,
  badge: (ctx) => {
    const errs = ctx.store.entityErrors.value;
    const ents = ctx.store.scene.value.entities;
    const n = Object.keys(errs).filter((id) => ents[id]).length;
    return n ? `!${n}` : Object.keys(ents).length;
  },
});

