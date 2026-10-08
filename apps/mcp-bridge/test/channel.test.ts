import { afterEach, describe, expect, it } from 'vitest';
import type { SceneState } from '@evolspace/protocol';
import { askToNotification, sanitizeMeta } from '../src/channel.ts';
import { CHANNEL_METHOD } from '../src/server.ts';
import { EventLog, FakeEvol, until } from './fake-evol.ts';
import { connectBridge } from './helpers.ts';

const SCENE: Partial<SceneState> = {
  version: 1, workspace: 'w', links: {},
  entities: {
    'e-1': { id: 'e-1', parent: null, name: 'lens', widget: 'slider', props: {}, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true },
  },
};

const PUMP = { waitMs: 150, backoffInitialMs: 30, backoffMaxMs: 120 };

function makeServer(log: EventLog) {
  return new FakeEvol()
    .on('GET /api/events', log.handler())
    .on('GET /api/scene', { json: SCENE })
    .on('POST /api/agent/status', { json: {} });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('askToNotification / sanitizeMeta', () => {
  it('extracts voice context (top-level or nested under context)', () => {
    const nested = askToNotification({
      text: 'make this bigger',
      context: { utteranceId: 'u-7', focus: { right: { entity: 'e-1', point: [0, 0, 0] }, left: null }, gaze: { entity: 'e-9', point: [0, 0, 0] }, selected: 'e-3' },
    });
    expect(nested).toEqual({
      content: 'make this bigger',
      meta: { kind: 'voice', target: 'e-1', target_widget: undefined, target_name: undefined, selected: 'e-3', utterance_id: 'u-7' },
    });
    const flat = askToNotification({ text: 'hi', utteranceId: 'u-1', gaze: { entity: 'e-9' } });
    expect(flat?.meta.target).toBe('e-9');
  });

  it('treats widget askAgent requests as kind=widget with the entity as target', () => {
    const n = askToNotification({ text: 'explain this plot', context: { entity: 'e-4', widget: 'plot' } });
    expect(n?.meta).toMatchObject({ kind: 'widget', target: 'e-4', target_widget: 'plot' });
    expect(askToNotification({ text: 'x', kind: 'ui' })?.meta.kind).toBe('ui');
  });

  it('maps the real server voice context (apps/server/src/voice agentContext)', () => {
    const n = askToNotification({
      text: 'make it red',
      context: {
        source: 'voice', kind: 'voice', utteranceId: 'u-9', clientId: 'c-1', target: 'e-2', target_name: 'cube', target_widget: 'box',
        selected: 'e-5', selected_name: 'panel', focus: { right: { entity: 'e-2', point: [0, 0, 0] } }, simulated: true,
      },
    });
    expect(sanitizeMeta(n!.meta)).toEqual({
      kind: 'voice', target: 'e-2', target_name: 'cube', target_widget: 'box', selected: 'e-5', selected_name: 'panel',
      utterance_id: 'u-9', simulated: 'true',
    });
    // agent.ask command run by a voice fast-path binding (origin voice, no utterance id)
    expect(askToNotification({ text: 'x', context: { origin: 'voice' } })?.meta.kind).toBe('voice');
    expect(askToNotification({ text: 'x', context: { origin: 'http' } })?.meta.kind).toBe('request');
  });

  it('ignores asks without text', () => {
    expect(askToNotification({ context: {} })).toBeNull();
    expect(askToNotification({ text: '   ' })).toBeNull();
  });

  it('sanitizes meta to [A-Za-z0-9_] keys and non-empty single-line strings', () => {
    expect(sanitizeMeta({ kind: 'voice', 'target-widget': 'slider', empty: '', none: undefined, n: 3, obj: { a: 1 }, text: 'a\nb' }))
      .toEqual({ kind: 'voice', target_widget: 'slider', n: '3', text: 'a b' });
  });
});

describe('channel pump', () => {
  async function setup(fake: FakeEvol) {
    const b = await connectBridge({ evolUrl: fake.url, pump: PUMP });
    cleanups.push(() => b.close());
    return b;
  }

  it('pushes new agent.ask events as channel notifications and never replays old ones', async () => {
    const log = new EventLog();
    log.add('agent.ask', { text: 'old request from yesterday' }, Date.now() - 86_400_000);
    log.add('voice.utterance', { text: 'noise' });
    const fake = await makeServer(log).start();
    cleanups.push(() => fake.stop());
    const b = await setup(fake);

    await until(() => b.bridge.pump!.stats.connected);
    log.add('agent.ask', {
      text: 'make this bigger',
      context: { kind: 'voice', utteranceId: 'u-1', focus: { right: { entity: 'e-1', point: [0, 1, 0] } }, selected: 'e-1' },
    });
    await until(() => b.notifications.length === 1);
    expect(b.notifications[0]).toMatchObject({
      method: CHANNEL_METHOD,
      params: {
        content: 'make this bigger',
        meta: { kind: 'voice', target: 'e-1', target_widget: 'slider', target_name: 'lens', selected: 'e-1', utterance_id: 'u-1' },
      },
    });
    // Exactly these keys: empty values are dropped, no hyphenated keys.
    expect(Object.keys((b.notifications[0]!.params as { meta: object }).meta).sort())
      .toEqual(['kind', 'selected', 'target', 'target_name', 'target_widget', 'utterance_id']);
    // Headset feedback that Claude picked it up.
    await until(() => fake.find('POST', '/api/agent/status').length === 1);
    expect(fake.find('POST', '/api/agent/status')[0]!.json()).toEqual({ state: 'thinking', detail: 'Heard: make this bigger' });

    log.add('agent.ask', { text: 'second' });
    await until(() => b.notifications.length === 2);
    expect((b.notifications[1]!.params as { content: string }).content).toBe('second');
    expect(b.bridge.pump!.stats.delivered).toBe(2);
    // Nothing old leaked through.
    expect(b.notifications.map((n) => (n.params as { content: string }).content)).not.toContain('old request from yesterday');
  });

  it('keeps retrying while the server is down, then delivers asks made after it came up', async () => {
    const probe = await new FakeEvol().start();
    const url = probe.url;
    const port = Number(new URL(url).port);
    await probe.stop();

    const b = await connectBridge({ evolUrl: url, pump: PUMP });
    cleanups.push(() => b.close());
    await until(() => b.bridge.pump!.stats.lastError !== undefined);
    expect(b.bridge.pump!.stats.connected).toBe(false);
    expect(b.bridge.pump!.stats.lastError).toMatch(/not running/);

    const log = new EventLog();
    const fake = await makeServer(log).start(port);
    cleanups.push(() => fake.stop());
    log.add('agent.ask', { text: 'hello after startup' });
    await until(() => b.notifications.length === 1, 8000);
    expect((b.notifications[0]!.params as { content: string }).content).toBe('hello after startup');
    expect(b.bridge.pump!.stats.connected).toBe(true);
  });

  it('survives a server restart (event log reset) without duplicates or losses', async () => {
    const log = new EventLog();
    const fake = await makeServer(log).start();
    cleanups.push(() => fake.stop());
    const b = await setup(fake);
    await until(() => b.bridge.pump!.stats.connected);
    log.add('agent.ask', { text: 'one' });
    log.add('agent.ask', { text: 'two' });
    await until(() => b.notifications.length === 2);

    log.reset(); // restarted server: seq starts over below our cursor
    log.add('agent.ask', { text: 'three' });
    await until(() => b.notifications.length === 3, 8000);
    // Allow a few more polls; nothing must be re-delivered.
    await new Promise((r) => setTimeout(r, 500));
    expect(b.notifications.map((n) => (n.params as { content: string }).content)).toEqual(['one', 'two', 'three']);
  });

  it('delivers asks that arrived during a brief outage exactly once', async () => {
    const log = new EventLog();
    let fail = false;
    const handler = log.handler();
    const fake = await makeServer(log).start();
    fake.on('GET /api/events', (req) => (fail ? { status: 503, json: { error: 'busy' } } : handler(req)));
    cleanups.push(() => fake.stop());
    const b = await setup(fake);
    await until(() => b.bridge.pump!.stats.connected);
    log.add('agent.ask', { text: 'before' });
    await until(() => b.notifications.length === 1);

    fail = true;
    await until(() => !b.bridge.pump!.stats.connected);
    log.add('agent.ask', { text: 'during outage' });
    fail = false;
    await until(() => b.notifications.length === 2, 8000);
    await new Promise((r) => setTimeout(r, 400));
    expect(b.notifications.map((n) => (n.params as { content: string }).content)).toEqual(['before', 'during outage']);
  });

  it('does not spin against a server that answers /api/events wrongly or ignores wait', async () => {
    // Regression: a non-EvolSpace server on the port replying `{}` instantly caused a hot loop.
    const bogus = await new FakeEvol().on('GET /api/events', { json: {} }).start();
    cleanups.push(() => bogus.stop());
    const b1 = await setup(bogus);
    await new Promise((r) => setTimeout(r, 1000));
    expect(bogus.requests.length).toBeLessThan(40);
    expect(b1.bridge.pump!.stats.lastError).toMatch(/unexpected \/api\/events response/);

    const impatient = await new FakeEvol().on('GET /api/events', { json: { events: [], next: 0 } }).start();
    cleanups.push(() => impatient.stop());
    const b2 = await connectBridge({ evolUrl: impatient.url, pump: { ...PUMP, waitMs: 2000 } });
    cleanups.push(() => b2.close());
    await new Promise((r) => setTimeout(r, 1000));
    expect(b2.bridge.pump!.stats.connected).toBe(true);
    expect(impatient.requests.length).toBeLessThan(10);
  });

  it('advertises the claude/channel capability and instructions', async () => {
    const log = new EventLog();
    const fake = await makeServer(log).start();
    cleanups.push(() => fake.stop());
    const b = await setup(fake);
    const caps = b.client.getServerCapabilities();
    expect(caps?.experimental).toEqual({ 'claude/channel': {} });
    expect(caps?.tools).toBeDefined();
    const instructions = b.client.getInstructions() ?? '';
    expect(instructions).toContain('<channel source="evolspace"');
    expect(instructions).toContain('say tool');
    expect(instructions).toContain('library');
  });
});

describe('unanswered-ask detector (session without the channel)', () => {
  /** Fake server whose agent status behaves like the real one: last POST wins, GET returns it. */
  async function statusServer(initial: { state: string; detail?: string } = { state: 'idle' }, unansweredMs = 300) {
    const log = new EventLog();
    let status: { state: string; detail?: string } = initial;
    const fake = await new FakeEvol()
      .on('GET /api/events', log.handler())
      .on('GET /api/scene', { json: SCENE })
      .on('POST /api/agent/status', (req) => {
        status = req.json();
        return { json: {} };
      })
      .on('GET /api/agent/status', () => ({ json: { status, messages: [] } }))
      .on('POST /api/agent/say', { json: { id: 'm-1' } })
      .start();
    cleanups.push(() => fake.stop());
    const b = await connectBridge({ evolUrl: fake.url, pump: { ...PUMP, unansweredMs } });
    cleanups.push(() => b.close());
    await until(() => b.bridge.pump!.stats.connected);
    return { log, fake, b, setStatus: (s: typeof status) => (status = s) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 700));

  it('tells the user in XR when nothing reacts to a pushed request', async () => {
    const { log, fake, b } = await statusServer();
    log.add('agent.ask', { text: 'anyone there?', context: { kind: 'voice', utteranceId: 'u-1' } });
    await until(() => b.notifications.length === 1);
    await until(() => fake.find('POST', '/api/agent/say').length === 1, 3000);
    expect(fake.find('POST', '/api/agent/say')[0]!.json()).toMatchObject({ kind: 'error', text: expect.stringContaining('scripts/claude.ps1') });
    expect(fake.find('POST', '/api/agent/status').at(-1)!.json()).toEqual({ state: 'idle', detail: 'Claude Code did not pick up the request' });
  });

  it('stays quiet when Claude calls a tool', async () => {
    const { log, fake, b } = await statusServer();
    fake.on('GET /api/health', { json: { ok: true, clients: [] } });
    log.add('agent.ask', { text: 'make it blue' });
    await until(() => b.notifications.length === 1);
    await b.callText('server_status');
    await settle();
    expect(fake.find('POST', '/api/agent/say')).toHaveLength(0);
  });

  it('stays quiet when a hook updates the status', async () => {
    // A longer window than the other cases: the test reacts to the push from another
    // process hop, and under a loaded full-suite run 300 ms was occasionally too short
    // for setStatus to land before the check (a flake, not a detector bug).
    const { log, fake, b, setStatus } = await statusServer({ state: 'idle' }, 1500);
    log.add('agent.ask', { text: 'make it red' });
    await until(() => b.notifications.length === 1);
    setStatus({ state: 'working', detail: 'Editing box/widget.ts' });
    await new Promise((r) => setTimeout(r, 1900));
    expect(fake.find('POST', '/api/agent/say')).toHaveLength(0);
  });

  it('stays quiet when Claude was already busy (the event queues behind the current task)', async () => {
    const { log, fake, b } = await statusServer({ state: 'working', detail: 'Running: npm test' });
    log.add('agent.ask', { text: 'after that, screenshot' });
    await until(() => b.notifications.length === 1);
    await settle();
    expect(fake.find('POST', '/api/agent/say')).toHaveLength(0);
  });

  it('ignores simulated asks entirely (no "Heard" status, no alarm)', async () => {
    const { log, fake, b } = await statusServer();
    log.add('agent.ask', { text: 'test phrase', context: { kind: 'voice', utteranceId: 'u-2', simulated: true } });
    await until(() => b.notifications.length === 1);
    expect((b.notifications[0]!.params as { meta: Record<string, string> }).meta.simulated).toBe('true');
    await settle();
    expect(fake.find('POST', '/api/agent/status')).toHaveLength(0);
    expect(fake.find('POST', '/api/agent/say')).toHaveLength(0);
  });
});
