import { describe, expect, it } from 'vitest';
import { decodeTensorFrame, encodeTensorFrame, makeTensor, type TensorValue } from '@evolspace/protocol';
import { ChannelHub } from '../src/data/ChannelHub.ts';
import { makeNet } from './helpers.ts';

describe('ChannelHub', () => {
  it('caches JSON and tensor values; subscribe fires immediately with the latest value', async () => {
    const { net, ws } = makeNet();
    const hub = new ChannelHub(net);
    ws.serverSend({ type: 'channel.value', channel: 'a', value: { x: 1 }, seq: 3 });
    expect(hub.get('a')).toEqual({ x: 1 });
    expect(hub.seq('a')).toBe(3);
    const t = makeTensor('u8', [2, 2], new Uint8Array([1, 0, 0, 1]));
    ws.serverBinary(encodeTensorFrame({ channel: 'interp.resid.mask', dtype: 'u8', shape: [2, 2], seq: 4 }, t));
    const got = hub.get('interp.resid.mask') as TensorValue;
    expect(got.$tensor).toBe(true);
    expect(got.shape).toEqual([2, 2]);
    expect(Array.from(got.data)).toEqual([1, 0, 0, 1]);

    const seen: unknown[] = [];
    const off = hub.subscribe('a', (v) => seen.push(v));
    expect(seen).toEqual([{ x: 1 }]);
    await Promise.resolve();
    expect(ws.messagesOf('channel.subscribe')[0].channels).toEqual(['a']);
    off();
    await Promise.resolve();
    expect(ws.messagesOf('channel.unsubscribe')[0].channels).toEqual(['a']);
  });

  it('local publish delivers immediately and suppresses the server echo of older values', () => {
    const { net, ws } = makeNet();
    const hub = new ChannelHub(net);
    const seen: unknown[] = [];
    hub.subscribe('ui.layer', (v) => seen.push(v));
    hub.publish('ui.layer', 1);
    hub.publish('ui.layer', 2);
    hub.publish('ui.layer', 3);
    expect(seen).toEqual([1, 2, 3]);
    expect(ws.messagesOf('channel.publish').map((m) => m.value)).toEqual([1, 2, 3]);
    // Echoes arrive late: must not make the consumer jump back.
    ws.serverSend({ type: 'channel.value', channel: 'ui.layer', value: 1, seq: 10 });
    ws.serverSend({ type: 'channel.value', channel: 'ui.layer', value: 2, seq: 11 });
    ws.serverSend({ type: 'channel.value', channel: 'ui.layer', value: 3, seq: 12 });
    expect(seen).toEqual([1, 2, 3]);
    expect(hub.seq('ui.layer')).toBe(12);
    // Another producer's value goes through.
    ws.serverSend({ type: 'channel.value', channel: 'ui.layer', value: 7, seq: 13 });
    expect(seen).toEqual([1, 2, 3, 7]);
  });

  it('publishes tensors as binary frames', () => {
    const { net, ws } = makeNet();
    const hub = new ChannelHub(net);
    hub.publish('probe', makeTensor('f32', [2], new Float32Array([0.5, -1])));
    const bin = ws.sent.find((s) => typeof s !== 'string') as Uint8Array;
    const { header, tensor } = decodeTensorFrame(bin);
    expect(header).toMatchObject({ type: 'channel.value', channel: 'probe', dtype: 'f32', shape: [2] });
    expect(Array.from(tensor.data)).toEqual([0.5, -1]);
  });

  it('isolates listener errors', () => {
    const { net, ws } = makeNet();
    const errs: string[] = [];
    const hub = new ChannelHub(net, (ch) => errs.push(ch));
    const seen: unknown[] = [];
    hub.subscribe('c', () => { throw new Error('x'); });
    hub.subscribe('c', (v) => seen.push(v));
    ws.serverSend({ type: 'channel.value', channel: 'c', value: 1, seq: 1 });
    expect(seen).toEqual([1]);
    expect(errs).toEqual(['c']);
  });

  it('drops the cached value after the last listener leaves, but not across a same-tick resubscribe', async () => {
    const { net, ws } = makeNet();
    const hub = new ChannelHub(net);
    const off1 = hub.subscribe('big', () => {});
    ws.serverSend({ type: 'channel.value', channel: 'big', value: [1, 2, 3], seq: 1 });
    // Re-create pattern: release and resubscribe in one tick → value kept, delivered at once.
    off1();
    const seen: unknown[] = [];
    const off2 = hub.subscribe('big', (v) => seen.push(v));
    await Promise.resolve();
    expect(hub.get('big')).toEqual([1, 2, 3]);
    expect(seen).toEqual([[1, 2, 3]]);
    // Last listener gone for good → evicted (it would only go stale).
    off2();
    await Promise.resolve();
    expect(hub.get('big')).toBeUndefined();
  });
});
