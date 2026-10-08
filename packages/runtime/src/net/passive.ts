// A mirror runtime is a passive observer: its widget instances are copies of
// the headset's (or one-off studio instances), so their side effects must not
// reach the server, where they would duplicate or fight the real ones (a slider
// in a thumbnail publishing its default to a live channel, a duplicated
// widget.event, an agent request asked twice…). Local effects still happen —
// optimistic scene edits and local channel listeners — so screenshots show
// them; they are just never sent.
//
// What still goes out: errors and logs (the server tags them with the
// connection's role, 'mirror') and channel (un)subscriptions (widgets render
// live data).

import type { ClientMessage } from '@evolspace/protocol';
import type { NetPort } from './types.ts';

export const PASSIVE_ALLOWED: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>([
  'client.error', 'client.log', 'channel.subscribe', 'channel.unsubscribe',
]);

/** Wrap a port so that only PASSIVE_ALLOWED messages are sent; binary frames (tensor publishes) are dropped. */
export function passiveNetPort(net: NetPort): NetPort {
  return {
    get connected() { return net.connected; },
    get clientId() { return net.clientId; },
    get httpBase() { return net.httpBase; },
    send(m) {
      if (PASSIVE_ALLOWED.has(m.type)) net.send(m);
    },
    sendBinary() { /* tensor publishes: dropped */ },
    subscribe: (channel) => net.subscribe(channel),
    on: (type, cb) => net.on(type, cb),
    onTensor: (cb) => net.onTensor(cb),
    onStatus: (cb) => net.onStatus(cb),
  };
}
