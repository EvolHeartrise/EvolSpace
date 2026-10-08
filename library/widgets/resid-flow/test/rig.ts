// Multi-widget test rig: instantiates a prefab's entities with real widget
// definitions, a shared in-memory channel bus (local publishes deliver
// synchronously, like the runtime's ChannelHub) and the runtime's real
// LinkEngine for the prefab's links. Input values that arrive before an
// instance exists are stored and replayed after create(), as the runtime's
// WidgetHost does. Enough to test dataflow, not rendering.

import * as THREE from 'three';
import type { ChannelValue, Link, Prefab, WidgetContext, WidgetDefinition, WidgetInstance } from '@evolspace/protocol';
import { LinkEngine } from '../../../../packages/runtime/src/links/LinkEngine.ts';
import { makeUi, propDefaults, TEST_THEME } from './fake-ctx.ts';

export interface RigEntity {
  id: string;
  def: WidgetDefinition;
  ctx: WidgetContext;
  inst: WidgetInstance | null;
  inputs: Map<string, unknown>;
}

export class Rig {
  /** Channel values as the server holds them. */
  readonly values = new Map<string, ChannelValue>();
  /** Every publish that would reach the server (widget publishes and port→channel links). */
  readonly published: Array<{ name: string; value: unknown }> = [];
  readonly emitted: Array<{ entity: string; port: string; value: unknown }> = [];
  readonly errors: string[] = [];
  readonly entities = new Map<string, RigEntity>();
  readonly links: LinkEngine;
  private listeners = new Map<string, Set<(v: ChannelValue) => void>>();

  /** `server`: channel values already on the server (e.g. from a previous session). */
  constructor(private prefab: Prefab, private defs: Record<string, WidgetDefinition>, server: Record<string, ChannelValue> = {}) {
    for (const [k, v] of Object.entries(server)) this.values.set(k, v);
    this.links = new LinkEngine({
      deliverInput: (entity, port, value) => this.deliverInput(entity, port, value),
      publish: (channel, value) => this.publish(channel, value),
      subscribe: (channel, cb) => this.subscribe(channel, cb),
      reportError: (message) => { this.errors.push(message); },
    });
    const links: Record<string, Link> = {};
    prefab.links.forEach((l, i) => { links[`l${i}`] = { ...l, id: `l${i}`, enabled: l.enabled ?? true }; });
    this.links.setLinks(links);
  }

  /** A value arriving from the server (another client, Claude, the interp producer). */
  serverPublish(name: string, value: ChannelValue): void {
    this.values.set(name, value);
    for (const cb of [...(this.listeners.get(name) ?? [])]) cb(value);
  }

  publish(name: string, value: unknown): void {
    this.published.push({ name, value });
    this.serverPublish(name, value);
  }

  subscribe(name: string, cb: (v: ChannelValue) => void): () => void {
    let s = this.listeners.get(name);
    if (!s) this.listeners.set(name, (s = new Set()));
    s.add(cb);
    if (this.values.has(name)) cb(this.values.get(name));
    return () => { s!.delete(cb); };
  }

  private deliverInput(entity: string, port: string, value: unknown): void {
    // Like WidgetHost records, entities exist (and keep inputs) before their widget is created.
    let e = this.entities.get(entity);
    if (!e) {
      const spec = this.prefab.entities.find((x) => x.id === entity);
      if (!spec) return;
      e = { id: entity, def: this.defs[spec.widget], ctx: null as unknown as WidgetContext, inst: null, inputs: new Map() };
      this.entities.set(entity, e);
    }
    e.inputs.set(port, value);
    e.inst?.onInput?.(port, value);
  }

  /** Create one prefab entity (order is up to the test: widget bundles load in any order). */
  async create(id: string): Promise<RigEntity> {
    const spec = this.prefab.entities.find((x) => x.id === id);
    if (!spec) throw new Error(`no entity ${id}`);
    const def = this.defs[spec.widget];
    let e = this.entities.get(id);
    if (!e) {
      e = { id, def, ctx: null as unknown as WidgetContext, inst: null, inputs: new Map() };
      this.entities.set(id, e);
    }
    const ent = e;
    const root = new THREE.Group();
    ent.ctx = {
      THREE,
      root,
      entityId: id,
      props: { ...propDefaults(def), ...(spec.props ?? {}) },
      theme: TEST_THEME,
      ui: makeUi(),
      channels: {
        get: (n) => this.values.get(n),
        subscribe: (n, cb) => this.subscribe(n, cb),
        publish: (n, v) => this.publish(n, v),
      },
      emit: (port, value) => {
        this.emitted.push({ entity: id, port, value });
        this.links.emit(id, port, value);
      },
      input: (port) => (ent.inputs.has(port) ? ent.inputs.get(port) : def.inputs?.[port]?.default),
      setProps: (patch) => { Object.assign(ent.ctx.props, patch); },
      interactive: () => {},
      spawnChild: () => { throw new Error('not supported'); },
      event: () => {},
      askAgent: () => {},
      log: () => {},
      error: (m) => { this.errors.push(m); },
      isMirror: false,
      user: { head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} },
    };
    const inst = await def.create(ent.ctx);
    ent.inst = inst;
    // WidgetHost replays inputs received before/while creating.
    for (const [port, v] of ent.inputs) inst.onInput?.(port, v);
    return ent;
  }

  frame(t = 0.5): void {
    this.links.beginFrame();
    for (const e of this.entities.values()) e.inst?.update?.(1 / 72, t);
  }
}
