import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeTensorFrame, makeTensor, type SceneState, type SceneSummary, type WidgetManifest } from '@evolspace/protocol';
import { ALL_TOOLS } from '../src/tools/index.ts';
import { deadUrl, EventLog, FakeEvol, PNG_1x1 } from './fake-evol.ts';
import { connectBridge } from './helpers.ts';

const SCENE: SceneState = {
  version: 7,
  workspace: 'default',
  entities: {
    'e-1': { id: 'e-1', parent: null, name: 'lens', widget: 'slider', props: { value: 3 }, transform: { position: [0, 1.2, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true },
    'e-2': { id: 'e-2', parent: 'e-1', widget: 'text', props: { text: 'Layer 3' }, transform: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true },
    'e-3': { id: 'e-3', parent: null, widget: 'box', props: {}, transform: { position: [1, 1, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true },
  },
  links: {
    'l-1': { id: 'l-1', from: { kind: 'port', entity: 'e-1', port: 'value' }, to: { kind: 'channel', channel: 'interp.ctl.layer' }, enabled: true },
    'l-2': { id: 'l-2', from: { kind: 'port', entity: 'e-1', port: 'value' }, to: { kind: 'port', entity: 'e-2', port: 'text' }, transform: '`Layer ${x}`', enabled: true },
  },
};

const SUMMARY: SceneSummary = {
  version: 7,
  workspace: 'default',
  roots: [
    { id: 'e-1', name: 'lens', widget: 'slider', position: [0, 1.2, -1], props: { value: 3 }, children: [{ id: 'e-2', widget: 'text', position: [0, 0.1, 0], props: { text: 'Layer 3' } }] },
    { id: 'e-3', widget: 'box', position: [1, 1, -1], props: {} },
  ],
  links: [
    { id: 'l-1', from: 'e-1.value', to: 'channel:interp.ctl.layer' }, // server's summary format
    { id: 'l-2', from: 'e-1.value', to: 'e-2.text', transform: '`Layer ${x}`' },
  ],
};

const manifest = (id: string, extra: Partial<WidgetManifest> = {}): WidgetManifest => ({
  id, description: `${id} widget`, props: {}, inputs: {}, outputs: {}, interactions: [], hash: 'h' + id, url: `/widgets/${id}.js`, hasThumbnail: false, ...extra,
});
const CATALOG: WidgetManifest[] = [
  manifest('slider', {
    description: 'A draggable slider.',
    props: { value: { type: 'number', default: 0, min: 0, max: 12 }, label: { type: 'string' } },
    inputs: { value: { type: 'number' } },
    outputs: { value: { type: 'number', description: 'current value' } },
  }),
  manifest('text', { props: { text: { type: 'string' } }, inputs: { text: { type: 'string' } } }),
  manifest('box', { error: 'widget.ts:3:1: ERROR: Unexpected "}"\nmore' }),
];

let fake: FakeEvol;
let log: EventLog;
let bridge: Awaited<ReturnType<typeof connectBridge>>;

beforeAll(async () => {
  fake = await new FakeEvol().start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(async () => {
  fake.requests.length = 0;
  fake.routes.clear();
  log = new EventLog();
  fake
    .on('GET /api/scene', { json: SCENE })
    .on('GET /api/scene/summary', { json: SUMMARY })
    .on('GET /api/widgets', { json: CATALOG })
    .on('GET /api/user', { json: null })
    .on('GET /api/events', log.handler())
    .on('POST /api/scene/ops', (req) => ({ json: { version: 8, ids: req.json().ops.map((_: unknown, i: number) => `new-${i + 1}`) } }));
  bridge = await connectBridge({ evolUrl: fake.url, channel: false });
});
afterEach(async () => {
  await bridge.close();
});

const opsBody = () => fake.find('POST', '/api/scene/ops').at(-1)!.json();

describe('tool listing', () => {
  it('exposes every tool with an object schema and description', async () => {
    const { tools } = await bridge.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const n of ['scene', 'spawn', 'update', 'remove', 'link', 'unlink', 'undo', 'redo', 'prefab', 'workspace', 'widgets', 'widget_info',
      'widget_build', 'thumbnail', 'screenshot', 'user', 'say', 'status', 'events', 'channels', 'channel_get', 'channel_set', 'sources',
      'pose_record', 'gestures', 'voice_simulate', 'command', 'server_status']) expect(names).toContain(n);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description!.length).toBeGreaterThan(20);
      expect(JSON.stringify(t.inputSchema)).not.toContain('$schema');
    }
  });

  it('rejects invalid and unknown arguments with a clear message', async () => {
    const r = await bridge.callText('spawn', { widget: 'box', position: [1, 2] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid arguments for spawn: position/);
    const r2 = await bridge.callText('scene', { ful: true });
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/ful/);
  });
});

describe('scene tools', () => {
  it('renders a compact summary tree with links', async () => {
    const { text } = await bridge.callText('scene');
    expect(text).toContain('scene v7 · workspace "default" · 3 entities · 2 links');
    expect(text).toContain('e-1 "lens" slider @(0, 1.2, -1) {value:3}');
    expect(text).toContain('  e-2 text @(0, 0.1, 0) {text:"Layer 3"}');
    expect(text).toContain('l-1: e-1.value → #interp.ctl.layer');
    expect(text).toContain('[`Layer ${x}`]');
  });

  it('filters the summary and full JSON to a subtree', async () => {
    const { text } = await bridge.callText('scene', { entity: 'e-3' });
    expect(text).toContain('1 entity · 0 links');
    const full = JSON.parse((await bridge.callText('scene', { full: true, entity: 'e-1' })).text) as SceneState;
    expect(Object.keys(full.entities).sort()).toEqual(['e-1', 'e-2']);
    expect(Object.keys(full.links).sort()).toEqual(['l-1', 'l-2']);
  });

  it('spawns with explicit transform (Euler degrees → quaternion, uniform scale)', async () => {
    const { text } = await bridge.callText('spawn', { widget: 'slider', name: 'gain', position: [0, 1, -0.5], rotation: [0, 90, 0], scale: 2, props: { value: 4 } });
    expect(text).toMatch(/^spawned new-1 \(slider "gain"\) at \(0, 1, -0.5\) · scene v8$/);
    const body = opsBody();
    expect(body.source).toBe('agent');
    const e = body.ops[0].entity;
    expect(e).toMatchObject({ widget: 'slider', name: 'gain', props: { value: 4 } });
    expect(e.transform.scale).toEqual([2, 2, 2]);
    expect(e.transform.rotation[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(e.transform.rotation[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('places new root content in front of the user, facing them', async () => {
    // User at origin, eye height 1.6, looking down -Z (identity rotation).
    fake.on('GET /api/user', { json: { t: Date.now(), mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} } });
    const { text } = await bridge.callText('spawn', { widget: 'slider' });
    expect(text).toContain('(in front of the user)');
    const t = opsBody().ops[0].entity.transform;
    expect(t.position[0]).toBeCloseTo(0);
    expect(t.position[2]).toBeCloseTo(-0.8);
    expect(t.position[1]).toBeCloseTo(1.45);
    // facing +Z toward the user → identity yaw
    expect(Math.abs(t.rotation[3])).toBeCloseTo(1);
  });

  it('places large widgets further away and head-anchored ones at arm\'s length', async () => {
    fake.on('GET /api/user', { json: { t: Date.now(), mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }, hands: {} } });
    fake.on('GET /api/widgets', { json: [...CATALOG, manifest('wall', { size: [2, 1, 0.1] })] });
    await bridge.callText('spawn', { widget: 'wall' });
    const t = opsBody().ops[0].entity.transform;
    // Head yawed +90° looks down -X; 2 m wide widget → 2.5 m away, rotated to face back (+X).
    expect(t.position[0]).toBeCloseTo(-2.5);
    expect(t.position[2]).toBeCloseTo(0);
    expect(t.rotation[1]).toBeCloseTo(Math.SQRT1_2);
    await bridge.callText('spawn', { widget: 'text', anchor: 'head-lazy' });
    expect(opsBody().ops[0].entity).toMatchObject({ anchor: { kind: 'head', lazy: true }, transform: { position: [0, -0.1, -0.7] } });
  });

  it('without a headset pose, places root content at eye height in front of the origin (not on the floor)', async () => {
    const { text } = await bridge.callText('spawn', { widget: 'slider' });
    expect(text).toContain('no headset pose');
    expect(opsBody().ops[0].entity.transform.position).toEqual([0, 1.3, -0.8]);
    fake.on('POST /api/prefabs/lens/instantiate', { json: { ids: { root: 'e-9' } } });
    expect((await bridge.callText('prefab', { id: 'lens' })).text).toContain('at (0, 1.3, -1.2)');
    expect(fake.find('POST', '/api/prefabs/lens/instantiate')[0]!.json().transform.position).toEqual([0, 1.3, -1.2]);
  });

  it('surfaces server op warnings', async () => {
    fake.on('POST /api/scene/ops', { json: { version: 9, ids: ['e-9'], warnings: ["entity 'e-9': widget 'slider' has no prop 'colour'"] } });
    let { text } = await bridge.callText('spawn', { widget: 'slider', position: [0, 0, 0], props: { colour: 'red' } });
    expect(text).toContain("warning: entity 'e-9': widget 'slider' has no prop 'colour'");
    expect(text).not.toContain('props not declared'); // no duplicate local note
    ({ text } = await bridge.callText('update', { id: 'e-1', props: { colour: 'red' } }));
    expect(text).toMatch(/^updated e-1 .*\nwarning: /);
  });

  it('warns about unknown widgets, build errors and undeclared props', async () => {
    let { text } = await bridge.callText('spawn', { widget: 'slidr', position: [0, 0, 0] });
    expect(text).toMatch(/not in the catalog.*did you mean slider/);
    ({ text } = await bridge.callText('spawn', { widget: 'box', position: [0, 0, 0] }));
    expect(text).toMatch(/build error.*Unexpected/);
    ({ text } = await bridge.callText('spawn', { widget: 'slider', position: [0, 0, 0], props: { colour: 'red' } }));
    expect(text).toMatch(/props not declared by "slider": colour \(declared: value, label\)/);
  });

  it('updates with a shallow patch and partial transform', async () => {
    const { text } = await bridge.callText('update', { id: 'e-1', props: { value: 5 }, position: [0, 1, -1], parent: null, anchor: 'head-lazy' });
    expect(text).toContain('updated e-1');
    const op = opsBody().ops[0];
    expect(op).toEqual({
      op: 'update', id: 'e-1',
      patch: { parent: null, props: { value: 5 }, anchor: { kind: 'head', lazy: true }, transform: { position: [0, 1, -1] } },
    });
    const empty = await bridge.callText('update', { id: 'e-1' });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/Nothing to update/);
  });

  it('removes one or many entities', async () => {
    await bridge.callText('remove', { id: ['e-1', 'e-3'] });
    expect(opsBody().ops).toEqual([{ op: 'remove', id: 'e-1' }, { op: 'remove', id: 'e-3' }]);
  });

  it('links refs after validating ports', async () => {
    const ok = await bridge.callText('link', { from: 'e-1.value', to: '#ui.gain', transform: 'x * 2' });
    expect(ok.text).toBe('linked new-1: e-1.value → #ui.gain [x * 2] · scene v8');
    expect(opsBody().ops[0]).toEqual({ op: 'link.add', link: { from: { kind: 'port', entity: 'e-1', port: 'value' }, to: { kind: 'channel', channel: 'ui.gain' }, transform: 'x * 2' } });

    const badPort = await bridge.callText('link', { from: 'e-1.valu', to: 'e-2.text' });
    expect(badPort.isError).toBe(true);
    expect(badPort.text).toContain('e-1 (slider) has no output port "valu". Available outputs: value:number');

    const badRef = await bridge.callText('link', { from: 'e-1', to: '#x' });
    expect(badRef.text).toMatch(/not a port or channel ref/);
    const chch = await bridge.callText('link', { from: '#a', to: '#b' });
    expect(chch.text).toMatch(/channel→channel/);
    const badExpr = await bridge.callText('link', { from: 'e-1.value', to: '#b', transform: 'x +' });
    expect(badExpr.text).toMatch(/not a valid JS expression/);
    const noEntity = await bridge.callText('link', { from: 'lens.value', to: '#b' });
    expect(noEntity.text).toMatch(/No entity "lens"/);
  });

  it('unlinks by id or by matching refs', async () => {
    await bridge.callText('unlink', { from: 'e-1.value' });
    expect(opsBody().ops).toEqual([{ op: 'link.remove', id: 'l-1' }, { op: 'link.remove', id: 'l-2' }]);
    await bridge.callText('unlink', { to: '#interp.ctl.layer' });
    expect(opsBody().ops).toEqual([{ op: 'link.remove', id: 'l-1' }]);
    const none = await bridge.callText('unlink', { to: '#nope' });
    expect(none.isError).toBe(true);
  });

  it('undo/redo with steps', async () => {
    let v = 10;
    fake.on('POST /api/scene/undo', () => ({ json: { version: ++v } }));
    const { text } = await bridge.callText('undo', { steps: 3 });
    expect(text).toBe('undo ×3 · scene v13');
    expect(fake.find('POST', '/api/scene/undo')).toHaveLength(3);
  });

  it('workspace save defaults to the current name', async () => {
    fake.on('GET /api/workspaces', { json: { current: 'lab', list: ['lab', 'demo'] } }).on('POST /api/workspaces/*', { json: {} });
    expect((await bridge.callText('workspace')).text).toBe('current: lab\nsaved: lab, demo');
    expect((await bridge.callText('workspace', { action: 'save' })).text).toBe('workspace saved: lab');
    expect(fake.find('POST', '/api/workspaces/lab/save')).toHaveLength(1);
    expect((await bridge.callText('workspace', { action: 'load' })).isError).toBe(true);
  });

  it('instantiates prefabs with prop overrides', async () => {
    fake.on('POST /api/prefabs/resid-lens/instantiate', { json: { ids: { root: 'e-9', slider: 'e-10' } } });
    const { text } = await bridge.callText('prefab', { id: 'resid-lens', position: [0, 1, -1], props: { slider: { value: 2 } } });
    expect(text).toBe('instantiated prefab resid-lens at (0, 1, -1): root→e-9, slider→e-10');
    const body = fake.find('POST', '/api/prefabs/resid-lens/instantiate')[0]!.json();
    expect(body.props).toEqual({ slider: { value: 2 } });
    expect(body.transform.position).toEqual([0, 1, -1]);
  });
});

describe('widget tools', () => {
  it('lists the catalog compactly', async () => {
    const { text } = await bridge.callText('widgets');
    expect(text).toContain('3 widgets');
    expect(text).toContain('slider — A draggable slider. | props: value:number label:string | in: value:number | out: value:number');
    expect(text).toContain('box — box widget | BUILD ERROR: widget.ts:3:1: ERROR: Unexpected "}"');
    expect((await bridge.callText('widgets', { filter: 'drag' })).text).toContain('1 widgets');
  });

  it('widget_info shows manifest, file path, build error and recent errors', async () => {
    fake.on('GET /api/widgets/box', { json: { ...CATALOG[2], source: 'export default {}' } });
    log.add('client.error', { widget: 'box', entity: 'e-3', message: 'TypeError: x is undefined' });
    log.add('client.error', { widget: 'slider', message: 'other' });
    const { text } = await bridge.callText('widget_info', { id: 'box' });
    expect(text).toContain('library/widgets/box/widget.ts');
    expect(text).toContain('build: ERROR');
    expect(text).toContain('TypeError: x is undefined');
    expect(text).not.toContain('other');
    expect(text).not.toContain('export default'); // source is read with file tools, not dumped
  });

  it('widget_info suggests close ids on 404', async () => {
    fake.on('GET /api/widgets/*', { status: 404, json: { error: 'not found' } });
    const r = await bridge.callText('widget_info', { id: 'sliderr' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Did you mean slider/);
  });

  it('widget_build reports failures', async () => {
    fake.on('POST /api/widgets/box/build', { json: { ok: false, error: 'boom at line 3' } });
    expect((await bridge.callText('widget_build', { id: 'box' })).text).toBe('build FAILED: box\nboom at line 3');
  });

  it('screenshot returns an image + caption and maps arguments to ScreenshotRequest', async () => {
    fake.on('POST /api/screenshot', { body: PNG_1x1, contentType: 'image/png' });
    const r = await bridge.call('screenshot', { entity: 'e-1', direction: [0, 0, 1], labels: true });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from(PNG_1x1).toString('base64') });
    expect(r.content[1]).toMatchObject({ type: 'text', text: 'screenshot (entity view of e-1, 1024x768, labels)' });
    expect(fake.find('POST', '/api/screenshot')[0]!.json()).toEqual({
      view: { kind: 'entity', entity: 'e-1', direction: [0, 0, 1] }, width: 1024, height: 768, labels: true,
    });
    await bridge.call('screenshot', { view: 'camera', position: [0, 2, 2], lookAt: [0, 1, 0], fov: 60, width: 640, height: 480 });
    expect(fake.find('POST', '/api/screenshot')[1]!.json()).toEqual({
      view: { kind: 'camera', position: [0, 2, 2], lookAt: [0, 1, 0], fov: 60 }, width: 640, height: 480,
    });
    await bridge.call('screenshot');
    expect(fake.find('POST', '/api/screenshot')[2]!.json().view).toEqual({ kind: 'user' });
  });

  it('screenshot surfaces JSON errors and missing view arguments', async () => {
    fake.on('POST /api/screenshot', { json: { error: 'no xr client connected' } });
    const r = await bridge.callText('screenshot', { view: 'user' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('screenshot failed: no xr client connected');
    const r2 = await bridge.callText('screenshot', { view: 'widget' });
    expect(r2.text).toMatch(/needs widget/);
  });

  it('thumbnail returns the image', async () => {
    fake.on('POST /api/widgets/slider/thumbnail', { body: PNG_1x1, contentType: 'image/png' });
    const r = await bridge.call('thumbnail', { id: 'slider' });
    expect(r.content[0]!.type).toBe('image');
  });
});

describe('data tools', () => {
  it('channel_get summarizes tensors', async () => {
    const t = makeTensor('f32', [2, 3], new Float32Array([1, 2, 3, 4, 5, 6]));
    fake.on('GET /api/channels/interp.resid.norm', { body: encodeTensorFrame({ channel: 'interp.resid.norm', dtype: 'f32', shape: [2, 3] }, t), contentType: 'application/x-evol-tensor' });
    const { text } = await bridge.callText('channel_get', { name: 'interp.resid.norm' });
    expect(text).toContain('interp.resid.norm: tensor f32[2,3] (6 values)');
    expect(text).toContain('min=1 max=6 mean=3.5');
    expect(text).toContain('first 6: [1, 2, 3, 4, 5, 6]');
  });

  it('channel_get handles JSON-encoded tensors and truncates big JSON', async () => {
    fake.on('GET /api/channels/t', { json: { $tensor: true, dtype: 'u8', shape: [3], b64: Buffer.from([0, 128, 255]).toString('base64') } });
    expect((await bridge.callText('channel_get', { name: 't' })).text).toContain('min=0 max=255');
    fake.on('GET /api/channels/big', { json: { s: 'x'.repeat(10_000) } });
    const short = (await bridge.callText('channel_get', { name: 'big' })).text;
    expect(short.length).toBeLessThan(4200);
    expect(short).toMatch(/\+\d+ chars/);
    expect((await bridge.callText('channel_get', { name: 'big', full: true })).text.length).toBeGreaterThan(10_000);
  });

  it('channel_set PUTs JSON', async () => {
    fake.on('PUT /api/channels/ui.gain', { json: {} });
    expect((await bridge.callText('channel_set', { name: 'ui.gain', value: { a: 1 } })).text).toBe('published ui.gain = {"a":1}');
    expect(fake.find('PUT', '/api/channels/ui.gain')[0]!.json()).toEqual({ a: 1 });
  });

  it('channels lists compact lines', async () => {
    fake.on('GET /api/channels', { json: [
      { name: 'interp.meta', kind: 'json', size: 300, updatedAt: Date.now(), seq: 2, producer: 'interp' },
      { name: 'interp.resid.proj', kind: 'tensor', dtype: 'f32', shape: [13, 24, 3], size: 3744, updatedAt: Date.now(), seq: 9 },
      { name: 'weather.x', kind: 'json', size: 10, updatedAt: Date.now(), seq: 1 },
    ] });
    const { text } = await bridge.callText('channels', { prefix: 'interp.' });
    expect(text.split('\n')).toEqual([
      'interp.meta  json 300B seq=2 now by interp',
      'interp.resid.proj  f32[13,24,3] 3.7KB seq=9 now',
    ]);
  });

  it('events: tail by default, cursor paging with since, compact lines', async () => {
    for (let i = 0; i < 5; i++) log.add('client.log', { level: 'info', message: `m${i}` });
    let { text } = await bridge.callText('events', { limit: 2 });
    expect(text).toMatch(/^#4 .* client\.log level="info" message="m3"\n#5 .*\nnext=5$/);
    expect(fake.find('GET', '/api/events').at(-1)!.query.has('since')).toBe(false); // tail = server's "most recent"
    ({ text } = await bridge.callText('events', { since: 1, limit: 2 }));
    expect(text).toMatch(/#2 .*\n#3 .*\nnext=3$/);
    ({ text } = await bridge.callText('events', { since: 5, types: ['client.error'] }));
    expect(text).toBe('(no events)\nnext=5');
  });

  it('sources: list and logs', async () => {
    fake.on('GET /api/sources', { json: [{ id: 'stt', running: true, pid: 42, restarts: 1, logTail: ['a', 'b', 'c'] }] });
    expect((await bridge.callText('sources')).text).toBe('stt: running pid 42 restarts=1');
    expect((await bridge.callText('sources', { action: 'logs', id: 'stt', lines: 2 })).text).toBe('stt (running) last 2 log lines:\nb\nc');
    fake.on('POST /api/sources/stt/restart', { json: { running: true } });
    expect((await bridge.callText('sources', { action: 'restart', id: 'stt' })).text).toBe('source stt: restart ok (running)');
  });
});

describe('agent & system tools', () => {
  it('say and status post to the agent API', async () => {
    fake.on('POST /api/agent/say', { json: { id: 'm-1' } }).on('POST /api/agent/status', { json: {} });
    expect((await bridge.callText('say', { text: 'Done!' })).text).toBe('shown in XR (m-1)');
    expect(fake.find('POST', '/api/agent/say')[0]!.json()).toEqual({ text: 'Done!', kind: 'reply' });
    await bridge.callText('status', { detail: 'Building weather widget' });
    expect(fake.find('POST', '/api/agent/status')[0]!.json()).toEqual({ state: 'working', detail: 'Building weather widget' });
  });

  it('user summarizes pose, focus and selection with entity names', async () => {
    // Shape of apps/server/src/user.ts UserState.summary().
    fake.on('GET /api/user', { json: {
      t: 123456, ageMs: 40, mode: 'ar', fov: 90,
      head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] },
      focus: { right: { entity: 'e-1', point: [0, 1.2, -1] } }, gaze: null, selected: 'e-3',
      hands: {
        left: { tracked: false, poses: [] },
        right: { tracked: true, wrist: { position: [0.2, 1.1, -0.3], rotation: [0, 0, 0, 1] }, features: { 'curl.index': 0.912, 'pinch.index': 0.012, 'spread.index-middle': 12 }, poses: ['pinch'] },
      },
    } });
    const { text } = await bridge.callText('user');
    expect(text).toContain('mode ar · fov 90° · pose age 40ms');
    expect(text).toContain('head (0, 1.6, 0) facing (0, 0, -1)');
    expect(text).toContain('right hand: wrist (0.2, 1.1, -0.3); curl.index=0.91 pinch.index=0.01; poses: pinch · ray → e-1 (slider "lens") at (0, 1.2, -1)');
    expect(text).toContain('left hand: not tracked');
    expect(text).toContain('gaze: nothing');
    expect(text).toContain('selected: e-3 (box)');
    await bridge.callText('user', { raw: true });
    expect(fake.find('GET', '/api/user').at(-1)!.query.get('raw')).toBe('1');
  });

  it('user reports when no headset is connected', async () => {
    expect((await bridge.callText('user')).text).toMatch(/No XR client connected/);
  });

  it('pose_record, gestures, voice_simulate, command', async () => {
    fake.on('POST /api/gestures/record', (req) => ({ json: { id: req.json().name, description: 'thumbs up', hand: 'right', source: 'recorded', conditions: [{ feature: 'curl.index', min: 0.7 }] } }));
    expect((await bridge.callText('pose_record', { name: 'thumbs-up', hand: 'right' })).text)
      .toBe('recorded pose → library/poses/thumbs-up.json\nthumbs-up (right, recorded) — thumbs up | 0.7≤curl.index');
    expect(fake.find('POST', '/api/gestures/record')[0]!.json()).toEqual({ name: 'thumbs-up', hand: 'right', seconds: 3, countdown: 3 });

    fake.on('GET /api/gestures', { json: {
      poses: [{ id: 'pinch', description: 'Index pinch', hand: 'either', source: 'builtin', conditions: [{ feature: 'pinch.index', max: 0.02 }] }],
      interactions: { default: { description: 'Standard', scope: 'entity-default', bindings: [{ id: 'grab', pose: 'pinch', target: 'near', action: { type: 'grab' } }] } },
    } });
    const g = (await bridge.callText('gestures')).text;
    expect(g).toContain('pinch (either, builtin) — Index pinch | pinch.index≤0.02');
    expect(g).toContain('grab: pinch (either, target near) → grab');

    fake.on('POST /api/voice/simulate', { json: { route: 'fastpath', command: 'undo' } });
    expect((await bridge.callText('voice_simulate', { text: 'undo that' })).text).toBe('"undo that" → fastpath (command undo)');

    fake.on('POST /api/command', { json: { ok: true, result: { id: 'e-4' } } });
    expect((await bridge.callText('command', { name: 'duplicate', args: { entity: 'e-1' } })).text).toBe('command duplicate ok: {"id":"e-4"}');
  });

  it('passes server error messages through', async () => {
    fake.on('POST /api/command', { status: 400, json: { error: 'unknown command "frob"' } });
    const r = await bridge.callText('command', { name: 'frob' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('POST /api/command failed (HTTP 400): unknown command "frob"');
  });

  it('server_status reports clients and channel state', async () => {
    fake.on('GET /api/health', { json: { ok: true, version: '0.1.0', clients: [{ role: 'xr', primary: true }, { role: 'mirror', primary: false }] } });
    const { text } = await bridge.callText('server_status');
    expect(text).toContain(`server: up at ${fake.url} (v0.1.0)`);
    expect(text).toContain('clients: xr*, mirror');
    expect(text).toContain('voice channel: not started');
  });
});

describe('server down', () => {
  // Minimal valid args per tool; every one must explain how to start the server.
  const ARGS: Record<string, Record<string, unknown>> = {
    spawn: { widget: 'box' }, update: { id: 'e-1', name: 'x' }, remove: { id: 'e-1' }, link: { from: 'e-1.v', to: '#c' },
    unlink: { id: 'l-1' }, prefab: { id: 'p' }, widget_info: { id: 'box' }, widget_build: { id: 'box' }, thumbnail: { id: 'box' },
    say: { text: 'hi' }, channel_get: { name: 'c' }, channel_set: { name: 'c', value: 1 }, pose_record: { name: 'p', hand: 'left' },
    voice_simulate: { text: 'hi' }, command: { name: 'undo' }, sources: { action: 'logs', id: 's' }, workspace: { action: 'list' },
  };

  it('every tool returns an actionable error', async () => {
    const down = await connectBridge({ evolUrl: await deadUrl(), channel: false });
    try {
      for (const t of ALL_TOOLS) {
        const r = await down.callText(t.name, ARGS[t.name] ?? {});
        expect(r.isError, `${t.name} should fail`).toBe(true);
        expect(r.text, t.name).toMatch(/EvolSpace server is not running at http:\/\/127\.0\.0\.1:\d+.*Start it with: npm run dev \(in .*EvolSpace\)/);
      }
    } finally {
      await down.close();
    }
  });
});
