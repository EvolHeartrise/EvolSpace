import { describe, expect, it } from 'vitest';
import type { HandFeatures, Handedness, Quat } from '@evolspace/protocol';
import { computeFeatures } from '../src/features.ts';
import { derivePose, featureStats } from '../src/derive.ts';
import { matchesPose } from '../src/matcher.ts';
import { synthHand, HAND_SHAPES } from '../src/synth.ts';
import { validatePoseDef } from '../src/validate.ts';
import { HEAD, ORIENT, jitterQuat, rng, uniform, wristPos } from './helpers.ts';

type ShapeName = keyof typeof HAND_SHAPES;

/** Simulated recording: n noisy samples of a shape (curl, spread, gap, orientation and position jitter). */
function record(shapeName: ShapeName, orient: (h: Handedness) => Quat, seed: number, n = 90, hand: Handedness = 'right'): HandFeatures[] {
  const r = rng(seed);
  const base = HAND_SHAPES[shapeName];
  const out: HandFeatures[] = [];
  for (let i = 0; i < n; i++) {
    const curl = Object.fromEntries(Object.entries(base.curl ?? {}).map(([f, v]) => [f, Math.min(1, Math.max(0, v + uniform(r, -0.04, 0.04)))]));
    const p = wristPos(hand);
    const frame = synthHand({
      hand, ...base, curl,
      spread: (base.spread ?? 8) + uniform(r, -2, 2),
      pinchGap: uniform(r, 0.006, 0.016),
      position: [p[0] + uniform(r, -0.05, 0.05), p[1] + uniform(r, -0.05, 0.05), p[2] + uniform(r, -0.05, 0.05)],
      rotation: jitterQuat(orient(hand), r, 8),
    });
    out.push(computeFeatures(frame, HEAD));
  }
  return out;
}

const matchRate = (pose: ReturnType<typeof derivePose>, samples: HandFeatures[]) =>
  samples.filter((s) => matchesPose(pose, s)).length / samples.length;

describe('derivePose', () => {
  it('computes per-feature mean/std', () => {
    const st = featureStats([{ a: 1, b: 2 }, { a: 3, b: 2 }]);
    expect(st.a).toEqual({ mean: 2, std: 1 });
    expect(st.b).toEqual({ mean: 2, std: 0 });
  });

  it('fist recording → pose that matches fists and rejects other shapes', () => {
    const pose = derivePose(record('fist', ORIENT.palmIn, 1), { id: 'my-fist', hand: 'either' });
    expect(pose.source).toBe('recorded');
    expect(pose.hand).toBe('either');
    expect(validatePoseDef(pose, 'my-fist').errors).toEqual([]);
    expect(pose.stats?.['curl.index'].mean).toBeGreaterThan(0.8);
    const features = pose.conditions.map((c) => c.feature);
    for (const f of ['curl.index', 'curl.middle', 'curl.ring', 'curl.pinky']) expect(features).toContain(f);
    // Fresh recording of the same pose (different noise) matches.
    expect(matchRate(pose, record('fist', ORIENT.palmIn, 2))).toBeGreaterThan(0.97);
    for (const other of ['open', 'point', 'pinch', 'pinch-middle', 'thumbs-up'] as ShapeName[]) {
      expect(matchRate(pose, record(other, ORIENT.palmIn, 3)), other).toBe(0);
    }
  });

  it('thumbs-up recording rejects fists (thumb features carry the difference)', () => {
    const pose = derivePose(record('thumbs-up', ORIENT.palmIn, 4), { id: 'tu', hand: 'right' });
    expect(matchRate(pose, record('thumbs-up', ORIENT.palmIn, 5))).toBeGreaterThan(0.97);
    expect(matchRate(pose, record('fist', ORIENT.palmIn, 6))).toBe(0);
    // Thumb direction is a strong, steady orientation feature here.
    expect(pose.conditions.find((c) => c.feature === 'thumb.up')?.min).toBeGreaterThan(0.3);
    // ...so a thumbs-down does not match.
    expect(matchRate(pose, record('thumbs-up', ORIENT.thumbDown, 7))).toBe(0);
  });

  it('pinch recording → contact condition on pinch.index, rejects open/fist/point', () => {
    const pose = derivePose(record('pinch', ORIENT.pinchPosture, 8), { id: 'p', hand: 'either' });
    const pinchCond = pose.conditions.find((c) => c.feature === 'pinch.index');
    expect(pinchCond).toBeDefined();
    expect(pinchCond!.min).toBeUndefined();
    expect(pinchCond!.max).toBeGreaterThanOrEqual(0.02);
    expect(pinchCond!.max).toBeLessThanOrEqual(0.04);
    expect(matchRate(pose, record('pinch', ORIENT.pinchPosture, 9))).toBeGreaterThan(0.97);
    for (const other of ['open', 'fist', 'point', 'pinch-middle'] as ShapeName[]) {
      expect(matchRate(pose, record(other, ORIENT.pinchPosture, 10)), other).toBe(0);
    }
  });

  it('palm-up recording keeps the orientation condition; orientation:false drops it', () => {
    const samples = record('open', ORIENT.palmUp, 11);
    const pose = derivePose(samples, { id: 'tray', hand: 'left' });
    expect(pose.conditions.find((c) => c.feature === 'palm.up')?.min).toBeGreaterThan(0.4);
    expect(matchRate(pose, record('open', ORIENT.palmDown, 12))).toBe(0);
    const free = derivePose(samples, { id: 'tray', hand: 'left', orientation: false });
    expect(free.conditions.some((c) => c.feature.startsWith('palm.'))).toBe(false);
    expect(matchRate(free, record('open', ORIENT.palmDown, 12))).toBeGreaterThan(0.97);
  });

  it('produces human-friendly conditions (rounded steps, one-sided at range edges)', () => {
    const pose = derivePose(record('fist', ORIENT.palmDown, 13), { id: 'f', hand: 'right', description: 'my fist' });
    expect(pose.description).toBe('my fist');
    for (const c of pose.conditions) {
      for (const v of [c.min, c.max]) {
        if (v === undefined) continue;
        expect(String(v).length, `${c.feature}=${v}`).toBeLessThanOrEqual(6);
      }
      if (c.feature.startsWith('curl.')) {
        // Fully curled fingers: a lower bound only.
        expect(c.max).toBeUndefined();
        expect(Math.round(c.min! * 20)).toBeCloseTo(c.min! * 20, 6);
      }
    }
    // Excluded by default: orientation-relative-to-gaze and position features.
    const names = pose.conditions.map((c) => c.feature);
    for (const f of ['point.forward', 'palm.forward', 'wrist.height', 'hands.distance']) expect(names).not.toContain(f);
  });

  it('honors include/exclude', () => {
    const samples = record('point', ORIENT.palmDown, 14);
    const pose = derivePose(samples, { id: 'aim', hand: 'right', include: ['point.forward'], exclude: ['curl.thumb'] });
    const names = pose.conditions.map((c) => c.feature);
    expect(names).toContain('point.forward');
    expect(names).not.toContain('curl.thumb');
  });

  it('throws on an empty recording', () => {
    expect(() => derivePose([], { id: 'x', hand: 'either' })).toThrow();
  });
});
