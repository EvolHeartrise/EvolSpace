import { describe, expect, it, vi } from 'vitest';
import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import { boxWidget, makeRuntime, manifest } from './helpers.ts';

const T = (x: number, y: number, z: number, s = 1) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [s, s, s] as [number, number, number] });

/** Slider-ish widget: a flat track (not interactive) and a knob registered via ctx.interactive. */
function sliderWidget(events: InteractionEvent[]): WidgetDefinition {
  return {
    description: 'slider',
    create(ctx) {
      const T3 = ctx.THREE;
      const track = new T3.Mesh(new T3.BoxGeometry(0.4, 0.05, 0.01), ctx.ui.material('#888888'));
      track.name = 'track';
      const knob = new T3.Mesh(new T3.BoxGeometry(0.05, 0.08, 0.04), ctx.ui.material('#ffffff'));
      knob.name = 'knob';
      knob.position.set(0.1, 0, 0.02);
      ctx.root.add(track, knob);
      ctx.interactive(knob);
      return { onInteraction: (e) => events.push(e) };
    },
  };
}

async function setup() {
  const r = makeRuntime();
  const events: InteractionEvent[] = [];
  r.widgets.set('box', boxWidget(0.2));
  r.widgets.set('slider', sliderWidget(events));
  r.rt.widgets.setCatalog([
    manifest('box', { interactions: [{ id: 'b', pose: 'pinch', target: 'ray', action: { type: 'grab' } }] }),
    manifest('slider'),
  ]);
  // Space root offset from the world origin, to exercise space↔world conversions.
  r.rt.root.position.set(10, 0, 0);
  r.rt.applyPatch([
    { op: 'add', entity: { id: 'near', widget: 'box', transform: T(0, 1.5, -1) } },
    { op: 'add', entity: { id: 'far', widget: 'box', transform: T(0, 1.5, -3) } },
    { op: 'add', entity: { id: 'sl', widget: 'slider', transform: T(1, 1.5, -1) } },
    { op: 'add', entity: { id: 'hidden', widget: 'box', transform: T(-1, 1.5, -1), visible: false } },
    { op: 'add', entity: { id: 'parent', widget: 'box', transform: T(0, 0.5, -1, 2) } },
    { op: 'add', entity: { id: 'child', widget: 'box', parent: 'parent', transform: T(0, 0, 0.1, 0.25) } },
  ]);
  await r.rt.whenIdle();
  r.rt.update(0.016, 0);
  return { ...r, events, host: r.rt.interactionHost() };
}

describe('interaction host', () => {
  it('raycasts in space coordinates and picks the nearest entity', async () => {
    const { host } = await setup();
    const hit = host.raycast([0, 1.5, 0], [0, 0, -1])!;
    expect(hit.entity).toBe('near');
    expect(hit.interactive).toBe(false);
    expect(hit.point[2]).toBeCloseTo(-0.9, 3);
    expect(hit.distance).toBeCloseTo(0.9, 3);
    expect(host.raycast([0, 1.5, 0], [0, 1, 0])).toBeNull();
    // Hidden entities are not hit.
    expect(host.raycast([-1, 1.5, 0], [0, 0, -1])).toBeNull();
  });

  it('distinguishes interactive parts from the widget frame', async () => {
    const { host } = await setup();
    const knob = host.raycast([1.1, 1.5, 0], [0, 0, -1])!;
    expect(knob).toMatchObject({ entity: 'sl', interactive: true, object: 'knob' });
    const track = host.raycast([0.9, 1.5, 0], [0, 0, -1])!;
    expect(track).toMatchObject({ entity: 'sl', interactive: false });
  });

  it('prefers a child entity in front of its parent', async () => {
    const { host } = await setup();
    // parent box: 0.4 m at z=-1; child: 0.1 m box centered 0.2 m in front (scale 2 × 0.1).
    const hit = host.raycast([0, 0.5, 0], [0, 0, -1])!;
    expect(hit.entity).toBe('child');
  });

  it('touch finds the entity whose bounds contain / are near the point, interactive parts first', async () => {
    const { host } = await setup();
    expect(host.touch([0, 1.5, -1], 0.01)!.entity).toBe('near');
    expect(host.touch([0, 1.5, -0.85], 0.06)!.entity).toBe('near');
    expect(host.touch([0, 1.5, -0.5], 0.05)).toBeNull();
    const k = host.touch([1.1, 1.5, -0.97], 0.02)!;
    expect(k).toMatchObject({ entity: 'sl', interactive: true, object: 'knob' });
    // Nested: the smaller (more specific) child wins when both contain the point.
    expect(host.touch([0, 0.5, -0.8], 0.01)!.entity).toBe('child');
  });

  it('getWorldTransform returns space coordinates', async () => {
    const { host } = await setup();
    const t = host.getWorldTransform('child');
    expect(t.position.map((v) => +v.toFixed(5))).toEqual([0, 0.5, -0.8]);
    expect(t.scale.map((v) => +v.toFixed(5))).toEqual([0.5, 0.5, 0.5]);
  });

  it('setEntityTransform previews locally, throttles move ops, groups a gesture for undo', async () => {
    const { host, ws, rt } = await setup();
    ws.clearSent();
    host.setEntityTransform('child', T(0, 1, -1, 0.5), 'start');
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
    host.setEntityTransform('child', T(0, 1.1, -1, 0.5), 'move');
    host.setEntityTransform('child', T(0, 1.2, -1, 0.5), 'move');
    host.setEntityTransform('child', T(0, 1.3, -1, 0.5), 'end');
    const ops = ws.messagesOf('scene.ops');
    expect(ops).toHaveLength(2); // first move (leading edge) + end
    expect(new Set(ops.map((o) => o.group)).size).toBe(1);
    expect(ops.every((o) => o.source === 'user')).toBe(true);
    // Converted into the parent's frame: parent at (0,0.5,-1) scale 2 → local (0, 0.4, 0) scale 0.25.
    const fin = ops[1].ops[0] as { patch: { transform: { position: number[]; scale: number[] } } };
    expect(fin.patch.transform.position.map((v) => +v.toFixed(5))).toEqual([0, 0.4, 0]);
    expect(fin.patch.transform.scale.map((v) => +v.toFixed(5))).toEqual([0.25, 0.25, 0.25]);
    // Preview is visible immediately even though the server hasn't confirmed.
    rt.update(0.016, 0.1);
    expect(host.getWorldTransform('child').position.map((v) => +v.toFixed(5))).toEqual([0, 1.3, -1]);
    // A new gesture gets a new group.
    host.setEntityTransform('child', T(0, 1, -1, 0.5), 'start');
    host.setEntityTransform('child', T(0, 1, -1, 0.5), 'end');
    const groups = new Set(ws.messagesOf('scene.ops').map((o) => o.group));
    expect(groups.size).toBe(2);
  });

  it('locked entities ignore transforms', async () => {
    const { host, ws, rt } = await setup();
    rt.applyPatch([{ op: 'update', id: 'near', patch: { locked: true } }]);
    ws.clearSent();
    host.setEntityTransform('near', T(5, 5, 5), 'start');
    host.setEntityTransform('near', T(5, 5, 5), 'end');
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
  });

  it('deliver converts the point into widget-local coordinates', async () => {
    const { host, events } = await setup();
    host.deliver('sl', { handler: 'drag', phase: 'start', hand: 'right', localPoint: [0, 0, 0], point: [1.1, 1.5, -0.98], pointer: { position: [1.1, 1.5, 0], rotation: [0, 0, 0, 1] } });
    expect(events).toHaveLength(1);
    expect(events[0].localPoint.map((v) => +v.toFixed(5))).toEqual([0.1, 0, 0.02]);
  });

  it('runCommand: local first, else forwarded to the server on start only', async () => {
    const { host, ws, rt } = await setup();
    const fn = vi.fn();
    rt.registerLocalCommand('voice.ptt', fn);
    host.runCommand('voice.ptt', undefined, 'start');
    host.runCommand('voice.ptt', undefined, 'end');
    expect(fn.mock.calls).toEqual([[undefined, 'start'], [undefined, 'end']]);
    ws.clearSent();
    host.runCommand('undo', undefined, 'start');
    host.runCommand('undo', undefined, 'end');
    expect(ws.messagesOf('command')).toEqual([{ type: 'command', name: 'undo' }]);
  });

  it('publish / poseEvent go to the net', async () => {
    const { host, ws } = await setup();
    host.publish('ui.toggle', true);
    host.poseEvent({ pose: 'pinch', hand: 'left', phase: 'start', t: 1 });
    expect(ws.messagesOf('channel.publish')[0]).toMatchObject({ channel: 'ui.toggle', value: true });
    expect(ws.messagesOf('pose.event')[0].event.pose).toBe('pinch');
  });

  it('select uses the hover target, toggles, and follows entity removal', async () => {
    const { host, rt } = await setup();
    const changes: Array<string | null> = [];
    rt.onSelectionChange((id) => changes.push(id));
    host.hover!('right', host.raycast([0, 1.5, 0], [0, 0, -1]));
    rt.runLocalCommand('select', undefined, 'start');
    expect(rt.selected).toBe('near');
    rt.update(0.016, 0.2);
    rt.runLocalCommand('select', undefined, 'start');
    expect(rt.selected).toBeNull();
    rt.runLocalCommand('select', { entity: 'far' }, 'start');
    expect(rt.selected).toBe('far');
    rt.applyPatch([{ op: 'remove', id: 'far' }]);
    expect(rt.selected).toBeNull();
    expect(changes).toEqual(['near', null, 'far', null]);
  });

  it('widgetBindings come from the manifest', async () => {
    const { host } = await setup();
    expect(host.widgetBindings('box')[0].id).toBe('b');
    expect(host.widgetBindings('unknown')).toEqual([]);
    expect(host.getEntity('near')!.widget).toBe('box');
  });

  it('frameEntity returns world bounds of the subtree', async () => {
    const { rt } = await setup();
    const b = rt.frameEntity('parent')!;
    expect(b.min.x).toBeCloseTo(9.8, 3); // root offset +10
    expect(b.max.z).toBeCloseTo(-0.75, 3); // child front face: center -0.8, half-depth 0.05
  });

  it('a pinch released in place sends no op (no empty undo step)', async () => {
    const { host, ws } = await setup();
    ws.clearSent();
    const t0 = host.getWorldTransform('near');
    host.setEntityTransform('near', t0, 'start');
    host.setEntityTransform('near', t0, 'end');
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
    // …but a gesture that moved and came back still sends its final op.
    host.setEntityTransform('near', t0, 'start');
    host.setEntityTransform('near', T(0, 1.6, -1), 'move');
    host.setEntityTransform('near', t0, 'end');
    expect(ws.messagesOf('scene.ops')).toHaveLength(2);
  });

  it('an entity removed mid-gesture gets no further ops', async () => {
    const { host, ws, rt } = await setup();
    host.setEntityTransform('near', T(0, 1.5, -1), 'start');
    host.setEntityTransform('near', T(0, 1.6, -1), 'move'); // leading edge → sent
    host.setEntityTransform('near', T(0, 1.7, -1), 'move'); // pending (throttled)
    ws.clearSent();
    rt.applyPatch([{ op: 'remove', id: 'near' }]);
    await new Promise((r) => setTimeout(r, 120));
    rt.update(0.016, 0.3);
    host.setEntityTransform('near', T(0, 1.8, -1), 'end');
    expect(ws.messagesOf('scene.ops')).toHaveLength(0);
  });

  it('hover (touch-preferred) drives highlight/select; the ray hit drives the beam', async () => {
    const { host, rt } = await setup();
    // The ray points at 'far' while the hand touches 'near'.
    const rayHit = host.raycast([0, 1.5, -2], [0, 0, -1])!;
    expect(rayHit.entity).toBe('far');
    const touchHit = host.touch([0, 1.5, -0.9], 0.03)!;
    expect(touchHit.entity).toBe('near');
    host.hover!('right', touchHit);
    rt.setPointerRays({ right: { origin: [0, 1.5, -2], direction: [0, 0, -1], hit: rayHit } });
    rt.update(0.016, 0.1);
    expect(rt.pointer.hoveredEntity()).toBe('near');
    rt.runLocalCommand('select', undefined, 'start');
    expect(rt.selected).toBe('near');
    const beam = rt.pointer.group.getObjectByName('ray:right')!;
    expect(beam.visible).toBe(true);
    expect(beam.scale.y).toBeCloseTo(rayHit.distance, 5);
    // Without hover() reports (no engine), the ray hit is the hover target.
    const r2 = makeRuntime();
    r2.rt.setPointerRays({ left: { origin: [0, 0, 0], direction: [0, 0, -1], hit: { entity: 'x', point: [0, 0, -1], distance: 1, interactive: false } } });
    expect(r2.rt.pointer.hoveredEntity()).toBe('x');
  });
});
