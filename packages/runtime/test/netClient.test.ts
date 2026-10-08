import { describe, expect, it, vi } from 'vitest';
import { encodeAudioFrame, encodeTensorFrame, makeTensor } from '@evolspace/protocol';
import { NetClient } from '../src/net/NetClient.ts';
import { MockWebSocket, fakeTimers, makeNet } from './helpers.ts';

describe('NetClient', () => {
  it('sends hello on open and reports ready after the server hello', () => {
    const { net, ws } = makeNet({ open: false });
    expect(net.connected).toBe(false);
    ws.open();
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.messages()[0]).toMatchObject({ type: 'hello', role: 'xr' });
    expect(net.ready).toBe(false);
    ws.serverSend({ type: 'hello', clientId: 'abc', serverVersion: '1', primary: true });
    expect(net.ready).toBe(true);
    expect(net.clientId).toBe('abc');
    expect(net.primary).toBe(true);
  });

  it('passes hello options through', () => {
    MockWebSocket.reset();
    new NetClient('ws://x/ws', 'desktop', { WebSocketImpl: MockWebSocket, timers: fakeTimers(), hello: { wantPrimary: true, capabilities: ['hands'] } });
    const ws = MockWebSocket.last();
    ws.open();
    // 'no-echo' is added by default: the ChannelHub delivers own publishes locally.
    expect(ws.messages()[0]).toEqual({ type: 'hello', role: 'desktop', wantPrimary: true, capabilities: ['hands', 'no-echo'] });
  });

  it('noEcho: false keeps the server echo', () => {
    MockWebSocket.reset();
    new NetClient('ws://x/ws', 'tool', { WebSocketImpl: MockWebSocket, timers: fakeTimers(), noEcho: false });
    MockWebSocket.last().open();
    expect(MockWebSocket.last().messages()[0]).toEqual({ type: 'hello', role: 'tool', capabilities: [] });
  });

  it('abandons a socket stuck in CONNECTING and retries', () => {
    MockWebSocket.reset();
    const timers = fakeTimers();
    const net = new NetClient('ws://x/ws', 'xr', { WebSocketImpl: MockWebSocket, timers, log: () => {}, connectTimeoutMs: 5000 });
    const first = MockWebSocket.last();
    expect(timers.pending.map((p) => p.ms)).toEqual([5000]);
    timers.runAll(); // connect timeout fires
    expect(first.readyState).toBe(3);
    expect(net.status.attempt).toBe(1);
    expect(timers.pending).toHaveLength(1); // the reconnect
    timers.runAll();
    const second = MockWebSocket.last();
    expect(second).not.toBe(first);
    second.open();
    expect(net.connected).toBe(true);
    // The open cleared the connect timeout; a late close of the first socket is ignored.
    expect(timers.pending).toHaveLength(0);
    first.onclose?.({ code: 1006 });
    expect(net.connected).toBe(true);
  });

  it('dispatches typed messages and isolates listener errors', () => {
    const { net, ws } = makeNet();
    const got: string[] = [];
    net.on('agent.status', () => { throw new Error('boom'); });
    const off = net.on('agent.status', (m) => got.push(m.status.state));
    net.on('agent.message', (m) => got.push(m.message.text));
    ws.serverSend({ type: 'agent.status', status: { state: 'working', since: 1 } });
    ws.serverSend({ type: 'agent.message', message: { id: '1', text: 'hi', kind: 'reply', ts: 1 } });
    off();
    ws.serverSend({ type: 'agent.status', status: { state: 'idle', since: 2 } });
    expect(got).toEqual(['working', 'hi']);
  });

  it('ignores malformed JSON frames', () => {
    const { net, ws } = makeNet();
    const cb = vi.fn();
    net.onMessage(cb);
    ws.onmessage?.({ data: '{nope' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('decodes binary tensor frames and ignores audio frames', () => {
    const { net, ws } = makeNet();
    const got: Array<[string, number[], number]> = [];
    net.onTensor((ch, t, seq) => got.push([ch, Array.from(t.data as Float32Array), seq]));
    const t = makeTensor('f32', [3], new Float32Array([1, 2, 3]));
    ws.serverBinary(encodeTensorFrame({ channel: 'interp.resid.norm', dtype: 'f32', shape: [3], seq: 7 }, t));
    ws.serverBinary(encodeAudioFrame('utt-1', new Int16Array(8)));
    expect(got).toEqual([['interp.resid.norm', [1, 2, 3], 7]]);
  });

  it('queues durable messages while disconnected and drops ephemeral ones', () => {
    const { net, ws } = makeNet({ open: false });
    net.send({ type: 'scene.undo' });
    net.send({ type: 'user.pose', pose: { t: 0, mode: 'vr', head: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, hands: {} } });
    net.send({ type: 'command', name: 'redo' });
    net.sendBinary(new Uint8Array(8)); // dropped
    ws.open();
    const types = ws.messages().map((m) => m.type);
    expect(types).toEqual(['hello', 'scene.undo', 'command']);
    expect(ws.sent.filter((s) => typeof s !== 'string')).toHaveLength(0);
  });

  it('reconnects with backoff and re-subscribes channels with live refs', async () => {
    const { net, ws, timers } = makeNet();
    const r1 = net.subscribe('a');
    const r2 = net.subscribe('a');
    const r3 = net.subscribe('b');
    await Promise.resolve();
    expect(ws.messagesOf('channel.subscribe')).toEqual([{ type: 'channel.subscribe', channels: ['a', 'b'] }]);
    r3();
    r1();
    await Promise.resolve();
    expect(ws.messagesOf('channel.unsubscribe')).toEqual([{ type: 'channel.unsubscribe', channels: ['b'] }]);

    ws.drop();
    expect(net.connected).toBe(false);
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0].ms).toBeGreaterThan(0);
    timers.runAll();
    const ws2 = MockWebSocket.last();
    expect(ws2).not.toBe(ws);
    ws2.open();
    expect(ws2.messages().map((m) => m.type)).toEqual(['hello', 'channel.subscribe']);
    expect(ws2.messagesOf('channel.subscribe')[0].channels).toEqual(['a']);
    r2();
    await Promise.resolve();
    expect(ws2.messagesOf('channel.unsubscribe')[0].channels).toEqual(['a']);
  });

  it('backoff grows and is capped', () => {
    const { ws, timers } = makeNet();
    const delays: number[] = [];
    let cur = ws;
    for (let i = 0; i < 12; i++) {
      cur.drop();
      delays.push(timers.pending[0].ms);
      timers.runAll();
      cur = MockWebSocket.last();
    }
    expect(delays[3]).toBeGreaterThan(delays[0]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10_000 * 1.25 + 1);
  });

  it('a subscribe+unsubscribe in the same tick sends nothing', async () => {
    const { net, ws } = makeNet();
    ws.clearSent();
    const r = net.subscribe('x');
    r();
    r(); // idempotent
    await Promise.resolve();
    expect(ws.messages()).toHaveLength(0);
  });

  it('close() stops reconnecting', () => {
    const { net, timers } = makeNet();
    net.close();
    expect(timers.pending).toHaveLength(0);
    expect(net.connected).toBe(false);
  });

  it('derives the HTTP base from the socket URL', () => {
    MockWebSocket.reset();
    const n = new NetClient('wss://10.0.0.5:8443/ws', 'xr', { WebSocketImpl: MockWebSocket, autoConnect: false });
    expect(n.httpBase).toBe('https://10.0.0.5:8443/');
  });

  it('skips user.pose while the send buffer is backed up, never ops', () => {
    const { net, ws } = makeNet();
    ws.clearSent();
    (ws as unknown as { bufferedAmount: number }).bufferedAmount = 1_000_000;
    const pose = { t: 0, mode: 'vr' as const, head: { position: [0, 1.6, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] }, hands: {} };
    net.send({ type: 'user.pose', pose });
    net.send({ type: 'scene.undo' });
    expect(ws.messages().map((m) => m.type)).toEqual(['scene.undo']);
    (ws as unknown as { bufferedAmount: number }).bufferedAmount = 0;
    net.send({ type: 'user.pose', pose });
    expect(ws.messages().map((m) => m.type)).toEqual(['scene.undo', 'user.pose']);
  });
});
