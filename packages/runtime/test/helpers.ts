// Shared test fixtures: a mock WebSocket, a runtime factory with a fake widget
// loader, and manifest/entity builders.

import * as THREE from 'three';
import type { ClientMessage, Entity, ServerMessage, WidgetDefinition, WidgetManifest } from '@evolspace/protocol';
import { NetClient } from '../src/net/NetClient.ts';
import type { WebSocketLike } from '../src/net/NetClient.ts';
import { SpaceRuntime, type SpaceRuntimeOptions } from '../src/SpaceRuntime.ts';
import { stubTextFactory } from '../src/ui/stubText.ts';

export class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: Array<string | Uint8Array> = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Server → client JSON. */
  serverSend(m: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }

  serverBinary(b: Uint8Array): void {
    // Deliver as an ArrayBuffer like a browser with binaryType 'arraybuffer'.
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /** Simulate a dropped connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  /** Parsed JSON messages sent by the client. */
  messages(): ClientMessage[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as ClientMessage);
  }

  messagesOf<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.messages().filter((m) => m.type === type) as Extract<ClientMessage, { type: T }>[];
  }

  clearSent(): void {
    this.sent = [];
  }
}

export interface FakeTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  pending: Array<{ fn: () => void; ms: number; id: number }>;
  runAll(): void;
}

export function fakeTimers(): FakeTimers {
  let id = 0;
  const t: FakeTimers = {
    pending: [],
    setTimeout(fn, ms) {
      const h = ++id;
      t.pending.push({ fn, ms, id: h });
      return h;
    },
    clearTimeout(h) {
      t.pending = t.pending.filter((p) => p.id !== h);
    },
    runAll() {
      const p = t.pending;
      t.pending = [];
      for (const x of p) x.fn();
    },
  };
  return t;
}

export function makeNet(opts: { open?: boolean } = {}): { net: NetClient; ws: MockWebSocket; timers: FakeTimers } {
  MockWebSocket.reset();
  const timers = fakeTimers();
  const net = new NetClient('ws://127.0.0.1:9999/ws', 'xr', { WebSocketImpl: MockWebSocket, timers, log: () => {} });
  const ws = MockWebSocket.last();
  if (opts.open !== false) {
    ws.open();
    ws.serverSend({ type: 'hello', clientId: 'c1', serverVersion: 'test', primary: true });
  }
  return { net, ws, timers };
}

export function manifest(id: string, extra: Partial<WidgetManifest> = {}): WidgetManifest {
  return {
    id,
    description: id,
    props: {},
    inputs: {},
    outputs: {},
    interactions: [],
    hash: 'h1',
    url: `/widgets/${id}.js?h=${extra.hash ?? 'h1'}`,
    hasThumbnail: false,
    ...extra,
  };
}

export function entity(id: string, widget: string, extra: Partial<Entity> = {}): Entity {
  return {
    id,
    parent: null,
    widget,
    props: {},
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visible: true,
    ...extra,
  };
}

/** A widget registry for the fake module loader: url → definition. */
export class FakeWidgets {
  defs = new Map<string, WidgetDefinition>();
  loads: string[] = [];
  failing = new Set<string>();

  set(id: string, def: WidgetDefinition): void {
    this.defs.set(id, def);
  }

  loader = async (url: string): Promise<unknown> => {
    this.loads.push(url);
    const id = /\/widgets\/([^/.?]+)\.js/.exec(url)?.[1] ?? '';
    if (this.failing.has(id)) throw new Error(`cannot load ${id}`);
    const def = this.defs.get(id);
    if (!def) throw new Error(`no fake widget ${id}`);
    return { default: def };
  };
}

/** A box widget: a 0.2 m cube mesh (hit-testable). */
export function boxWidget(size = 0.2, hooks: Partial<WidgetDefinition> & Record<string, unknown> = {}): WidgetDefinition {
  return {
    description: 'box',
    create(ctx) {
      const m = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(size, size, size), ctx.ui.material('#ffffff'));
      m.name = 'body';
      ctx.root.add(m);
      return {};
    },
    ...hooks,
  };
}

export function makeRuntime(extra: Partial<SpaceRuntimeOptions> = {}, netOpts: { open?: boolean } = {}) {
  const { net, ws, timers } = makeNet(netOpts);
  const widgets = new FakeWidgets();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  const rt = new SpaceRuntime({
    scene,
    net,
    role: 'xr',
    camera,
    textFactory: stubTextFactory,
    loadModule: widgets.loader,
    ...extra,
  });
  return { rt, net, ws, timers, widgets, scene, camera };
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));
