// @vitest-environment happy-dom
// Debug dashboard panels A: links (formatting, transform validation, link
// creation op, live values, errors), widgets (catalog, errors, spawn), channels
// (tensor stats / slicing / color helpers, rates, live value via the runtime
// ChannelHub, JSON tree, publish).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ChannelInfo, Entity, Link, SceneState, ServerEvent, WidgetManifest } from '@evolspace/protocol';
import { makeTensor } from '@evolspace/protocol';
import { DEFAULT_THEME } from '@evolspace/runtime';
import { createApi } from '../src/debug/api.ts';
import { createDebugStore, type StoreNet, type StoreRuntime } from '../src/debug/store.ts';
import type { DebugContext } from '../src/debug/types.ts';
import linksPanel from '../src/debug/panels/links.tsx';
import widgetsPanel from '../src/debug/panels/widgets.tsx';
import channelsPanel from '../src/debug/panels/channels.tsx';
import {
  checkDraft, checkTransform, emptyEnd, endpointView, filterLinks, linkErrors, linkText, previewTransform, sourceValue, typeWarning,
} from '../src/debug/panels/links/model.ts';
import { formOpen, draft } from '../src/debug/panels/links/form.tsx';
import {
  colorScale, downsample, envelope, guessRange, halfToFloat, heatmapPixels, hexToRgb, NAN_RGB, rampAt, slice2d, sparkPoints, stats,
  tensorLabel, tensorStats, valueKind,
} from '../src/debug/panels/channels/tensor.ts';
import { History, RateTracker, channelType, filterChannels, fmtRate, selectedChannel, validateChannelName } from '../src/debug/panels/channels/model.ts';
import { parseEditor } from '../src/debug/panels/channels/detail.tsx';
import { JsonTree, summarize } from '../src/debug/panels/channels/JsonTree.tsx';
import { visibleRange } from '../src/debug/panels/channels/vlist.tsx';
import { buildErrorCount, filterWidgets, instanceCounts, portsSummary, sourcePath, widgetErrors } from '../src/debug/panels/widgets/model.ts';

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { render(null, host); host.remove(); });

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: Element, k: string, extra: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

// ------------------------------------------------------------------ fixtures

const T = { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as Entity['transform'];
const ent = (id: string, widget: string, name?: string): Entity => ({ id, parent: null, widget, props: {}, transform: T, visible: true, ...(name ? { name } : {}) });
const man = (id: string, extra: Partial<WidgetManifest> = {}): WidgetManifest => ({
  id, description: `${id} widget`, version: '1.0.0', hash: `h-${id}`, url: `/widgets/${id}.js`, hasThumbnail: false, interactions: [], props: {}, inputs: {}, outputs: {}, ...extra,
});
const SLIDER = man('slider', { props: { min: { type: 'number', default: 0 } }, inputs: { value: { type: 'number' } }, outputs: { value: { type: 'number' }, commit: { type: 'number' } } });
const NUMBER = man('number', { inputs: { value: { type: 'any' } } });
const TOGGLE = man('toggle', { inputs: { value: { type: 'boolean' } }, outputs: { value: { type: 'boolean' } } });
const LABEL = man('label', { inputs: { text: { type: 'string' } } });
const BROKEN = man('broken', { error: 'widget.ts:1:2: Expected "}"', hash: '' });

const L = (id: string, from: Link['from'], to: Link['to'], extra: Partial<Link> = {}): Link => ({ id, from, to, enabled: true, ...extra });
const P = (entity: string, port: string) => ({ kind: 'port' as const, entity, port });
const C = (channel: string) => ({ kind: 'channel' as const, channel });

function makeScene(): SceneState {
  const s: SceneState = { version: 1, workspace: 'w', entities: {}, links: {} };
  for (const e of [ent('s1', 'slider', 'gain'), ent('n1', 'number', 'readout'), ent('t1', 'toggle'), ent('x1', 'label', 'title')]) s.entities[e.id] = e;
  for (const l of [
    L('l1', P('s1', 'value'), P('n1', 'value'), { transform: 'x * 2' }),
    L('l2', C('demo.wave'), P('s1', 'value')),
    L('l3', P('t1', 'value'), C('ui.flag'), { enabled: false }),
  ]) s.links[l.id] = l;
  return s;
}

const CHANNELS: ChannelInfo[] = [
  { name: 'demo.wave', kind: 'json', size: 8, updatedAt: Date.now() - 1000, seq: 10, producer: 'seed' },
  { name: 'demo.matrix', kind: 'tensor', dtype: 'f32', shape: [2, 3], size: 24, updatedAt: Date.now() - 5000, seq: 1, producer: 'interp' },
  { name: 'cfg', kind: 'json', size: 40, updatedAt: Date.now(), seq: 3 },
];

function fakeCtx(opts: { events?: ServerEvent[] } = {}) {
  const scene = makeScene();
  let selected: string | null = null;
  const selCbs = new Set<(id: string | null) => void>();
  const outputs = new Map<string, unknown>([['s1\0value', 0.25], ['t1\0value', true]]);
  const chanVals = new Map<string, unknown>([['demo.wave', 0.5]]);
  const subs = new Map<string, Set<(v: unknown) => void>>();
  const runtime = {
    sceneState: scene,
    get selected() { return selected; },
    select(id: string | null) { selected = id && scene.entities[id] ? id : null; for (const cb of selCbs) cb(selected); },
    onSelectionChange(cb: (id: string | null) => void) { selCbs.add(cb); return () => selCbs.delete(cb); },
    onSceneChange() { return () => {}; },
    widgets: { catalog: [SLIDER, NUMBER, TOGGLE, LABEL, BROKEN], allRecords: () => [].values(), record: () => undefined },
    links: { lastOutput: (e: string, p: string) => outputs.get(`${e}\0${p}`) },
    channels: {
      get: (n: string) => chanVals.get(n),
      seq: () => 1,
      subscribe(n: string, cb: (v: unknown) => void) {
        let s = subs.get(n);
        if (!s) subs.set(n, (s = new Set()));
        s.add(cb);
        if (chanVals.has(n)) cb(chanVals.get(n));
        return () => { s!.delete(cb); if (!s!.size) subs.delete(n); };
      },
    },
    theme: DEFAULT_THEME,
    entityObject: () => undefined,
  };
  const emit = (n: string, v: unknown) => { chanVals.set(n, v); for (const cb of subs.get(n) ?? []) cb(v); };
  const net = { connected: true, clientId: 'c', primary: false, httpBase: 'http://x/', status: { connected: true, ready: true, attempt: 0 }, on: () => () => {}, onStatus: () => () => {} };
  const posts: Array<{ ops: unknown[] }> = [];
  const puts: Array<{ name: string; body: unknown }> = [];
  const calls: string[] = [];
  const api = createApi('http://x', async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/api/scene/ops') {
      const body = JSON.parse(String(init?.body)) as { ops: Array<{ op: string; entity?: { widget: string } }> };
      posts.push(body);
      for (const o of body.ops) if (o.op === 'add' && o.entity) scene.entities['new-1'] = ent('new-1', o.entity.widget);
      return new Response(JSON.stringify({ version: 2, ids: ['new-1'] })); }
    if (u.pathname === '/api/events') return new Response(JSON.stringify({ events: opts.events ?? [], next: (opts.events ?? []).length }));
    if (u.pathname === '/api/channels') return new Response(JSON.stringify(CHANNELS));
    if (u.pathname.startsWith('/api/channels/') && init?.method === 'PUT') {
      const name = decodeURIComponent(u.pathname.slice('/api/channels/'.length));
      puts.push({ name, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ name, kind: 'json', size: 1, updatedAt: 0, seq: 1 }));
    }
    if (u.pathname.startsWith('/api/widgets/') && u.pathname.endsWith('/build')) return new Response(JSON.stringify({ ok: true }));
    return new Response('null');
  });
  const toasts: string[] = [];
  const shown: string[] = [];
  const { store, actions } = createDebugStore({ runtime: runtime as unknown as StoreRuntime, net: net as unknown as StoreNet, api, eventsWaitMs: 0, toast: (t) => toasts.push(t) });
  const ctx = { store, actions, runtime, api, toast: (t: string) => toasts.push(t), layout: { show: (id: string) => shown.push(id) } } as unknown as DebugContext;
  return { ctx, runtime, scene, posts, puts, calls, toasts, shown, outputs, emit, subs, store, dispose: () => store.dispose() };
}

// ------------------------------------------------------------------ links: logic

describe('links model', () => {
  const scene = makeScene();
  it('formats endpoints readably (name.port / #channel), flags missing entities', () => {
    expect(linkText(scene, scene.links.l1)).toBe('gain.value → readout.value ƒ x * 2');
    expect(linkText(scene, scene.links.l2)).toBe('#demo.wave → gain.value');
    expect(endpointView(scene, P('t1', 'value')).label).toBe('toggle'); // unnamed → widget id
    expect(endpointView(scene, P('gone', 'value'))).toMatchObject({ missing: true, label: 'gone', raw: 'gone.value' });
  });

  it('filters by names, ids, ports, channels and transform (all terms)', () => {
    expect(filterLinks(scene, '').map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
    expect(filterLinks(scene, 'gain readout').map((l) => l.id)).toEqual(['l1']);
    expect(filterLinks(scene, '#demo').map((l) => l.id)).toEqual(['l2']);
    expect(filterLinks(scene, 'x * 2').map((l) => l.id)).toEqual(['l1']);
    expect(filterLinks(scene, 'slider').map((l) => l.id)).toEqual(['l1', 'l2']); // widget id
    expect(filterLinks(scene, '', { errors: new Map([['l3', 1]]) }).map((l) => l.id)).toEqual(['l3']);
  });

  it('validates transforms by compiling them like the runtime, and previews them', () => {
    expect(checkTransform('')).toEqual({ ok: true });
    expect(checkTransform('Math.round(x * 10)').ok).toBe(true);
    const bad = checkTransform('x +');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(bad.error).not.toContain('does not compile'); // prefix stripped
    expect(previewTransform('x * 2', 3)).toEqual({ ran: true, value: 6 });
    expect(previewTransform('x > 1 ? x : undefined', 0)).toEqual({ ran: true, dropped: true });
    expect(previewTransform('x.a.b', 1).error).toMatch(/^throws:/);
    expect(previewTransform('x * 2', undefined)).toEqual({ ran: false });
  });

  it('warns loosely on port type mismatches', () => {
    expect(typeWarning('number', 'number', false)).toBeNull();
    expect(typeWarning('number', 'any', false)).toBeNull();
    expect(typeWarning('event', 'number', false)).toBeNull();
    expect(typeWarning('number', 'json', false)).toBeNull();
    expect(typeWarning('number', 'boolean', false)).toMatch(/x > 0.5/);
    expect(typeWarning('number', 'boolean', true)).toBeNull();
    expect(typeWarning('tensor', 'string', false)).toMatch(/String\(x\)/);
    expect(typeWarning('tensor', 'vec3', false)).toMatch(/mismatch/);
    expect(typeWarning(undefined, 'number', false)).toBeNull();
  });

  it('builds the link.add op from the form and reports errors / warnings', () => {
    const env = { scene, catalog: { slider: SLIDER, number: NUMBER, toggle: TOGGLE, label: LABEL }, channels: [{ name: 'demo.wave', kind: 'json' as const }] };
    const ok = checkDraft({ from: { ...emptyEnd(), entity: 's1', port: 'value' }, to: { ...emptyEnd(), entity: 'n1', port: 'value' }, transform: ' x + 1 ' }, env);
    expect(ok.errors).toEqual([]);
    expect(ok.op).toEqual({ op: 'link.add', link: { from: P('s1', 'value'), to: P('n1', 'value'), transform: 'x + 1' } });
    const ch = checkDraft({ from: { ...emptyEnd('channel'), channel: '#demo.wave' }, to: { ...emptyEnd(), entity: 's1', port: 'value' }, transform: '' }, env);
    expect(ch.op).toEqual({ op: 'link.add', link: { from: C('demo.wave'), to: P('s1', 'value') } });
    expect(ch.warnings.some((w) => w.includes('identical link'))).toBe(true); // l2 exists
    const both = checkDraft({ from: { ...emptyEnd('channel'), channel: 'a' }, to: { ...emptyEnd('channel'), channel: 'b' }, transform: '' }, env);
    expect(both.op).toBeNull();
    expect(both.errors.join()).toMatch(/channel → channel/);
    const badPort = checkDraft({ from: { ...emptyEnd(), entity: 's1', port: 'nope' }, to: { ...emptyEnd(), entity: 'n1', port: 'value' }, transform: 'x +' }, env);
    expect(badPort.op).toBeNull();
    expect(badPort.errors.join('|')).toMatch(/no output 'nope'.*\|transform:/);
    const mismatch = checkDraft({ from: { ...emptyEnd(), entity: 't1', port: 'value' }, to: { ...emptyEnd(), entity: 'x1', port: 'text' }, transform: '' }, env);
    expect(mismatch.op).not.toBeNull();
    expect(mismatch.warnings.join()).toMatch(/boolean → string/);
    const unknownCh = checkDraft({ from: { ...emptyEnd('channel'), channel: 'not.there' }, to: { ...emptyEnd(), entity: 'n1', port: 'value' }, transform: '' }, env);
    expect(unknownCh.warnings.join()).toMatch(/no value yet/);
    expect(checkDraft({ from: emptyEnd(), to: emptyEnd(), transform: '' }, env).errors[0]).toMatch(/^From: pick/);
  });

  it('extracts the latest error per link from client.error events', () => {
    const ev = (seq: number, message: string, type: ServerEvent['type'] = 'client.error'): ServerEvent => ({ seq, ts: seq * 1000, type, data: { message } });
    const m = linkErrors([ev(1, 'link l1: transform "x.a" threw: boom'), ev(2, 'something else'), ev(3, 'link l1: feedback loop'), ev(4, 'link l2: x', 'client.log')]);
    expect([...m.keys()]).toEqual(['l1']);
    expect(m.get('l1')).toEqual({ message: 'feedback loop', ts: 3000, count: 2 });
    expect(linkErrors([ev(1, 'link l1: old')], 5000).size).toBe(0);
  });

  it('reads the live source value of a link (port cache or channel cache)', () => {
    const rt = { links: { lastOutput: (e: string, p: string) => (e === 's1' && p === 'value' ? 0.5 : undefined) }, channels: { get: () => 'hi', seq: () => 7 } };
    expect(sourceValue(rt, { from: P('s1', 'value') })).toEqual({ value: 0.5 });
    expect(sourceValue(rt, { from: C('x') })).toEqual({ value: 'hi', seq: 7 });
  });
});

// ------------------------------------------------------------------ links: panel

describe('links panel', () => {
  it('lists links with readable endpoints and live values; toggle / delete / transform edit become link ops', async () => {
    const f = fakeCtx();
    const Panel = linksPanel.component;
    await act(() => { render(<Panel ctx={f.ctx} />, host); });
    await tick();
    const rows = () => [...host.querySelectorAll<HTMLElement>('.dbg-lk-row')];
    expect(rows().map((r) => r.dataset.id)).toEqual(['l1', 'l2', 'l3']);
    const r1 = rows()[0];
    expect(r1.querySelectorAll('.dbg-ep')[0].textContent).toContain('gain');
    expect(r1.querySelectorAll('.dbg-ep')[0].textContent).toContain('value');
    expect(r1.querySelector('.dbg-lk-val .v')!.textContent).toBe('0.25'); // source value
    expect(r1.querySelector('.dbg-lk-val .out')!.textContent).toBe('0.5'); // after transform
    expect(rows()[1].querySelector('.dbg-ep.ch')!.textContent).toContain('demo.wave');
    expect(rows()[1].querySelector('.dbg-lk-val .v')!.textContent).toBe('0.5');
    expect(rows()[2].className).toContain('off');

    // A new value passes → flash
    f.outputs.set('s1\0value', 0.75);
    await tick(260);
    expect(rows()[0].querySelector('.dbg-lk-val .v')!.textContent).toBe('0.75');
    expect(rows()[0].querySelector('.dbg-lk-val .v')!.className).toContain('flash');
    expect(rows()[0].querySelector('.pulse')!.className).toContain('on');

    // Enable toggle
    await act(() => { const cb = rows()[2].querySelector<HTMLInputElement>('.dbg-switch input')!; cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'link.update', id: 'l3', patch: { enabled: true } }] });

    // Transform edit: invalid is flagged, not applied; valid applies on Enter; empty clears (null)
    const tf = rows()[0].querySelector<HTMLInputElement>('.tfx')!;
    await act(() => { tf.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(tf, 'x +'));
    expect(tf.className).toContain('bad');
    expect(rows()[0].querySelector('.prev.bad')).toBeTruthy();
    await act(() => typeInto(tf, 'x * 3'));
    expect(rows()[0].querySelector('.prev')!.textContent).toBe('⇒ 2.25');
    const n = f.posts.length;
    await act(() => { tf.dispatchEvent(new FocusEvent('blur')); });
    await tick();
    expect(f.posts.length).toBe(n + 1);
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'link.update', id: 'l1', patch: { transform: 'x * 3' } }] });
    await act(() => { tf.dispatchEvent(new FocusEvent('focus')); });
    await act(() => typeInto(tf, ''));
    await act(() => { tf.dispatchEvent(new FocusEvent('blur')); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'link.update', id: 'l1', patch: { transform: null } }] });

    // Delete
    await act(() => { rows()[1].querySelector<HTMLButtonElement>('.dbg-lk-acts .dbg-ibtn')!.click(); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'link.remove', id: 'l2' }] });

    // Endpoint click selects the entity; channel endpoint opens the channels panel
    await act(() => { (rows()[0].querySelector('.dbg-ep') as HTMLElement).click(); });
    expect(f.runtime.selected).toBe('s1');
    await act(() => { (rows()[1].querySelector('.dbg-ep.ch') as HTMLElement).click(); });
    expect(f.shown).toEqual(['channels']);
    expect(selectedChannel.value).toBe('demo.wave');

    // Filter
    await act(() => typeInto(host.querySelector<HTMLInputElement>('.dbg-search input')!, 'readout'));
    expect(rows().map((r) => r.dataset.id)).toEqual(['l1']);
    f.dispose();
  });

  it('creates a link from the New link form (link.add op)', async () => {
    formOpen.value = false;
    draft.value = { from: emptyEnd(), to: emptyEnd(), transform: '' };
    const f = fakeCtx();
    const Panel = linksPanel.component;
    await act(() => { render(<Panel ctx={f.ctx} />, host); });
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('.dbg-btn')].find((b) => b.textContent?.includes('New link'))!.click(); });
    const form = host.querySelector('.dbg-lk-form')!;
    expect(form).toBeTruthy();
    const create = () => [...form.querySelectorAll<HTMLButtonElement>('.dbg-btn')].find((b) => b.textContent?.includes('Create'))!;
    expect(create().disabled).toBe(true);
    const sel = (side: number, i: number) => form.querySelectorAll('.end')[side].querySelectorAll<HTMLSelectElement>('select')[i];
    const choose = async (s: HTMLSelectElement, v: string) => { await act(() => { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }); };
    await choose(sel(0, 0), 't1'); // toggle has one output → auto-picked
    expect(draft.value.from).toMatchObject({ entity: 't1', port: 'value' });
    await choose(sel(1, 0), 'x1');
    await choose(sel(1, 1), 'text');
    expect(form.textContent).toMatch(/boolean → string/); // type warning
    await act(() => typeInto(form.querySelector<HTMLInputElement>('.tf input')!, 'x ? "on" : "off"'));
    expect(form.textContent).toContain('preview: true ⇒ "on"');
    expect(create().disabled).toBe(false);
    await act(() => { create().click(); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'link.add', link: { from: P('t1', 'value'), to: P('x1', 'text'), transform: 'x ? "on" : "off"' } }], source: 'user' });
    expect(host.querySelector('.dbg-lk-form')).toBeNull();
    f.dispose();
  });

  it('badge: error count (error style) or link count; error rows marked', async () => {
    const events: ServerEvent[] = [{ seq: 1, ts: Date.now(), type: 'client.error', data: { message: 'link l1: transform "x * 2" threw: nope', entity: 'n1' } }];
    const f = fakeCtx({ events });
    expect(linksPanel.badge!(f.ctx)).toBe(3);
    await (f.store as unknown as { pollEventsOnce(w: number): Promise<void> }).pollEventsOnce(0);
    expect(linksPanel.badge!(f.ctx)).toBe('!1');
    const Panel = linksPanel.component;
    await act(() => { render(<Panel ctx={f.ctx} />, host); });
    const r1 = host.querySelector<HTMLElement>('.dbg-lk-row[data-id="l1"]')!;
    expect(r1.className).toContain('err');
    expect(r1.querySelector('.errico')!.getAttribute('title')).toContain('threw: nope');
    f.dispose();
  });
});

// ------------------------------------------------------------------ widgets

describe('widgets panel', () => {
  it('model: search, summaries, instances, errors, badge', () => {
    const list = [SLIDER, NUMBER, BROKEN];
    expect(filterWidgets(list, 'commit').map((m) => m.id)).toEqual(['slider']);
    expect(filterWidgets(list, '', true).map((m) => m.id)).toEqual(['broken']);
    expect(portsSummary(SLIDER)).toBe('1 in · 2 out · 1 prop');
    expect(portsSummary(BROKEN)).toBe('no ports or props');
    expect(buildErrorCount({ slider: SLIDER, broken: BROKEN })).toBe(1);
    expect(sourcePath('slider')).toBe('library/widgets/slider/widget.ts');
    const scene = makeScene();
    expect(instanceCounts(scene).get('slider')).toBe(1);
    const evs: ServerEvent[] = [
      { seq: 1, ts: 1, type: 'client.error', data: { message: 'by widget field', widget: 'slider' } },
      { seq: 2, ts: 2, type: 'client.error', data: { message: 'by entity', entity: 's1' } },
      { seq: 3, ts: 3, type: 'client.error', data: { message: 'other', entity: 'n1' } },
      { seq: 4, ts: 4, type: 'widget.build', data: { widget: 'slider', ok: false, error: 'syntax' } },
      { seq: 5, ts: 5, type: 'widget.build', data: { widget: 'slider', ok: true } },
    ];
    expect(widgetErrors(evs, 'slider', scene).map((e) => e.message)).toEqual(['syntax', 'by entity', 'by widget field']);
  });

  it('lists the catalog with build status, expands details, spawns and rebuilds', async () => {
    const f = fakeCtx();
    expect(widgetsPanel.badge!(f.ctx)).toBe('!1');
    const Panel = widgetsPanel.component;
    await act(() => { render(<Panel ctx={f.ctx} />, host); });
    const ids = () => [...host.querySelectorAll('.dbg-wrow .id')].map((e) => e.textContent);
    expect(ids()).toEqual(['broken', 'label', 'number', 'slider', 'toggle']);
    expect(host.querySelector('.dbg-witem.bad .dbg-wrow .er')).toBeTruthy();
    expect(host.querySelector('.dbg-pbar.foot')!.textContent).toContain('1 build error');
    // details
    await act(() => { ([...host.querySelectorAll<HTMLElement>('.dbg-wrow')].find((r) => r.textContent?.includes('slider'))!).click(); });
    const det = host.querySelector('.dbg-wdet')!;
    expect(det.textContent).toContain('commit');
    expect(det.textContent).toContain('library/widgets/slider/widget.ts');
    expect(det.querySelector('.chip')!.textContent).toContain('gain');
    // spawn → add op
    await act(() => { [...det.querySelectorAll<HTMLButtonElement>('.dbg-btn')].find((b) => b.textContent?.includes('Spawn'))!.click(); });
    await tick();
    expect(f.posts.at(-1)).toMatchObject({ ops: [{ op: 'add', entity: { widget: 'slider' } }] });
    // rebuild → POST build
    await act(() => { [...det.querySelectorAll<HTMLButtonElement>('.dbg-btn')].find((b) => b.textContent?.includes('Rebuild'))!.click(); });
    await tick();
    expect(f.calls).toContain('POST /api/widgets/slider/build');
    expect(host.querySelector('.dbg-wdet .res.ok')).toBeTruthy();
    // search
    await act(() => typeInto(host.querySelector<HTMLInputElement>('.dbg-search input')!, 'toggle'));
    expect(ids()).toEqual(['toggle']);
    f.dispose();
  });
});

// ------------------------------------------------------------------ channels: logic

describe('channels helpers', () => {
  it('classifies values and labels tensors', () => {
    expect(valueKind(undefined)).toBe('none');
    expect(valueKind(1)).toBe('number');
    expect(valueKind([1, 2])).toBe('numarray');
    expect(valueKind([1, 'a'])).toBe('array');
    expect(valueKind({ a: 1 })).toBe('object');
    const t = makeTensor('f32', [2, 3], new Float32Array(6));
    expect(valueKind(t)).toBe('tensor');
    expect(tensorLabel(t)).toBe('f32[2×3]');
    expect(channelType(CHANNELS[1])).toBe('f32[2×3]');
    expect(channelType(CHANNELS[0])).toBe('json');
  });

  it('computes stats over finite values and counts NaN / Inf; decodes f16', () => {
    const s = stats([1, 2, 3, NaN, Infinity, 4]);
    expect(s).toMatchObject({ count: 6, finite: 4, nan: 1, inf: 1, min: 1, max: 4, mean: 2.5 });
    expect(s.std).toBeCloseTo(Math.sqrt(1.25));
    expect(stats([]).min).toBeNaN();
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7e00)).toBeNaN();
    const h = makeTensor('f16', [2], new Uint16Array([0x3c00, 0x4000]));
    expect(tensorStats(h)).toMatchObject({ min: 1, max: 2 });
  });

  it('slices rank-3 tensors to 2-D at leading indices and downsamples by block mean', () => {
    const d = new Float32Array(2 * 2 * 3).map((_, i) => i);
    const t = makeTensor('f32', [2, 2, 3], d);
    expect([...slice2d(t, [1]).values]).toEqual([6, 7, 8, 9, 10, 11]);
    expect(slice2d(t, [9])).toMatchObject({ rows: 2, cols: 3 }); // clamped
    expect([...slice2d(t, [9]).values][0]).toBe(6);
    const v = slice2d(makeTensor('f32', [4], new Float32Array([1, 2, 3, 4])));
    expect(v).toMatchObject({ rows: 1, cols: 4 });
    const big = { rows: 4, cols: 4, values: new Float32Array(16).map((_, i) => i) };
    const ds = downsample(big, 2);
    expect(ds).toMatchObject({ rows: 2, cols: 2 });
    expect([...ds.values]).toEqual([2.5, 4.5, 10.5, 12.5]);
    expect(downsample(big, 8)).toBe(big);
  });

  it('picks a diverging scale for signed data and maps colors (NaN magenta)', () => {
    expect(colorScale({ min: -1, max: 3 })).toEqual({ diverging: true, lo: -3, hi: 3 });
    expect(colorScale({ min: 1, max: 3 })).toEqual({ diverging: false, lo: 1, hi: 3 });
    expect(colorScale({ min: 2, max: 2 })).toEqual({ diverging: false, lo: 2, hi: 3 });
    const ramp = [hexToRgb('#000000'), hexToRgb('#ffffff')];
    expect(rampAt(ramp, 0.5)).toEqual([128, 128, 128]);
    const px = heatmapPixels({ rows: 1, cols: 3, values: new Float32Array([0, 1, NaN]) }, { diverging: false, lo: 0, hi: 1 }, ramp);
    expect([...px.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...px.slice(4, 8)]).toEqual([255, 255, 255, 255]);
    expect([...px.slice(8, 11)]).toEqual(NAN_RGB);
  });

  it('sparkline helpers: min/max envelope, scaled points, slider range guess', () => {
    const env = envelope([1, 5, 2, 8, NaN, NaN], 3);
    expect([...env]).toEqual([1, 5, 2, 8, NaN, NaN]);
    const pts = sparkPoints([0, 1], 100, 10, undefined, 0);
    expect(pts).toEqual([[0, 10], [100, 0]]);
    expect(guessRange(0.4)).toMatchObject({ min: 0, max: 1 });
    expect(guessRange(-3)).toMatchObject({ min: -10, max: 0 });
    expect(guessRange(42)).toMatchObject({ min: 0, max: 100, step: 1 });
  });

  it('filters channels, tracks rates from seq deltas, keeps a bounded history', () => {
    expect(filterChannels(CHANNELS, '').map((c) => c.name)).toEqual(['cfg', 'demo.matrix', 'demo.wave']);
    expect(filterChannels(CHANNELS, 'interp').map((c) => c.name)).toEqual(['demo.matrix']);
    expect(filterChannels(CHANNELS, 'f32').map((c) => c.name)).toEqual(['demo.matrix']);
    const r = new RateTracker();
    r.update([{ ...CHANNELS[0], seq: 10 }], 0);
    r.update([{ ...CHANNELS[0], seq: 20 }], 1000);
    expect(r.rate('demo.wave')).toBe(10);
    expect(r.fresh.has('demo.wave')).toBe(true);
    r.update([{ ...CHANNELS[0], seq: 20 }], 2000);
    expect(r.rate('demo.wave')).toBe(4);
    expect(r.fresh.size).toBe(0);
    expect(fmtRate(10)).toBe('10/s');
    expect(fmtRate(0.5)).toBe('30/m');
    expect(fmtRate(0)).toBe('');
    const h = new History(3);
    for (const v of [1, true, 'x', 3, 4]) h.push(v);
    expect(h.v).toEqual([1, 3, 4]);
    expect(validateChannelName('a.b-c:d')).toBeNull();
    expect(validateChannelName('a..b')).toBeTruthy();
    expect(validateChannelName('')).toBe('required');
    expect(visibleRange(1000, 24, 240, 240, 2)).toEqual([8, 22]);
    expect(parseEditor('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseEditor('{a').ok).toBe(false);
  });

  it('JsonTree folds containers and caps long arrays', async () => {
    expect(summarize([1, 2, 3])).toBe('[1, 2, 3]');
    expect(summarize({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('{a, b, c, d, …+1}');
    const big = Array.from({ length: 250 }, (_, i) => ({ i }));
    await act(() => { render(<JsonTree value={{ name: 'x', deep: { a: { b: { c: 1 } } }, big }} open={2} />, host); });
    expect(host.textContent).toContain('"x"');
    expect(host.textContent).toContain('… 50 more');
    expect(host.textContent).toContain('{b}'); // depth-2 node folded
    const sum = [...host.querySelectorAll<HTMLElement>('.sum')].find((s) => s.textContent === '{b}')!;
    await act(() => { sum.click(); });
    expect(host.textContent).toContain('{c}');
  });
});

// ------------------------------------------------------------------ channels: panel

describe('channels panel', () => {
  it('lists channels while open, subscribes to the selected one through the runtime, publishes, unsubscribes', async () => {
    selectedChannel.value = null;
    const f = fakeCtx();
    const Panel = channelsPanel.component;
    await act(() => { render(<Panel ctx={f.ctx} />, host); });
    await tick(10);
    const names = () => [...host.querySelectorAll('.dbg-ch-row .nm')].map((e) => e.textContent);
    expect(names()).toEqual(['cfg', 'demo.matrix', 'demo.wave']);
    expect(host.querySelector('.dbg-ch-row .ty')!.textContent).toBe('json');
    // select a number channel → live value + history + quick slider
    await act(() => { ([...host.querySelectorAll<HTMLElement>('.dbg-ch-row')].find((r) => r.textContent?.includes('demo.wave'))!).click(); });
    await tick(80);
    expect(f.subs.has('demo.wave')).toBe(true);
    expect(host.querySelector('.dbg-ch-detail .dbg-big')!.textContent).toContain('0.5');
    await act(() => { f.emit('demo.wave', 0.9); });
    await tick(100);
    expect(host.querySelector('.dbg-ch-detail .dbg-big')!.textContent).toContain('0.9');
    expect(host.querySelector('.dbg-ch-detail .dbg-slider')).toBeTruthy();
    // a tensor value → stats
    await act(() => { f.emit('demo.wave', makeTensor('f32', [2, 3], new Float32Array([1, -2, 3, NaN, 5, 6]))); });
    await tick(100);
    const st = host.querySelector('.dbg-stats')!.textContent!;
    expect(st).toContain('min-2');
    expect(st).toContain('max6');
    expect(st).toContain('NaN1');
    // JSON editor → PUT
    await act(() => { f.emit('demo.wave', { a: 1 }); });
    await tick(100);
    expect(host.querySelector('.dbg-jt')!.textContent).toContain('a');
    await act(() => { host.querySelector<HTMLButtonElement>('.dbg-ch-dhead .dbg-ibtn[title^="Edit"]')!.click(); });
    const ta = host.querySelector<HTMLTextAreaElement>('.dbg-edit textarea')!;
    await act(() => typeInto(ta, '{"a": 2,'));
    expect(host.querySelector('.dbg-edit.invalid')).toBeTruthy();
    await act(() => typeInto(ta, '{"a": 2}'));
    await act(() => { key(ta, 'Enter', { ctrlKey: true }); });
    await tick(10);
    expect(f.puts.at(-1)).toEqual({ name: 'demo.wave', body: { a: 2 } });
    // closing the detail releases the subscription
    await act(() => { host.querySelector<HTMLButtonElement>('.dbg-ch-dhead .dbg-ibtn[title="Close"]')!.click(); });
    await tick();
    expect(f.subs.has('demo.wave')).toBe(false);
    // unmounting the panel stops polling (need released) — no throw
    render(null, host);
    f.dispose();
  });
});
