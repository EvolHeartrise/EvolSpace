// The mirror's runtimes talk to the server through a "passive" port.
//
// The mirror is an observer: its widget instances are copies of the headset's
// (or one-off studio instances for thumbnails), so their side effects — scene
// edits (setProps / spawnChild), channel publishes (incl. port→channel links),
// widget events, agent requests, commands — must not reach the server, or they
// would duplicate or fight the real ones (e.g. a slider in a thumbnail
// publishing its default value to a live channel). The runtime still applies
// widget scene edits locally (optimistic writes), so screenshots show them;
// they are just never persisted.
//
// What does go out: errors and logs (they tell the agent what broke, tagged
// with role 'mirror' by the server) and channel subscriptions (widgets render
// live data). Pure module (type-only imports) so it is unit-testable in Node.
import type { ClientMessage } from '@evolspace/protocol';
import type { NetPort } from '@evolspace/runtime';

export const PASSIVE_ALLOWED: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>([
  'client.error', 'client.log', 'channel.subscribe', 'channel.unsubscribe',
]);

/** The NetClient surface the passive port delegates to. */
export type PassiveSource = Pick<NetPort, 'connected' | 'clientId' | 'httpBase' | 'send' | 'subscribe' | 'on' | 'onTensor' | 'onStatus'>;

/**
 * A NetPort over the shared NetClient that drops side-effect messages and
 * binary (tensor) publishes. `observe` sees every message a runtime tries to
 * send, before filtering (the mirror uses it to notice widget errors).
 */
export function passivePort(net: PassiveSource, observe?: (m: ClientMessage) => void): NetPort {
  return {
    get connected() { return net.connected; },
    get clientId() { return net.clientId; },
    get httpBase() { return net.httpBase; },
    send(m) {
      observe?.(m);
      if (PASSIVE_ALLOWED.has(m.type)) net.send(m);
    },
    sendBinary() { /* tensor publishes: dropped (passive) */ },
    subscribe: (channel) => net.subscribe(channel),
    on: (type, cb) => net.on(type, cb),
    onTensor: (cb) => net.onTensor(cb),
    onStatus: (cb) => net.onStatus(cb),
  };
}
