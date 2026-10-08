import { describe, expect, it } from 'vitest';
import type { HandFrame, Handedness, InteractionSet, Vec3 } from '@evolspace/protocol';
import { InteractionEngine, type InteractionEngineOptions } from '../src/engine.ts';
import type { HandFrames } from '../src/matcher.ts';
import { handRay, pinchPoint } from '../src/ray.ts';
import { INDEX_TIP, jointPos, jointRot } from '../src/joints.ts';
import { add, addScaled, distance, length, qFromAxisAngle, qMul, qRotate, relativeTo, scale, sub } from '../src/math.ts';
import { FakeHost, HEAD, ORIENT, loadInteractionSets, loadPoses, shape, wristPos } from './helpers.ts';
import { HAND_SHAPES } from '../src/synth.ts';

const POSES = loadPoses();
const SETS = loadInteractionSets();
/** Disable ray smoothing so geometry assertions are exact. */
const RAW: InteractionEngineOptions = { smoothing: { origin: { minCutoff: 1e9 }, direction: { minCutoff: 1e9 } } };

function setup(extraSets: Record<string, InteractionSet> = {}, opts: InteractionEngineOptions = RAW) {
  const host = new FakeHost();
  const eng = new InteractionEngine(host, opts);
  eng.setPoses(POSES);
  eng.setInteractions({ ...SETS, ...extraSets });
  return { host, eng };
}

type ShapeName = keyof typeof HAND_SHAPES;
/** A hand in a shape, offset from its default wrist position. */
const H = (name: ShapeName, hand: Handedness = 'right', delta: Vec3 = [0, 0, 0], extra = {}): HandFrame =>
  shape(name, hand, { position: add(wristPos(hand), delta), ...extra });

/** Run updates every 10 ms over [from, to). Returns the next time. */
function run(eng: InteractionEngine, frames: HandFrames, from: number, to: number): number {
  for (let t = from; t < to; t += 10) eng.update(frames, HEAD, t);
  return to;
}

const near = (a: Vec3, b: Vec3, eps = 1e-6) => expect(distance(a, b)).toBeLessThan(eps);

describe('InteractionEngine: grab', () => {
  it('near pinch grabs, follows the hand rigidly keeping the offset, and releases', () => {
    const { host, eng } = setup();
    const pp = pinchPoint(H('pinch'));
    const start: Vec3 = add(pp, [0.01, -0.01, -0.02]);
    host.add('cube', start, { half: [0.04, 0.04, 0.04] });
    let t = run(eng, { right: H('relaxed') }, 0, 20);
    t = run(eng, { right: H('pinch') }, t, 100);
    const starts = host.of('setEntityTransform').filter((c) => c.phase === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].id).toBe('cube');
    near(starts[0].t.position, start);
    expect(host.of('poseEvent')[0].e).toMatchObject({ pose: 'pinch', hand: 'right', phase: 'start', binding: 'grab', target: 'cube' });

    // Translate the hand: the entity translates by the same amount.
    const d: Vec3 = [0.1, 0.05, -0.03];
    t = run(eng, { right: H('pinch', 'right', d) }, t, t + 20);
    near(host.getWorldTransform('cube').position, add(start, d));

    // Rotate the hand 90° about world up around its wrist: the offset in the hand's frame is preserved.
    const yaw = qFromAxisAngle([0, 1, 0], Math.PI / 2);
    const rotated = H('pinch', 'right', d, { rotation: qMul(yaw, ORIENT.pinchPosture('right')) });
    const before = relativeTo({ position: pinchPoint(H('pinch', 'right', d)), rotation: jointRot(H('pinch', 'right', d), 0) }, host.getWorldTransform('cube'));
    t = run(eng, { right: rotated }, t, t + 20);
    const after = relativeTo({ position: pinchPoint(rotated), rotation: jointRot(rotated, 0) }, host.getWorldTransform('cube'));
    near(after.position, before.position);
    expect(Math.abs(Math.abs(after.rotation.reduce((s, v, i) => s + v * before.rotation[i], 0)) - 1)).toBeLessThan(1e-9);

    t = run(eng, { right: H('relaxed') }, t, t + 20);
    const ends = host.of('setEntityTransform').filter((c) => c.phase === 'end');
    expect(ends).toHaveLength(1);
    near(ends[0].t.position, host.getWorldTransform('cube').position);
    expect(host.of('poseEvent').at(-1)!.e).toMatchObject({ phase: 'end', binding: 'grab', target: 'cube' });
    expect(eng.activeSessions()).toEqual([]);
  });

  it('ray pinch grabs a distant entity and keeps its distance along the ray', () => {
    const { host, eng } = setup();
    const ray = handRay(H('pinch'), HEAD);
    const pos = addScaled(ray.origin, ray.direction, 1.5);
    host.add('far', pos, { half: [0.1, 0.1, 0.1] });
    let t = run(eng, { right: H('pinch') }, 0, 60);
    expect(eng.activeSessions()).toMatchObject([{ binding: 'grab', target: 'far', mode: 'grab' }]);
    const startDist = distance(ray.origin, host.getWorldTransform('far').position);
    const moved = H('pinch', 'right', [0.15, 0.1, 0]);
    t = run(eng, { right: moved }, t, t + 20);
    const r2 = handRay(moved, HEAD);
    const p2 = host.getWorldTransform('far').position;
    expect(Math.abs(distance(r2.origin, p2) - startDist)).toBeLessThan(1e-6);
    // Still on (close to) the new ray, i.e. it swung with the ray.
    const along = sub(p2, r2.origin);
    expect(length(sub(along, scale(r2.direction, startDist)))).toBeLessThan(0.05);
    expect(distance(p2, pos)).toBeGreaterThan(0.1);
  });

  it('locked entities ignore grab', () => {
    const { host, eng } = setup();
    host.add('locked', pinchPoint(H('pinch')), { locked: true });
    run(eng, { right: H('pinch') }, 0, 80);
    expect(host.of('setEntityTransform')).toEqual([]);
    expect(host.of('poseEvent')[0].e.binding).toBeUndefined();
  });

  it('an entity removed mid-grab is dropped without further transforms', () => {
    const { host, eng } = setup();
    host.add('cube', pinchPoint(H('pinch')));
    let t = run(eng, { right: H('pinch') }, 0, 60);
    host.entities.delete('cube');
    host.clear();
    t = run(eng, { right: H('pinch', 'right', [0.1, 0, 0]) }, t, t + 30);
    run(eng, { right: H('relaxed') }, t, t + 30);
    expect(host.of('setEntityTransform')).toEqual([]);
  });
});

describe('InteractionEngine: binding resolution', () => {
  const slider = (host: FakeHost, knobAtPinch: boolean, extra = {}) => {
    const pp = pinchPoint(H('pinch'));
    const center: Vec3 = knobAtPinch ? add(pp, [0.1, 0, 0]) : pp;
    host.widgetDefaults.set('slider', [{ id: 'drag', pose: 'pinch', target: 'near', action: { type: 'widget', handler: 'drag' } }]);
    host.add('sl', center, {
      widget: 'slider', half: [0.15, 0.03, 0.01], ...extra,
      parts: [{ name: 'knob', offset: knobAtPinch ? [-0.1, 0, 0] : [0.1, 0, 0], half: [0.012, 0.012, 0.012], interactive: true }],
    });
    return center;
  };

  it("widget actions only fire on interactive parts (knob drags, frame grabs)", () => {
    {
      const { host, eng } = setup();
      slider(host, true);
      let t = run(eng, { right: H('pinch') }, 0, 60);
      t = run(eng, { right: H('pinch', 'right', [0.05, 0, 0]) }, t, t + 20);
      run(eng, { right: H('relaxed') }, t, t + 20);
      const ev = host.of('deliver').filter((c) => c.e.handler === 'drag');
      expect(ev.map((c) => c.e.phase)).toEqual(['start', 'move', 'move', 'move', 'move', 'end']);
      expect(ev[0].e.objectName).toBe('knob');
      expect(ev[0].id).toBe('sl');
      // Touch drags report the contact point; localPoint is in the widget's frame.
      const lastMove = ev.at(-2)!.e;
      near(lastMove.point, pinchPoint(H('pinch', 'right', [0.05, 0, 0])));
      near(lastMove.localPoint, sub(lastMove.point, host.getWorldTransform('sl').position));
      expect(host.of('setEntityTransform')).toEqual([]);
    }
    {
      const { host, eng } = setup();
      slider(host, false);
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('deliver').filter((c) => c.e.handler === 'drag')).toEqual([]);
      expect(eng.activeSessions()).toMatchObject([{ binding: 'grab', scope: 'entity-default', target: 'sl' }]);
    }
  });

  it('ray-started widget drags report points on the widget plane (through the hit, normal = local +Z)', () => {
    const { host, eng } = setup();
    host.widgetDefaults.set('slider', [{ id: 'drag', pose: 'pinch', target: 'near', action: { type: 'widget', handler: 'drag' } }]);
    const ray = handRay(H('pinch'), HEAD);
    host.add('sl', addScaled(ray.origin, ray.direction, 1.2), {
      widget: 'slider', half: [0.3, 0.1, 0.01], parts: [{ name: 'knob', offset: [0, 0, 0], half: [0.03, 0.03, 0.03], interactive: true }],
    });
    let t = run(eng, { right: H('pinch') }, 0, 60);
    run(eng, { right: H('pinch', 'right', [0.06, 0.03, 0]) }, t, t + 20);
    const ev = host.of('deliver').filter((c) => c.e.handler === 'drag').map((c) => c.e);
    expect(ev[0].phase).toBe('start');
    const last = ev.at(-1)!;
    expect(Math.abs(last.point[2] - ev[0].point[2])).toBeLessThan(1e-9);
    expect(last.point[0] - ev[0].point[0]).toBeGreaterThan(0.05);
    expect(length(sub(last.pointer.position, pinchPoint(H('pinch', 'right', [0.06, 0.03, 0]))))).toBeLessThan(0.05);
  });

  it('touch drags report the contact point from start on, even when the host clamps hit points to the surface', () => {
    const { host, eng } = setup();
    host.widgetDefaults.set('slider', [{ id: 'drag', pose: 'pinch', target: 'near', action: { type: 'widget', handler: 'drag' } }]);
    // Knob 2 cm to the right of the pinch point (within the 3 cm touch radius).
    host.add('sl', add(pinchPoint(H('pinch')), [0.032, 0, 0]), {
      widget: 'slider', half: [0.012, 0.012, 0.012], parts: [{ name: 'knob', offset: [0, 0, 0], half: [0.012, 0.012, 0.012], interactive: true }],
    });
    const realTouch = host.touch.bind(host);
    host.touch = (p, r) => {
      const h = realTouch(p, r);
      if (!h) return h;
      const c = host.getWorldTransform('sl').position;
      return { ...h, point: [c[0] - 0.012, p[1], p[2]] }; // surface point, like the runtime Picker
    };
    let t = run(eng, { right: H('pinch') }, 0, 60);
    run(eng, { right: H('pinch') }, t, t + 20);
    const ev = host.of('deliver').filter((c) => c.e.handler === 'drag').map((c) => c.e);
    expect(ev[0].phase).toBe('start');
    near(ev[0].point, pinchPoint(H('pinch')));
    near(ev[1].point, ev[0].point);
  });

  it('locked widgets still get widget actions', () => {
    const { host, eng } = setup();
    slider(host, true, { locked: true });
    run(eng, { right: H('pinch') }, 0, 60);
    expect(eng.activeSessions()).toMatchObject([{ binding: 'drag', scope: 'widget' }]);
  });

  it("standard 'press' fires for interactive parts of widgets without their own bindings", () => {
    const { host, eng } = setup();
    host.add('btn', pinchPoint(H('pinch')), { parts: [{ name: 'face', offset: [0, 0, 0], half: [0.02, 0.02, 0.02], interactive: true }] });
    let t = run(eng, { right: H('pinch') }, 0, 60);
    run(eng, { right: H('relaxed') }, t, t + 20);
    const press = host.of('deliver').filter((c) => c.e.handler === 'press');
    expect(press[0].e.phase).toBe('start');
    expect(press.at(-1)!.e.phase).toBe('end');
    expect(host.of('setEntityTransform')).toEqual([]);
  });

  it('scope order: entity > widget default > entity-default > global', () => {
    const globalPinch: Record<string, InteractionSet> = {
      zz: { description: '', scope: 'global', bindings: [{ id: 'g', pose: 'pinch', target: 'none', action: { type: 'command', command: 'gcmd' } }] },
    };
    // entity scope beats the widget default (even on an interactive part)
    {
      const { host, eng } = setup(globalPinch);
      slider(host, true, { interactions: [{ id: 'mine', pose: 'pinch', target: 'near', action: { type: 'command', command: 'ecmd', args: { x: 1 } } }] });
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('runCommand')).toMatchObject([{ name: 'ecmd', phase: 'start', args: { x: 1, hand: 'right', entity: 'sl' } }]);
    }
    // widget default (any action) beats entity-default grab
    {
      const { host, eng } = setup(globalPinch);
      host.widgetDefaults.set('box', [{ id: 'w', pose: 'pinch', target: 'near', action: { type: 'command', command: 'wcmd' } }]);
      host.add('b', pinchPoint(H('pinch')));
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('runCommand').map((c) => c.name)).toEqual(['wcmd']);
    }
    // entity-default beats global; global applies when nothing (grabbable) is hit
    {
      const { host, eng } = setup(globalPinch);
      host.add('b', pinchPoint(H('pinch')));
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('runCommand')).toEqual([]);
      expect(eng.activeSessions()[0].binding).toBe('grab');
    }
    {
      const { host, eng } = setup(globalPinch);
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('runCommand')).toMatchObject([{ name: 'gcmd', args: { hand: 'right' } }]);
      expect(host.of('runCommand')[0].args).not.toHaveProperty('entity');
    }
    {
      const { host, eng } = setup(globalPinch);
      host.add('b', pinchPoint(H('pinch')), { locked: true });
      run(eng, { right: H('pinch') }, 0, 60);
      expect(host.of('runCommand').map((c) => c.name)).toEqual(['gcmd']);
    }
  });

  it('within a scope the highest priority wins; ties go to the first declared', () => {
    const extra: Record<string, InteractionSet> = {
      a: { description: '', scope: 'entity-default', bindings: [
        { id: 'p5', pose: 'pinch', target: 'near', action: { type: 'command', command: 'five' }, priority: 5 },
        { id: 'p5b', pose: 'pinch', target: 'near', action: { type: 'command', command: 'five-b' }, priority: 5 },
      ] },
    };
    const { host, eng } = setup(extra);
    host.add('b', pinchPoint(H('pinch')));
    run(eng, { right: H('pinch') }, 0, 60);
    expect(host.of('runCommand').map((c) => c.name)).toEqual(['five']);
    expect(host.of('setEntityTransform')).toEqual([]);
  });

  it("per-binding target modes: 'ray' ignores touch-only hits, 'touch' ignores ray-only hits", () => {
    const extra: Record<string, InteractionSet> = {
      a: { description: '', scope: 'entity-default', bindings: [
        { id: 'rayonly', pose: 'fist', target: 'ray', action: { type: 'command', command: 'ray' } },
        { id: 'touchonly', pose: 'fist', target: 'touch', action: { type: 'command', command: 'touch' } },
      ] },
    };
    const { host, eng } = setup(extra);
    const ray = handRay(H('fist'), HEAD);
    host.add('far', addScaled(ray.origin, ray.direction, 1), { half: [0.1, 0.1, 0.1] });
    run(eng, { right: H('fist') }, 0, 150);
    expect(host.of('runCommand').map((c) => c.name)).toEqual(['ray']);
  });
});

describe('InteractionEngine: two-hand scale', () => {
  function panelSetup() {
    const { host, eng } = setup();
    const l = pinchPoint(H('pinch', 'left'));
    const r = pinchPoint(H('pinch', 'right'));
    const mid = scale(add(l, r), 0.5);
    host.add('panel', mid, { half: [0.35, 0.15, 0.15] });
    return { host, eng, mid };
  }

  it('second hand pinching the grabbed entity takes over with translate/rotate/scale about the midpoint', () => {
    const { host, eng, mid } = panelSetup();
    let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
    expect(eng.activeSessions()).toMatchObject([{ hand: 'left', binding: 'grab', mode: 'grab' }]);
    t = run(eng, { left: H('pinch', 'left'), right: H('pinch') }, t, t + 60);
    const sessions = eng.activeSessions();
    expect(sessions.find((s) => s.hand === 'right')).toMatchObject({ binding: 'scale', target: 'panel', mode: 'scale' });
    expect(host.of('setEntityTransform').filter((c) => c.phase === 'start')).toHaveLength(1);
    expect(host.of('poseEvent').find((c) => c.e.hand === 'right' && c.e.phase === 'start')!.e).toMatchObject({ binding: 'scale', target: 'panel' });

    // Move the right hand outward and forward: scale up and yaw.
    const dR: Vec3 = [0.2, 0, -0.15];
    const L0 = pinchPoint(H('pinch', 'left'));
    const R0 = pinchPoint(H('pinch'));
    const R1 = pinchPoint(H('pinch', 'right', dR));
    t = run(eng, { left: H('pinch', 'left'), right: H('pinch', 'right', dR) }, t, t + 20);
    const tr = host.getWorldTransform('panel');
    const s = length(sub(R1, L0)) / length(sub(R0, L0));
    expect(tr.scale[0]).toBeCloseTo(s, 6);
    expect(tr.scale[1]).toBeCloseTo(s, 6);
    const v0 = sub(R0, L0), v1 = sub(R1, L0);
    const yaw = Math.atan2(v1[0], v1[2]) - Math.atan2(v0[0], v0[2]);
    const expectedRot = qFromAxisAngle([0, 1, 0], yaw);
    const dotq = Math.abs(tr.rotation.reduce((acc, v, i) => acc + v * expectedRot[i], 0));
    expect(dotq).toBeCloseTo(1, 9);
    const m0 = scale(add(L0, R0), 0.5), m1 = scale(add(L0, R1), 0.5);
    near(tr.position, add(m1, qRotate(expectedRot, scale(sub(mid, m0), s))));

    // Release the right hand: falls back to a left-hand grab without jumping or ending.
    t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, t, t + 20);
    expect(eng.activeSessions()).toMatchObject([{ hand: 'left', binding: 'grab', mode: 'grab' }]);
    near(host.getWorldTransform('panel').position, tr.position);
    expect(host.of('setEntityTransform').filter((c) => c.phase === 'end')).toEqual([]);
    // Left keeps moving it.
    t = run(eng, { left: H('pinch', 'left', [0, 0.1, 0]), right: H('relaxed') }, t, t + 20);
    near(host.getWorldTransform('panel').position, add(tr.position, [0, 0.1, 0]));
    // Release left: exactly one end.
    run(eng, { left: H('relaxed', 'left'), right: H('relaxed') }, t, t + 20);
    const phases = host.of('setEntityTransform').map((c) => c.phase);
    expect(phases.filter((p) => p === 'start')).toHaveLength(1);
    expect(phases.filter((p) => p === 'end')).toHaveLength(1);
    expect(phases.at(-1)).toBe('end');
  });

  it('releasing the first hand leaves the second hand grabbing', () => {
    const { host, eng } = panelSetup();
    let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
    t = run(eng, { left: H('pinch', 'left'), right: H('pinch') }, t, t + 60);
    t = run(eng, { left: H('relaxed', 'left'), right: H('pinch') }, t, t + 20);
    expect(eng.activeSessions()).toMatchObject([{ hand: 'right', binding: 'scale', mode: 'grab' }]);
    const p = host.getWorldTransform('panel').position;
    t = run(eng, { left: H('relaxed', 'left'), right: H('pinch', 'right', [0, 0, -0.1]) }, t, t + 20);
    near(host.getWorldTransform('panel').position, add(p, [0, 0, -0.1]));
    run(eng, { left: H('relaxed', 'left'), right: H('relaxed') }, t, t + 20);
    expect(host.of('setEntityTransform').filter((c) => c.phase === 'end')).toHaveLength(1);
  });

  it('ray-acquired (distant) objects scale/rotate about their own origin, not about the hands', () => {
    const { host, eng } = setup();
    const rl = handRay(H('pinch', 'left'), HEAD);
    const rr = handRay(H('pinch'), HEAD);
    const center = scale(add(addScaled(rl.origin, rl.direction, 3), addScaled(rr.origin, rr.direction, 3)), 0.5);
    host.add('far', center, { half: [1.2, 0.5, 0.05] });
    let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
    t = run(eng, { left: H('pinch', 'left'), right: H('pinch') }, t, t + 60);
    expect(eng.activeSessions().find((s) => s.hand === 'right')).toMatchObject({ binding: 'scale', target: 'far', mode: 'scale' });
    const p0 = host.getWorldTransform('far').position;
    const L0 = pinchPoint(H('pinch', 'left')), R0 = pinchPoint(H('pinch'));
    // Spread both hands 10 cm outward: scale up, but the object stays where it is.
    const dl: Vec3 = [-0.1, 0, 0], dr: Vec3 = [0.1, 0, 0];
    run(eng, { left: H('pinch', 'left', dl), right: H('pinch', 'right', dr) }, t, t + 20);
    const tr = host.getWorldTransform('far');
    const L1 = pinchPoint(H('pinch', 'left', dl)), R1 = pinchPoint(H('pinch', 'right', dr));
    expect(tr.scale[0]).toBeCloseTo(length(sub(R1, L1)) / length(sub(R0, L0)), 6);
    expect(tr.scale[0]).toBeGreaterThan(1.5);
    // Translation = midpoint motion (zero here), no push-away from scaling about the hands.
    near(tr.position, add(p0, sub(scale(add(L1, R1), 0.5), scale(add(L0, R0), 0.5))));
    expect(Math.abs(distance(HEAD.position, tr.position) - distance(HEAD.position, p0))).toBeLessThan(0.01);
  });

  it('second hand pinching a different entity grabs that one; scale needs a grab first', () => {
    const { host, eng } = setup();
    host.add('a', pinchPoint(H('pinch', 'left')));
    host.add('b', pinchPoint(H('pinch', 'right')));
    let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
    t = run(eng, { left: H('pinch', 'left'), right: H('pinch') }, t, t + 60);
    expect(eng.activeSessions().map((s) => `${s.hand}:${s.binding}:${s.target}`).sort()).toEqual(['left:grab:a', 'right:grab:b']);
  });

  it('left pinching empty space then right pinching an entity is a plain grab', () => {
    const { host, eng } = setup();
    host.add('b', pinchPoint(H('pinch', 'right')));
    let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
    run(eng, { left: H('pinch', 'left'), right: H('pinch') }, t, t + 60);
    expect(eng.activeSessions()).toMatchObject([{ hand: 'right', binding: 'grab', target: 'b' }]);
  });
});

describe('InteractionEngine: commands, channels, two-handed bindings', () => {
  it('left middle pinch = held push-to-talk (start + end)', () => {
    const { host, eng } = setup();
    let t = run(eng, { left: H('pinch-middle', 'left') }, 0, 80);
    expect(host.of('runCommand')).toEqual([{ fn: 'runCommand', name: 'voice.ptt', args: { hand: 'left' }, phase: 'start' }]);
    run(eng, { left: H('relaxed', 'left') }, t, t + 20);
    expect(host.of('runCommand').map((c) => `${c.name}:${c.phase}`)).toEqual(['voice.ptt:start', 'voice.ptt:end']);
  });

  it('right middle pinch selects the ray target (or nothing)', () => {
    {
      const { host, eng } = setup();
      const ray = handRay(H('pinch-middle'), HEAD);
      host.add('far', addScaled(ray.origin, ray.direction, 2), { half: [0.2, 0.2, 0.2] });
      run(eng, { right: H('pinch-middle') }, 0, 80);
      expect(host.of('runCommand')[0]).toMatchObject({ name: 'select', phase: 'start', args: { hand: 'right', entity: 'far' } });
    }
    {
      const { host, eng } = setup();
      run(eng, { right: H('pinch-middle') }, 0, 80);
      // Targeted binding, nothing hit: an explicit null (the runtime clears the selection).
      expect(host.of('runCommand')[0]).toEqual({ fn: 'runCommand', name: 'select', phase: 'start', args: { hand: 'right', entity: null } });
    }
  });

  it("a binding's own args.entity is not overwritten by a miss", () => {
    const sets: Record<string, InteractionSet> = {
      del: { description: '', scope: 'global', bindings: [
        { id: 'd', pose: 'fist', hand: 'right', target: 'ray', action: { type: 'command', command: 'delete', args: { entity: 'fixed' } } },
      ] },
    };
    const { host, eng } = setup(sets);
    run(eng, { right: H('fist') }, 0, 150);
    expect(host.of('runCommand')[0].args).toEqual({ entity: 'fixed', hand: 'right' });
  });

  it('left palm-up toggles the agent panel after its 300 ms hold', () => {
    const { host, eng } = setup();
    const palmUp = H('open', 'left', [0, 0, 0], { rotation: ORIENT.palmUp('left') });
    run(eng, { left: palmUp }, 0, 250);
    expect(host.of('runCommand')).toEqual([]);
    run(eng, { left: palmUp }, 250, 400);
    expect(host.of('runCommand').map((c) => c.name)).toEqual(['agent.panel.toggle']);
  });

  it('channel actions publish value on start and endValue on end', () => {
    const sets: Record<string, InteractionSet> = {
      ch: { description: '', scope: 'global', bindings: [
        { id: 'c1', pose: 'fist', hand: 'right', target: 'none', action: { type: 'channel', channel: 'ctl.play', value: true, endValue: false } },
        { id: 'c2', pose: 'fist', hand: 'left', target: 'none', action: { type: 'channel', channel: 'ctl.once', value: 7 } },
      ] },
    };
    const { host, eng } = setup(sets);
    let t = run(eng, { right: H('fist'), left: H('fist', 'left') }, 0, 150);
    run(eng, { right: H('open'), left: H('open', 'left') }, t, t + 20);
    expect(host.of('publish').map((c) => `${c.channel}=${c.value}`)).toEqual(['ctl.once=7', 'ctl.play=true', 'ctl.play=false']);
  });

  it("hand 'both' bindings fire when the second hand joins and end when either lets go", () => {
    const sets: Record<string, InteractionSet> = {
      both: { description: '', scope: 'global', bindings: [
        { id: 'two-fists', pose: 'fist', hand: 'both', target: 'none', action: { type: 'command', command: 'two' } },
      ] },
    };
    const { host, eng } = setup(sets);
    let t = run(eng, { right: H('fist'), left: H('open', 'left') }, 0, 150);
    expect(host.of('runCommand')).toEqual([]);
    t = run(eng, { right: H('fist'), left: H('fist', 'left') }, t, t + 150);
    expect(host.of('runCommand').map((c) => `${c.name}:${c.phase}`)).toEqual(['two:start']);
    run(eng, { right: H('open'), left: H('fist', 'left') }, t, t + 50);
    expect(host.of('runCommand').map((c) => `${c.name}:${c.phase}`)).toEqual(['two:start', 'two:end']);
    expect(eng.activeSessions()).toEqual([]);
  });
});

describe('InteractionEngine: hover, poke, tracking loss, determinism', () => {
  it('widget drags are cancelled when the hand is lost', () => {
    const { host, eng } = setup();
    host.add('btn', pinchPoint(H('pinch')), { parts: [{ name: 'face', offset: [0, 0, 0], half: [0.02, 0.02, 0.02], interactive: true }] });
    let t = run(eng, { right: H('pinch') }, 0, 60);
    run(eng, {}, t, t + 200);
    const press = host.of('deliver').filter((c) => c.e.handler === 'press');
    expect(press.at(-1)!.e.phase).toBe('cancel');
    expect(host.of('poseEvent').at(-1)!.e).toMatchObject({ phase: 'end', binding: 'press' });
  });

  it('poking an interactive part with an extended index delivers press; hover tracks the near target', () => {
    const { host, eng } = setup();
    const tip = jointPos(H('point'), INDEX_TIP);
    host.add('btn', add(tip, [0, 0, -0.03]), { half: [0.01, 0.01, 0.01], parts: [{ name: 'cap', offset: [0, 0, 0.02], half: [0.015, 0.015, 0.006], interactive: true }] });
    let t = run(eng, { right: H('point') }, 0, 30);
    t = run(eng, { right: H('point', 'right', [0, 0, 0.2]) }, t, t + 20);
    const press = host.of('deliver').filter((c) => c.e.handler === 'press').map((c) => c.e.phase);
    expect(press).toEqual(['start', 'end']);
    const hover = host.of('deliver').filter((c) => c.e.handler === 'hover').map((c) => c.e.phase);
    expect(hover[0]).toBe('start');
    expect(hover).toContain('end');
    expect(host.hovers.some((h) => h.hit?.entity === 'btn')).toBe(true);
  });

  it('rays() reports smoothed rays and hits per tracked hand', () => {
    const { host, eng } = setup({}, {});
    const ray = handRay(H('relaxed'), HEAD);
    host.add('far', addScaled(ray.origin, ray.direction, 2), { half: [0.3, 0.3, 0.3] });
    run(eng, { right: H('relaxed') }, 0, 30);
    const rays = eng.rays();
    expect(rays.left).toBeUndefined();
    expect(rays.right!.hit?.entity).toBe('far');
    expect(length(rays.right!.direction)).toBeCloseTo(1, 9);
  });

  it('is deterministic given tMs', () => {
    const script = (eng: InteractionEngine) => {
      let t = run(eng, { left: H('pinch', 'left'), right: H('relaxed') }, 0, 60);
      t = run(eng, { left: H('pinch', 'left', [0.05, 0, 0]), right: H('pinch') }, t, t + 60);
      t = run(eng, { left: H('pinch', 'left', [0.05, 0.1, 0]), right: H('pinch', 'right', [0.1, 0, 0]) }, t, t + 60);
      run(eng, { left: H('relaxed', 'left') }, t, t + 200);
    };
    const logs: string[] = [];
    for (let k = 0; k < 2; k++) {
      const { host, eng } = setup({}, {});
      host.add('panel', scale(add(pinchPoint(H('pinch', 'left')), pinchPoint(H('pinch'))), 0.5), { half: [0.35, 0.15, 0.15] });
      script(eng);
      logs.push(JSON.stringify(host.calls));
    }
    expect(logs[0]).toEqual(logs[1]);
    expect(logs[0].length).toBeGreaterThan(100);
  });

  it('cancelAll ends running sessions; a still-held pose does not re-trigger until re-made', () => {
    const { host, eng } = setup();
    let t = run(eng, { left: H('pinch-middle', 'left') }, 0, 80);
    eng.cancelAll();
    expect(host.of('runCommand').map((c) => c.phase)).toEqual(['start', 'end']);
    expect(eng.activeSessions()).toEqual([]);
    // Still holding the pinch: no new push-to-talk.
    t = run(eng, { left: H('pinch-middle', 'left') }, t, t + 300);
    expect(host.of('runCommand')).toHaveLength(2);
    // Release and pinch again: fires normally.
    t = run(eng, { left: H('relaxed', 'left') }, t, t + 50);
    run(eng, { left: H('pinch-middle', 'left') }, t, t + 80);
    expect(host.of('runCommand').map((c) => `${c.name}:${c.phase}`)).toEqual(['voice.ptt:start', 'voice.ptt:end', 'voice.ptt:start']);
  });

  it('a throwing host callback does not swallow the other transitions of the same update', () => {
    const { host, eng } = setup();
    host.add('cube', pinchPoint(H('pinch')));
    // Left: push-to-talk (enterMs 40, from t=0); right: grab (enterMs 30, from t=10).
    // Both start in the update at t=40, ptt (left) first.
    let t = 0;
    eng.update({ left: H('pinch-middle', 'left'), right: H('relaxed') }, HEAD, t);
    t += 10;
    const both = { left: H('pinch-middle', 'left'), right: H('pinch') };
    const orig = host.runCommand.bind(host);
    host.runCommand = (name, args, phase) => {
      orig(name, args, phase);
      if (name === 'voice.ptt' && phase === 'start') throw new Error('mic failed');
    };
    let thrown = 0;
    for (; t < 80; t += 10) {
      try { eng.update(both, HEAD, t); } catch (e) { thrown++; expect((e as Error).message).toBe('mic failed'); }
    }
    expect(thrown).toBe(1);
    // The grab (processed after the throwing ptt start) still happened and still moves.
    expect(eng.activeSessions().map((s) => `${s.hand}:${s.binding}`).sort()).toEqual(['left:push-to-talk', 'right:grab']);
    // Releasing both ends both: ptt gets its 'end', the grab its single 'end'.
    for (; t < 120; t += 10) eng.update({ left: H('relaxed', 'left'), right: H('relaxed') }, HEAD, t);
    expect(host.of('runCommand').map((c) => `${c.name}:${c.phase}`)).toEqual(['voice.ptt:start', 'voice.ptt:end']);
    expect(host.of('setEntityTransform').filter((c) => c.phase === 'end')).toHaveLength(1);
    expect(eng.activeSessions()).toEqual([]);
  });

  it('cancelAll during a grab ends it exactly once and leaves the entity in place', () => {
    const { host, eng } = setup();
    host.add('cube', pinchPoint(H('pinch')));
    let t = run(eng, { right: H('pinch') }, 0, 60);
    t = run(eng, { right: H('pinch', 'right', [0.05, 0, 0]) }, t, t + 30);
    const p = host.getWorldTransform('cube').position;
    eng.cancelAll();
    run(eng, { right: H('pinch', 'right', [0.2, 0, 0]) }, t, t + 50);
    const phases = host.of('setEntityTransform').map((c) => c.phase);
    expect(phases.filter((x) => x === 'end')).toHaveLength(1);
    expect(phases.at(-1)).toBe('end');
    near(host.getWorldTransform('cube').position, p);
  });
});
