// Desktop debug dashboard support: the /debug redirect and the `user-pose`
// capability (primary's user.pose forwarded to subscribed clients, ≤15 Hz).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserPose } from '@evolspace/protocol';
import { startTestServer, TestClient, type TestServer } from './helpers.ts';
import { UserPoseFeed } from '../src/ws/user-pose-feed.ts';

const pose = (x: number): UserPose => ({ t: Date.now(), mode: 'vr', head: { position: [x, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} });

describe('debug dashboard support', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });

  it('/debug redirects to the desktop client with debug=1, keeping other params', async () => {
    const r = await fetch(`${srv.url}/debug?server=wss://pc:8443&role=xr`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!, srv.url);
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('role')).toBe('desktop');
    expect(loc.searchParams.get('debug')).toBe('1');
    expect(loc.searchParams.get('server')).toBe('wss://pc:8443');
    expect(loc.searchParams.getAll('role')).toHaveLength(1);
  });

  it('forwards the primary pose to user-pose subscribers only, and null when the primary leaves', async () => {
    const dbg = await TestClient.connect(srv.wsUrl, { role: 'desktop', capabilities: ['user-pose'] });
    const plain = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    expect(xr.of('hello').at(-1)!.primary).toBe(true);
    expect(dbg.of('hello').at(-1)!.primary).toBe(false); // a desktop client never becomes primary

    const got = dbg.next('user.pose', (m) => m.pose?.head.position[0] === 1);
    xr.send({ type: 'user.pose', pose: pose(1) });
    await got;
    // Burst: latest wins (trailing edge), at most ~15 Hz.
    const last = dbg.next('user.pose', (m) => m.pose?.head.position[0] === 5, 2000);
    for (let i = 2; i <= 5; i++) xr.send({ type: 'user.pose', pose: pose(i) });
    await last;
    const n = dbg.of('user.pose').length;
    expect(n).toBeLessThanOrEqual(3);

    // A late subscriber gets the latest pose right after hello.
    const late = await TestClient.connect(srv.wsUrl, { role: 'desktop', capabilities: ['user-pose'] });
    await new Promise((r) => setTimeout(r, 100));
    expect(late.of('user.pose').at(-1)?.pose?.head.position[0]).toBe(5);

    const cleared = dbg.next('user.pose', (m) => m.pose === null);
    await xr.close();
    await cleared;
    expect(plain.of('user.pose')).toHaveLength(0);
    await Promise.all([dbg.close(), plain.close(), late.close()]);
  });

  it('UserPoseFeed skips work without subscribers', () => {
    let sent = 0;
    const feed = new UserPoseFeed({ clients: new Map(), broadcast: () => { sent++; return 0; } });
    feed.offer(pose(0));
    expect(sent).toBe(0);
    feed.close();
  });
});
