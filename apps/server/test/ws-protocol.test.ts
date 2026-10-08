import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { HandFrame, UserPose } from '@evolspace/protocol';
import { encodeAudioFrame } from '@evolspace/protocol';
import { startTestServer, TestClient, api, until, writeFiles, makeLibrary, type TestServer } from './helpers.ts';

const joints = (x: number): number[] => Array.from({ length: 25 }, (_, i) => [x, 1 + i * 0.01, -0.3, 0, 0, 0, 1]).flat();
const hand = (h: 'left' | 'right'): HandFrame => ({ hand: h, joints: joints(h === 'left' ? -0.2 : 0.2), radii: new Array(25).fill(0.01) });

describe('WS protocol end-to-end', () => {
  let srv: TestServer;
  const audio: Array<{ clientId: string; utteranceId: string; samples: number }> = [];
  const voiceMsgs: string[] = [];

  beforeAll(async () => {
    const lib = makeLibrary();
    writeFiles(lib, {
      'poses/pinch.json': JSON.stringify({ id: 'pinch', description: 'pinch', hand: 'either', conditions: [{ feature: 'pinch.index', max: 0.02 }], source: 'builtin' }),
      'poses/bad.json': JSON.stringify({ hand: 'up', conditions: [] }),
      'interactions/default.json': JSON.stringify({ description: 'std', scope: 'entity-default', bindings: [{ id: 'grab', pose: 'pinch', target: 'near', action: { type: 'grab' } }] }),
      'prefabs/pair.json': JSON.stringify({ description: 'two boxes', entities: [{ id: 'a', widget: 'box' }, { id: 'b', widget: 'box', parent: 'a', transform: { position: [0, 0.3, 0] } }], links: [{ from: { kind: 'port', entity: 'a', port: 'changed' }, to: { kind: 'port', entity: 'b', port: 'value' } }] }),
    });
    srv = await startTestServer({
      lib,
      overrides: {
        createVoice: (deps) => ({
          onBegin: (_c, m) => voiceMsgs.push(`begin:${m.utteranceId}`),
          onAudio: (clientId, utteranceId, pcm) => audio.push({ clientId, utteranceId, samples: pcm.length }),
          onEnd: (_c, m) => voiceMsgs.push(`end:${m.utteranceId}`),
          simulate: async (text) => { await deps.runCommand('undo', undefined, {}); return { route: 'fastpath' as const, command: `undo(${text})` }; },
          commands: () => [{ id: 'undo', patterns: ['^undo$'], command: 'undo' }],
          close: async () => {},
        }),
        loadInput: async () => ({
          computeFeatures: (f: HandFrame) => ({ 'curl.index': f.hand === 'left' ? 0.12345 : 0.9, 'pinch.index': 0.0101 }),
          derivePose: (samples, opts) => ({ id: opts.id, description: opts.description ?? '', hand: opts.hand, source: 'recorded' as const, conditions: [{ feature: 'curl.index', min: Math.min(...samples.map((s) => s['curl.index'])) - 0.1 }] }),
        }),
      },
    });
  });
  afterAll(async () => { await srv?.close(); });

  it('hello → snapshot, catalog, gesture defs, agent state', async () => {
    const c = new TestClient(srv.wsUrl);
    await new Promise((r) => c.ws.once('open', r));
    const snap = c.next('scene.snapshot');
    const cat = c.next('widgets.catalog');
    const defs = c.next('gestures.defs');
    const hello = c.next('hello');
    c.send({ type: 'hello', role: 'desktop', userAgent: 'vitest' });
    expect((await hello).primary).toBe(false);
    expect((await snap).scene.workspace).toBe('default');
    expect((await cat).widgets.map((w) => w.id)).toEqual(['box']);
    const d = await defs;
    expect(d.poses.map((p) => p.id)).toEqual(['pinch']); // bad.json skipped
    expect(Object.keys(d.interactions)).toEqual(['default']);
    expect(c.of('agent.status')).toHaveLength(1);
    const g = (await api(srv.url, 'GET', '/api/gestures')).body as { errors: Record<string, string> };
    expect(g.errors['poses/bad.json']).toMatch(/hand/);
    await c.close();
  });

  it('primary election: most recent xr wins; promotion on disconnect', async () => {
    const x1 = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    expect(x1.of('hello').at(-1)!.primary).toBe(true);
    const demoted = x1.next('hello', (m) => m.primary === false);
    const x2 = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    expect(x2.of('hello').at(-1)!.primary).toBe(true);
    await demoted;
    const shy = await TestClient.connect(srv.wsUrl, { role: 'xr', wantPrimary: false });
    expect(shy.of('hello').at(-1)!.primary).toBe(false);
    const health = (await api(srv.url, 'GET', '/api/health')).body as { clients: Array<{ role: string; primary: boolean }> };
    expect(health.clients.filter((c) => c.primary)).toHaveLength(1);

    const promoted = x1.next('hello', (m) => m.primary === true);
    await x2.close();
    await promoted;
    await x1.close();
    // Only the shy one left: it gets promoted as a last resort.
    await shy.next('hello', (m) => m.primary === true);
    await shy.close();
  });

  it('scene ops from clients and HTTP are validated, normalized and broadcast', async () => {
    const a = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const b = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    const patch = b.next('scene.patch');
    const r = await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { widget: 'box', name: 'cube', props: { size: 0.4 } } }] });
    expect(r.status).toBe(200);
    const id = (r.body as { ids: string[] }).ids[0];
    const p = await patch;
    expect(p.source).toBe('agent');
    expect(p.ops[0]).toMatchObject({ op: 'add', entity: { id, props: { size: 0.4, color: '#44aaff' } } });

    // user op from a client (grab group)
    const moved = b.next('scene.patch', (m) => m.source === 'user');
    a.send({ type: 'scene.ops', source: 'user', group: 'g1', ops: [{ op: 'update', id, patch: { transform: { position: [1, 1, 1] } } }] });
    await moved;
    expect((await api(srv.url, 'GET', '/api/scene')).body.entities[id].transform.position).toEqual([1, 1, 1]);

    // invalid client op → resync snapshot to that client + client.log event
    const resync = a.next('scene.snapshot');
    a.send({ type: 'scene.ops', source: 'user', ops: [{ op: 'update', id: 'ghost', patch: {} }] });
    await resync;

    // invalid HTTP op → 400 with message
    const bad = await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { widget: 'box' } }, { op: 'add', entity: { widget: 'nope' } }] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ opIndex: 1 });
    expect((bad.body as { error: string }).error).toMatch(/unknown widget 'nope'/);

    // undo via WS and via HTTP
    const undone = b.next('scene.patch', (m) => m.source === 'undo');
    a.send({ type: 'scene.undo' });
    await undone;
    expect((await api(srv.url, 'GET', '/api/scene')).body.entities[id].transform.position).toEqual([0, 0, 0]);
    await api(srv.url, 'POST', '/api/scene/redo');
    expect((await api(srv.url, 'GET', '/api/scene')).body.entities[id].transform.position).toEqual([1, 1, 1]);

    // summary
    const sum = (await api(srv.url, 'GET', '/api/scene/summary')).body as { roots: Array<{ id: string; name: string }> };
    expect(sum.roots.find((n) => n.id === id)?.name).toBe('cube');
    await a.close(); await b.close();
  });

  it('commands: registry over HTTP and WS, broadcast to xr, errors', async () => {
    const x = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const add = await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { widget: 'box', name: 'dup me' } }] });
    const id = (add.body as { ids: string[] }).ids[0];
    const dup = await api(srv.url, 'POST', '/api/command', { name: 'duplicate', args: { entity: id } });
    expect(dup.body).toMatchObject({ ok: true, result: { entity: `${id}-2` } });
    const del = await api(srv.url, 'POST', '/api/command', { name: 'delete', args: { entity: `${id}-2` } });
    expect(del.status).toBe(200);
    const unknown = await api(srv.url, 'POST', '/api/command', { name: 'frobnicate' });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: string }).error).toMatch(/unknown command 'frobnicate' \(available: .*undo/);

    const cmd = x.next('command', (m) => m.name === 'session.mode');
    await api(srv.url, 'POST', '/api/command', { name: 'broadcast', args: { name: 'session.mode', args: { mode: 'ar' } } });
    expect((await cmd).args).toEqual({ mode: 'ar' });

    // WS command
    const patch = x.next('scene.patch', (m) => m.ops.some((o) => o.op === 'remove' && o.id === id));
    x.send({ type: 'command', name: 'delete', args: { entity: id } });
    await patch;
    // Failing WS command → error message to that client
    const err = x.next('agent.message', (m) => m.message.kind === 'error');
    x.send({ type: 'command', name: 'delete', args: { entity: 'ghost' } });
    expect((await err).message.text).toMatch(/ghost/);
    await x.close();
  });

  it('agent status/say broadcast and recent messages on connect', async () => {
    const c = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    const st = c.next('agent.status', (m) => m.status.state === 'working');
    await api(srv.url, 'POST', '/api/agent/status', { state: 'working', detail: 'Running Bash' });
    expect((await st).status.detail).toBe('Running Bash');
    const msg = c.next('agent.message');
    const said = await api(srv.url, 'POST', '/api/agent/say', { text: 'Done!' });
    expect((await msg).message).toMatchObject({ id: (said.body as { id: string }).id, text: 'Done!', kind: 'reply' });
    expect((await api(srv.url, 'POST', '/api/agent/status', { state: 'bogus' })).status).toBe(400);
    const late = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    await until(() => late.of('agent.message').some((m) => m.message.text === 'Done!'));
    expect(late.of('agent.status').at(-1)!.status.state).toBe('working');
    await c.close(); await late.close();
  });

  it('user pose from the primary only, summarized with features and active poses', async () => {
    expect((await api(srv.url, 'GET', '/api/user')).body).toBeNull();
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const other = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    const pose: UserPose = { t: 1, mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: { left: hand('left') }, gaze: null, selected: 'e-1' };
    other.send({ type: 'user.pose', pose: { ...pose, mode: 'ar' } }); // ignored (not primary)
    xr.send({ type: 'user.pose', pose });
    xr.send({ type: 'pose.event', event: { pose: 'pinch', hand: 'left', phase: 'start', t: 1 } });
    await until(async () => (await api(srv.url, 'GET', '/api/user')).body !== null);
    await new Promise((r) => setTimeout(r, 50));
    const u = (await api(srv.url, 'GET', '/api/user')).body as Record<string, any>;
    expect(u.mode).toBe('vr');
    expect(u.selected).toBe('e-1');
    expect(u.hands.left).toMatchObject({ tracked: true, poses: ['pinch'], features: { 'curl.index': 0.123 } });
    expect(u.hands.left.wrist.position).toEqual([-0.2, 1, -0.3]);
    expect(u.hands.left.joints).toBeUndefined();
    expect(u.hands.right).toMatchObject({ tracked: false });
    const raw = (await api(srv.url, 'GET', '/api/user?raw=1')).body as Record<string, any>;
    expect(raw.hands.left.joints).toHaveLength(175);
    const evs = (await api(srv.url, 'GET', '/api/events?since=0&types=pose.event')).body as { events: Array<{ data: { pose: string } }> };
    expect(evs.events.at(-1)!.data.pose).toBe('pinch');
    await xr.close(); await other.close();
    await until(async () => (await api(srv.url, 'GET', '/api/user')).body === null);
  });

  it('pose recording round-trip writes library/poses/<name>.json', async () => {
    expect((await api(srv.url, 'POST', '/api/gestures/record', { name: 'wave', hand: 'right' })).status).toBe(409); // no headset
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    const req = xr.next('pose.record');
    const pending = api(srv.url, 'POST', '/api/gestures/record', { name: 'thumbs-up', hand: 'right', seconds: 1, countdown: 0, description: 'like' });
    const r = await req;
    expect(r).toMatchObject({ name: 'thumbs-up', hand: 'right', seconds: 1, countdown: 0 });
    xr.send({ type: 'pose.recording', requestId: r.requestId, name: 'thumbs-up', hand: 'right', frames: [{ 'curl.index': 0.8 }, { 'curl.index': 0.9 }] });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'thumbs-up', source: 'recorded', description: 'like' });
    const file = path.join(srv.lib, 'poses', 'thumbs-up.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).conditions[0].min).toBeCloseTo(0.7);
    await xr.close();
  });

  it('routes voice messages and audio frames to the voice service', async () => {
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    xr.send({ type: 'voice.begin', utteranceId: 'u1', sampleRate: 16000, context: {} });
    xr.ws.send(encodeAudioFrame('u1', new Int16Array(160)));
    xr.send({ type: 'voice.end', utteranceId: 'u1' });
    await until(() => voiceMsgs.includes('end:u1'));
    expect(voiceMsgs).toContain('begin:u1');
    expect(audio[0]).toMatchObject({ utteranceId: 'u1', samples: 160 });
    expect((await api(srv.url, 'GET', '/api/voice/commands')).body).toHaveLength(1);
    expect((await api(srv.url, 'POST', '/api/voice/simulate', { text: 'undo' })).body).toMatchObject({ route: 'fastpath' });
    await xr.close();
  });

  it('prefab instantiate, widget endpoints, screenshot', async () => {
    const r = await api(srv.url, 'POST', '/api/prefabs/pair/instantiate', { transform: { position: [0, 1, -1] } });
    expect(r.status).toBe(200);
    const ids = (r.body as { ids: Record<string, string> }).ids;
    const scene = (await api(srv.url, 'GET', '/api/scene')).body;
    expect(scene.entities[ids.b].parent).toBe(ids.a);
    expect(scene.entities[ids.a].transform.position).toEqual([0, 1, -1]);
    expect((await api(srv.url, 'POST', '/api/prefabs/nope/instantiate', {})).status).toBe(400);

    const w = (await api(srv.url, 'GET', '/api/widgets/box')).body as { source: string; url: string; hash: string };
    expect(w.source).toContain('A test box.');
    const js = await fetch(srv.url + w.url);
    expect(js.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(js.headers.get('cache-control')).toBe('no-cache');
    expect(await js.text()).toContain('A test box.');
    expect((await api(srv.url, 'POST', '/api/widgets/box/build')).body).toMatchObject({ ok: true });
    expect((await api(srv.url, 'GET', '/api/widgets/nope')).status).toBe(404);

    const shot = await fetch(srv.url + '/api/screenshot', { method: 'POST', body: JSON.stringify({ view: { kind: 'entity', entity: ids.a } }) });
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'user' } })).status).toBe(409);
    expect((await api(srv.url, 'GET', '/api/nope')).status).toBe(404);
  });
});

describe('workspaces persistence', () => {
  it('saves debounced + atomically, reloads the last workspace on boot', async () => {
    const lib = makeLibrary();
    const { tempDir, rmDir } = await import('./helpers.ts');
    const data = tempDir('evol-ws-');
    const s1 = await startTestServer({ lib, data });
    await api(s1.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { id: 'keep', widget: 'box' } }] });
    const file = path.join(data, 'workspaces', 'default.json');
    await until(() => existsSync(file));
    expect(JSON.parse(readFileSync(file, 'utf8')).entities.keep.widget).toBe('box');

    expect((await api(s1.url, 'POST', '/api/workspaces/lab/new')).status).toBe(200);
    await api(s1.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { id: 'lab-thing', widget: 'box' } }] });
    const list = (await api(s1.url, 'GET', '/api/workspaces')).body;
    expect(list).toEqual({ current: 'lab', list: ['default', 'lab'] });
    expect((await api(s1.url, 'POST', '/api/workspaces/bad name!/save')).status).toBe(400);
    expect((await api(s1.url, 'POST', '/api/workspaces/ghost/load')).status).toBe(404);
    await s1.app.stop(); // flushes pending save

    const s2 = await startTestServer({ lib, data });
    const scene = (await api(s2.url, 'GET', '/api/scene')).body;
    expect(scene.workspace).toBe('lab');
    expect(Object.keys(scene.entities)).toEqual(['lab-thing']);
    const c = await TestClient.connect(s2.wsUrl, { role: 'desktop' });
    const snap = c.next('scene.snapshot', (m) => m.scene.workspace === 'default');
    await api(s2.url, 'POST', '/api/workspaces/default/load');
    expect(Object.keys((await snap).scene.entities)).toEqual(['keep']);
    await c.close();
    await s2.app.stop();
    rmDir(lib); rmDir(data);
  });
});
