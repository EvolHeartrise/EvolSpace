// Debug dashboard: store (scene/selection sync, events ring buffer, needs
// refcounting, user pose), actions → HTTP, and the typed API wrapper.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, SceneState, ServerEvent, ServerMessage, UserPose, WidgetManifest } from '@evolspace/protocol';
import { makeTensor } from '@evolspace/protocol';
import { ApiError, createApi } from '../src/debug/api.ts';
import { buildTree, createDebugStore, userPoseFromSummary, type StoreNet, type StoreRuntime } from '../src/debug/store.ts';

const ent = (id: string, parent: string | null = null, extra: Partial<Entity> = {}): Entity => ({
  id, parent, widget: 'box', props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, ...extra,
});

class FakeRuntime implements StoreRuntime {
  sceneState: SceneState = { version: 1, workspace: 'ws', entities: {}, links: {} };
  selected: string | null = null;
  private sceneCbs = new Set<() => void>();
  private selCbs = new Set<(id: string | null) => void>();
  records: Array<{ entityId: string; status: string; error: string | null }> = [];
  widgets = { catalog: [] as WidgetManifest[], allRecords: () => this.records.values() };
  onSceneChange(cb: () => void) { this.sceneCbs.add(cb); return () => { this.sceneCbs.delete(cb); }; }
  onSelectionChange(cb: (id: string | null) => void) { this.selCbs.add(cb); return () => { this.selCbs.delete(cb); }; }
  select(id: string | null) {
    const next = id && this.sceneState.entities[id] ? id : null;
    if (next === this.selected) return;
    this.selected = next;
    for (const cb of this.selCbs) cb(next);
  }
  setEntities(list: Entity[], version = this.sceneState.version + 1) {
    this.sceneState.entities = Object.fromEntries(list.map((e) => [e.id, e]));
    this.sceneState.version = version;
    for (const cb of this.sceneCbs) cb();
  }
}

class FakeNet {
  connected = true;
  clientId: string | null = 'c-1';
  primary = false;
  httpBase = 'http://srv:1/';
  status = { connected: true, ready: true, attempt: 0 };
  private cbs = new Map<string, Set<(m: ServerMessage) => void>>();
  on(type: string, cb: (m: ServerMessage) => void) {
    let s = this.cbs.get(type);
    if (!s) this.cbs.set(type, (s = new Set()));
    s.add(cb);
    return () => { s!.delete(cb); };
  }
  onStatus() { return () => {}; }
  emit(m: ServerMessage) { for (const cb of this.cbs.get(m.type) ?? []) cb(m); }
}

type Handler = (body: unknown, url: URL, init?: RequestInit) => unknown;
function fakeFetch(routes: Record<string, Handler>, calls: Array<{ method: string; path: string; body: unknown }>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method, path: url.pathname + url.search, body });
    const h = routes[`${method} ${url.pathname}`];
    if (!h) return new Response(JSON.stringify({ error: `no route ${method} ${url.pathname}` }), { status: 404 });
    const out = h(body, url, init);
    if (out instanceof Response) return out;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const baseRoutes = (): Record<string, Handler> => ({
  'GET /api/health': () => ({ ok: true, version: '0', clients: [{ id: 'c-x', role: 'xr', primary: true, address: '', connectedAt: 0, subscriptions: 0, pending: 0 }], workspace: 'ws' }),
  'GET /api/agent/status': () => ({ status: { state: 'idle', since: 1 }, messages: [{ id: 'm1', text: 'hi', kind: 'reply', ts: 1 }] }),
  'GET /api/workspaces': () => ({ current: 'ws', list: ['ws', 'other'] }),
  'GET /api/channels': () => [],
  'GET /api/sources': () => [],
  'GET /api/events': () => ({ events: [], next: 0 }),
});

function setup(routes: Record<string, Handler> = {}, opts: Partial<Parameters<typeof createDebugStore>[0]> = {}) {
  const runtime = new FakeRuntime();
  const net = new FakeNet();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = createApi('http://srv:1', fakeFetch({ ...baseRoutes(), ...routes }, calls));
  const toasts: Array<[string, string | undefined]> = [];
  const { store, actions } = createDebugStore({
    runtime, net: net as unknown as StoreNet, api, eventsWaitMs: 0, toast: (t, k) => toasts.push([t, k]), ...opts,
  });
  return { runtime, net, api, calls, toasts, store, actions };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('buildTree', () => {
  it('nests children in table order, orphans and cycles become roots', () => {
    const t = buildTree({
      a: ent('a'), b: ent('b', 'a'), c: ent('c', 'b'), d: ent('d', 'gone'), x: ent('x', 'y'), y: ent('y', 'x'),
    });
    expect(t.map((n) => n.id)).toEqual(['a', 'd', 'x']);
    expect(t[0].children[0].id).toBe('b');
    expect(t[0].children[0].children[0]).toMatchObject({ id: 'c', depth: 2 });
    expect(t[2].children.map((n) => n.id)).toEqual(['y']);
  });
});

describe('debug store', () => {
  let ctx: ReturnType<typeof setup>;
  afterEach(() => ctx?.store.dispose());

  it('mirrors the runtime scene (shallow copy per change) and the tree', async () => {
    ctx = setup();
    const first = ctx.store.scene.value;
    ctx.runtime.setEntities([ent('a'), ent('b', 'a')]);
    expect(ctx.store.scene.value).toBe(first); // coalesced to a microtask
    await flush();
    expect(ctx.store.scene.value).not.toBe(first);
    expect(Object.keys(ctx.store.scene.value.entities)).toEqual(['a', 'b']);
    expect(ctx.store.tree.value[0].children[0].id).toBe('b');
  });

  it('syncs the selection both ways', async () => {
    ctx = setup();
    ctx.runtime.setEntities([ent('a'), ent('b')]);
    await flush();
    ctx.runtime.select('b'); // e.g. Ctrl+click in the 3D view
    expect(ctx.store.selection.value).toBe('b');
    expect(ctx.store.selectedEntity.value?.id).toBe('b');
    ctx.actions.select('a'); // e.g. tree click
    expect(ctx.runtime.selected).toBe('a');
    expect(ctx.store.selection.value).toBe('a');
    ctx.actions.select('nope'); // unknown → cleared, signal stays truthful
    expect(ctx.runtime.selected).toBeNull();
    expect(ctx.store.selection.value).toBeNull();
  });

  it('loads health / agent / workspaces at start and derives the headset indicator', async () => {
    ctx = setup();
    await vi.waitFor(() => expect(ctx.store.health.value).not.toBeNull());
    expect(ctx.store.headset.value).toMatchObject({ connected: true, primaryId: 'c-x', xrClients: 1 });
    await vi.waitFor(() => expect(ctx.store.agentMessages.value.map((m) => m.id)).toEqual(['m1']));
    ctx.net.emit({ type: 'agent.message', message: { id: 'm1', text: 'hi', kind: 'reply', ts: 1 } }); // replay → deduped
    ctx.net.emit({ type: 'agent.message', message: { id: 'm2', text: 'yo', kind: 'info', ts: 2 } });
    expect(ctx.store.agentMessages.value.map((m) => m.id)).toEqual(['m1', 'm2']);
    ctx.net.emit({ type: 'agent.status', status: { state: 'working', detail: 'Bash', since: 3 } });
    expect(ctx.store.agentStatus.value?.state).toBe('working');
    await vi.waitFor(() => expect(ctx.store.workspaces.value?.list).toEqual(['ws', 'other']));
  });

  it('long-polls events into a bounded ring buffer and turns client.error into entity badges', async () => {
    let seq = 0;
    const ev = (type: ServerEvent['type'], data: Record<string, unknown> = {}): ServerEvent => ({ seq: ++seq, ts: Date.now(), type, data });
    const pages = [
      { events: [ev('client.connect'), ev('client.error', { entity: 'a', message: 'boom' })], next: 2 },
      { events: [ev('widget.build'), ev('scene.changed')], next: 4 },
    ];
    const seen: string[] = [];
    ctx = setup({
      'GET /api/events': (_b, url) => { seen.push(url.search); return pages.shift() ?? { events: [], next: seq }; },
    }, { maxEvents: 3 });
    ctx.runtime.setEntities([ent('a')]);
    const poll = (ctx.store as unknown as { pollEventsOnce(w: number): Promise<void> }).pollEventsOnce;
    await poll(0);
    await poll(0);
    expect(seen[0]).toBe('?limit=500'); // first page: the most recent events
    expect(seen[1]).toBe('?since=2');
    expect(ctx.store.events.value.map((e) => e.seq)).toEqual([2, 3, 4]);
    await flush();
    expect(ctx.store.entityErrors.value.a).toMatchObject({ message: 'boom', source: 'event' });
    ctx.store.clearErrors();
    expect(ctx.store.entityErrors.value.a).toBeUndefined();
  });

  it('merges runtime widget failures and build errors into entityErrors', async () => {
    vi.useFakeTimers();
    try {
      ctx = setup({}, { intervals: { widgetStatus: 100 } });
      ctx.runtime.setEntities([ent('a'), ent('b', null, { widget: 'broken' })]);
      ctx.runtime.records = [{ entityId: 'a', status: 'error', error: 'box.create() threw: x' }];
      ctx.net.emit({ type: 'widgets.catalog', widgets: [{ id: 'broken', error: 'SyntaxError' } as WidgetManifest] });
      await vi.advanceTimersByTimeAsync(150);
      expect(ctx.store.entityErrors.value.a).toMatchObject({ source: 'runtime', message: 'box.create() threw: x' });
      expect(ctx.store.entityErrors.value.b?.source).toBe('build');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reference-counts polling needs', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      ctx = setup({ 'GET /api/channels': () => { n++; return [{ name: 'x', kind: 'json', size: 1, updatedAt: 0, seq: 1 }]; } }, { intervals: { channels: 1000 } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(n).toBe(0); // nobody needs channels
      const r1 = ctx.store.need('channels');
      const r2 = ctx.store.need('channels');
      await vi.advanceTimersByTimeAsync(3050);
      expect(n).toBe(4); // immediate + 3 ticks, one poller for two needs
      expect(ctx.store.channels.value[0].name).toBe('x');
      r1();
      r1(); // double release is a no-op
      await vi.advanceTimersByTimeAsync(2000);
      expect(n).toBe(6);
      r2();
      await vi.advanceTimersByTimeAsync(5000);
      expect(n).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the headset pose from server pushes (user-pose capability)', () => {
    ctx = setup();
    const pose: UserPose = { t: 1, mode: 'vr', head: { position: [1, 2, 3], rotation: [0, 0, 0, 1] }, hands: {} };
    ctx.net.emit({ type: 'user.pose', pose });
    expect(ctx.store.userPose.value?.head.position).toEqual([1, 2, 3]);
    ctx.net.emit({ type: 'user.pose', pose: null });
    expect(ctx.store.userPose.value).toBeNull();
  });

  it('converts GET /api/user?raw=1 into a UserPose (fallback)', () => {
    const joints = new Array(175).fill(0.5);
    const p = userPoseFromSummary({
      t: 5, ageMs: 10, mode: 'ar', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, focus: {}, gaze: null, selected: 'e-1',
      hands: { left: { tracked: true, poses: [], joints }, right: { tracked: false, poses: [] } },
    });
    expect(p).toMatchObject({ t: 5, mode: 'ar', selected: 'e-1' });
    expect(p!.hands.left!.joints).toHaveLength(175);
    expect(p!.hands.right).toBeUndefined();
    expect(userPoseFromSummary(null)).toBeNull();
  });
});

describe('debug actions', () => {
  let ctx: ReturnType<typeof setup>;
  afterEach(() => ctx?.store.dispose());

  it('edits go to POST /api/scene/ops as source user with an undo group', async () => {
    ctx = setup({ 'POST /api/scene/ops': () => ({ version: 2, ids: [] }) });
    await ctx.actions.setProps('a', { size: 0.4 }, { group: 'g1' });
    await ctx.actions.update('a', { visible: false });
    const posts = ctx.calls.filter((c) => c.path === '/api/scene/ops');
    expect(posts[0].body).toEqual({ ops: [{ op: 'update', id: 'a', patch: { props: { size: 0.4 } } }], source: 'user', group: 'g1' });
    expect((posts[1].body as { group: string }).group).toMatch(/^dbg-/);
    expect((posts[1].body as { group: string }).group).not.toBe('g1');
  });

  it('toasts failures and warnings', async () => {
    ctx = setup({
      'POST /api/scene/ops': (b) => ((b as { ops: Array<{ op: string }> }).ops[0].op === 'remove'
        ? new Response(JSON.stringify({ error: 'unknown entity', opIndex: 0 }), { status: 400 })
        : { version: 2, ids: [], warnings: ['unknown prop foo'] }),
    });
    expect(await ctx.actions.remove('zz')).toBeNull();
    await ctx.actions.setProps('a', { foo: 1 });
    expect(ctx.toasts.map(([, k]) => k)).toEqual(['error', 'warn']);
    expect(ctx.toasts[0][0]).toContain('unknown entity');
  });

  it('undo/redo report nothing-to-do; spawn places in front of the camera and selects', async () => {
    ctx = setup({
      'POST /api/scene/undo': () => ({ version: 3, ok: false }),
      'POST /api/scene/ops': () => ({ version: 4, ids: ['e-new'] }),
    }, { camera: { frame: () => true, spawnTransform: (d = 1.2) => ({ position: [0, 1.5, -d], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }) } });
    expect(await ctx.actions.undo()).toBe(false);
    expect(ctx.toasts.at(-1)?.[0]).toBe('Nothing to undo');
    const p = ctx.actions.spawn('box', { size: 0.2 }, { name: 'n' });
    setTimeout(() => ctx.runtime.setEntities([ent('e-new')]), 20); // the patch arrives later
    expect(await p).toBe('e-new');
    const add = ctx.calls.find((c) => c.path === '/api/scene/ops')!.body as { ops: Array<{ entity: Partial<Entity> }> };
    expect(add.ops[0].entity).toMatchObject({ widget: 'box', name: 'n', props: { size: 0.2 }, transform: { position: [0, 1.5, -1.2] } });
    expect(ctx.runtime.selected).toBe('e-new');
  });

  it('duplicate runs the server command and selects the copy', async () => {
    ctx = setup({ 'POST /api/command': (b) => ({ ok: true, result: { entity: `${(b as { args: { entity: string } }).args.entity}-2` } }) });
    ctx.runtime.setEntities([ent('a'), ent('a-2')]);
    expect(await ctx.actions.duplicate('a')).toBe('a-2');
    expect(ctx.calls.find((c) => c.path === '/api/command')!.body).toEqual({ name: 'duplicate', args: { entity: 'a' } });
    expect(ctx.runtime.selected).toBe('a-2');
  });
});

describe('debug api', () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  beforeEach(() => { calls.length = 0; });

  it('builds query strings and bodies per endpoint', async () => {
    const api = createApi('http://h:2/', fakeFetch({
      'GET /api/events': () => ({ events: [], next: 9 }),
      'POST /api/workspaces/my%20ws/save': () => ({ current: 'my ws' }),
      'POST /api/voice/simulate': () => ({ route: 'agent' }),
      'GET /api/user': () => null,
    }, calls));
    await api.events({ since: 3, wait: 1000, types: ['client.error', 'widget.build'] });
    await api.saveWorkspace('my ws');
    await api.simulateVoice('undo');
    expect(await api.user(true)).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/events?since=3&wait=1000&types=client.error%2Cwidget.build',
      'POST /api/workspaces/my%20ws/save',
      'POST /api/voice/simulate',
      'GET /api/user?raw=1',
    ]);
    expect(calls[2].body).toEqual({ text: 'undo' });
  });

  it('throws ApiError with the server message', async () => {
    const api = createApi('http://h:2', fakeFetch({ 'POST /api/scene/ops': () => new Response(JSON.stringify({ error: 'bad op', opIndex: 1 }), { status: 400 }) }, calls));
    const err = await api.ops([{ op: 'remove', id: 'x' }]).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('bad op');
    expect(err.body).toEqual({ error: 'bad op', opIndex: 1 });
  });

  it('decodes tensor channels and encodes tensor publishes', async () => {
    const t = makeTensor('f32', [2], new Float32Array([1, 2]));
    const { encodeTensorFrame } = await import('@evolspace/protocol');
    let put: RequestInit | undefined;
    const api = createApi('http://h:2', fakeFetch({
      'GET /api/channels/t': () => new Response(encodeTensorFrame({ channel: 't' }, t) as unknown as BodyInit, { headers: { 'Content-Type': 'application/x-evol-tensor' } }),
      'GET /api/channels/j': () => ({ a: 1 }),
      'PUT /api/channels/t': (_b, _u, init) => { put = init; return { name: 't', kind: 'tensor', size: 8, updatedAt: 0, seq: 1 }; },
    }, calls));
    const v = await api.channel('t') as { $tensor: true; data: Float32Array; shape: number[] };
    expect(v.$tensor).toBe(true);
    expect([...v.data]).toEqual([1, 2]);
    expect(await api.channel('j')).toEqual({ a: 1 });
    await api.publish('t', t, { producer: 'debug' });
    expect((put!.headers as Record<string, string>)['Content-Type']).toBe('application/x-evol-tensor');
    expect((put!.headers as Record<string, string>)['X-Producer']).toBe('debug');
  });
});
