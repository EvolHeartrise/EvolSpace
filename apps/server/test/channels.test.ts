import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decodeTensorFrame, encodeTensorFrame, makeTensor, tensorFromJson } from '@evolspace/protocol';
import { ClientConnection, type SocketLike } from '../src/ws/client.ts';
import { DataBus } from '../src/data/bus.ts';
import { startTestServer, TestClient, api, until, type TestServer } from './helpers.ts';

class FakeSocket implements SocketLike {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  send(d: string | Uint8Array) { this.sent.push(d); }
  close() { this.readyState = 3; }
}

describe('ClientConnection backpressure', () => {
  it('coalesces channel values latest-per-channel while the socket is congested', async () => {
    const sock = new FakeSocket();
    const c = new ClientConnection('c-1', sock, 1000);
    const bus = new DataBus();
    c.subscribe(['a', 'b']);
    bus.onPublish((ch) => c.sendChannel(ch));

    bus.publish('a', 0);
    expect(sock.sent).toHaveLength(1); // uncongested: immediate

    sock.bufferedAmount = 5000; // congested
    for (let i = 1; i <= 50; i++) bus.publish('a', i);
    bus.publish('b', { x: 1 });
    bus.publish('a', 51);
    expect(sock.sent).toHaveLength(1);
    expect(c.pendingChannels).toBe(2);
    expect(c.stats.coalesced).toBeGreaterThanOrEqual(50);

    // Control messages are never dropped or delayed.
    c.send({ type: 'agent.status', status: { state: 'idle', since: 0 } });
    expect(sock.sent).toHaveLength(2);

    sock.bufferedAmount = 0; // drained
    await until(() => c.pendingChannels === 0);
    const texts = sock.sent.slice(2).map((d) => JSON.parse(String(d)));
    expect(texts).toEqual([
      { type: 'channel.value', channel: 'b', value: { x: 1 }, seq: 1 },
      { type: 'channel.value', channel: 'a', value: 51, seq: 52 },
    ]);
    c.dispose();
  });

  it('supports prefix patterns', () => {
    const c = new ClientConnection('c-2', new FakeSocket(), 1000);
    c.subscribe(['interp.*']);
    expect(c.isSubscribed('interp.resid.proj')).toBe(true);
    expect(c.isSubscribed('interpx')).toBe(false);
    c.unsubscribe(['interp.*']);
    expect(c.isSubscribed('interp.meta')).toBe(false);
  });
});

describe('channels over HTTP / SSE / WS', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer({ config: { wsHighWaterMark: 64 * 1024 } }); });
  afterAll(async () => { await srv?.close(); });

  it('PUT/GET JSON values with ChannelInfo bookkeeping', async () => {
    const put = await fetch(`${srv.url}/api/channels/demo.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Producer': 'test', 'X-Description': 'a demo' }, body: JSON.stringify({ a: [1, 2] }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ name: 'demo.json', kind: 'json', seq: 1, producer: 'test', description: 'a demo' });
    expect((await api(srv.url, 'GET', '/api/channels/demo.json')).body).toEqual({ a: [1, 2] });
    await api(srv.url, 'PUT', '/api/channels/demo.json', 42);
    const list = (await api(srv.url, 'GET', '/api/channels')).body as Array<{ name: string; seq: number; producer?: string }>;
    expect(list.find((c) => c.name === 'demo.json')).toMatchObject({ seq: 2, producer: 'test' });
    expect((await api(srv.url, 'GET', '/api/channels/nope')).status).toBe(404);
    expect((await api(srv.url, 'PUT', '/api/channels/bad name', 1)).status).toBe(400);
  });

  it('PUT/GET tensors as frames, raw bytes and JSON form', async () => {
    const t = makeTensor('f32', [2, 3], new Float32Array([1, 2, 3, 4, 5, 6]));
    const frame = encodeTensorFrame({ channel: 'ignored', dtype: 'f32', shape: [2, 3] }, t);
    const put = await fetch(`${srv.url}/api/channels/demo.t`, { method: 'PUT', headers: { 'Content-Type': 'application/x-evol-tensor' }, body: Buffer.from(frame) });
    expect(await put.json()).toMatchObject({ kind: 'tensor', dtype: 'f32', shape: [2, 3], size: 24 });
    const get = await fetch(`${srv.url}/api/channels/demo.t`);
    expect(get.headers.get('content-type')).toBe('application/x-evol-tensor');
    const back = decodeTensorFrame(new Uint8Array(await get.arrayBuffer()));
    expect(back.header.channel).toBe('demo.t');
    expect([...back.tensor.data]).toEqual([1, 2, 3, 4, 5, 6]);

    // raw bytes + headers
    const raw = new Uint8Array(new Int16Array([7, -8, 9, 10]).buffer);
    const put2 = await fetch(`${srv.url}/api/channels/demo.raw`, { method: 'PUT', headers: { 'X-Dtype': 'i16', 'X-Shape': '2,2' }, body: raw });
    expect(put2.status).toBe(200);
    const j = (await api(srv.url, 'GET', '/api/channels/demo.raw?format=json')).body as { $tensor: true; dtype: 'i16'; shape: number[]; b64: string };
    expect(j).toMatchObject({ $tensor: true, dtype: 'i16', shape: [2, 2] });
    expect([...tensorFromJson(j).data]).toEqual([7, -8, 9, 10]);

    // size mismatch is a 400 with a clear message
    const bad = await fetch(`${srv.url}/api/channels/demo.raw`, { method: 'PUT', headers: { 'X-Dtype': 'f32', 'X-Shape': '3' }, body: raw });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/needs 12/);

    // JSON tensor form via PUT JSON
    const put3 = await api(srv.url, 'PUT', '/api/channels/demo.jt', { $tensor: true, dtype: 'u8', shape: [3], b64: Buffer.from([1, 2, 3]).toString('base64') });
    expect(put3.body).toMatchObject({ kind: 'tensor', dtype: 'u8', shape: [3] });
  });

  it('streams values over SSE (current value first)', async () => {
    await api(srv.url, 'PUT', '/api/channels/demo.sse', 1);
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/api/channels/demo.sse/events`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const values: unknown[] = [];
    let buf = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) values.push(JSON.parse(data.slice(6)));
        }
      }
    })();
    await until(() => values.length >= 1);
    await api(srv.url, 'PUT', '/api/channels/demo.sse', { two: 2 });
    await until(() => values.length >= 2);
    expect(values).toEqual([1, { two: 2 }]);
    ac.abort();
    await pump;
  });

  it('WS subscribe/publish for JSON and binary tensors (with prefix patterns)', async () => {
    const a = await TestClient.connect(srv.wsUrl, { role: 'tool' });
    const b = await TestClient.connect(srv.wsUrl, { role: 'desktop' });
    await api(srv.url, 'PUT', '/api/channels/ws.pre', 'existing');
    const first = b.next('channel.value', (m) => m.channel === 'ws.pre');
    b.send({ type: 'channel.subscribe', channels: ['ws.*'] });
    expect((await first).value).toBe('existing');

    const got = b.next('channel.value', (m) => m.channel === 'ws.json');
    a.send({ type: 'channel.publish', channel: 'ws.json', value: { hello: true } });
    expect((await got).value).toEqual({ hello: true });

    const bin = b.nextBinary();
    const t = makeTensor('u16', [4], new Uint16Array([1, 2, 3, 65535]));
    a.ws.send(encodeTensorFrame({ channel: 'ws.tensor', dtype: 'u16', shape: [4], producer: 'tester' }, t));
    const frame = decodeTensorFrame(await bin);
    expect(frame.header).toMatchObject({ channel: 'ws.tensor', producer: 'tester', seq: 1 });
    expect([...frame.tensor.data]).toEqual([1, 2, 3, 65535]);
    const info = (await api(srv.url, 'GET', '/api/channels')).body as Array<{ name: string; producer?: string }>;
    expect(info.find((c) => c.name === 'ws.tensor')?.producer).toBe('tester');

    // unsubscribe stops delivery
    b.send({ type: 'channel.unsubscribe', channels: ['ws.*'] });
    await new Promise((r) => setTimeout(r, 50));
    const before = b.messages.length;
    await api(srv.url, 'PUT', '/api/channels/ws.json', 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.length).toBe(before);
    await a.close(); await b.close();
  });

  it('a channel.publish COMMAND reaches the requesting no-echo client (voice fast path)', async () => {
    const a = await TestClient.connect(srv.wsUrl, { role: 'xr', wantPrimary: false, capabilities: ['no-echo'] });
    a.send({ type: 'channel.subscribe', channels: ['cmd.echo'] });
    await new Promise((r) => setTimeout(r, 50));
    const got = a.next('channel.value', (m) => m.channel === 'cmd.echo');
    a.send({ type: 'command', name: 'channel.publish', args: { channel: 'cmd.echo', value: '10' } });
    expect((await got).value).toBe('10');
    await a.close();
  });

  it('a slow WS consumer gets the latest tensor, not a backlog', async () => {
    const slow = await TestClient.connect(srv.wsUrl, { role: 'xr', wantPrimary: false });
    const sub = slow.next('channel.value').catch(() => null); // no JSON expected; just ensure the subscribe went through
    slow.send({ type: 'channel.subscribe', channels: ['big'] });
    await new Promise((r) => setTimeout(r, 50));
    void sub;
    // Stop reading at the TCP level so the server's socket buffer fills up.
    const raw = (slow.ws as unknown as { _socket: import('node:net').Socket })._socket;
    raw.pause();
    const N = 40;
    const elems = 64 * 1024; // 256 KB per value
    for (let i = 1; i <= N; i++) {
      const data = new Float32Array(elems).fill(i);
      const r = await fetch(`${srv.url}/api/channels/big`, { method: 'PUT', headers: { 'X-Dtype': 'f32', 'X-Shape': String(elems) }, body: new Uint8Array(data.buffer) });
      expect(r.status).toBe(200);
    }
    raw.resume();
    const last = await slow.nextBinary((b) => decodeTensorFrame(b).header.seq === N, 10_000).catch(() => null);
    // Either the final value arrived just now, or it was already received before.
    const frames = slow.binary.map((b) => decodeTensorFrame(b));
    expect(last ?? frames.find((f) => f.header.seq === N)).toBeTruthy();
    expect(frames.at(-1)!.header.seq).toBe(N);
    expect(frames.at(-1)!.tensor.data[0]).toBe(N);
    expect(frames.length).toBeLessThan(N); // intermediate values were coalesced
    await slow.close();
  }, 30_000);
});
