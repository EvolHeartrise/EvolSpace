// Dashboard frame: toolbar on top, left/right/bottom docks around the 3D
// viewport. The client's canvas is moved into the viewport cell and sized to it
// (EvolClient.attachViewport), so the camera aspect and mouse → ray mapping
// follow the remaining area.

import { useEffect, useRef } from 'preact/hooks';
import type { DebugContext, DockId } from '../types.ts';
import { Dock } from './Dock.tsx';
import { Toolbar } from './Toolbar.tsx';
import { OverlayLayer } from '../ui/menu.tsx';
import { IconButton } from '../ui/kit.tsx';

export const RAIL_PX = 30;
/** Height of a collapsed bottom dock (its tab bar). */
export const BOTTOM_BAR_PX = 33;

export function dockPx(ctx: DebugContext, dock: DockId): number {
  const st = ctx.layout.state.value;
  const d = st.docks[dock];
  const any = d.tabs.some((t) => !st.hidden.includes(t));
  if (!any) return 0;
  if (d.collapsed) return dock === 'bottom' ? BOTTOM_BAR_PX : RAIL_PX;
  return d.size;
}

function ViewHud({ ctx }: { ctx: DebugContext }) {
  const e = ctx.store.selectedEntity.value;
  const err = e ? ctx.store.entityErrors.value[e.id] : undefined;
  return (
    <div class="dbg-view-hud">
      {e ? (
        <div class="chip" title={err ? err.message : e.id}>
          <span style={{ color: err ? 'var(--neg)' : 'var(--accent)' }}>●</span>
          <b>{e.name ?? e.widget}</b>
          <span class="dbg-mono dim">{e.id}</span>
          <IconButton icon="target" class="sm" title="Frame (F)" onClick={() => ctx.actions.frame(e.id)} />
          <IconButton icon="x" class="sm" title="Clear selection (Esc)" onClick={() => ctx.actions.select(null)} />
        </div>
      ) : null}
    </div>
  );
}

function ViewHelp() {
  return (
    <div class="dbg-view-help">
      <kbd>RMB</kbd> look · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <kbd>Q</kbd><kbd>E</kbd> fly · <kbd>LMB</kbd> pinch · <kbd>Ctrl</kbd>+<kbd>LMB</kbd> select<br />
      <kbd>F</kbd> / <kbd>Shift</kbd>+<kbd>F</kbd> frame sel / all · <kbd>Del</kbd> delete · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>V</kbd> talk · <kbd>`</kbd> hide UI
    </div>
  );
}

export function Shell({ ctx }: { ctx: DebugContext }) {
  const host = useRef<HTMLDivElement>(null);
  const visible = ctx.layout.state.value.visible;
  const left = dockPx(ctx, 'left'), right = dockPx(ctx, 'right'), bottom = dockPx(ctx, 'bottom');

  // Canvas into the viewport cell while shown; back to the page container when hidden.
  useEffect(() => {
    ctx.client.attachViewport(visible ? host.current : null);
    document.body.classList.toggle('evol-debug', visible);
  }, [visible]);
  useEffect(() => () => { ctx.client.attachViewport(null); document.body.classList.remove('evol-debug'); }, []);

  // Docks sizes as CSS variables on <body> too (toasts / PTT indicator sit inside the viewport).
  useEffect(() => {
    const b = document.body.style;
    b.setProperty('--dbg-left', `${visible ? left : 0}px`);
    b.setProperty('--dbg-right', `${visible ? right : 0}px`);
    b.setProperty('--dbg-bottom', `${visible ? bottom : 0}px`);
  }, [visible, left, right, bottom]);

  return (
    <div class={`dbg-root${visible ? '' : ' hidden'}`}
      style={{ '--dbg-left': `${left}px`, '--dbg-right': `${right}px`, '--dbg-bottom': `${bottom}px` }}>
      <Toolbar ctx={ctx} />
      <Dock ctx={ctx} dock="left" />
      <div class="dbg-view">
        <div class="dbg-canvas-host" ref={host} />
        <ViewHud ctx={ctx} />
        <ViewHelp />
      </div>
      <Dock ctx={ctx} dock="right" />
      <Dock ctx={ctx} dock="bottom" />
      <OverlayLayer />
    </div>
  );
}
