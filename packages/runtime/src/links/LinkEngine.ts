// Client-side dataflow over scene links:
//   port → port      local, synchronous, no server round trip
//   channel → port   server data bus values into widget inputs
//   port → channel   widget outputs published to the data bus
//   channel → channel  republish (with optional transform)
//
// Transforms: `x => expr` compiled once; a transform returning `undefined`
// drops the value (so transforms can filter). Errors are reported once per
// link/message and the value is dropped.
//
// Feedback-loop guard: a link may not re-enter itself synchronously (A→B→A
// stops at the second hop), and each link fires at most `maxFiresPerFrame`
// times per frame, so a cycle through async paths can't snowball either.
// Values over the cap are not lost: the latest one is delivered at the next
// frame (dataflow is latest-value-wins). If frames stall (rAF paused while
// the headset is off), the counters reset by time instead.

import type { Link, PortRef } from '@evolspace/protocol';
import { compileTransform, type CompiledTransform } from './compile.ts';
import { Deduper, now } from '../util/rate.ts';

export interface LinkTargets {
  deliverInput(entity: string, port: string, value: unknown): void;
  publish(channel: string, value: unknown): void;
  subscribe(channel: string, cb: (value: unknown) => void): () => void;
  reportError(message: string, detail: { link: string; entity?: string }): void;
}

export interface LinkEngineOptions {
  maxFiresPerFrame?: number;
}

interface ActiveLink {
  link: Link;
  sig: string;
  transform: CompiledTransform | null;
  unsubscribe: (() => void) | null;
}

const portKey = (entity: string, port: string) => `${entity}\u0000${port}`;

export class LinkEngine {
  private links = new Map<string, ActiveLink>();
  private byPort = new Map<string, ActiveLink[]>();
  private lastOutputs = new Map<string, unknown>();
  private active = new Set<string>();
  private fires = new Map<string, number>();
  /** Latest over-cap input per link, delivered at the next beginFrame(). */
  private deferred = new Map<string, unknown>();
  private frameAt = now();
  private readonly maxFires: number;
  private errors = new Deduper(10_000);

  constructor(private targets: LinkTargets, opts: LinkEngineOptions = {}) {
    this.maxFires = opts.maxFiresPerFrame ?? 32;
  }

  /** Reset per-frame fire counters. Call once per frame. */
  beginFrame(): void {
    this.frameAt = now();
    if (this.fires.size) this.fires.clear();
    if (this.deferred.size) {
      const due = [...this.deferred];
      this.deferred.clear();
      for (const [id, x] of due) {
        const a = this.links.get(id);
        if (a) this.fire(a, x);
      }
    }
  }

  /** Sync with the scene's link table (diffs subscriptions; unchanged links are untouched). */
  setLinks(links: Record<string, Link>): void {
    const fresh: ActiveLink[] = [];
    for (const [id, a] of this.links) {
      const l = links[id];
      if (!l || signature(l) !== a.sig) {
        a.unsubscribe?.();
        this.links.delete(id);
        this.deferred.delete(id);
      }
    }
    for (const [id, l] of Object.entries(links)) {
      if (this.links.has(id)) {
        this.links.get(id)!.link = l;
        continue;
      }
      const a: ActiveLink = { link: l, sig: signature(l), transform: null, unsubscribe: null };
      if (l.transform && l.transform.trim()) {
        a.transform = compileTransform(l.transform);
        if (a.transform.error) this.report(l, a.transform.error);
      }
      this.links.set(id, a);
      fresh.push(a);
    }
    this.reindex();
    for (const a of fresh) this.activate(a);
  }

  private reindex(): void {
    this.byPort.clear();
    for (const a of this.links.values()) {
      const f = a.link.from;
      if (f.kind !== 'port' || !a.link.enabled) continue;
      const k = portKey(f.entity, f.port);
      let list = this.byPort.get(k);
      if (!list) this.byPort.set(k, (list = []));
      list.push(a);
    }
  }

  private activate(a: ActiveLink): void {
    const l = a.link;
    if (!l.enabled) return;
    if (l.from.kind === 'channel') {
      a.unsubscribe = this.targets.subscribe(l.from.channel, (v) => this.fire(a, v));
    } else {
      // A newly linked output delivers its latest value right away.
      const k = portKey(l.from.entity, l.from.port);
      if (this.lastOutputs.has(k)) this.fire(a, this.lastOutputs.get(k));
    }
  }

  /** A widget emitted on an output port. */
  emit(entity: string, port: string, value: unknown): void {
    const k = portKey(entity, port);
    this.lastOutputs.set(k, value);
    const list = this.byPort.get(k);
    if (!list) return;
    for (let i = 0; i < list.length; i++) this.fire(list[i], value);
  }

  lastOutput(entity: string, port: string): unknown {
    return this.lastOutputs.get(portKey(entity, port));
  }

  /** Links whose target is this entity's input port (for diagnostics / input defaults). */
  linksInto(entity: string): Link[] {
    const out: Link[] = [];
    for (const a of this.links.values()) if (a.link.to.kind === 'port' && a.link.to.entity === entity) out.push(a.link);
    return out;
  }

  /** Forget cached outputs of a removed entity. */
  forgetEntity(entity: string): void {
    const prefix = entity + '\u0000';
    for (const k of [...this.lastOutputs.keys()]) if (k.startsWith(prefix)) this.lastOutputs.delete(k);
  }

  private fire(a: ActiveLink, x: unknown): void {
    const l = a.link;
    if (!l.enabled) return;
    if (this.active.has(l.id)) {
      this.report(l, `feedback loop: link ${describe(l.from)} → ${describe(l.to)} re-entered itself; value dropped`);
      return;
    }
    if (this.fires.size && now() - this.frameAt > STALL_MS) {
      // No frames for a while (render loop paused): count per time window instead.
      this.fires.clear();
      this.frameAt = now();
    }
    const n = (this.fires.get(l.id) ?? 0) + 1;
    this.fires.set(l.id, n);
    if (n > this.maxFires) {
      if (n === this.maxFires + 1) this.report(l, `link fired more than ${this.maxFires}× in one frame (feedback loop?); deferring to the next frame`);
      this.deferred.set(l.id, x);
      return;
    }
    let v = x;
    if (a.transform) {
      if (!a.transform.fn) return; // compile error already reported
      try {
        v = a.transform.fn(x);
      } catch (err) {
        this.report(l, `transform "${l.transform}" threw: ${(err as Error)?.message ?? String(err)}`);
        return;
      }
      if (v === undefined) return;
    }
    this.active.add(l.id);
    try {
      const to = l.to;
      if (to.kind === 'port') this.targets.deliverInput(to.entity, to.port, v);
      else this.targets.publish(to.channel, v);
    } finally {
      this.active.delete(l.id);
    }
  }

  private report(l: Link, message: string): void {
    if (!this.errors.allow(`${l.id}|${message}`)) return;
    const entity = l.to.kind === 'port' ? l.to.entity : l.from.kind === 'port' ? l.from.entity : undefined;
    this.targets.reportError(`link ${l.id}: ${message}`, { link: l.id, entity });
  }

  dispose(): void {
    for (const a of this.links.values()) a.unsubscribe?.();
    this.links.clear();
    this.byPort.clear();
    this.lastOutputs.clear();
    this.deferred.clear();
  }
}

const STALL_MS = 250;

function signature(l: Link): string {
  return JSON.stringify([l.from, l.to, l.transform ?? '', l.enabled]);
}

function describe(p: PortRef): string {
  return p.kind === 'port' ? `${p.entity}.${p.port}` : `#${p.channel}`;
}
