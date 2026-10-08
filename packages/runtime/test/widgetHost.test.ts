import { describe, expect, it, vi } from 'vitest';
import type { WidgetContext, WidgetDefinition } from '@evolspace/protocol';
import { boxWidget, flush, makeRuntime, manifest } from './helpers.ts';

function trackingWidget(log: string[], opts: { onProps?: boolean } = {}): WidgetDefinition {
  return {
    description: 'tracker',
    props: {
      size: { type: 'number', default: 0.1, min: 0, max: 1 },
      label: { type: 'string', default: 'hi' },
      mode: { type: 'enum', options: ['a', 'b'] },
    },
    create(ctx) {
      log.push(`create ${JSON.stringify(ctx.props)}`);
      const inst: Record<string, unknown> = {
        update: () => {},
        dispose: () => log.push('dispose'),
        onInput: (p: string, v: unknown) => log.push(`input ${p}=${JSON.stringify(v)}`),
      };
      if (opts.onProps !== false) {
        inst.onProps = (p: Record<string, unknown>, prev: Record<string, unknown>) => log.push(`props ${prev.size}->${p.size}`);
      }
      return inst;
    },
  };
}

describe('WidgetHost', () => {
  it('loads bundles with cache-busting URLs and applies prop defaults/validation', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const log: string[] = [];
    const def = trackingWidget(log);
    widgets.set('t', def);
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('t', { props: def.props!, hash: 'abc', url: '/widgets/t.js' })] });
    ws.serverSend({ type: 'scene.snapshot', scene: { version: 1, workspace: 'w', links: {}, entities: { e1: { id: 'e1', parent: null, widget: 't', props: { size: 5, mode: 'B', extra: true }, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true } } } });
    await rt.whenIdle();
    expect(widgets.loads).toEqual(['http://127.0.0.1:9999/widgets/t.js?h=abc']);
    expect(log).toEqual(['create {"size":1,"mode":"b","extra":true,"label":"hi"}']);
    expect(rt.widgets.record('e1')!.status).toBe('ready');
    // Clamp is reported as a warning log to the server.
    expect(ws.messagesOf('client.log').some((m) => m.message.includes("prop 'size'"))).toBe(true);
  });

  it('waits for the catalog before declaring a widget missing', async () => {
    const { rt, ws, widgets } = makeRuntime();
    widgets.set('box', boxWidget());
    rt.applyPatch([{ op: 'add', entity: { id: 'a', widget: 'box' } }, { op: 'add', entity: { id: 'b', widget: 'nope' } }]);
    await rt.whenIdle();
    expect(rt.widgets.record('a')!.status).toBe('pending');
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('box')] });
    await rt.whenIdle();
    expect(rt.widgets.record('a')!.status).toBe('ready');
    expect(rt.widgets.record('b')!.status).toBe('missing');
    const fb = rt.entityObject('b')!.getObjectByName('fallback');
    expect(fb).toBeDefined();
    expect(ws.messagesOf('client.error').some((m) => m.message.includes("unknown widget 'nope'"))).toBe(true);
    // The widget appears later (agent created it): instantiated.
    widgets.set('nope', boxWidget());
    ws.serverSend({ type: 'widgets.updated', widget: manifest('nope') });
    await rt.whenIdle();
    expect(rt.widgets.record('b')!.status).toBe('ready');
    expect(rt.entityObject('b')!.getObjectByName('fallback')).toBeUndefined();
  });

  it('calls onProps in place, or re-creates when onProps is absent', async () => {
    const { rt, widgets } = makeRuntime();
    const log1: string[] = [];
    const log2: string[] = [];
    widgets.set('with', trackingWidget(log1));
    widgets.set('without', trackingWidget(log2, { onProps: false }));
    rt.widgets.setCatalog([manifest('with', { props: trackingWidget([]).props! }), manifest('without', { props: trackingWidget([]).props! })]);
    rt.applyPatch([{ op: 'add', entity: { id: 'a', widget: 'with' } }, { op: 'add', entity: { id: 'b', widget: 'without' } }]);
    await rt.whenIdle();
    const ctxProps = rt.widgets.record('a')!.state!.props;
    rt.applyPatch([{ op: 'update', id: 'a', patch: { props: { size: 0.5 } } }, { op: 'update', id: 'b', patch: { props: { size: 0.5 } } }]);
    await rt.whenIdle();
    expect(log1).toEqual(['create {"size":0.1,"label":"hi","mode":"a"}', 'props 0.1->0.5']);
    expect(rt.widgets.record('a')!.state!.props).toBe(ctxProps); // same object, mutated
    expect(log2).toEqual(['create {"size":0.1,"label":"hi","mode":"a"}', 'create {"size":0.5,"label":"hi","mode":"a"}', 'dispose']);
    // A no-op props update (same resolved values) does not call onProps.
    rt.applyPatch([{ op: 'update', id: 'a', patch: { props: { size: 0.5 } } }]);
    expect(log1).toHaveLength(2);
  });

  it('hot reload re-creates only instances of the updated widget, preserving inputs', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const created: string[] = [];
    const mk = (tag: string): WidgetDefinition => ({
      description: tag,
      create(ctx) {
        created.push(`${tag}:${ctx.entityId}:${String(ctx.input('in'))}`);
        return { onInput: () => {} };
      },
    });
    widgets.set('a', mk('a1'));
    widgets.set('b', mk('b1'));
    rt.widgets.setCatalog([manifest('a'), manifest('b')]);
    rt.applyPatch([
      { op: 'add', entity: { id: 'x', widget: 'a' } },
      { op: 'add', entity: { id: 'y', widget: 'a' } },
      { op: 'add', entity: { id: 'z', widget: 'b' } },
    ]);
    await rt.whenIdle();
    rt.widgets.deliverInput('x', 'in', 42);
    created.length = 0;
    widgets.set('a', mk('a2'));
    ws.serverSend({ type: 'widgets.updated', widget: manifest('a', { hash: 'h2', url: '/widgets/a.js?h=h2' }) });
    await rt.whenIdle();
    expect(created.sort()).toEqual(['a2:x:42', 'a2:y:undefined']);
    expect(widgets.loads.filter((u) => u.includes('/a.js'))).toHaveLength(2);
    // Same hash again → nothing happens.
    ws.serverSend({ type: 'widgets.updated', widget: manifest('a', { hash: 'h2', url: '/widgets/a.js?h=h2' }) });
    await rt.whenIdle();
    expect(created).toHaveLength(2);
  });

  it('isolates errors: create/update throws → fallback + client.error + toast, others keep running', async () => {
    const { rt, ws, widgets } = makeRuntime();
    widgets.set('bad', { description: 'bad', create() { throw new Error('kaput'); } });
    let ticks = 0;
    widgets.set('flaky', {
      description: 'flaky',
      create: () => ({ update() { if (++ticks === 2) throw new Error('tick fail'); } }),
    });
    widgets.set('good', boxWidget());
    rt.widgets.setCatalog([manifest('bad', { size: [0.5, 0.4, 0.1] }), manifest('flaky'), manifest('good')]);
    rt.applyPatch([
      { op: 'add', entity: { id: 'b', widget: 'bad' } },
      { op: 'add', entity: { id: 'f', widget: 'flaky' } },
      { op: 'add', entity: { id: 'g', widget: 'good' } },
    ]);
    await rt.whenIdle();
    expect(rt.widgets.record('b')!.status).toBe('error');
    const box = rt.entityObject('b')!.getObjectByName('fallback-box')!;
    expect(box.scale.toArray()).toEqual([0.5, 0.4, 0.1]);
    rt.update(0.016, 0);
    rt.update(0.016, 0.016);
    rt.update(0.016, 0.032);
    expect(rt.widgets.record('f')!.status).toBe('error');
    expect(ticks).toBe(2); // not called again after failing
    expect(rt.widgets.record('g')!.status).toBe('ready');
    const errs = ws.messagesOf('client.error');
    expect(errs.find((e) => e.entity === 'b')!.message).toContain('kaput');
    expect(errs.find((e) => e.entity === 'f')!.message).toContain('tick fail');
    expect(errs.find((e) => e.entity === 'b')!.stack).toContain('Error');
    expect(rt.system.toasts.messages().some((m) => m.includes('kaput'))).toBe(true);
  });

  it('module load failures fall back and retry on rebuild', async () => {
    const { rt, ws, widgets } = makeRuntime();
    widgets.failing.add('w');
    widgets.set('w', boxWidget());
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'e', widget: 'w' } }]);
    await rt.whenIdle();
    expect(rt.widgets.record('e')!.status).toBe('error');
    widgets.failing.delete('w');
    ws.serverSend({ type: 'widgets.updated', widget: manifest('w', { hash: 'h9' }) });
    await rt.whenIdle();
    expect(rt.widgets.record('e')!.status).toBe('ready');
  });

  it('discards a slow create when the entity is removed meanwhile', async () => {
    const { rt, widgets } = makeRuntime();
    let release!: () => void;
    const disposed = vi.fn();
    widgets.set('slow', {
      description: 'slow',
      create: () => new Promise((r) => { release = () => r({ dispose: disposed }); }),
    });
    rt.widgets.setCatalog([manifest('slow')]);
    rt.applyPatch([{ op: 'add', entity: { id: 's', widget: 'slow' } }]);
    await flush();
    rt.applyPatch([{ op: 'remove', id: 's' }]);
    release();
    await rt.whenIdle();
    expect(disposed).toHaveBeenCalledOnce();
    expect(rt.widgets.record('s')).toBeUndefined();
  });

  it('ctx.setProps is optimistic, throttled, and does not echo into onProps', async () => {
    const { rt, ws, widgets } = makeRuntime();
    let ctx!: WidgetContext;
    const onProps = vi.fn();
    widgets.set('slider', { description: 's', props: { value: { type: 'number', default: 0 } }, create(c) { ctx = c; return { onProps }; } });
    rt.widgets.setCatalog([manifest('slider', { props: { value: { type: 'number', default: 0 } } })]);
    rt.applyPatch([{ op: 'add', entity: { id: 's', widget: 'slider' } }]);
    await rt.whenIdle();
    ws.clearSent();
    ctx.setProps({ value: 0.1 });
    ctx.setProps({ value: 0.2 });
    ctx.setProps({ value: 0.3 });
    expect(rt.entity('s')!.props.value).toBe(0.3);
    expect(ctx.props.value).toBe(0.3);
    let ops = ws.messagesOf('scene.ops');
    expect(ops).toHaveLength(1); // leading edge only
    expect(ops[0]).toMatchObject({ source: 'widget', ops: [{ op: 'update', id: 's', patch: { props: { value: 0.1 } } }] });
    rt.writer.flush(performance.now() + 500);
    ops = ws.messagesOf('scene.ops');
    expect(ops).toHaveLength(2);
    expect(ops[1].ops[0]).toMatchObject({ patch: { props: { value: 0.3 } } });
    // Delayed echo of the intermediate value is suppressed (field owned locally).
    ws.serverSend({ type: 'scene.patch', version: 2, source: 'widget', ops: [{ op: 'update', id: 's', patch: { props: { value: 0.1 } } }] });
    expect(rt.entity('s')!.props.value).toBe(0.3);
    expect(onProps).not.toHaveBeenCalled();
  });

  it('spawnChild adds a persisted child entity; handles update and remove it', async () => {
    const { rt, ws, widgets } = makeRuntime();
    let ctx!: WidgetContext;
    widgets.set('parent', { description: 'p', create(c) { ctx = c; return {}; } });
    widgets.set('box', boxWidget());
    rt.widgets.setCatalog([manifest('parent'), manifest('box')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'p', widget: 'parent' } }]);
    await rt.whenIdle();
    const h = ctx.spawnChild('box', { color: '#f00' }, { position: [0, 0.2, 0] }, 'kid');
    const add = ws.messagesOf('scene.ops').at(-1)!;
    expect(add.ops[0]).toMatchObject({ op: 'add', entity: { id: h.entityId, parent: 'p', widget: 'box', name: 'kid' } });
    expect(rt.entityObject(h.entityId)!.parent).toBe(rt.entityObject('p'));
    h.setTransform({ position: [0, 0.3, 0] });
    expect(rt.entityObject(h.entityId)!.position.y).toBeCloseTo(0.3);
    h.remove();
    expect(rt.entity(h.entityId)).toBeUndefined();
    expect(ws.messagesOf('scene.ops').at(-1)!.ops[0]).toEqual({ op: 'remove', id: h.entityId });
  });

  it('context: channels subscriptions are released on dispose; events, askAgent, error', async () => {
    const { rt, ws, widgets } = makeRuntime();
    let ctx!: WidgetContext;
    const seen: unknown[] = [];
    widgets.set('w', { description: 'w', create(c) { ctx = c; c.channels.subscribe('weather', (v) => seen.push(v)); return {}; } });
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'e', widget: 'w' } }]);
    await rt.whenIdle();
    await flush();
    expect(ws.messagesOf('channel.subscribe').flatMap((m) => m.channels)).toContain('weather');
    ws.serverSend({ type: 'channel.value', channel: 'weather', value: { t: 20 }, seq: 1 });
    expect(seen).toEqual([{ t: 20 }]);
    expect(ctx.channels.get('weather')).toEqual({ t: 20 });
    ctx.event('clicked', { n: 1 });
    ctx.askAgent('make it blue');
    ctx.error('bad data', { row: 3 });
    expect(ws.messagesOf('widget.event')[0]).toEqual({ type: 'widget.event', entity: 'e', widget: 'w', name: 'clicked', data: { n: 1 } });
    expect(ws.messagesOf('agent.ask')[0]).toEqual({ type: 'agent.ask', text: 'make it blue', context: { entity: 'e', widget: 'w' } });
    expect(ws.messagesOf('client.error').at(-1)).toMatchObject({ message: 'bad data', entity: 'e', widget: 'w' });
    expect(ctx.isMirror).toBe(false);
    expect(ctx.user.head.position).toHaveLength(3);

    rt.applyPatch([{ op: 'remove', id: 'e' }]);
    await flush();
    expect(ws.messagesOf('channel.unsubscribe').flatMap((m) => m.channels)).toContain('weather');
    ws.serverSend({ type: 'channel.value', channel: 'weather', value: { t: 21 }, seq: 2 });
    expect(seen).toHaveLength(1);
    // Calls on a dead context are ignored.
    const before = ws.sent.length;
    ctx.event('late');
    expect(ws.sent.length).toBe(before);
  });

  it('cleans up widget-owned GPU resources but not shared UiKit resources', async () => {
    const { rt, widgets } = makeRuntime();
    let geom!: { dispose: () => void };
    let shared!: { dispose: () => void };
    widgets.set('w', boxWidget(0.2, {
      create(ctx: WidgetContext) {
        const g = new ctx.THREE.BoxGeometry(1, 1, 1);
        const mat = ctx.ui.material('#123456');
        geom = g;
        shared = mat;
        ctx.root.add(new ctx.THREE.Mesh(g, mat));
        return {};
      },
    }));
    rt.widgets.setCatalog([manifest('w')]);
    rt.applyPatch([{ op: 'add', entity: { id: 'e', widget: 'w' } }]);
    await rt.whenIdle();
    const gd = vi.spyOn(geom, 'dispose');
    const md = vi.spyOn(shared, 'dispose');
    rt.applyPatch([{ op: 'remove', id: 'e' }]);
    expect(gd).toHaveBeenCalled();
    expect(md).not.toHaveBeenCalled();
  });

  it('a widget that never built (empty url) shows the build error instead of importing the page', async () => {
    const { rt, ws, widgets } = makeRuntime();
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('broken', { hash: '', url: '', error: 'SyntaxError: Unexpected token (3:4)' })] });
    rt.applyPatch([{ op: 'add', entity: { id: 'b', widget: 'broken' } }]);
    await rt.whenIdle();
    const rec = rt.widgets.record('b')!;
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('no successful build: SyntaxError');
    expect(widgets.loads).toEqual([]);
    expect(ws.messagesOf('client.error').some((m) => m.message.includes('no successful build'))).toBe(true);
    // A successful rebuild brings it back.
    widgets.set('broken', boxWidget());
    ws.serverSend({ type: 'widgets.updated', widget: manifest('broken', { hash: 'h2' }) });
    await rt.whenIdle();
    expect(rt.widgets.record('b')!.status).toBe('ready');
  });

  it('missing widgets carry an error message (mirror reports it)', async () => {
    const { rt, ws } = makeRuntime();
    ws.serverSend({ type: 'widgets.catalog', widgets: [] });
    rt.applyPatch([{ op: 'add', entity: { id: 'x', widget: 'ghost' } }]);
    await rt.whenIdle();
    expect(rt.widgets.record('x')!.status).toBe('missing');
    expect(rt.widgets.record('x')!.error).toContain("unknown widget 'ghost'");
  });

  it('forgets widgets that disappear from a new catalog', async () => {
    const { rt, ws, widgets } = makeRuntime();
    widgets.set('box', boxWidget());
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('box'), manifest('old')] });
    expect(rt.widgets.manifest('old')).toBeDefined();
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('box')] });
    expect(rt.widgets.manifest('old')).toBeUndefined();
    expect(rt.widgets.catalog.map((m) => m.id)).toEqual(['box']);
  });

  it('props changed while an async create() runs are applied once it finishes', async () => {
    const { rt, ws, widgets } = makeRuntime();
    const seen: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    widgets.set('slow', {
      description: 'slow',
      props: { n: { type: 'number', default: 0 } },
      async create(ctx) {
        await gate;
        seen.push(['create', ctx.props.n]);
        return { onProps: (p: Record<string, unknown>) => seen.push(['props', p.n]) };
      },
    });
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('slow', { props: { n: { type: 'number', default: 0 } } })] });
    rt.applyPatch([{ op: 'add', entity: { id: 's', widget: 'slow', props: { n: 1 } } }]);
    await flush();
    rt.applyPatch([{ op: 'update', id: 's', patch: { props: { n: 2 } } }]);
    release();
    await rt.whenIdle();
    expect(seen).toEqual([['create', 1], ['props', 2]]);
    expect(rt.widgets.record('s')!.state!.props.n).toBe(2);
  });

  it('spawnChild ids stay within the server id rules', async () => {
    const { rt, ws, widgets } = makeRuntime();
    let ctxRef!: WidgetContext;
    widgets.set('p', { description: 'p', create(ctx) { ctxRef = ctx; return {}; } });
    ws.serverSend({ type: 'widgets.catalog', widgets: [manifest('p')] });
    rt.applyPatch([{ op: 'add', entity: { id: 'parent', widget: 'p' } }]);
    await rt.whenIdle();
    const h = ctxRef.spawnChild('a-very-long-widget-name-that-goes-on-and-on-and-on-forever', {});
    expect(h.entityId).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  });
});
