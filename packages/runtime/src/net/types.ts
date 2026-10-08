// The subset of NetClient the rest of the runtime depends on. Keeping this
// narrow makes every subsystem testable with a fake.

import type { ClientMessage, ServerMessage } from '@evolspace/protocol';
import type { NetStatus, ServerMessageOf, TensorListener } from './NetClient.ts';

export interface NetPort {
  readonly connected: boolean;
  readonly clientId: string | null;
  send(m: ClientMessage): void;
  sendBinary(b: Uint8Array): void;
  subscribe(channel: string): () => void;
  on<T extends ServerMessage['type']>(type: T, cb: (m: ServerMessageOf<T>) => void): () => void;
  onTensor(cb: TensorListener): () => void;
  onStatus(cb: (s: NetStatus) => void): () => void;
  /** HTTP origin for widget bundles (optional; defaults to the page origin). */
  readonly httpBase?: string;
}
