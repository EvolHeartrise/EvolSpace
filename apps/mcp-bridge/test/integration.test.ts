// Contract test against the REAL EvolSpace server (apps/server, in-process on a random
// port, temp library/data dirs, stub mirror, real voice router). The other suites use a
// fake HTTP server; this one catches drift between the bridge and the actual API:
// routes, payload shapes, event context fields, error bodies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVoice } from '../../server/src/voice/index.ts';
import { startTestServer, TestClient, type TestServer } from '../../server/test/helpers.ts';
import type { UserPose } from '@evolspace/protocol';
import { CHANNEL_METHOD } from '../src/server.ts';
import { PNG_1x1, until } from './fake-evol.ts';
import { connectBridge, textOf } from './helpers.ts';

type Bridge = Awaited<ReturnType<typeof connectBridge>>;

const POSE: UserPose = {
  t: 0,
  mode: 'vr',
  head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, // facing -Z
  hands: {},
  focus: {},
  gaze: null,
  selected: null,
};

describe('bridge ↔ real EvolSpace server', () => {
  let srv: TestServer;
  let b: Bridge;
  let xr: TestClient;
  const contents = () => b.notifications.filter((n) => n.method === CHANNEL_METHOD).map((n) => n.params as { content: string; meta: Record<string, string> });

  beforeAll(async () => {
    srv = await startTestServer({
      overrides: {
        startMirror: async () => ({
          screenshot: async () => Buffer.from(PNG_1x1),
          thumbnail: async () => Buffer.from(PNG_1x1),
          close: async () => {},
        }),
        createVoice: (deps) => createVoice(deps),
      },
    });
    b = await connectBridge({ evolUrl: srv.url, pump: { waitMs: 300, backoffInitialMs: 50, backoffMaxMs: 200 } });
    xr = await TestClient.connect(srv.wsUrl, { role: 'xr', wantPrimary: true });
    xr.send({ type: 'user.pose', pose: POSE });
    await until(() => b.bridge.pump!.stats.connected, 5000);
  }, 30_000);

  afterAll(async () => {
    await xr?.close();
    await b?.close();
    await srv?.close();
  });

  it('server_status sees the server and the headset', async () => {
    const { text, isError } = await b.callText('server_status');
    expect(isError).toBe(false);
    expect(text).toMatch(/server: up at .* \(vtest\)/);
    expect(text).toContain('xr*');
    expect(text).toContain('voice channel: connected');
  });

  it('widget catalog, info and forced build', async () => {
    await until(() => srv.app.services.widgets.list().some((w) => w.id === 'box' && !!w.hash), 15_000);
    expect((await b.callText('widgets')).text).toMatch(/^box — A test box\. \| props: size:number color:color mode:a\|b \| in: value:number \| out: changed:number/m);
    const info = await b.callText('widget_info', { id: 'box' });
    expect(info.text).toContain('size: number, default 0.2');
    expect(info.text).toMatch(/build: ok \(hash /);
    const missing = await b.callText('widget_info', { id: 'boks' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('Did you mean box');
    expect((await b.callText('widget_build', { id: 'box' })).text).toMatch(/^build ok: box/);
  }, 30_000);

  it('spawn → scene → update → link → unlink → undo/redo → remove', async () => {
    // No position: placed in front of the user (head at z=0 facing -Z → negative z), facing them.
    const spawned = await b.callText('spawn', { widget: 'box', name: 'cube', props: { size: 0.3, bogus: 1 } });
    expect(spawned.isError).toBe(false);
    expect(spawned.text).toContain('(in front of the user)');
    expect(spawned.text).toMatch(/warning: .*bogus/); // server-side prop validation is surfaced
    const id = /spawned (\S+)/.exec(spawned.text)![1]!;
    const e = srv.app.services.store.scene.entities[id]!;
    expect(e.name).toBe('cube');
    expect(e.transform.position[2]).toBeLessThan(-0.5);

    const scene = await b.callText('scene');
    expect(scene.text).toContain(`${id} "cube" box @(`);

    expect((await b.callText('update', { id, props: { color: '#ff0000' }, position: [0, 1, -1] })).text).toMatch(/^updated/);
    expect(srv.app.services.store.scene.entities[id]!.props).toMatchObject({ size: 0.3, color: '#ff0000' });
    expect(srv.app.services.store.scene.entities[id]!.transform.position).toEqual([0, 1, -1]);

    const linked = await b.callText('link', { from: `${id}.changed`, to: '#test.out' });
    expect(linked.isError).toBe(false);
    const badPort = await b.callText('link', { from: `${id}.nope`, to: '#test.out' });
    expect(badPort.text).toContain('Available outputs: changed:number');
    // The server summary spells channels "channel:x"; the tool shows "#x".
    expect((await b.callText('scene', { entity: id })).text).toContain(`${id}.changed → #test.out`);
    expect((await b.callText('unlink', { from: `${id}.changed` })).text).toMatch(/^unlinked/);
    expect(Object.keys(srv.app.services.store.scene.links)).toHaveLength(0);

    expect((await b.callText('undo')).isError).toBe(false);
    expect(Object.keys(srv.app.services.store.scene.links)).toHaveLength(1);
    expect((await b.callText('redo')).isError).toBe(false);

    expect((await b.callText('remove', { id })).text).toMatch(/^removed/);
    expect(srv.app.services.store.scene.entities[id]).toBeUndefined();
    const gone = await b.callText('update', { id, visible: false });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('HTTP 400');
  });

  it('workspaces', async () => {
    expect((await b.callText('workspace', { action: 'save', name: 'bridge-test' })).text).toBe('workspace saved: bridge-test');
    expect((await b.callText('workspace')).text).toMatch(/saved: .*bridge-test/);
  });

  it('data channels: JSON and tensors', async () => {
    expect((await b.callText('channel_set', { name: 'test.json', value: { a: [1, 2, 3] } })).isError).toBe(false);
    expect((await b.callText('channel_get', { name: 'test.json' })).text).toBe('test.json = {"a":[1,2,3]}');
    const raw = new Float32Array([1, 2, 3, 4, 5, 6]);
    const put = await fetch(`${srv.url}/api/channels/test.t`, {
      method: 'PUT', headers: { 'X-Dtype': 'f32', 'X-Shape': '2,3' }, body: Buffer.from(raw.buffer),
    });
    expect(put.ok).toBe(true);
    const t = await b.callText('channel_get', { name: 'test.t' });
    expect(t.text).toContain('tensor f32[2,3] (6 values)');
    expect(t.text).toContain('min=1 max=6 mean=3.5');
    expect((await b.callText('channels', { prefix: 'test.' })).text).toMatch(/test\.t {2}f32\[2,3\]/);
    expect((await b.callText('channel_get', { name: 'nope' })).text).toContain('HTTP 404');
  });

  it('say / status reach the headset', async () => {
    const msg = xr.next('agent.message', (m) => m.message.text === 'hello from Claude');
    await b.callText('say', { text: 'hello from Claude' });
    expect((await msg).message.kind).toBe('reply');
    const st = xr.next('agent.status', (m) => m.status.detail === 'Building things');
    await b.callText('status', { detail: 'Building things' });
    expect((await st).status.state).toBe('working');
  });

  it('user, screenshot and thumbnail', async () => {
    expect((await b.callText('user')).text).toMatch(/^mode vr/);
    const shot = await b.call('screenshot', {});
    expect(shot.isError).toBeFalsy();
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const thumb = await b.call('thumbnail', { id: 'box', props: { size: 0.1 } });
    expect(thumb.isError).toBeFalsy();
    const missing = await b.callText('screenshot', { view: 'entity', entity: 'e-nope' });
    expect(missing.text).toContain('HTTP 404');
  });

  it('widget askAgent → channel event (kind=widget, target resolved from the scene)', async () => {
    const id = /spawned (\S+)/.exec((await b.callText('spawn', { widget: 'box', name: 'plotter', position: [0, 1, -1] })).text)![1]!;
    const before = contents().length;
    xr.send({ type: 'agent.ask', text: 'explain this plot', context: { entity: id, widget: 'box' } });
    await until(() => contents().length > before, 5000);
    expect(contents().at(-1)).toEqual({
      content: 'explain this plot',
      meta: { kind: 'widget', target: id, target_widget: 'box', target_name: 'plotter' },
    });
    // The headset was told Claude heard it.
    await until(() => srv.app.services.agent.status.detail === 'Heard: explain this plot', 3000);
  });

  it('voice_simulate → agent route → channel event flagged simulated (no "Heard" status)', async () => {
    await b.callText('status', { state: 'idle' });
    const before = contents().length;
    const r = await b.callText('voice_simulate', { text: 'please paint the sky green' });
    expect(r.text).toContain('→ agent');
    expect(r.text).toContain('simulated="true"');
    await until(() => contents().length > before, 5000);
    const ev = contents().at(-1)!;
    expect(ev.content).toBe('please paint the sky green');
    expect(ev.meta).toMatchObject({ kind: 'voice', simulated: 'true' });
    expect(ev.meta.utterance_id).toBeTruthy();
    expect(srv.app.services.agent.status.state).toBe('idle');
  });

  it('a request nobody reacts to is reported in XR (real /api/agent/status shape)', async () => {
    await b.callText('status', { state: 'idle' });
    const quick = await connectBridge({ evolUrl: srv.url, pump: { waitMs: 300, backoffInitialMs: 50, unansweredMs: 400 } });
    try {
      await until(() => quick.bridge.pump!.stats.connected, 5000);
      const warned = xr.next('agent.message', (m) => m.message.kind === 'error' && m.message.text.includes('hello?'), 5000);
      xr.send({ type: 'agent.ask', text: 'hello?' });
      await warned;
      expect(srv.app.services.agent.status).toMatchObject({ state: 'idle', detail: 'Claude Code did not pick up the request' });
    } finally {
      await quick.close();
    }
  });

  it('events tool reads the real log', async () => {
    const r = await b.callText('events', { types: ['agent.ask'], limit: 5 });
    expect(r.text).toContain('agent.ask text="please paint the sky green"');
    expect(r.text).toMatch(/next=\d+$/);
  });

  it('command passes through and reports errors', async () => {
    expect((await b.callText('command', { name: 'undo' })).isError).toBe(false);
    const bad = await b.callText('command', { name: 'no.such.command' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad.result)).toMatch(/HTTP 4\d\d/);
  });
});
