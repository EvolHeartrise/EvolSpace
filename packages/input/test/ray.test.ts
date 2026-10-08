import { describe, expect, it } from 'vitest';
import type { Quat } from '@evolspace/protocol';
import { OneEuroFilter, RaySmoother, contactPoint, handRay, pinchPoint, rayAnchor, shoulderPosition } from '../src/ray.ts';
import { INDEX_TIP, THUMB_TIP, jointPos } from '../src/joints.ts';
import { add, distance, dot, length, normalize, qFromAxisAngle, scale, sub, lookRotation, qRotate } from '../src/math.ts';
import { HEAD, rng, shape } from './helpers.ts';

describe('hand ray', () => {
  it('goes from the estimated shoulder through the hand anchor', () => {
    const frame = shape('relaxed', 'right');
    const ray = handRay(frame, HEAD);
    const shoulder = shoulderPosition('right', HEAD);
    expect(shoulder[0]).toBeGreaterThan(0.1); // right shoulder is to the right of the eyes
    expect(shoulder[1]).toBeLessThan(HEAD.position[1]);
    expect(length(ray.direction)).toBeCloseTo(1, 9);
    expect(distance(ray.origin, rayAnchor(frame))).toBeLessThan(1e-12);
    const expected = normalize(sub(ray.origin, shoulder));
    expect(dot(ray.direction, expected)).toBeCloseTo(1, 9);
    // Hand in front of the user: the ray points forward (-Z).
    expect(ray.direction[2]).toBeLessThan(-0.7);
  });

  it('does not jump when the hand closes into a pinch', () => {
    const a = handRay(shape('relaxed', 'right'), HEAD);
    const b = handRay(shape('pinch', 'right'), HEAD);
    const deg = (Math.acos(Math.min(1, dot(a.direction, b.direction))) * 180) / Math.PI;
    expect(deg).toBeLessThan(4);
  });

  it('the shoulder follows head yaw but not pitch', () => {
    const pitched = { position: HEAD.position, rotation: qFromAxisAngle([1, 0, 0], 0.6) as Quat };
    expect(distance(shoulderPosition('left', pitched), shoulderPosition('left', HEAD))).toBeLessThan(1e-9);
    const turned = { position: HEAD.position, rotation: qFromAxisAngle([0, 1, 0], Math.PI / 2) as Quat };
    const s = shoulderPosition('right', turned);
    // Facing -X after a +90° yaw: the right shoulder is toward -Z.
    expect(s[2]).toBeLessThan(-0.1);
    // Looking straight up still yields a sensible heading.
    const up = { position: HEAD.position, rotation: lookRotation([0, 1, 0], [0, 0, 1]) };
    expect(qRotate(up.rotation, [0, 0, -1])[1]).toBeCloseTo(1, 6);
    expect(shoulderPosition('right', up)[0]).toBeGreaterThan(0.1);
  });

  it('pinchPoint and contactPoint', () => {
    const pinch = shape('pinch', 'left');
    const mid = scale(add(jointPos(pinch, THUMB_TIP), jointPos(pinch, INDEX_TIP)), 0.5);
    expect(distance(pinchPoint(pinch), mid)).toBeLessThan(1e-12);
    expect(distance(contactPoint(pinch), mid)).toBeLessThan(1e-12);
    const point = shape('point', 'left');
    expect(distance(contactPoint(point), jointPos(point, INDEX_TIP))).toBeLessThan(1e-12);
  });
});

describe('smoothing', () => {
  it('OneEuroFilter passes the first sample, converges to a constant input, and damps jitter', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    expect(f.filter([1, 2], 0)).toEqual([1, 2]);
    let out: number[] = [];
    for (let t = 10; t <= 3000; t += 10) out = f.filter([2, 2], t);
    expect(out[0]).toBeCloseTo(2, 3);
    const g = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    const r = rng(1);
    let inVar = 0, outVar = 0;
    for (let i = 0; i < 500; i++) {
      const x = r() - 0.5;
      const y = g.filter([x], i * 11)[0];
      if (i > 50) { inVar += x * x; outVar += y * y; }
    }
    expect(outVar).toBeLessThan(inVar * 0.2);
  });

  it('OneEuroFilter ignores repeated timestamps and re-seeds when time goes backwards', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.5 });
    f.filter([0], 0);
    const a = f.filter([1], 10)[0];
    // Same timestamp again: no update (a 1 ms fake dt would read as a huge speed).
    expect(f.filter([5], 10)[0]).toBe(a);
    // Clock restarted: the filter starts over instead of freezing.
    expect(f.filter([3], 2)).toEqual([3]);
    expect(f.filter([3], 12)[0]).toBeCloseTo(3, 9);
  });

  it('RaySmoother jump detection compares raw inputs (fast motion does not reset)', () => {
    // Heavy origin smoothing so the output lags the input by more than resetDistance.
    const s = new RaySmoother({ resetDistance: 0.3, origin: { minCutoff: 0.1, beta: 0 } });
    // 4 m/s sweep at 90 Hz: raw steps of ~4.4 cm, never a jump.
    let out = s.update({ origin: [0, 1, 0], direction: [0, 0, -1] }, 0);
    for (let i = 1; i <= 20; i++) out = s.update({ origin: [i * 0.044, 1, 0], direction: [0, 0, -1] }, i * 11.1);
    // Comparing smoothed-vs-raw would have "detected a jump" and snapped to the raw 0.88 m.
    expect(out.origin[0]).toBeLessThan(0.3);
    expect(out.origin[0]).toBeGreaterThan(0);
  });

  it('RaySmoother keeps unit directions and resets on large jumps', () => {
    const s = new RaySmoother();
    const a = s.update({ origin: [0, 1, 0], direction: [0, 0, -1] }, 0);
    expect(a.direction).toEqual([0, 0, -1]);
    const b = s.update({ origin: [0.01, 1, 0], direction: normalize([0.2, 0, -1]) }, 11);
    expect(length(b.direction)).toBeCloseTo(1, 9);
    expect(b.origin[0]).toBeGreaterThan(0);
    expect(b.origin[0]).toBeLessThan(0.01);
    const c = s.update({ origin: [2, 1, 0], direction: [1, 0, 0] }, 22);
    expect(c.origin).toEqual([2, 1, 0]);
    expect(s.current()).toEqual(c);
  });
});
