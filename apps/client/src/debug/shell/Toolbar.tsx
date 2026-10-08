// Top toolbar: connection, workspace menu, undo/redo, scene version,
// registered actions (grid, screenshot, …), headset indicator, panels menu.

import { panelDefs, toolbarActions } from '../registry.ts';
import type { DebugContext } from '../types.ts';
import { DOCK_IDS } from '../types.ts';
import { Icon } from '../ui/icons.tsx';
import { Dot, IconButton } from '../ui/kit.tsx';
import { openMenu, promptText, type MenuEntry } from '../ui/menu.tsx';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const validName = (v: string) => (NAME_RE.test(v.trim()) ? null : 'letters, digits, . _ - (max 64)');

async function workspaceMenu(ctx: DebugContext, anchor: HTMLElement): Promise<void> {
  let ws = ctx.store.workspaces.value;
  try { await ctx.store.refresh('workspaces'); ws = ctx.store.workspaces.value; } catch { /* offline: last known */ }
  const current = ws?.current ?? ctx.store.scene.value.workspace;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); ctx.toast(what); } catch (e) { ctx.toast((e as Error).message, 'error'); }
    void ctx.store.refresh('workspaces').catch(() => {});
  };
  const items: MenuEntry[] = [
    { header: 'Workspaces' },
    ...(ws?.list ?? []).map((name) => ({
      label: name, checked: name === current,
      run: () => { if (name !== current) void run(`Loaded workspace '${name}'`, () => ctx.api.loadWorkspace(name)); },
    })),
    'separator',
    { label: 'Save', icon: 'save', hint: current, run: () => void run(`Saved '${current}'`, () => ctx.api.saveWorkspace(current)) },
    {
      label: 'Save as…', icon: 'copy', run: async () => {
        const name = await promptText({ title: 'Save workspace as', label: 'New name (the scene keeps going under this name)', value: `${current}-copy`, ok: 'Save', validate: validName });
        if (name) void run(`Saved as '${name}'`, () => ctx.api.saveWorkspace(name));
      },
    },
    {
      label: 'New workspace…', icon: 'plus', run: async () => {
        const name = await promptText({ title: 'New empty workspace', label: `'${current}' is saved first`, value: '', ok: 'Create', validate: validName });
        if (name) void run(`Created workspace '${name}'`, () => ctx.api.newWorkspace(name));
      },
    },
  ];
  openMenu(anchor, items);
}

function panelsMenu(ctx: DebugContext, anchor: HTMLElement): void {
  const st = ctx.layout.state.value;
  const items: MenuEntry[] = [{ header: 'Panels' }];
  for (const d of DOCK_IDS) {
    for (const id of st.docks[d].tabs) {
      const def = panelDefs.value.find((p) => p.id === id);
      if (!def) continue;
      const shown = !st.hidden.includes(id);
      items.push({ label: `${def.title}`, hint: d, checked: shown, run: () => (shown ? ctx.layout.hide(id) : ctx.layout.show(id)) });
    }
  }
  items.push('separator',
    ...DOCK_IDS.map((d) => ({ label: `${st.docks[d].collapsed ? 'Expand' : 'Collapse'} ${d} dock`, icon: ({ left: 'panelLeft', right: 'panelRight', bottom: 'panelBottom' } as const)[d], run: () => ctx.layout.toggleCollapsed(d) })),
    'separator',
    { label: 'Reset layout', icon: 'refresh', run: () => ctx.layout.reset() },
    { label: 'Hide debug UI', icon: 'hide', hint: '`  F1', run: () => ctx.layout.setVisible(false) },
  );
  openMenu(anchor, items);
}

export function Toolbar({ ctx }: { ctx: DebugContext }) {
  const conn = ctx.store.conn.value;
  const scene = ctx.store.scene.value;
  const headset = ctx.store.headset.value;
  const health = ctx.store.health.value;
  const actions = [...toolbarActions.value].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const host = conn.url.replace(/^https?:\/\//, '');
  const connKind = conn.connected && conn.ready ? 'ok' : conn.connected || conn.attempt <= 1 ? 'busy' : 'error';
  const others = (health?.clients ?? []).filter((c) => c.id !== conn.clientId);
  const clientsTitle = others.map((c) => `${c.id} ${c.role}${c.primary ? ' (primary)' : ''}${c.userAgent ? ` — ${c.userAgent.slice(0, 50)}` : ''}`).join('\n');

  return (
    <div class="dbg-toolbar">
      <div class="dbg-brand"><span class="logo" />EvolSpace<span class="tag">DEBUG</span></div>
      <span class="dbg-tsep" />
      <div class="dbg-conn" title={`${conn.connected ? 'Connected' : 'Disconnected'} · client ${conn.clientId ?? '—'} (desktop, never primary)\n${conn.url}`}>
        <Dot kind={connKind} />
        <span>{host || 'server'}</span>
      </div>
      <button type="button" class="dbg-ws" title="Workspace: load / save / save as / new" onClick={(e) => void workspaceMenu(ctx, e.currentTarget as HTMLElement)}>
        <Icon name="folder" size={14} />
        <span class="n">{scene.workspace || '—'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <span class="dbg-tsep" />
      <div class="dbg-tgroup">
        <IconButton icon="undo" title="Undo (Ctrl+Z)" onClick={() => void ctx.actions.undo()} />
        <IconButton icon="redo" title="Redo (Ctrl+Shift+Z / Ctrl+Y)" onClick={() => void ctx.actions.redo()} />
        <span class="dbg-ver" title="Scene version">v{scene.version}</span>
      </div>
      <span class="dbg-tsep" />
      <div class="dbg-tgroup">
        {actions.map((a) => (
          <IconButton key={a.id} icon={a.icon ?? 'dot'} title={a.title} label={a.label} active={(() => { try { return a.active?.(ctx) ?? false; } catch { return false; } })()}
            onClick={() => { void Promise.resolve().then(() => a.run(ctx)).catch((e: Error) => ctx.toast(`${a.title}: ${e.message}`, 'error')); }} />
        ))}
      </div>
      <span class="dbg-tspacer" />
      <div class={`dbg-headset${headset.connected ? ' on' : ''}`} title={`${headset.connected ? `Headset connected (primary ${headset.primaryId})${headset.userAgent ? `\n${headset.userAgent}` : ''}` : 'No primary xr client: user screenshots / user pose unavailable'}${clientsTitle ? `\n\nOther clients:\n${clientsTitle}` : ''}`}>
        <Icon name="headset" size={15} />
        <Dot kind={headset.connected ? 'ok' : 'off'} />
        <span>{headset.connected ? 'Headset' : 'No headset'}</span>
        {others.length ? <span class="dbg-count">· {others.length} client{others.length === 1 ? '' : 's'}</span> : null}
      </div>
      <span class="dbg-tsep" />
      <IconButton icon="layers" title="Panels & layout" onClick={(e) => panelsMenu(ctx, e.currentTarget as HTMLElement)} />
      <IconButton icon="hide" title="Hide debug UI (` or F1)" onClick={() => ctx.layout.setVisible(false)} />
    </div>
  );
}
