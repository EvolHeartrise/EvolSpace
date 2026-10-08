import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventLog } from '../src/events.ts';
import { startTestServer, api, type TestServer } from './helpers.ts';

describe('EventLog', () => {
  it('assigns increasing seq numbers, filters by type and bounds the buffer', () => {
    const log = new EventLog(5);
    for (let i = 0; i < 8; i++) log.emit(i % 2 ? 'client.log' : 'widget.build', { i });
    const all = log.query({ since: 0 });
    expect(all.events.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(all.next).toBe(8);
    const builds = log.query({ since: 0, types: ['widget.build'] });
    expect(builds.events.every((e) => e.type === 'widget.build')).toBe(true);
    expect(builds.next).toBe(8); // filtered-out events are skipped for good
    expect(log.query({}).events).toHaveLength(5); // no since → most recent
    const limited = log.query({ since: 0, limit: 2 });
    expect(limited.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(limited.next).toBe(5);
  });

  it('long-poll resolves on the first matching event, or empty after the wait', async () => {
    const log = new EventLog();
    log.emit('client.log', {});
    const t0 = Date.now();
    const p = log.wait({ since: 1, types: ['agent.ask'] }, 2000);
    setTimeout(() => log.emit('client.log', { ignored: true }), 20);
    setTimeout(() => log.emit('agent.ask', { text: 'hi' }), 60);
    const page = await p;
    expect(page.events).toHaveLength(1);
    expect(page.events[0].data.text).toBe('hi');
    expect(Date.now() - t0).toBeLessThan(1000);

    const empty = await log.wait({ since: log.lastSeq, types: ['agent.ask'] }, 50);
    expect(empty.events).toEqual([]);
    expect(empty.next).toBe(log.lastSeq);
  });
});

describe('GET /api/events', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv?.close(); });

  it('long-polls over HTTP with types filter', async () => {
    const head = (await api(srv.url, 'GET', '/api/events')).body as { next: number };
    const pending = api(srv.url, 'GET', `/api/events?since=${head.next}&wait=3000&types=agent.ask`);
    await new Promise((r) => setTimeout(r, 100));
    await api(srv.url, 'POST', '/api/command', { name: 'agent.ask', args: { text: 'make it bigger' } });
    const res = (await pending).body as { events: Array<{ type: string; data: { text: string } }>; next: number };
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'agent.ask', data: { text: 'make it bigger' } });
    expect(res.next).toBeGreaterThan(head.next);
  });

  it('records widget build events at boot', async () => {
    const res = (await api(srv.url, 'GET', '/api/events?since=0&types=widget.build')).body as { events: Array<{ data: { widget: string; ok: boolean } }> };
    expect(res.events.some((e) => e.data.widget === 'box' && e.data.ok)).toBe(true);
  });
});
