// Pure helpers of the Events / Sources / Screenshots debug panels:
// event summaries, severity, filters, unseen-error counting, stack formatting;
// source exits + log line classes; screenshot requests from the desktop camera pose.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ServerEvent } from '@evolspace/protocol';
import {
  countErrorsSince, eventEntities, filterEvents, formatStack, severity, summarize, summaryText,
} from '../src/debug/panels/events/summarize.ts';
import { exitsFor, lineClass } from '../src/debug/panels/sources/model.ts';
import {
  DEFAULT_FORM, buildRequest, cameraViewFromWorld, cameraViewOf, captionOf, directionToCamera, sizeOf,
} from '../src/debug/panels/screenshots/request.ts';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ts = 1000 + seq): ServerEvent => ({ seq: ++seq, ts, type: type as ServerEvent['type'], data });

describe('event summaries', () => {
  it('summarizes each type in one line', () => {
    expect(summaryText(summarize(ev('widget.build', { widget: 'slider', ok: true, ms: 42, hash: 'abc' })))).toBe('slider ok 42 ms · abc');
    expect(summaryText(summarize(ev('widget.build', { widget: 'bad', ok: false, error: 'x.ts:1:2: ERROR: nope\nmore' })))).toBe('bad error x.ts:1:2: ERROR: nope …');
    expect(summaryText(summarize(ev('voice.utterance', { text: 'undo that', route: 'fastpath', command: 'undo', run: 'undo' })))).toBe('“undo that” → fastpath undo');
    expect(summaryText(summarize(ev('voice.utterance', { text: 'make it red', route: 'agent', target: 'e-4' })))).toBe('“make it red” → agent @ e-4');
    expect(summaryText(summarize(ev('voice.utterance', { text: '', route: 'none', reason: 'too short' })))).toBe('too short → none');
    expect(summaryText(summarize(ev('agent.ask', { text: 'hi', context: { kind: 'debug', selected: 'e-2' } })))).toBe('“hi” · debug → e-2');
    expect(summaryText(summarize(ev('pose.event', { pose: 'pinch', hand: 'right', phase: 'start', binding: 'grab', target: 'e-1' })))).toBe('pinch right start · grab → e-1');
    expect(summaryText(summarize(ev('client.error', { message: 'boom\nat x', widget: 'box', entity: 'e-9' })))).toBe('boom … (box e-9)');
    expect(summaryText(summarize(ev('source.exit', { id: 'stt', code: 1, ranMs: 2500, restarting: true, restarts: 2 })))).toBe('stt exited code 1 after 2.5 s · restarting (#2)');
    expect(summaryText(summarize(ev('scene.changed', { version: 7, source: 'user', ops: 2 })))).toBe('v7 · user · 2 ops');
  });

  it('classifies severity (errors are red: client.error, failed builds, source exits)', () => {
    expect(severity(ev('client.error', { message: 'x' }))).toBe('error');
    expect(severity(ev('widget.build', { ok: false, error: 'e' }))).toBe('error');
    expect(severity(ev('widget.build', { ok: true }))).toBe('info');
    expect(severity(ev('source.exit', { id: 's', code: 0 }))).toBe('error');
    expect(severity(ev('client.log', { level: 'warn', message: 'w' }))).toBe('warn');
    expect(severity(ev('gestures.load', { ok: false, errors: { 'a.json': 'bad' } }))).toBe('error');
    expect(severity(ev('scene.changed', {}))).toBe('dim');
  });

  it('extracts entity references (entity, target, selected, focus, gaze; ask context)', () => {
    expect(eventEntities(ev('client.error', { entity: 'e-1' }))).toEqual(['e-1']);
    expect(eventEntities(ev('agent.ask', { text: 't', context: { selected: 'e-2', focus: { right: { entity: 'e-3' } } } }))).toEqual(['e-2', 'e-3']);
    expect(summarize(ev('pose.event', { pose: 'p', target: 'e-5' })).segs).toContainEqual({ entity: 'e-5' });
  });

  it('filters by type, errors-only, multi-term text search and the clear mark; counts unseen errors', () => {
    const list = [
      ev('widget.build', { widget: 'slider', ok: true }, 10),
      ev('client.error', { message: 'TypeError in slider', entity: 'e-1' }, 11),
      ev('pose.event', { pose: 'pinch', hand: 'left', phase: 'start' }, 12),
      ev('widget.build', { widget: 'gauge', ok: false, error: 'syntax' }, 13),
      ev('scene.changed', { version: 3 }, 14),
    ];
    const base = { hidden: new Set<string>(), query: '', errorsOnly: false, clearedAt: null };
    expect(filterEvents(list, base)).toHaveLength(5);
    expect(filterEvents(list, { ...base, hidden: new Set(['widget.build', 'scene.changed']) }).map((e) => e.type)).toEqual(['client.error', 'pose.event']);
    expect(filterEvents(list, { ...base, errorsOnly: true }).map((e) => e.type)).toEqual(['client.error', 'widget.build']);
    expect(filterEvents(list, { ...base, query: 'SLIDER error' }).map((e) => e.type)).toEqual(['client.error']);
    expect(filterEvents(list, { ...base, query: 'e-1' })).toHaveLength(1); // JSON payload is searched
    expect(filterEvents(list, { ...base, clearedAt: { ts: list[2].ts, seq: list[2].seq } })).toHaveLength(2);
    expect(countErrorsSince(list, null)).toBe(2);
    expect(countErrorsSince(list, { ts: list[1].ts, seq: list[1].seq })).toBe(1);
    expect(countErrorsSince(list, { ts: list[4].ts, seq: list[4].seq })).toBe(0);
  });

  it('filters thousands of events quickly', () => {
    const many: ServerEvent[] = [];
    for (let i = 0; i < 5000; i++) many.push(ev(i % 7 ? 'pose.event' : 'client.error', { pose: `p${i}`, message: `m${i}` }, 2000 + i));
    const t0 = performance.now();
    const r = filterEvents(many, { hidden: new Set(), query: 'm42', errorsOnly: true, clearedAt: null });
    expect(r.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('formats stack traces (origin stripped, own/vendor frames marked)', () => {
    const lines = formatStack(
      'TypeError: x is undefined\n    at update (http://127.0.0.1:8787/widgets/slider.js?v=abc:10:5)\n    at run (http://127.0.0.1:8787/node_modules/.vite/deps/three.js?v=12:1:1)\n    at tick (http://127.0.0.1:8787/src/app.ts:3:3)',
      'http://127.0.0.1:8787',
    );
    expect(lines[0]).toMatchObject({ text: 'TypeError: x is undefined', frame: false });
    expect(lines[1]).toMatchObject({ text: '  at update (/widgets/slider.js:10:5)', frame: true, own: true, vendor: false });
    expect(lines[2]).toMatchObject({ frame: true, vendor: true });
    expect(lines[3]).toMatchObject({ frame: true, own: false, vendor: false });
    expect(formatStack('f@http://h:1/widgets/a.js:1:2')[0]).toMatchObject({ frame: true, own: true });
  });
});

describe('sources helpers', () => {
  it('lists a source’s exits newest first and classifies log lines', () => {
    const list = [ev('source.exit', { id: 'stt', code: 1, restarting: true }), ev('source.exit', { id: 'other', code: 0 }), ev('source.exit', { id: 'stt', code: null, signal: 'SIGTERM' })];
    const x = exitsFor(list, 'stt');
    expect(x.map((e) => e.signal ?? e.code)).toEqual(['SIGTERM', 1]);
    expect(lineClass('Traceback (most recent call last):')).toBe('e');
    expect(lineClass('  File "x.py", line 3, in <module>')).toBe('e');
    expect(lineClass('WARNING: slow')).toBe('w');
    expect(lineClass('listening on :8790')).toBe('');
  });
});

describe('screenshot requests', () => {
  it('converts the desktop camera world pose into space coordinates (root offset + yaw)', () => {
    const root = new THREE.Group();
    root.position.set(1, 0, -2);
    root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const camPos = new THREE.Vector3(1, 1.6, 0); // 2 m along world +Z from the root
    const camQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const v = cameraViewFromWorld(camPos, camQ, 55, root);
    expect(v.kind).toBe('camera');
    // world +Z rotated into the root frame (yaw -90°) → space +X... check by round trip:
    const back = new THREE.Vector3(...v.position).applyMatrix4(root.matrixWorld);
    expect(back.distanceTo(camPos)).toBeLessThan(1e-3);
    const qBack = root.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion(...v.rotation!));
    expect(Math.abs(qBack.dot(camQ))).toBeCloseTo(1, 4);
    // Root rotation equals the camera's: in space the camera has identity rotation.
    expect(Math.abs(v.rotation![3])).toBeCloseTo(1, 4);
    expect(v.fov).toBe(55);
  });

  it('uses a PerspectiveCamera’s world pose and FOV (identity root = world coords)', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 100);
    cam.position.set(0, 1.6, 2);
    cam.lookAt(0, 1.2, 0);
    const v = cameraViewOf(cam, new THREE.Group());
    expect(v.position).toEqual([0, 1.6, 2]);
    expect(v.fov).toBe(60);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...v.rotation!));
    expect(fwd.z).toBeLessThan(-0.9);
    expect(fwd.y).toBeLessThan(0);
  });

  it('builds requests per view kind with sizes, overlays and background', () => {
    const camera = { kind: 'camera' as const, position: [0, 1.6, 2] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], fov: 50 };
    const env = { camera, selection: 'e-1', viewport: { width: 1000, height: 500 }, entityCenter: () => new THREE.Vector3(0, 1.6, 0) };
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'camera' }, env)).toEqual({ view: camera, width: 1280, height: 640, hands: false });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'user', hands: true, size: '1024x768' }, env)).toEqual({ view: { kind: 'user' }, width: 1024, height: 768, hands: true });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'entity', direction: 'left', labels: true, background: 'transparent', size: '512x512' }, env))
      .toEqual({ view: { kind: 'entity', entity: 'e-1', direction: [-1, 0.3, 0] }, width: 512, height: 512, hands: false, labels: true, background: 'transparent' });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'entity', direction: 'camera', entity: 'e-2' }, env))
      .toMatchObject({ view: { kind: 'entity', entity: 'e-2', direction: [0, 0, 1] } });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'entity' }, { ...env, selection: null })).toEqual({ error: expect.any(String) });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'widget', widget: 'gauge', widgetProps: { value: 0.5 }, direction: 'front', background: 'color', color: '#222222', size: 'custom', width: 640, height: 9000 }, env))
      .toEqual({ view: { kind: 'widget', widget: 'gauge', props: { value: 0.5 }, direction: [0, 0.3, 1] }, width: 640, height: 4096, hands: false, background: '#222222' });
    expect(buildRequest({ ...DEFAULT_FORM, kind: 'widget' }, env)).toEqual({ error: 'pick a widget' });
  });

  it('sizes, directions and captions', () => {
    expect(sizeOf({ size: 'viewport', width: 0, height: 0 }, { width: 600, height: 900 })).toEqual({ width: 853, height: 1280 });
    expect(directionToCamera(new THREE.Vector3(0, 0, 0), [3, 0, 4])).toEqual([0.6, 0, 0.8]);
    expect(captionOf({ view: { kind: 'entity', entity: 'e-3' }, width: 800, height: 600 })).toBe('entity e-3 · 800×600');
  });
});
