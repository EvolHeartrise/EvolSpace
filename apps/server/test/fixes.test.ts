// Regression tests for the server integration fixes: exact undo, no empty undo
// steps, save-as resync, channel.publish/ping commands, voice wiring
// (agentStatus, onDisconnect), gesture-file lint warnings and mirror error mapping.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Entity, SceneOp, SceneState } from '@evolspace/protocol';
import { encodeTensorFrame, decodeTensorFrame, makeTensor } from '@evolspace/protocol';
import { SceneStore, SceneError, sameJson } from '../src/scene/store.ts';
import { GestureLibrary } from '../src/gestures/library.ts';
import { silentLogger } from '../src/log.ts';
import { createVoice } from '../src/voice/index.ts';
import type { VoiceDeps, VoiceService } from '../src/voice/types.ts';
import { ScreenshotRequestError } from '../src/mirror/index.ts';
import { TimeoutError } from '../src/mirror/queue.ts';
import { mirrorHttpStatus } from '../src/routes/mirror-errors.ts';
import { api, makeLibrary, startTestServer, staticCatalog, TestClient, until, writeFiles, type TestServer } from './helpers.ts';

const catalog = staticCatalog([
  {
    id: 'box',
    props: { size: { type: 'number', default: 0.2, min: 0 }, color: { type: 'color', default: '#fff' }, mode: { type: 'enum', options: ['a', 'b'], default: 'a' } },
    inputs: { value: { type: 'number' } },
  },
  { id: 'slider', props: { value: { type: 'number', default: 0.5 }, label: { type: 'string', default: 'x' } } },
]);

const ent = (id: string, widget: string, props: Record<string, unknown>): Entity => ({
  id, parent: null, widget, props, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true,
});

describe('SceneStore: exact undo', () => {
  let store: SceneStore;
  let resyncs: SceneState[];
  let patches: Array<{ ops: SceneOp[]; source: string }>;
  beforeEach(() => {
    resyncs = [];
    patches = [];
    store = new SceneStore({ catalog, onResync: (s) => resyncs.push(structuredClone(s)), onPatch: (_v, ops, source) => patches.push({ ops, source }) });
  });

  it('undo of a prop that did not exist deletes the key (and resyncs clients); redo puts it back', () => {
    store.apply([{ op: 'add', entity: { id: 'b', widget: 'box' } }], { source: 'agent' });
    const before = structuredClone(store.entity('b')!.props);
    const r = store.apply([{ op: 'update', id: 'b', patch: { props: { extra: 1, size: 0.5 } } }], { source: 'agent' });
    expect(r.warnings.join()).toMatch(/extra/);
    expect(store.undo().ok).toBe(true);
    expect(store.entity('b')!.props).toEqual(before);
    expect('extra' in store.entity('b')!.props).toBe(false);
    expect(resyncs).toHaveLength(1);
    expect('extra' in resyncs[0].entities.b.props).toBe(false);
    // The broadcast patch never carries the internal deletion marker.
    expect(JSON.stringify(patches.at(-1)!.ops)).not.toContain('$unsetProps');
    expect(patches.at(-1)!.ops).toEqual([{ op: 'update', id: 'b', patch: { props: { size: 0.2 } } }]);
    expect(store.redo().ok).toBe(true);
    expect(store.entity('b')!.props).toEqual({ ...before, extra: 1, size: 0.5 });
    expect(resyncs).toHaveLength(1); // redo is expressible as a patch
  });

  it('undo of a widget change restores the exact previous props (no defaults filled in)', () => {
    // A loaded entity that lacks some of its widget's defaults (old workspace file).
    store.reset({ entities: { e: ent('e', 'box', { size: 1, custom: 'keep' }) } }, 'w');
    const original = structuredClone(store.entity('e')!);
    store.apply([{ op: 'update', id: 'e', patch: { widget: 'slider', props: { value: 0.9 } } }], { source: 'user' });
    expect(store.entity('e')!.props).toEqual({ size: 1, custom: 'keep', value: 0.9, label: 'x' });
    expect(store.undo().ok).toBe(true);
    expect(store.entity('e')).toEqual(original);
    expect(store.redo().ok).toBe(true);
    expect(store.entity('e')!.widget).toBe('slider');
    expect(store.entity('e')!.props).toEqual({ size: 1, custom: 'keep', value: 0.9, label: 'x' });
    expect(store.undo().ok).toBe(true);
    expect(store.entity('e')).toEqual(original);
  });

  it('merged undo steps (same group) restore exactly too', () => {
    store.reset({ entities: { e: ent('e', 'box', { size: 1 }) } }, 'w');
    const original = structuredClone(store.entity('e')!);
    store.apply([{ op: 'update', id: 'e', patch: { props: { a: 1 } } }], { source: 'user', group: 'g' });
    store.apply([{ op: 'update', id: 'e', patch: { props: { a: 2, b: 3 } } }], { source: 'user', group: 'g' });
    store.apply([{ op: 'update', id: 'e', patch: { widget: 'slider' } }], { source: 'user', group: 'g' });
    expect(store.undo().ok).toBe(true);
    expect(store.entity('e')).toEqual(original);
    expect(store.canUndo).toBe(false);
  });

  it('a failing batch rolls a widget change back exactly', () => {
    store.reset({ entities: { e: ent('e', 'box', { size: 1 }) } }, 'w');
    const original = structuredClone(store.entity('e')!);
    expect(() => store.apply([
      { op: 'update', id: 'e', patch: { widget: 'slider', props: { fresh: true } } },
      { op: 'update', id: 'nope', patch: {} },
    ], { source: 'agent' })).toThrow(SceneError);
    expect(store.entity('e')).toEqual(original);
  });

  it('rejects the internal deletion marker from callers', () => {
    store.apply([{ op: 'add', entity: { id: 'b', widget: 'box' } }], { source: 'agent' });
    expect(() => store.apply([{ op: 'update', id: 'b', patch: { $unsetProps: ['size'] } as never }], { source: 'agent' })).toThrow(/unknown field '\$unsetProps'/);
    expect(store.entity('b')!.props.size).toBe(0.2);
  });

  it('save-as (setWorkspaceName) asks for a resync only when the name changes', () => {
    store.setWorkspaceName('default');
    expect(resyncs).toHaveLength(0);
    store.setWorkspaceName('other');
    expect(resyncs.map((s) => s.workspace)).toEqual(['other']);
  });
});

describe('SceneStore: no empty undo steps', () => {
  let store: SceneStore;
  beforeEach(() => { store = new SceneStore({ catalog }); });

  it('a batch that changes nothing creates no undo entry and keeps redo', () => {
    store.apply([{ op: 'add', entity: { id: 'b', widget: 'box', props: { size: 0.3 } } }], { source: 'agent' });
    store.apply([{ op: 'update', id: 'b', patch: { props: { size: 0.4 } } }], { source: 'agent' });
    expect(store.undo().ok).toBe(true); // size back to 0.3; redo available
    const v = store.version;
    const r = store.apply([
      { op: 'update', id: 'b', patch: { props: { size: 0.3 }, visible: true, transform: { position: [0, 0, 0] }, name: null, widget: 'box' } },
    ], { source: 'agent' });
    expect(r.version).toBe(v + 1); // still applied + broadcast
    expect(store.canRedo).toBe(true);
    expect(store.redo().ok).toBe(true);
    expect(store.entity('b')!.props.size).toBe(0.4);
    expect(store.undo().ok).toBe(true);
    expect(store.undo().ok).toBe(true); // the add
    expect(store.entity('b')).toBeUndefined();
    expect(store.undo().ok).toBe(false); // no empty step left behind
  });

  it('clear on an empty scene and no-op link updates are not undo steps', () => {
    store.apply([{ op: 'clear' }], { source: 'agent' });
    expect(store.canUndo).toBe(false);
    store.apply([
      { op: 'add', entity: { id: 'a', widget: 'box' } },
      { op: 'link.add', link: { id: 'l', from: { kind: 'channel', channel: 'x' }, to: { kind: 'port', entity: 'a', port: 'value' } } },
    ], { source: 'agent' });
    store.apply([{ op: 'link.update', id: 'l', patch: { enabled: true } }], { source: 'agent' });
    expect(store.undo().ok).toBe(true); // undoes the add batch, not an empty link step
    expect(store.entity('a')).toBeUndefined();
  });

  it('an interactive no-op does not extend or split the merge window', () => {
    let now = 1000;
    store = new SceneStore({ catalog, now: () => now });
    store.apply([{ op: 'add', entity: { id: 'b', widget: 'box' } }], { source: 'agent' });
    store.apply([{ op: 'update', id: 'b', patch: { props: { size: 1 } } }], { source: 'user' });
    now += 300;
    store.apply([{ op: 'update', id: 'b', patch: { props: { size: 1 } } }], { source: 'user' }); // no-op
    now += 300; // 600 ms after the real edit: outside the 400 ms window → separate step
    store.apply([{ op: 'update', id: 'b', patch: { props: { size: 2 } } }], { source: 'user' });
    store.undo();
    expect(store.entity('b')!.props.size).toBe(1);
    store.undo();
    expect(store.entity('b')!.props.size).toBe(0.2);
  });

  it('sameJson compares structurally', () => {
    expect(sameJson({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameJson([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

describe('protocol codec: relaxed tensor header', () => {
  it('encodeTensorFrame needs only the channel; dtype/shape come from the tensor', () => {
    const t = makeTensor('f32', [2], new Float32Array([1, 2]));
    const frame = encodeTensorFrame({ channel: 'a.b' }, t);
    const { header, tensor } = decodeTensorFrame(frame);
    expect(header).toMatchObject({ type: 'channel.value', channel: 'a.b', dtype: 'f32', shape: [2] });
    expect([...tensor.data]).toEqual([1, 2]);
    // Backward compatible: a full header still type-checks; the tensor wins.
    expect(decodeTensorFrame(encodeTensorFrame({ channel: 'a.b', dtype: 'u8', shape: [9], seq: 3 }, t)).header).toMatchObject({ dtype: 'f32', shape: [2], seq: 3 });
  });
});

describe('GestureLibrary lint warnings', () => {
  let lib: string;
  beforeEach(() => {
    lib = mkdtempSync(path.join(tmpdir(), 'evol-gest-'));
    writeFiles(lib, {
      'poses/pinch.json': JSON.stringify({ id: 'pinch', description: 'ok', hand: 'either', conditions: [{ feature: 'pinch.index', max: 0.02 }], source: 'manual' }),
      'poses/typo.json': JSON.stringify({ hand: 'right', conditions: [{ feature: 'pinch.idnex', max: 0.02 }] }),
      'interactions/set.json': JSON.stringify({ description: 's', scope: 'global', bindings: [
        { id: 'b1', pose: 'pinch', hand: 'rihgt', target: 'none', action: { type: 'command', command: 'undo' } },
        { id: 'b2', pose: 'ghost', target: 'none', action: { type: 'command', command: 'redo' } },
      ] }),
    });
  });

  it('reports unknown features and bad binding hands as warnings (files still load) and calls onLoad', async () => {
    const loads: number[] = [];
    const g = new GestureLibrary({
      libraryDir: lib, log: silentLogger, watch: false,
      onLoad: (d) => loads.push(Object.keys(d.warnings).length),
      validators: async () => (await import('@evolspace/input' as string)) as never,
    });
    await g.init();
    const d = g.current;
    expect(d.poses.map((p) => p.id).sort()).toEqual(['pinch', 'typo']);
    expect(Object.keys(d.interactions)).toEqual(['set']);
    expect(d.warnings['poses/typo.json']?.join('\n')).toMatch(/unknown feature "pinch\.idnex"/);
    expect(d.warnings['poses/pinch.json']).toBeUndefined();
    expect(d.warnings['interactions/set.json']?.join('\n')).toMatch(/hand must be/);
    // The dangling pose ref stays an `errors` entry and is not duplicated as a warning.
    expect(d.errors['interactions/set.json']).toMatch(/ghost/);
    expect(d.warnings['interactions/set.json']?.join('\n')).not.toMatch(/ghost/);
    expect(loads).toEqual([2]);
    await g.close();
    rmSync(lib, { recursive: true, force: true });
  });

  it('without validators (input package missing) there are simply no warnings', async () => {
    const g = new GestureLibrary({ libraryDir: lib, log: silentLogger, watch: false, validators: async () => { throw new Error('missing'); } });
    await g.init();
    expect(g.current.warnings).toEqual({});
    expect(g.current.poses).toHaveLength(2);
    await g.close();
    rmSync(lib, { recursive: true, force: true });
  });
});

describe('voice: drops a client\'s in-flight utterances on disconnect', () => {
  it('clears listening immediately and restores the agent status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'evol-voice-fix-'));
    writeFileSync(path.join(dir, 'commands.json'), '[]');
    const statuses: string[] = [];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let status = { state: 'working' as const, detail: 'Running Bash', since: 1 } as { state: string; detail?: string; since: number };
    const deps: VoiceDeps = {
      voiceDir: dir,
      runCommand: async () => ({}),
      agentAsk: () => {},
      say: () => {},
      setAgentStatus: (state, detail) => { statuses.push(state); status = { state, ...(detail ? { detail } : {}), since: 2 }; },
      agentStatus: () => status as never,
      send: () => {}, broadcast: () => {},
      event: (type, data) => { events.push({ type, data }); },
      vocabulary: () => [], log: () => {},
    };
    const v: VoiceService = createVoice(deps, { sttUrl: 'http://127.0.0.1:9', watch: false, staleMs: 60_000 });
    v.onBegin('c1', { type: 'voice.begin', utteranceId: 'u1', sampleRate: 16000, context: {} });
    v.onBegin('c2', { type: 'voice.begin', utteranceId: 'u2', sampleRate: 16000, context: {} });
    expect(statuses).toEqual(['listening']);
    v.onDisconnect!('c1');
    expect(events).toEqual([{ type: 'voice.utterance', data: { utteranceId: 'u1', clientId: 'c1', text: '', route: 'none', reason: 'disconnected' } }]);
    expect(statuses).toEqual(['listening']); // c2 still talking
    v.onDisconnect!('c2');
    expect(statuses).toEqual(['listening', 'working']); // Claude's status handed back, not idle
    expect(status).toMatchObject({ state: 'working', detail: 'Running Bash' });
    v.onEnd('c2', { type: 'voice.end', utteranceId: 'u2' }); // late end: ignored
    await v.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('mirror error mapping', () => {
  it('request errors are 400, timeouts 504, busy/closed 503, crashes 502', () => {
    expect(mirrorHttpStatus(new ScreenshotRequestError('invalid screenshot request: width'))).toBe(400);
    expect(mirrorHttpStatus(new Error('mirror: invalid background "nope" (use \'scene\', \'transparent\' or a CSS color)'))).toBe(400);
    expect(mirrorHttpStatus(new Error('mirror: unknown widget "x" (known: box)'))).toBe(400);
    expect(mirrorHttpStatus(new Error('mirror: unknown entity "e-1"'))).toBe(400);
    expect(mirrorHttpStatus(new Error('mirror: widget "box" failed: SyntaxError'))).toBe(400);
    expect(mirrorHttpStatus(new Error('mirror: widget "box" reported an error while rendering: boom'))).toBe(400);
    expect(mirrorHttpStatus(new TimeoutError('mirror: capture (entity) timed out after 20000 ms'))).toBe(504);
    expect(mirrorHttpStatus(new Error('mirror: page.waitForFunction: Timeout 20000ms exceeded.'))).toBe(504);
    expect(mirrorHttpStatus(new Error('mirror: busy (32 captures queued); try again shortly'))).toBe(503);
    expect(mirrorHttpStatus(new Error('mirror: closed'))).toBe(503);
    expect(mirrorHttpStatus(new Error('mirror: Target page, context or browser has been closed'))).toBe(502);
    expect(mirrorHttpStatus('weird')).toBe(502);
  });
});

describe('server integration (fixes)', () => {
  let srv: TestServer;
  let voiceDeps: VoiceDeps | null = null;
  const disconnected: string[] = [];
  let mirrorError: unknown = null;

  beforeAll(async () => {
    srv = await startTestServer({
      lib: makeLibrary({
        'poses/typo.json': JSON.stringify({ hand: 'right', conditions: [{ feature: 'curl.indx', min: 0.5 }] }),
      }),
      overrides: {
        createVoice: (deps) => {
          voiceDeps = deps;
          return {
            onBegin() {}, onAudio() {}, onEnd() {},
            onDisconnect: (id: string) => { disconnected.push(id); },
            simulate: async () => ({ route: 'none' as const }), commands: () => [], close: async () => {},
          };
        },
        startMirror: async () => ({
          screenshot: async () => { if (mirrorError) throw mirrorError; return Buffer.from('89504e470d0a1a0a', 'hex'); },
          thumbnail: async () => { if (mirrorError) throw mirrorError; return Buffer.from('89504e470d0a1a0a', 'hex'); },
          close: async () => {},
        }),
      },
    });
  });
  afterAll(async () => {
    await srv?.close();
    rmSync(srv.lib, { recursive: true, force: true, maxRetries: 5 });
  });

  it('gives voice the current agent status', async () => {
    expect((await api(srv.url, 'POST', '/api/agent/status', { state: 'thinking', detail: 'pondering' })).status).toBe(200);
    expect(voiceDeps!.agentStatus!()).toMatchObject({ state: 'thinking', detail: 'pondering' });
    await api(srv.url, 'POST', '/api/agent/status', { state: 'idle' });
    expect(voiceDeps!.agentStatus!().state).toBe('idle');
  });

  it('tells voice when a client disconnects', async () => {
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const id = xr.of('hello')[0]!.clientId;
    await xr.close();
    await until(() => disconnected.includes(id));
  });

  it('channel.publish command (HTTP and WS) drives channels; bad input is a 400', async () => {
    const r = await api(srv.url, 'POST', '/api/command', { name: 'channel.publish', args: { channel: 'interp.ctl.layer', value: 5 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, result: { channel: 'interp.ctl.layer' } });
    expect((await api(srv.url, 'GET', '/api/channels/interp.ctl.layer')).body).toBe(5);
    const info = (await api(srv.url, 'GET', '/api/channels')).body as Array<{ name: string; producer?: string }>;
    expect(info.find((c) => c.name === 'interp.ctl.layer')?.producer).toBe('command:http');

    const sub = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    sub.send({ type: 'channel.subscribe', channels: ['ui.mode'] });
    const got = sub.next('channel.value', (m) => m.channel === 'ui.mode' && m.value === 'ar');
    sub.send({ type: 'command', name: 'channel.publish', args: { channel: 'ui.mode', value: 'ar' } });
    await got;
    await sub.close();

    expect((await api(srv.url, 'POST', '/api/command', { name: 'channel.publish', args: { channel: 'bad name!', value: 1 } })).status).toBe(400);
    expect((await api(srv.url, 'POST', '/api/command', { name: 'channel.publish', args: { channel: 'ok.name' } })).status).toBe(400);
    expect((await api(srv.url, 'POST', '/api/command', { name: 'channel.publish', args: { value: 1 } })).status).toBe(400);
  });

  it('ping: HTTP returns {ok:true}; over WS the sender gets a pong command', async () => {
    expect((await api(srv.url, 'POST', '/api/command', { name: 'ping' })).body).toEqual({ ok: true, result: { ok: true } });
    const a = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const b = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    const pong = a.next('command', (m) => m.name === 'pong');
    a.send({ type: 'command', name: 'ping' });
    expect(await pong).toEqual({ type: 'command', name: 'pong' });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.of('command').some((m) => m.name === 'pong')).toBe(false);
    expect(a.of('agent.message')).toHaveLength(0); // no error reply
    await a.close();
    await b.close();
  });

  it('save-as broadcasts a snapshot with the new workspace name', async () => {
    const c = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const snap = c.next('scene.snapshot', (m) => m.scene.workspace === 'renamed-ws');
    expect((await api(srv.url, 'POST', '/api/workspaces/renamed-ws/save')).body).toEqual({ current: 'renamed-ws' });
    expect((await snap).scene.workspace).toBe('renamed-ws');
    // The workspace.save command (voice/WS) goes through the same path.
    const snap2 = c.next('scene.snapshot', (m) => m.scene.workspace === 'renamed-2');
    c.send({ type: 'command', name: 'workspace.save', args: { name: 'renamed-2' } });
    await snap2;
    // Saving under the current name changes nothing for clients.
    const count = c.of('scene.snapshot').length;
    await api(srv.url, 'POST', '/api/workspaces/renamed-2/save');
    await new Promise((r) => setTimeout(r, 100));
    expect(c.of('scene.snapshot')).toHaveLength(count);
    await c.close();
  });

  it('undo that deletes a created prop resyncs clients with a snapshot', async () => {
    await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { id: 'undo-me', widget: 'box' } }] });
    const ops = await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'update', id: 'undo-me', patch: { props: { secret: 1 } } }] });
    expect(ops.body.warnings?.join()).toMatch(/secret/);
    const c = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const snap = c.next('scene.snapshot', (m) => !!m.scene.entities['undo-me'] && !('secret' in m.scene.entities['undo-me'].props));
    const u = await api(srv.url, 'POST', '/api/scene/undo');
    expect(u.body).toMatchObject({ ok: true });
    await snap;
    expect('secret' in srv.app.services.store.entity('undo-me')!.props).toBe(false);
    await c.close();
  });

  it('records gestures.load events with lint warnings and serves them in GET /api/gestures', async () => {
    const g = (await api(srv.url, 'GET', '/api/gestures')).body as { warnings?: Record<string, string[]> };
    expect(g.warnings?.['poses/typo.json']?.join()).toMatch(/curl\.indx/);
    const ev = (await api(srv.url, 'GET', '/api/events?since=0&types=gestures.load')).body as { events: Array<{ data: { ok: boolean; warnings?: Record<string, string[]> } }> };
    expect(ev.events.length).toBeGreaterThan(0);
    expect(ev.events[0].data.ok).toBe(false);
    expect(Object.keys(ev.events[0].data.warnings ?? {})).toContain('poses/typo.json');
  });

  it('screenshot/thumbnail: request errors are 4xx, renderer trouble 5xx', async () => {
    const cam = { view: { kind: 'camera', position: [0, 1, 1] } };
    mirrorError = new Error('mirror: invalid background "nope" (use \'scene\', \'transparent\' or a CSS color)');
    const bad = await api(srv.url, 'POST', '/api/screenshot', { ...cam, background: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/invalid background/);
    mirrorError = new TimeoutError('mirror: capture (camera) timed out after 20000 ms');
    expect((await api(srv.url, 'POST', '/api/screenshot', cam)).status).toBe(504);
    mirrorError = new Error('mirror: busy (32 captures queued); try again shortly');
    expect((await api(srv.url, 'POST', '/api/screenshot', cam)).status).toBe(503);
    mirrorError = new Error('mirror: renderer died');
    expect((await api(srv.url, 'POST', '/api/screenshot', cam)).status).toBe(502);
    mirrorError = null;
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'widget', widget: 'no-such-widget' } })).status).toBe(404);
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'entity', entity: 'e-none' } })).status).toBe(404);
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'widget', widget: 'box' } })).status).toBe(200);

    mirrorError = new Error('mirror: widget "box" reported an error while rendering: boom');
    expect((await api(srv.url, 'POST', '/api/widgets/box/thumbnail', {})).status).toBe(400);
    mirrorError = new TimeoutError('mirror: startup timed out after 45000 ms');
    expect((await api(srv.url, 'POST', '/api/widgets/box/thumbnail', {})).status).toBe(504);
    mirrorError = new ScreenshotRequestError('invalid widget id "../x"');
    expect((await api(srv.url, 'POST', '/api/widgets/box/thumbnail', {})).status).toBe(400);
    mirrorError = null;
  });
});
