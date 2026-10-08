// A tabbed, resizable, collapsible dock. Only the active tab's panel is mounted
// (inside an error boundary, so a broken panel can't take the dashboard down).

import { Component, type ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { panelDefs } from '../registry.ts';
import type { DebugContext, DockId, PanelDef } from '../types.ts';
import { DOCK_IDS } from '../types.ts';
import { Icon } from '../ui/icons.tsx';
import { IconButton } from '../ui/kit.tsx';
import { openMenu, type MenuEntry } from '../ui/menu.tsx';

const DOCK_LABEL: Record<DockId, string> = { left: 'left', right: 'right', bottom: 'bottom' };
const DOCK_ICON = { left: 'panelLeft', right: 'panelRight', bottom: 'panelBottom' } as const;
const DRAG_MIME = 'text/x-evol-debug-panel';

class PanelBoundary extends Component<{ id: string; children: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[debug] panel ${this.props.id} crashed`, error); }
  render() {
    if (this.state.error) {
      return (
        <div class="dbg-panel-error">
          {`Panel '${this.props.id}' crashed:\n${this.state.error.stack ?? this.state.error.message}\n\n`}
          <button type="button" class="dbg-btn" onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function TabBadge({ def, ctx }: { def: PanelDef; ctx: DebugContext }) {
  let b: string | number | null = null;
  try { b = def.badge?.(ctx) ?? null; } catch { b = null; }
  if (b === null || b === '' || b === 0) return null;
  const err = typeof b === 'string' && b.startsWith('!');
  return <span class={`b${err ? ' err' : ''}`}>{err ? (b as string).slice(1) : b}</span>;
}

function tabMenu(ctx: DebugContext, def: PanelDef, dock: DockId): MenuEntry[] {
  return [
    { header: def.title },
    ...DOCK_IDS.filter((d) => d !== dock).map((d) => ({ label: `Move to ${DOCK_LABEL[d]} dock`, icon: DOCK_ICON[d], run: () => ctx.layout.move(def.id, d) })),
    'separator',
    { label: 'Close tab', icon: 'x', run: () => ctx.layout.hide(def.id) },
    { label: `Collapse ${DOCK_LABEL[dock]} dock`, icon: DOCK_ICON[dock], run: () => ctx.layout.setCollapsed(dock, true) },
  ];
}

export function Dock({ ctx, dock }: { ctx: DebugContext; dock: DockId }) {
  const layout = ctx.layout.state.value;
  const st = layout.docks[dock];
  const all = panelDefs.value;
  const tabs = st.tabs.filter((t) => !layout.hidden.includes(t)).map((id) => all.find((p) => p.id === id)).filter((p): p is PanelDef => !!p);
  const active = tabs.find((t) => t.id === st.active) ?? tabs[0] ?? null;
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const raf = useRef(0);

  if (!tabs.length) return <div class={`dbg-dock ${dock}`} />;

  const onDragOverTabs = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    const list = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.dbg-tab');
    let idx = list.length;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { idx = i; break; }
    }
    setDropAt(idx);
  };
  const onDropTabs = (e: DragEvent) => {
    const id = e.dataTransfer?.getData(DRAG_MIME);
    const idx = dropAt;
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    if (ctx.layout.dockOf(id) !== dock) ctx.layout.move(id, dock);
    // index among visible tabs → index in the dock's tab list
    const visible = ctx.layout.state.value.docks[dock].tabs.filter((t) => !ctx.layout.state.value.hidden.includes(t) && t !== id);
    const before = idx !== null ? visible[idx] : undefined;
    const full = ctx.layout.state.value.docks[dock].tabs.filter((t) => t !== id);
    ctx.layout.reorder(id, before ? full.indexOf(before) : full.length);
  };

  const onResizeDown = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setResizing(true);
    document.body.classList.add('dbg-resizing', dock === 'bottom' ? 'dbg-resizing-y' : 'dbg-resizing-x');
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        const px = dock === 'left' ? ev.clientX : dock === 'right' ? innerWidth - ev.clientX : innerHeight - ev.clientY;
        ctx.layout.setSize(dock, px);
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setResizing(false);
      document.body.classList.remove('dbg-resizing', 'dbg-resizing-x', 'dbg-resizing-y');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const tabButton = (def: PanelDef, i: number, rail = false) => (
    <button key={def.id} type="button" class={`dbg-tab${!st.collapsed && def.id === active?.id ? ' on' : ''}`} title={rail ? def.title : undefined}
      draggable={!rail} data-panel={def.id}
      style={dropAt === i ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
      onDragStart={(e) => { e.dataTransfer?.setData(DRAG_MIME, def.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => {
        if (!st.collapsed && def.id === active?.id && dock === 'bottom') ctx.layout.setCollapsed(dock, true);
        else ctx.layout.setActive(dock, def.id);
      }}
      onAuxClick={(e) => { if (e.button === 1) ctx.layout.hide(def.id); }}
      onContextMenu={(e) => openMenu(e, tabMenu(ctx, def, dock))}>
      {def.icon ? <Icon name={def.icon} size={13} /> : null}
      <span>{def.title}</span>
      <TabBadge def={def} ctx={ctx} />
    </button>
  );

  if (st.collapsed && dock !== 'bottom') {
    return (
      <div class={`dbg-dock ${dock} collapsed`}>
        <div class="dbg-rail">
          <IconButton icon={DOCK_ICON[dock]} title={`Expand ${dock} dock`} class="sm" onClick={() => ctx.layout.setCollapsed(dock, false)} />
          {tabs.map((t, i) => tabButton(t, i, true))}
        </div>
      </div>
    );
  }

  const Comp = active?.component;
  return (
    <div class={`dbg-dock ${dock}${st.collapsed ? ' collapsed' : ''}`} data-dock={dock}>
      <div class="dbg-tabs">
        <div class="list" onDragOver={onDragOverTabs} onDragLeave={() => setDropAt(null)} onDrop={onDropTabs}>
          {tabs.map((t, i) => tabButton(t, i))}
        </div>
        <div class="tools">
          <IconButton icon={st.collapsed ? 'chevronRight' : DOCK_ICON[dock]} class="sm" title={st.collapsed ? `Expand ${dock} dock` : `Collapse ${dock} dock`}
            onClick={() => ctx.layout.toggleCollapsed(dock)} />
        </div>
      </div>
      {!st.collapsed && active && Comp ? (
        <div class="dbg-dock-body" data-panel-body={active.id}>
          <PanelBoundary id={active.id} key={active.id}>
            <Comp ctx={ctx} />
          </PanelBoundary>
        </div>
      ) : null}
      {!st.collapsed ? <div class={`dbg-resizer${resizing ? ' active' : ''}`} onPointerDown={onResizeDown}
        onDblClick={() => ctx.layout.setSize(dock, { left: 300, right: 380, bottom: 290 }[dock])} title="Drag to resize · double-click to reset" /> : null}
    </div>
  );
}
