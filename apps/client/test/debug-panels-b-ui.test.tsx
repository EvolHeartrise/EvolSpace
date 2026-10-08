// @vitest-environment happy-dom
// Events / Agent / Sources / Screenshots debug panels rendered with a fake
// context: event rows + filters + entity click + unseen-error badge, agent.ask
// over the WebSocket with the selection as context, voice simulate routing,
// source start, and the screenshot.myView toolbar action replacing the placeholder.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ClientMessage, Entity, SceneState, ServerEvent, SourceStatus } from '@evolspace/protocol';
import { DEFAULT_THEME } from '@evolspace/runtime';
import * as THREE from 'three';
import { createApi } from '../src/debug/api.ts';
import { createDebugStore, type StoreNet, type StoreRuntime } from '../src/debug/store.ts';
import { registerToolbarAction, resetRegistries, toolbarActions } from '../src/debug/registry.ts';
import eventsPanel, { __eventsState } from '../src/debug/panels/events.tsx';
import agentPanel, { __agentState } from '../src/debug/panels/agent.tsx';
import sourcesPanel from '../src/debug/panels/sources.tsx';
import screenshotsPanel, { __shotsState } from '../src/debug/panels/screenshots.tsx';
import type { DebugContext } from '../src/debug/types.ts';

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { render(null, host); host.remove(); });
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const ent = (id: string): Entity => ({ id, parent: null, widget: 'box', props: {}, transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true });

function fakeCtx(events: ServerEvent[] = [], sources: SourceStatus[] = []) {
  const scene: SceneState = { version: 1, workspace: 'w', entities: { 'e-1': ent('e-1'), 'e-2': ent('e-2') }, links: {} };
  let selected: string | null = null;
  const selCbs = new Set<(id: string | null) => void>();
  const runtime = {
    sceneState: scene,
    get selected() { return selected; },
    select(id: string | null) { selected = id && scene.entities[id] ? id : null; for (const cb of selCbs) cb(selected); },
    onSelectionChange(cb: (id: string | null) => void) { selCbs.add(cb); return () => selCbs.delete(cb); },
    onSceneChange() { return () => {}; },
    widgets: { catalog: [], allRecords: () => [].values() },
    theme: DEFAULT_THEME,
    root: new THREE.Group(),
    frameEntity: () => null,
  };
  const sent: ClientMessage[] = [];
  const handlers = new Map<string, Array<(m: unknown) => void>>();
  const net = {
    connected: true, clientId: 'c1', primary: false, httpBase: 'http://x/', status: { connected: true, ready: true, attempt: 0 },
    on: (t: string, cb: (m: unknown) => void) => { handlers.set(t, [...(handlers.get(t) ?? []), cb]); return () => {}; },
    onStatus: () => () => {},
    send: (m: ClientMessage) => sent.push(m),
  };
  const calls: Array<{ path: string; body?: unknown }> = [];
  const api = createApi('http://x', async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname, body });
    if (u.pathname === '/api/events') return new Response(JSON.stringify({ events, next: events.length }));
    if (u.pathname === '/api/sources') return new Response(JSON.stringify(sources));
    if (u.pathname === '/api/voice/commands') return new Response(JSON.stringify([{ id: 'undo', patterns: ['undo( that)?'], command: 'undo' }]));
    if (u.pathname === '/api/voice/simulate') return new Response(JSON.stringify({ route: 'fastpath', command: 'undo' }));
    if (u.pathname === '/api/screenshot') return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    if (/\/api\/sources\/.+\/start/.test(u.pathname)) return new Response(JSON.stringify({ ...sources[0], running: true }));
    return new Response('null');
  });
  const toasts: string[] = [];
  const { store, actions } = createDebugStore({ runtime: runtime as unknown as StoreRuntime, net: net as unknown as StoreNet, api, eventsWaitMs: 0, toast: (t) => toasts.push(t) });
  const framed: string[] = [];
  const shown: string[] = [];
  const pttCalls: string[] = [];
  const camera = new THREE.PerspectiveCamera(50, 2, 0.05, 100);
  camera.position.set(0, 1.6, 2);
  const ctx = {
    store, runtime, api, net, THREE, camera,
    actions: { ...actions, frame: (id: string) => framed.push(id) },
    toast: (t: string) => toasts.push(t),
    layout: { show: (id: string) => shown.push(id) },
    client: {
      state: () => ({ ptt: { active: true, framesSent: 3 }, mic: { state: 'live', error: null } }),
      command: (name: string, _a: unknown, phase: string) => { pttCalls.push(`${name}:${phase}`); return 'local'; },
      viewportSize: () => ({ width: 1000, height: 500 }),
    },
  } as unknown as DebugContext;
  const emit = (type: string, m: unknown) => { for (const cb of handlers.get(type) ?? []) cb(m); };
  return { ctx, store, sent, calls, toasts, framed, shown, pttCalls, emit, runtime, dispose: () => store.dispose() };
}

let s = 0;
const ev = (type: string, data: Record<string, unknown>): ServerEvent => ({ seq: ++s, ts: 1_700_000_000_000 + s, type: type as ServerEvent['type'], data });

describe('events panel', () => {
  it('lists events, filters errors / types, selects entities, counts unseen errors in the badge', async () => {
    const events = [
      ev('widget.build', { widget: 'box', ok: true, ms: 12 }),
      ev('client.error', { message: 'boom', stack: 'Error: boom\n    at f (http://x/widgets/box.js:1:2)', entity: 'e-1', widget: 'box' }),
      ev('voice.utterance', { text: 'undo', route: 'fastpath', command: 'undo' }),
    ];
    const f = fakeCtx(events);
    await act(async () => { await (f.store as unknown as { pollEventsOnce(w: number): Promise<void> }).pollEventsOnce(0); });
    expect(eventsPanel.badge!(f.ctx)).toBe('!1');
    const Events = eventsPanel.component;
    await act(() => { render(<Events ctx={f.ctx} />, host); });
    await tick();
    const rows = () => [...host.querySelectorAll<HTMLElement>('.dbg-ev-row')];
    expect(rows()).toHaveLength(3);
    expect(rows()[1].className).toContain('error');
    expect(rows()[0].textContent).toContain('box ok 12 ms');
    expect(eventsPanel.badge!(f.ctx)).toBeNull(); // seen while open
    // Entity id → select + frame
    await act(() => { host.querySelector<HTMLElement>('.dbg-ev-ent')!.click(); });
    expect(f.runtime.selected).toBe('e-1');
    expect(f.framed).toEqual(['e-1']);
    // Expand → formatted stack
    await act(() => { rows()[1].querySelector<HTMLElement>('.l')!.click(); });
    expect(host.querySelector('.dbg-ev-stack')!.textContent).toContain('at f (/widgets/box.js:1:2)');
    // Errors only
    await act(() => { host.querySelector<HTMLElement>('.dbg-ev-chip.err')!.click(); });
    expect(rows()).toHaveLength(1);
    __eventsState.errorsOnly.value = false;
    // Type chip toggles
    const chip = [...host.querySelectorAll<HTMLElement>('.dbg-ev-chips .dbg-ev-chip')].find((c) => c.textContent!.startsWith('voice'))!;
    await act(() => { chip.click(); });
    expect(rows()).toHaveLength(2);
    __eventsState.hidden.value = new Set();
    // Search
    await act(() => typeInto(host.querySelector<HTMLInputElement>('.dbg-search input')!, 'fastpath'));
    expect(rows()).toHaveLength(1);
    __eventsState.query.value = '';
    __eventsState.expanded.value = new Set();
    f.dispose();
  });
});

describe('agent panel', () => {
  it('asks Claude over the WebSocket with the selection as context; simulates voice; push-to-talk', async () => {
    const f = fakeCtx();
    const Agent = agentPanel.component;
    const off = agentPanel.init!(f.ctx);
    await act(() => { f.ctx.actions.select('e-2'); });
    await act(() => { render(<Agent ctx={f.ctx} />, host); });
    await tick();
    expect(host.querySelector('.dbg-ag-cmd .id')!.textContent).toBe('undo');
    const input = host.querySelector<HTMLInputElement>('.dbg-ag-comp input')!;
    await act(() => typeInto(input, 'make it blue'));
    await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await tick();
    expect(f.sent.at(-1)).toEqual({ type: 'agent.ask', text: 'make it blue', context: { kind: 'debug', selected: 'e-2', selected_name: 'box', selected_widget: 'box' } });
    // Simulate voice mode
    __agentState.mode.value = 'simulate';
    await tick();
    await act(() => typeInto(input, 'undo that'));
    await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await tick(5);
    expect(f.calls.find((c) => c.path === '/api/voice/simulate')!.body).toEqual({ text: 'undo that', context: { selected: 'e-2' } });
    expect(host.querySelector('.dbg-ag-route')!.textContent).toContain('fastpath · undo');
    // Dry-run tester highlights the command
    await act(() => typeInto(host.querySelector<HTMLInputElement>('.dbg-ag-test .dbg-search input')!, 'okay undo please'));
    expect(host.querySelector('.dbg-ag-cmd.hit')).not.toBeNull();
    expect(host.querySelector('.dbg-ag-res')!.textContent).toContain('undo');
    // Hold to talk → voice.ptt start/end through the client router
    const ptt = host.querySelector<HTMLButtonElement>('.dbg-ptt')!;
    ptt.setPointerCapture = () => {};
    await act(() => { ptt.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); });
    expect(host.querySelector('.dbg-ptt')!.className).toContain('on');
    await act(() => { ptt.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true })); });
    expect(f.pttCalls).toEqual(['voice.ptt:start', 'voice.ptt:end']);
    // voice.result → route in the timeline
    await act(() => { f.emit('voice.result', { type: 'voice.result', utteranceId: 'u', text: 'redo', route: 'agent' }); });
    expect([...host.querySelectorAll('.dbg-ag-route')].at(-1)!.textContent).toContain('Claude');
    __agentState.mode.value = 'ask';
    __agentState.testPhrase.value = '';
    if (typeof off === 'function') off();
    f.dispose();
  });
});

describe('sources panel', () => {
  it('lists sources with status and starts one', async () => {
    const f = fakeCtx([], [{ id: 'stt', running: false, restarts: 2, lastExit: { code: 1, at: Date.now() - 5000 }, logTail: ['loading model', 'Traceback (most recent call last):'] } as SourceStatus]);
    const Sources = sourcesPanel.component;
    await act(() => { render(<Sources ctx={f.ctx} />, host); });
    await tick(5);
    expect(host.querySelector('.dbg-src-row .id')!.textContent).toBe('stt');
    expect(host.querySelector('.dbg-src-lines .e')!.textContent).toContain('Traceback');
    await act(() => { host.querySelector<HTMLButtonElement>('.dbg-src-row button[title="Start"]')!.click(); });
    await tick(5);
    expect(f.calls.some((c) => c.path === '/api/sources/stt/start')).toBe(true);
    f.dispose();
  });
});

describe('screenshots panel', () => {
  it('replaces the screenshot.myView placeholder and captures the desktop camera view into the gallery', async () => {
    resetRegistries();
    registerToolbarAction({ id: 'screenshot.myView', title: 'placeholder', placeholder: true, run: () => {} });
    const f = fakeCtx();
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL ??= () => 'blob:x';
    const dispose = screenshotsPanel.init!(f.ctx);
    const action = toolbarActions.value.find((a) => a.id === 'screenshot.myView')!;
    expect(action.placeholder).toBeFalsy();
    await act(async () => { await action.run(f.ctx); });
    expect(f.shown).toEqual(['screenshots']);
    const req = f.calls.find((c) => c.path === '/api/screenshot')!.body as { view: { kind: string; position: number[]; fov: number }; width: number; height: number };
    expect(req.view).toMatchObject({ kind: 'camera', position: [0, 1.6, 2], fov: 50 });
    expect([req.width, req.height]).toEqual([1280, 640]);
    expect(__shotsState.gallery.value[0]).toMatchObject({ kind: 'my view' });
    const Shots = screenshotsPanel.component;
    await act(() => { render(<Shots ctx={f.ctx} />, host); });
    expect(host.querySelectorAll('.dbg-shot-card')).toHaveLength(1);
    if (typeof dispose === 'function') dispose();
    resetRegistries();
    __shotsState.gallery.value = [];
    f.dispose();
  });
});
