import { describe, expect, it } from 'vitest';
import type { ClientMessage } from '@evolspace/protocol';
import { passivePort, type PassiveSource } from '../passive.ts';
import { isStructural } from '../scene-index.ts';

function fakeNet(): PassiveSource & { sent: ClientMessage[]; subs: string[] } {
  const sent: ClientMessage[] = [];
  const subs: string[] = [];
  return {
    sent,
    subs,
    connected: true,
    clientId: 'c1',
    httpBase: 'http://127.0.0.1:1/',
    send: (m) => { sent.push(m); },
    subscribe: (ch) => { subs.push(ch); return () => {}; },
    on: () => () => {},
    onTensor: () => () => {},
    onStatus: () => () => {},
  };
}

describe('passivePort', () => {
  it('forwards only errors, logs and subscriptions; observes everything', () => {
    const net = fakeNet();
    const seen: string[] = [];
    const port = passivePort(net, (m) => seen.push(m.type));
    const msgs: ClientMessage[] = [
      { type: 'scene.ops', ops: [{ op: 'remove', id: 'x' }], source: 'widget' },
      { type: 'channel.publish', channel: 'a', value: 1 },
      { type: 'widget.event', entity: 'e', widget: 'w', name: 'n' },
      { type: 'agent.ask', text: 'hi' },
      { type: 'command', name: 'undo' },
      { type: 'client.error', message: 'boom', entity: 'e' },
      { type: 'client.log', level: 'warn', message: 'meh' },
      { type: 'channel.subscribe', channels: ['a'] },
    ];
    for (const m of msgs) port.send(m);
    port.sendBinary(new Uint8Array(8));
    expect(net.sent.map((m) => m.type)).toEqual(['client.error', 'client.log', 'channel.subscribe']);
    expect(seen).toEqual(msgs.map((m) => m.type));
    port.subscribe('live.data');
    expect(net.subs).toEqual(['live.data']);
    expect([port.connected, port.clientId, port.httpBase]).toEqual([true, 'c1', 'http://127.0.0.1:1/']);
  });
});

describe('isStructural', () => {
  it('ignores transform-only updates (drags) but not anything else', () => {
    expect(isStructural([{ op: 'update', id: 'a', patch: { transform: { position: [1, 2, 3] } } }])).toBe(false);
    expect(isStructural([{ op: 'update', id: 'a', patch: { props: { v: 1 } } }])).toBe(true);
    expect(isStructural([{ op: 'update', id: 'a', patch: { transform: { position: [0, 0, 0] }, visible: false } }])).toBe(true);
    expect(isStructural([{ op: 'remove', id: 'a' }])).toBe(true);
    expect(isStructural([])).toBe(false);
  });
});
