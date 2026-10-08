// Desktop debug dashboard entry (lazy-loaded by main.ts for ?debug=1 / /debug).
// Mounts the Preact shell around the 3D view, wires shortcuts, built-in toolbar
// actions, panel init hooks and the overlay runner. Exposed as __evol.debug.

import { render } from 'preact';
import { signal } from '@preact/signals';
import type { EvolClient } from '../app.ts';
import { createDebugContext } from './context.ts';
import { installShortcuts, isDashboardControl } from './keyboard.ts';
import { panelDefs, registerToolbarAction } from './registry.ts';
import { Shell } from './shell/Shell.tsx';
import { injectDebugStyles } from './styles.ts';
import type { DebugContext } from './types.ts';
import './panels/index.ts';

export interface DebugHandle {
  ctx: DebugContext;
  dispose(): void;
}

/** Grid visibility mirrored as a signal (grid.toggle can also come from voice / bindings). */
const gridOn = signal(true);

function registerBuiltinActions(): void {
  registerToolbarAction({
    id: 'grid', title: 'Floor grid (grid.toggle)', icon: 'grid', order: 10,
    active: () => gridOn.value,
    run: (ctx) => { ctx.actions.command('grid.toggle', { visible: !ctx.runtime.environment.grid }); gridOn.value = ctx.runtime.environment.grid; },
  });
  registerToolbarAction({
    id: 'frame', title: 'Frame selection (F)', icon: 'target', order: 20,
    run: (ctx) => ctx.actions.frame(),
  });
  registerToolbarAction({
    id: 'frameAll', title: 'Frame everything (Shift+F)', icon: 'crosshair', order: 21,
    run: (ctx) => ctx.actions.frameAll(),
  });
  // Replaced by the screenshots panel (panels/screenshots.tsx registers the same id).
  registerToolbarAction({
    id: 'screenshot.myView', title: 'Screenshot (my view)', icon: 'camera', order: 30, placeholder: true,
    run: (ctx) => ctx.toast('Screenshots are not wired up yet (panels/screenshots.tsx)', 'warn'),
  });
}

export async function startDebug(client: EvolClient): Promise<DebugHandle> {
  const style = injectDebugStyles(client.runtime.theme);
  registerBuiltinActions();
  const handle = createDebugContext(client);
  const { ctx } = handle;

  const disposers: Array<() => void> = [];
  for (const def of panelDefs.value) {
    if (!def.init) continue;
    try {
      const d = def.init(ctx);
      if (typeof d === 'function') disposers.push(d);
    } catch (e) {
      console.error(`[debug] panel ${def.id} init failed`, e);
    }
  }
  handle.overlays.start(ctx);

  const root = document.createElement('div');
  root.id = 'evol-debug';
  document.body.appendChild(root);
  render(<Shell ctx={ctx} />, root);

  // Keys typed into dashboard controls never reach the fly camera / PTT.
  if (client.desktop) client.desktop.keyFilter = (ev) => isDashboardControl(ev.target, root);
  // Keep the dashboard's clicks/wheel away from the page-level desktop hand (it listens on window for pointerup/move only).
  root.addEventListener('contextmenu', (e) => { if (!(e.target as Element).closest?.('.dbg-canvas-host')) e.preventDefault(); });

  const syncGrid = () => { gridOn.value = client.runtime.environment.grid; };
  syncGrid();
  const gridTimer = setInterval(syncGrid, 1000);

  disposers.push(installShortcuts({
    toggleUi: () => ctx.layout.toggleVisible(),
    frame: () => ctx.actions.frame(),
    frameAll: () => ctx.actions.frameAll(),
    remove: () => { const id = ctx.store.selection.value; if (id) void ctx.actions.remove(id); },
    undo: () => void ctx.actions.undo(),
    redo: () => void ctx.actions.redo(),
    clearSelection: () => ctx.actions.select(null),
  }, () => ctx.layout.state.value.visible));

  const onHide = () => ctx.layout.flush();
  window.addEventListener('pagehide', onHide);

  if (window.__evol) window.__evol.debug = ctx;
  console.info('[evol] debug dashboard ready (` or F1 toggles it)');

  return {
    ctx,
    dispose: () => {
      clearInterval(gridTimer);
      window.removeEventListener('pagehide', onHide);
      for (const d of disposers) { try { d(); } catch { /* ignore */ } }
      render(null, root);
      root.remove();
      style.remove();
      if (client.desktop) client.desktop.keyFilter = null;
      handle.dispose();
      if (window.__evol?.debug === ctx) delete window.__evol.debug;
    },
  };
}
