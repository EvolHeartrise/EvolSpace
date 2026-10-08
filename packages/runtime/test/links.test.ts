import { describe, expect, it } from 'vitest';
import type { Link, WidgetDefinition } from '@evolspace/protocol';
import { LinkEngine, type LinkTargets } from '../src/links/LinkEngine.ts';
import { compileTransform } from '../src/links/compile.ts';
import { flush, makeRuntime, manifest } from './helpers.ts';

function harness() {
  const delivered: Array<[string, string, unknown]> = [];
  const published: Array<[string, unknown]> = [];
  const errors: string[] = [];
  const subs = new Map<string, Set<(v: unknown) => void>>();
  let engine!: LinkEngine;
  // Optional reaction hook to build feedback loops: input → emit.
  const reactions = new Map<string, (v: unknown) => void>();
  const targets: LinkTargets = {
    deliverInput(e, p, v) {
      delivered.push([e, p, v]);
      reactions.get(`${e}.${p}`)?.(v);
    },
    publish(ch, v) {
      published.push([ch, v]);
      for (const cb of subs.get(ch) ?? []) cb(v);
    },
    subscribe(ch, cb) {
      let s = subs.get(ch);
      if (!s) subs.set(ch, (s = new Set()));
      s.add(cb);
      return () => s!.delete(cb);
    },
    reportError(m) {
      errors.push(m);
    },
  };
  engine = new LinkEngine(targets, { maxFiresPerFrame: 5 });
  return { engine, delivered, published, errors, subs, reactions };
}

const L = (id: string, from: Link['from'], to: Link['to'], transform?: string, enabled = true): Link => ({ id, from, to, transform, enabled });
const port = (entity: string, p: string) => ({ kind: 'port' as const, entity, port: p });
const chan = (channel: string) => ({ kind: 'channel' as const, channel });

describe('compileTransform', () => {
  it('compiles once and caches; reports syntax errors', () => {
    const a = compileTransform('x * 2');
    expect(a.fn!(3)).toBe(6);
    expect(compileTransform('x * 2')).toBe(a);
    const bad = compileTransform('x +* 2');
    expect(bad.fn).toBeNull();
    expect(bad.error).toMatch(/does not compile/);
  });
});

describe('LinkEngine', () => {
  it('port → port with transform, and filtering via undefined', () => {
    const h = harness();
    h.engine.setLinks({
      l1: L('l1', port('a', 'out'), port('b', 'in'), 'Math.round(x * 10)'),
      l2: L('l2', port('a', 'out'), port('c', 'in'), 'x > 0.5 ? x : undefined'),
    });
    h.engine.emit('a', 'out', 0.26);
    h.engine.emit('a', 'out', 0.75);
    expect(h.delivered).toEqual([
      ['b', 'in', 3],
      ['b', 'in', 8],
      ['c', 'in', 0.75],
    ]);
  });

  it('channel → port subscribes; port → channel publishes; removal unsubscribes', () => {
    const h = harness();
    h.engine.setLinks({
      in: L('in', chan('weather.t'), port('w', 'temp')),
      out: L('out', port('s', 'value'), chan('ui.value'), 'x * 100'),
    });
    expect(h.subs.get('weather.t')!.size).toBe(1);
    h.engine.emit('s', 'value', 0.5);
    expect(h.published).toEqual([['ui.value', 50]]);
    h.engine.setLinks({ out: L('out', port('s', 'value'), chan('ui.value'), 'x * 100') });
    expect(h.subs.get('weather.t')!.size).toBe(0);
  });

  it('delivers the latest output when a link is added later', () => {
    const h = harness();
    h.engine.emit('a', 'out', 7);
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in')) });
    expect(h.delivered).toEqual([['b', 'in', 7]]);
  });

  it('disabled links do nothing; changed links are re-activated', () => {
    const h = harness();
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in'), undefined, false) });
    h.engine.emit('a', 'out', 1);
    expect(h.delivered).toEqual([]);
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in'), 'x + 1', true) });
    expect(h.delivered).toEqual([['b', 'in', 2]]); // last output replayed through the new link
  });

  it('reports compile and runtime errors once, dropping the value', () => {
    const h = harness();
    h.engine.setLinks({
      c: L('c', port('a', 'out'), port('b', 'in'), 'x +* 1'),
      r: L('r', port('a', 'out'), port('d', 'in'), 'x.foo.bar'),
    });
    h.engine.emit('a', 'out', 1);
    h.engine.emit('a', 'out', 2);
    expect(h.delivered).toEqual([]);
    expect(h.errors.filter((e) => e.includes('does not compile'))).toHaveLength(1);
    expect(h.errors.filter((e) => e.includes('threw'))).toHaveLength(1);
  });

  it('breaks synchronous feedback loops (A → B → A)', () => {
    const h = harness();
    h.engine.setLinks({
      ab: L('ab', port('a', 'out'), port('b', 'in')),
      ba: L('ba', port('b', 'out'), port('a', 'in'), 'x + 1'),
    });
    h.reactions.set('b.in', (v) => h.engine.emit('b', 'out', v));
    h.reactions.set('a.in', (v) => h.engine.emit('a', 'out', v));
    h.engine.emit('a', 'out', 0);
    expect(h.delivered).toEqual([['b', 'in', 0], ['a', 'in', 1]]);
    expect(h.errors.some((e) => e.includes('feedback loop'))).toBe(true);
  });

  it('caps fires per link per frame (async / channel loops)', () => {
    const h = harness();
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in')) });
    for (let i = 0; i < 20; i++) h.engine.emit('a', 'out', i);
    expect(h.delivered).toHaveLength(5);
    expect(h.errors.filter((e) => e.includes('more than 5'))).toHaveLength(1);
    // The latest over-cap value is not lost: it arrives at the next frame.
    h.engine.beginFrame();
    expect(h.delivered).toHaveLength(6);
    expect(h.delivered.at(-1)).toEqual(['b', 'in', 19]);
    h.engine.emit('a', 'out', 99);
    expect(h.delivered.at(-1)).toEqual(['b', 'in', 99]);
  });

  it('resets the per-frame cap by time when frames stall (render loop paused)', async () => {
    const h = harness();
    h.engine.setLinks({ l: L('l', chan('c'), port('b', 'in')) });
    const push = (v: number) => { for (const cb of h.subs.get('c')!) cb(v); };
    for (let i = 0; i < 8; i++) push(i);
    expect(h.delivered).toHaveLength(5);
    await new Promise((r) => setTimeout(r, 300)); // no beginFrame() meanwhile
    push(42);
    expect(h.delivered.at(-1)).toEqual(['b', 'in', 42]);
  });

  it('drops deferred values of links that were removed', () => {
    const h = harness();
    h.engine.setLinks({ l: L('l', port('a', 'out'), port('b', 'in')) });
    for (let i = 0; i < 8; i++) h.engine.emit('a', 'out', i);
    h.engine.setLinks({});
    h.engine.beginFrame();
    expect(h.delivered).toHaveLength(5);
  });

  it('channel → channel loop through publish is stopped', () => {
    const h = harness();
    h.engine.setLinks({
      ab: L('ab', chan('a'), chan('b')),
      ba: L('ba', chan('b'), chan('a')),
    });
    // Simulate a publish on 'a' arriving from the server.
    for (const cb of h.subs.get('a')!) cb(1);
    expect(h.published).toEqual([['b', 1], ['a', 1]]);
    expect(h.errors.some((e) => e.includes('feedback loop'))).toBe(true);
  });
});

describe('links through the runtime', () => {
  it('widget emit → link → other widget onInput, and channel values → ports', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const inputs: Array<[string, unknown]> = [];
    let emit!: (p: string, v: unknown) => void;
    const src: WidgetDefinition = { description: 'src', outputs: { value: { type: 'number' } }, create(ctx) { emit = ctx.emit; return {}; } };
    const dst: WidgetDefinition = {
      description: 'dst',
      inputs: { in: { type: 'number', default: -1 } },
      create(ctx) {
        inputs.push(['initial', ctx.input('in')]);
        return { onInput: (p, v) => inputs.push([p, v]) };
      },
    };
    widgets.set('src', src);
    widgets.set('dst', dst);
    rt.widgets.setCatalog([manifest('src'), manifest('dst', { inputs: { in: { type: 'number', default: -1 } } })]);
    rt.applyPatch([
      { op: 'add', entity: { id: 's', widget: 'src' } },
      { op: 'add', entity: { id: 'd', widget: 'dst' } },
      { op: 'link.add', link: { id: 'l1', from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'port', entity: 'd', port: 'in' }, transform: 'x * 2' } },
      { op: 'link.add', link: { id: 'l2', from: { kind: 'channel', channel: 'ext' }, to: { kind: 'port', entity: 'd', port: 'in' } } },
      { op: 'link.add', link: { id: 'l3', from: { kind: 'port', entity: 's', port: 'value' }, to: { kind: 'channel', channel: 'ui.out' } } },
    ]);
    await rt.whenIdle();
    await flush();
    expect(inputs).toEqual([['initial', -1]]);
    emit('value', 5);
    expect(inputs.at(-1)).toEqual(['in', 10]);
    expect(rt.widgets.inputValue('d', 'in')).toBe(10);
    expect(ws.messagesOf('channel.publish')).toEqual([{ type: 'channel.publish', channel: 'ui.out', value: 5 }]);
    expect(ws.messagesOf('channel.subscribe').flatMap((m) => m.channels)).toContain('ext');
    ws.serverSend({ type: 'channel.value', channel: 'ext', value: 3, seq: 1 });
    expect(inputs.at(-1)).toEqual(['in', 3]);
  });
});
