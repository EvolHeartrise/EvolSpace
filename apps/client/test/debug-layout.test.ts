// Debug dashboard: layout reconciliation + persistence, shortcuts, tree helpers, registry.
import { describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import type { Entity } from '@evolspace/protocol';
import { LAYOUT_KEY, LayoutStore, defaultLayout, loadLayout, reconcileLayout, safeLocalStorage, type StorageLike } from '../src/debug/layout.ts';
import { isDashboardControl, matchShortcut, type KeyLike } from '../src/debug/keyboard.ts';
import { ancestorsOf, flattenTree, isSelfOrDescendant } from '../src/debug/panels/scene/tree.ts';
import { buildTree } from '../src/debug/store.ts';
import { registerToolbarAction, resetRegistries, toolbarActions } from '../src/debug/registry.ts';
import type { PanelDef } from '../src/debug/types.ts';

const panel = (id: string, dock: PanelDef['dock'], order: number): PanelDef => ({ id, title: id, dock, order, component: () => null });
const PANELS = [panel('scene', 'left', 0), panel('widgets', 'left', 10), panel('inspector', 'right', 0), panel('links', 'bottom', 0), panel('events', 'bottom', 20)];

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

describe('layout reconciliation', () => {
  it('defaults: panels in their docks by order, lowest order active', () => {
    const l = defaultLayout(PANELS);
    expect(l.docks.left).toMatchObject({ tabs: ['scene', 'widgets'], active: 'scene', collapsed: false, size: 300 });
    expect(l.docks.bottom.tabs).toEqual(['links', 'events']);
    expect(l.visible).toBe(true);
    expect(l.overlays).toBeNull();
  });

  it('keeps saved placement, drops unknown panels, appends new ones, clamps sizes, fixes the active tab', () => {
    const saved = {
      visible: false,
      docks: {
        left: { size: 5, tabs: ['inspector', 'gone'], active: 'gone', collapsed: true },
        right: { size: 99999, tabs: [], active: null },
        bottom: { size: 'x', tabs: ['events', 'links', 'events'], active: 'links' },
      },
      hidden: ['events', 'gone'],
      overlays: ['bounds', 3],
    };
    const l = reconcileLayout(saved, PANELS);
    expect(l.visible).toBe(false);
    expect(l.docks.left.tabs).toEqual(['inspector', 'scene', 'widgets']); // moved panel kept, new ones appended
    expect(l.docks.left.active).toBe('inspector'); // 'gone' invalid → lowest order (ties: tab order)
    expect(l.docks.left.size).toBe(180);
    expect(l.docks.left.collapsed).toBe(true);
    expect(l.docks.right.size).toBe(900);
    expect(l.docks.right.tabs).toEqual([]);
    expect(l.docks.bottom.tabs).toEqual(['events', 'links']);
    expect(l.docks.bottom.size).toBe(290);
    expect(l.hidden).toEqual(['events']);
    expect(l.overlays).toEqual(['bounds']);
  });

  it('survives corrupt / missing storage', () => {
    expect(loadLayout(memStorage({ [LAYOUT_KEY]: '{not json' }), PANELS).docks.left.tabs).toEqual(['scene', 'widgets']);
    expect(reconcileLayout('nope', PANELS).docks.right.tabs).toEqual(['inspector']);
    const throwing: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => new LayoutStore(signal(PANELS), throwing, 0).setSize('left', 400)).not.toThrow();
    expect(typeof safeLocalStorage().getItem).toBe('function'); // node: falls back to memory
  });
});

describe('LayoutStore', () => {
  it('persists changes and restores them', () => {
    const storage = memStorage();
    const panels = signal(PANELS);
    const a = new LayoutStore(panels, storage, 0);
    a.setSize('bottom', 333.4);
    a.setActive('bottom', 'events');
    a.toggleCollapsed('right');
    a.move('widgets', 'right');
    a.hide('links');
    a.setOverlays(['axes', 'axes', 'bounds']);
    a.dispose();
    const b = new LayoutStore(panels, storage, 0);
    const v = b.value;
    expect(v.docks.bottom).toMatchObject({ size: 333, active: 'events' });
    expect(v.docks.right).toMatchObject({ collapsed: false, tabs: ['inspector', 'widgets'], active: 'widgets' }); // move expands + activates
    expect(v.docks.left.tabs).toEqual(['scene']);
    expect(v.hidden).toEqual(['links']);
    expect(v.overlays).toEqual(['axes', 'bounds']);
    b.show('links');
    expect(b.value.hidden).toEqual([]);
    expect(b.value.docks.bottom.active).toBe('links');
    b.reorder('links', 5);
    expect(b.value.docks.bottom.tabs).toEqual(['events', 'links']);
    b.reset();
    expect(b.value.docks.right.tabs).toEqual(['inspector']);
    expect(b.value.overlays).toEqual(['axes', 'bounds']); // reset keeps overlay choices
    b.dispose();
  });

  it('merges panels registered later', () => {
    const panels = signal(PANELS.slice(0, 2));
    const s = new LayoutStore(panels, memStorage(), 0);
    expect(s.value.docks.right.tabs).toEqual([]);
    panels.value = PANELS;
    expect(s.value.docks.right.tabs).toEqual(['inspector']);
    s.dispose();
  });
});

describe('shortcuts', () => {
  const key = (k: Partial<KeyLike>): KeyLike => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, ...k });
  const input = { tagName: 'INPUT', type: 'text' } as unknown as EventTarget;
  const checkbox = { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget;

  it('maps keys', () => {
    expect(matchShortcut(key({ code: 'Backquote', key: '`' }))).toBe('toggleUi');
    expect(matchShortcut(key({ key: 'F1', code: 'F1' }))).toBe('toggleUi');
    expect(matchShortcut(key({ code: 'KeyF', key: 'f' }))).toBe('frame');
    expect(matchShortcut(key({ code: 'KeyF', key: 'F', shiftKey: true }))).toBe('frameAll');
    expect(matchShortcut(key({ key: 'Delete', code: 'Delete' }))).toBe('remove');
    expect(matchShortcut(key({ code: 'KeyZ', ctrlKey: true }))).toBe('undo');
    expect(matchShortcut(key({ code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(matchShortcut(key({ code: 'KeyY', metaKey: true }))).toBe('redo');
    expect(matchShortcut(key({ key: 'Escape', code: 'Escape' }))).toBe('clearSelection');
  });

  it('never fires while typing, leaves desktop-control keys alone, only toggles while hidden', () => {
    expect(matchShortcut(key({ code: 'KeyF', key: 'f', target: input }))).toBeNull();
    expect(matchShortcut(key({ key: 'Delete', target: input }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyZ', ctrlKey: true, target: input }))).toBeNull();
    expect(matchShortcut(key({ code: 'Backquote', target: input }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyF', key: 'f', target: checkbox }))).toBe('frame');
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyV', 'KeyP', 'KeyH']) expect(matchShortcut(key({ code }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyF', key: 'f', repeat: true }))).toBeNull();
    expect(matchShortcut(key({ code: 'KeyF', key: 'f' }), false)).toBeNull();
    expect(matchShortcut(key({ code: 'Backquote' }), false)).toBe('toggleUi');
  });

  it('isDashboardControl: form controls inside the dashboard root only', () => {
    const root = { contains: (n: unknown) => n === inside || n === button } as unknown as Element;
    const inside = { closest: (s: string) => (s.includes('input') ? {} : null) } as unknown as Element;
    const button = { closest: () => null } as unknown as Element;
    const outside = { closest: () => ({}) } as unknown as Element;
    expect(isDashboardControl(inside, root)).toBe(true);
    expect(isDashboardControl(button, root)).toBe(false);
    expect(isDashboardControl(outside, root)).toBe(false);
    expect(isDashboardControl(null, root)).toBe(false);
  });
});

describe('scene tree helpers', () => {
  const e = (id: string, parent: string | null = null, name?: string): Entity => ({
    id, parent, widget: id.startsWith('s') ? 'slider' : 'box', props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, ...(name ? { name } : {}),
  });
  const ents = { a: e('a', null, 'Alpha'), b: e('b', 'a'), s1: e('s1', 'b', 'gain'), c: e('c') };
  const tree = buildTree(ents);

  it('flattens with collapse state', () => {
    expect(flattenTree(tree, new Set()).map((r) => `${r.node.id}@${r.depth}`)).toEqual(['a@0', 'b@1', 's1@2', 'c@0']);
    expect(flattenTree(tree, new Set(['b'])).map((r) => r.node.id)).toEqual(['a', 'b', 'c']);
    expect(flattenTree(tree, new Set(['b'])).find((r) => r.node.id === 'b')).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('filters by name / widget / id, keeping ancestors (expanded) of matches', () => {
    const rows = flattenTree(tree, new Set(['a', 'b']), 'GAIN');
    expect(rows.map((r) => [r.node.id, r.match])).toEqual([['a', false], ['b', false], ['s1', true]]);
    expect(flattenTree(tree, new Set(), 'slider').map((r) => r.node.id)).toEqual(['a', 'b', 's1']);
    expect(flattenTree(tree, new Set(), 'zzz')).toEqual([]);
  });

  it('ancestry / reparent validity', () => {
    expect(ancestorsOf(ents, 's1')).toEqual(['b', 'a']);
    expect(isSelfOrDescendant(ents, 'a', 's1')).toBe(true);
    expect(isSelfOrDescendant(ents, 'a', 'a')).toBe(true);
    expect(isSelfOrDescendant(ents, 's1', 'a')).toBe(false);
  });
});

describe('registry', () => {
  it('placeholder toolbar actions never replace real ones', () => {
    resetRegistries();
    const real = { id: 'screenshot.myView', title: 'real', run: () => {} };
    registerToolbarAction(real);
    registerToolbarAction({ id: 'screenshot.myView', title: 'placeholder', placeholder: true, run: () => {} });
    expect(toolbarActions.value.map((a) => a.title)).toEqual(['real']);
    resetRegistries();
    registerToolbarAction({ id: 'screenshot.myView', title: 'placeholder', placeholder: true, run: () => {} });
    registerToolbarAction(real);
    expect(toolbarActions.value.map((a) => a.title)).toEqual(['real']);
    resetRegistries();
  });
});

describe('overlay runner', () => {
  it('creates enabled overlays, updates them per frame, disposes on disable, disables a crashing one', async () => {
    const { OverlayRunner } = await import('../src/debug/overlays.ts');
    const log: string[] = [];
    const frames = new Set<(dt: number, t: number) => void>();
    const toasts: string[] = [];
    const defs = signal([
      { id: 'a', title: 'A', defaultEnabled: true, create: () => ({ update: (dt: number) => log.push(`a.update ${dt}`), dispose: () => log.push('a.dispose') }) },
      { id: 'b', title: 'B', create: () => ({ update: () => { throw new Error('bad'); }, dispose: () => log.push('b.dispose') }) },
    ]);
    const layout = new LayoutStore(signal(PANELS), memStorage(), 0);
    const runner = new OverlayRunner(defs, layout);
    const ctx = { client: { onFrame: (cb: (dt: number, t: number) => void) => { frames.add(cb); return () => frames.delete(cb); } }, toast: (t: string) => toasts.push(t) };
    runner.start(ctx as never);
    expect([...runner.enabled.value]).toEqual(['a']); // defaultEnabled until the user chooses
    for (const f of frames) f(0.016, 1);
    expect(log).toEqual(['a.update 0.016']);
    runner.setEnabled('a', false);
    expect(log.at(-1)).toBe('a.dispose');
    expect(layout.value.overlays).toEqual([]);
    runner.toggle('b');
    for (const f of frames) f(0.016, 2);
    expect(runner.isEnabled('b')).toBe(false); // crashed → disabled + disposed
    expect(log.at(-1)).toBe('b.dispose');
    expect(toasts[0]).toContain('crashed');
    runner.dispose();
    layout.dispose();
  });
});
