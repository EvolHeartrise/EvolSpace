// The desktop mouse-hand must aim the input package's real hand ray at the
// cursor target, and pinch/release must be recognized as the pinch features.
import { describe, it, expect } from 'vitest';
import { synthHand, handRay, rayAnchor, shoulderPosition, pinchPoint, computeFeatures, type SynthHandSpec } from '@evolspace/input';
import { placeDesktopHand, fingersForward, translateFrame, isTextEntry, type DesktopHandInput } from '../src/desktop/controls.ts';
import { SimHands } from '../src/sim/sim.ts';
import { quatFromYaw, quatRotate, type Pose } from '../src/math/space.ts';
import type { Vec3 } from '@evolspace/protocol';

const input: DesktopHandInput = {
  synthHand: (s) => synthHand(s as SynthHandSpec),
  shoulderPosition: (h, head) => shoulderPosition(h, head),
  rayAnchor: (f) => rayAnchor(f),
};

function distToRay(o: Vec3, d: Vec3, p: Vec3): number {
  const v: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const t = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
  return Math.hypot(v[0] - d[0] * t, v[1] - d[1] * t, v[2] - d[2] * t);
}

describe('desktop hand placement', () => {
  const heads: Pose[] = [
    { position: [0, 1.6, 1.6], rotation: [0, 0, 0, 1] },
    { position: [2, 1.5, -1], rotation: quatFromYaw(1.2) },
  ];
  const targets: Vec3[] = [[0, 1.2, -0.5], [1.5, 0.4, -3], [-2, 2.5, 0.5]];

  for (const [hi, head] of heads.entries()) {
    for (const target of targets) {
      for (const pinching of [false, true]) {
        it(`ray hits the target (head ${hi}, target ${target.join(',')}, pinch ${pinching})`, () => {
          const f = placeDesktopHand(input, head, target, 0.45, pinching);
          const ray = handRay(f, head);
          expect(distToRay(ray.origin, ray.direction, target)).toBeLessThan(1e-6);
          // pointing toward, not away from, the target
          const toT: Vec3 = [target[0] - ray.origin[0], target[1] - ray.origin[1], target[2] - ray.origin[2]];
          expect(toT[0] * ray.direction[0] + toT[1] * ray.direction[1] + toT[2] * ray.direction[2]).toBeGreaterThan(0);
        });
      }
    }
  }

  it('pinching changes the pinch.index feature', () => {
    const head = heads[0];
    const open = computeFeatures(placeDesktopHand(input, head, [0, 1.2, -1], 0.45, false), head);
    const pinch = computeFeatures(placeDesktopHand(input, head, [0, 1.2, -1], 0.45, true), head);
    expect(pinch['pinch.index']).toBeLessThan(0.02);
    expect(open['pinch.index']).toBeGreaterThan(0.04);
  });

  it('fingersForward points the wrist -Z along the direction with +Y up-ish', () => {
    const dir: Vec3 = [0.6, -0.2, -0.77];
    const l = Math.hypot(...dir);
    const q = fingersForward(dir);
    const z: Vec3 = [0, 0, 0], y: Vec3 = [0, 0, 0];
    quatRotate(q, [0, 0, -1], z);
    quatRotate(q, [0, 1, 0], y);
    z.forEach((v, i) => expect(v).toBeCloseTo(dir[i] / l, 6));
    expect(y[1]).toBeGreaterThan(0.9);
    // straight down is well defined
    const qd = fingersForward([0, -1, 0]);
    expect(qd.every(Number.isFinite)).toBe(true);
  });

  it('translateFrame moves positions only', () => {
    const f = synthHand({ hand: 'left' });
    const g = translateFrame(f, [1, 2, 3]);
    expect(g.joints[0]).toBeCloseTo(f.joints[0] + 1);
    expect(g.joints[3]).toBe(f.joints[3]);
    expect(f.joints[0]).not.toBe(g.joints[0]);
  });

  it('SimHands.setPinchAt puts the pinch point exactly at the target', () => {
    const sim = new SimHands((s) => synthHand(s as SynthHandSpec), pinchPoint);
    for (const pinching of [false, true]) {
      const f = sim.setPinchAt('right', [0.3, 1.1, -0.6], pinching);
      pinchPoint(f).forEach((v, i) => expect(v).toBeCloseTo([0.3, 1.1, -0.6][i], 9));
    }
    expect(sim.active).toBe(true);
  });
});

describe('desktop keyboard focus', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
  it('only text entry swallows shortcuts (not the page checkboxes/buttons)', () => {
    expect(isTextEntry(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTextEntry(el('BUTTON'))).toBe(false);
    expect(isTextEntry(el('CANVAS'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTextEntry(el('INPUT'))).toBe(true);
    expect(isTextEntry(el('TEXTAREA'))).toBe(true);
    expect(isTextEntry(el('DIV', { isContentEditable: true }))).toBe(true);
  });
});
