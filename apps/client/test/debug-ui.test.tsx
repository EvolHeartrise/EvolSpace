// @vitest-environment happy-dom
// Debug dashboard Preact components: fields (commit/cancel), the scene tree
// (rows, click-to-select, filter) and the inspector (prop editing → scene op).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Entity, SceneState, ServerMessage, WidgetManifest } from '@evolspace/protocol';
import { DEFAULT_THEME } from '@evolspace/runtime';
import { createApi } from '../src/debug/api.ts';
import { createDebugStore, type StoreNet, type StoreRuntime } from '../src/debug/store.ts';
import { NumberField, TextField } from '../src/debug/ui/fields.tsx';
import scenePanel from '../src/debug/panels/scene.tsx';
import inspectorPanel from '../src/debug/panels/inspector.tsx';
import type { DebugContext } from '../src/debug/types.ts';

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { render(null, host); host.remove(); });

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('fields', () => {
  it('NumberField commits on Enter (with arithmetic) and Esc cancels without committing on blur', async () => {
    const changes: Array<[number, boolean]> = [];
    await act(() => { render(<NumberField value={1} step={0.1} onChange={(v, i) => changes.push([v, i.final])} />, host); });
    const input = host.querySelector('input')!;
    await act(() => { input.focus(); input.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(input, '0.5*3'));
    await act(() => { key(input, 'Enter'); });
    expect(changes).toEqual([[1.5, true]]);
    await act(() => { input.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(input, '9'));
    await act(() => { key(input, 'Escape'); input.dispatchEvent(new FocusEvent('blur')); });
    expect(changes).toHaveLength(1);
    await act(() => { key(input, 'ArrowUp'); });
    expect(changes.at(-1)).toEqual([1.1, true]);
  });

  it('NumberField clamps to min/max and rounds integers', async () => {
    const changes: number[] = [];
    await act(() => { render(<NumberField value={2} min={0} max={5} integer onChange={(v) => changes.push(v)} />, host); });
    const input = host.querySelector('input')!;
    await act(() => { input.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(input, '7.6'));
    await act(() => { input.dispatchEvent(new FocusEvent('blur')); });
    expect(changes).toEqual([5]);
  });

  it('TextField: Enter commits, Esc reverts (the following blur must not commit)', async () => {
    const commits: string[] = [];
    await act(() => { render(<TextField value="abc" onCommit={(v) => commits.push(v)} />, host); });
    const input = host.querySelector('input')!;
    await act(() => typeInto(input, 'abc f'));
    await act(() => { key(input, 'Escape'); input.dispatchEvent(new FocusEvent('blur')); });
    expect(commits).toEqual([]);
    expect(input.value).toBe('abc');
    await act(() => typeInto(input, 'xyz'));
    await act(() => { key(input, 'Enter'); });
    expect(commits).toEqual(['xyz']);
  });
});

// ------------------------------------------------------------------ panels with a fake context

const ent = (id: string, parent: string | null, extra: Partial<Entity> = {}): Entity => ({
  id, parent, widget: 'box', props: { size: 0.2 }, transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, ...extra,
});
const BOX: WidgetManifest = {
  id: 'box', description: 'A box.', hash: 'h', url: '/widgets/box.js', hasThumbnail: false, interactions: [],
  props: { size: { type: 'number', default: 0.1, min: 0.001, max: 20 }, wireframe: { type: 'boolean', default: false } },
  inputs: { scale: { type: 'number' } }, outputs: { press: { type: 'event' } },
};

function fakeCtx() {
  const scene: SceneState = { version: 3, workspace: 'w', entities: {}, links: {} };
  for (const e of [ent('root', null, { name: 'Root group' }), ent('kid', 'root', { name: 'child box' }), ent('solo', null)]) scene.entities[e.id] = e;
  let selected: string | null = null;
  const selCbs = new Set<(id: string | null) => void>();
  const runtime = {
    sceneState: scene,
    get selected() { return selected; },
    select(id: string | null) { selected = id && scene.entities[id] ? id : null; for (const cb of selCbs) cb(selected); },
    onSelectionChange(cb: (id: string | null) => void) { selCbs.add(cb); return () => selCbs.delete(cb); },
    onSceneChange() { return () => {}; },
    widgets: { catalog: [BOX], allRecords: () => [].values(), record: () => undefined },
    links: { lastOutput: () => undefined },
    theme: DEFAULT_THEME,
    entityObject: () => undefined,
    root: undefined,
  };
  const net = { connected: true, clientId: 'c', primary: false, httpBase: 'http://x/', status: { connected: true, ready: true, attempt: 0 }, on: () => () => {}, onStatus: () => () => {} };
  const posts: unknown[] = [];
  const api = createApi('http://x', async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    if (u.pathname === '/api/scene/ops') { posts.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ version: 4, ids: [] })); }
    if (u.pathname === '/api/events') return new Response(JSON.stringify({ events: [], next: 0 }));
    return new Response('null');
  });
  const toasts: string[] = [];
  const { store, actions } = createDebugStore({ runtime: runtime as unknown as StoreRuntime, net: net as unknown as StoreNet, api, eventsWaitMs: 0, toast: (t) => toasts.push(t) });
  const ctx = { store, actions, runtime, api, toast: (t: string) => toasts.push(t), layout: { show: () => {} } } as unknown as DebugContext;
  return { ctx, runtime, posts, toasts, dispose: () => store.dispose() };
}

describe('scene panel', () => {
  it('lists the hierarchy, selects on click, filters', async () => {
    const f = fakeCtx();
    const Scene = scenePanel.component;
    await act(() => { render(<Scene ctx={f.ctx} />, host); });
    const ids = () => [...host.querySelectorAll<HTMLElement>('.dbg-trow')].map((r) => r.dataset.id);
    expect(ids()).toEqual(['root', 'kid', 'solo']);
    expect(host.querySelector('[data-id="kid"]')!.getAttribute('style')).toContain('padding-left: 20px'); // depth 1
    await act(() => { (host.querySelector('[data-id="kid"]') as HTMLElement).click(); });
    expect(f.runtime.selected).toBe('kid');
    await tick();
    expect(host.querySelector('[data-id="kid"]')!.className).toContain('sel');
    const search = host.querySelector<HTMLInputElement>('.dbg-search input')!;
    await act(() => typeInto(search, 'child'));
    expect(ids()).toEqual(['root', 'kid']);
    expect(host.querySelector('[data-id="kid"] mark')!.textContent).toBe('child');
    await act(() => typeInto(search, ''));
    // Eye toggle → update op (visible false)
    await act(() => { (host.querySelectorAll<HTMLButtonElement>('[data-id="solo"] .tg')[1]).click(); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'update', id: 'solo', patch: { visible: false } }], source: 'user' });
    f.dispose();
  });
});

describe('inspector panel', () => {
  it('shows the selection and turns a prop edit into an update op', async () => {
    const f = fakeCtx();
    const Insp = inspectorPanel.component;
    await act(() => { render(<Insp ctx={f.ctx} />, host); });
    expect(host.textContent).toContain('Nothing selected');
    await act(() => { f.ctx.actions.select('kid'); });
    await tick();
    expect(host.querySelector<HTMLInputElement>('.dbg-insp-head .nm input')!.value).toBe('child box');
    expect(host.textContent).toContain('A box.');
    const size = host.querySelector<HTMLInputElement>('.dbg-row[title^="size:"] .dbg-num input')!;
    expect(size.value).toBe('0.2');
    await act(() => { size.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(size, '0.75'));
    await act(() => { key(size, 'Enter'); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'update', id: 'kid', patch: { props: { size: 0.75 } } }], source: 'user' });
    // Ports table lists inputs/outputs from the manifest
    expect(host.querySelector('.dbg-ports')!.textContent).toContain('scale');
    f.dispose();
  });
});

export type { ServerMessage };
