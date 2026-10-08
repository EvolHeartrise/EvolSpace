import { describe, expect, it } from 'vitest';
import type { Finger, Handedness, Vec3 } from '@evolspace/protocol';
import { computeFeatures, palmBasis } from '../src/features.ts';
import { synthHand, wristRotation, HAND_SHAPES } from '../src/synth.ts';
import { FINGER_BASE, JOINT_COUNT, jointPos, jointRot, tipIndex } from '../src/joints.ts';
import { dot, length, normalize, qRotate, reject, sub } from '../src/math.ts';
import { HEAD, randomQuat, rng, uniform, wristPos } from './helpers.ts';

const HANDS: Handedness[] = ['left', 'right'];
const FINGERS: Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

describe('computeFeatures on synthetic hands', () => {
  it('recovers requested curls for any hand, size and wrist orientation', () => {
    const r = rng(1);
    for (let n = 0; n < 200; n++) {
      const hand = HANDS[n % 2];
      const curl = Object.fromEntries(FINGERS.map((f) => [f, uniform(r, 0, 1)])) as Record<Finger, number>;
      const size = uniform(r, 0.75, 1.3);
      const frame = synthHand({ hand, curl, size, spread: uniform(r, 0, 15), position: [uniform(r, -1, 1), uniform(r, 0.5, 2), uniform(r, -1, 1)], rotation: randomQuat(r) });
      const f = computeFeatures(frame, HEAD);
      for (const finger of FINGERS) expect(f[`curl.${finger}`]).toBeCloseTo(curl[finger], 1);
      for (const finger of FINGERS) expect(Math.abs(f[`curl.${finger}`] - curl[finger])).toBeLessThan(0.02);
    }
  });

  it('is hand-size invariant (angles and normalized distances)', () => {
    const spec = { hand: 'right' as const, curl: { index: 0.3, middle: 0.5, ring: 0.7, pinky: 0.9, thumb: 0.2 }, spread: 9 };
    const a = computeFeatures(synthHand({ ...spec, size: 0.8 }), HEAD);
    const b = computeFeatures(synthHand({ ...spec, size: 1.25 }), HEAD);
    for (const k of Object.keys(a)) {
      if (k.startsWith('curl.') || k.startsWith('spread.') || k === 'thumb.out') expect(Math.abs(a[k] - b[k])).toBeLessThan(1e-3);
    }
  });

  it('measures spread between extended fingers', () => {
    for (const hand of HANDS) {
      for (const spread of [0, 5, 10, 18]) {
        const f = computeFeatures(synthHand({ hand, spread, rotation: randomQuat(rng(spread + 7)) }), HEAD);
        expect(Math.abs(f['spread.index-middle'] - spread)).toBeLessThan(1.5);
        expect(Math.abs(f['spread.middle-ring'] - spread)).toBeLessThan(1.5);
        expect(Math.abs(f['spread.ring-pinky'] - spread)).toBeLessThan(1.5);
      }
    }
  });

  it('palm normal points out of the palm for both hands', () => {
    for (const hand of HANDS) {
      const down = computeFeatures(synthHand({ hand }), HEAD);
      expect(down['palm.up']).toBeLessThan(-0.95);
      const up = computeFeatures(synthHand({ hand, rotation: wristRotation([0, 0, -1], [0, 1, 0]) }), HEAD);
      expect(up['palm.up']).toBeGreaterThan(0.95);
      // Palm toward the face.
      const pos = wristPos(hand);
      const toHead = normalize(sub(HEAD.position, pos));
      const facing = computeFeatures(synthHand({ hand, position: pos, rotation: wristRotation(reject([0, 1, 0], toHead), toHead) }), HEAD);
      expect(facing['palm.towardHead']).toBeGreaterThan(0.85);
      // Palm away from the face, facing forward.
      const fwd = computeFeatures(synthHand({ hand, rotation: wristRotation([0, 1, 0], [0, 0, -1]) }), HEAD);
      expect(fwd['palm.forward']).toBeGreaterThan(0.95);
    }
  });

  it('thumb lies on the correct side for each hand', () => {
    // Palm down, fingers forward: right thumb toward -X, left thumb toward +X.
    for (const hand of HANDS) {
      const frame = synthHand({ hand, position: [0, 1, 0], curl: { thumb: 0 }, thumbSpread: 80 });
      const thumbTip = jointPos(frame, tipIndex('thumb'));
      expect(Math.sign(thumbTip[0])).toBe(hand === 'right' ? -1 : 1);
      const basis = palmBasis(frame);
      expect(basis.normal[1]).toBeLessThan(-0.95);
    }
  });

  it('pinches: requested finger at pinchGap, others clearly apart', () => {
    for (const hand of HANDS) {
      for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) {
        for (const size of [0.8, 1, 1.2]) {
          const frame = synthHand({ hand, pinch: finger, size, rotation: randomQuat(rng(size * 10)) });
          const f = computeFeatures(frame, HEAD);
          expect(Math.abs(f[`pinch.${finger}`] - 0.01)).toBeLessThan(0.002);
        }
      }
      const f = computeFeatures(synthHand({ hand, ...HAND_SHAPES.pinch }), HEAD);
      expect(f['pinch.middle']).toBeGreaterThan(0.04);
      const g = computeFeatures(synthHand({ hand, ...HAND_SHAPES['pinch-middle'] }), HEAD);
      expect(g['pinch.index']).toBeGreaterThan(0.04);
    }
  });

  it('point.forward / thumb.up / thumb.out behave', () => {
    const pointFwd = computeFeatures(synthHand({ hand: 'right', ...HAND_SHAPES.point }), HEAD);
    expect(pointFwd['point.forward']).toBeGreaterThan(0.9);
    const thumbsUp = computeFeatures(synthHand({ hand: 'right', ...HAND_SHAPES['thumbs-up'], rotation: wristRotation([0, 0, -1], [-1, 0, 0]) }), HEAD);
    expect(thumbsUp['thumb.up']).toBeGreaterThan(0.9);
    expect(thumbsUp['thumb.out']).toBeGreaterThan(1);
    const fist = computeFeatures(synthHand({ hand: 'right', ...HAND_SHAPES.fist }), HEAD);
    expect(fist['thumb.out']).toBeLessThan(0.7);
  });

  it('hands.distance only with the other hand', () => {
    const l = synthHand({ hand: 'left', position: [-0.2, 1.2, -0.3] });
    const r = synthHand({ hand: 'right', position: [0.2, 1.2, -0.3] });
    expect(computeFeatures(r, HEAD)['hands.distance']).toBeUndefined();
    expect(computeFeatures(r, HEAD, l)['hands.distance']).toBeCloseTo(0.4, 4);
  });
});

describe('synthHand joint conventions (WebXR)', () => {
  it('-Z of each joint points along its bone toward the tip; +Y is the back of the hand', () => {
    const r = rng(42);
    for (let n = 0; n < 40; n++) {
      const hand = HANDS[n % 2];
      const frame = synthHand({
        hand, rotation: randomQuat(r), curl: { index: r(), middle: r(), ring: r(), pinky: r(), thumb: r() },
        ...(n % 3 === 0 ? { pinch: 'index' as const, curl: {} } : {}),
      });
      expect(frame.joints).toHaveLength(JOINT_COUNT * 7);
      expect(frame.radii).toHaveLength(JOINT_COUNT);
      const normal = palmBasis(frame).normal;
      for (let i = 0; i < JOINT_COUNT; i++) {
        const q = jointRot(frame, i);
        expect(Math.hypot(...q)).toBeCloseTo(1, 6);
      }
      const chains: number[][] = [[1, 2, 3, 4]];
      for (const f of ['index', 'middle', 'ring', 'pinky'] as const) chains.push([0, 1, 2, 3, 4].map((k) => FINGER_BASE[f] + k));
      for (const chain of chains) {
        for (let k = 0; k < chain.length - 1; k++) {
          const bone = normalize(sub(jointPos(frame, chain[k + 1]), jointPos(frame, chain[k])));
          const negZ = qRotate(jointRot(frame, chain[k]), [0, 0, -1]);
          expect(dot(bone, negZ)).toBeGreaterThan(0.999);
        }
      }
      // Wrist and metacarpals: +Y is the back of the hand (opposite the palm normal).
      for (const i of [0, 5, 10, 15]) {
        const y = qRotate(jointRot(frame, i), [0, 1, 0]);
        expect(dot(y, normal)).toBeLessThan(-0.95);
      }
      // Wrist -Z points toward the middle knuckle.
      const wristFwd = qRotate(jointRot(frame, 0), [0, 0, -1]);
      const toMid = normalize(sub(jointPos(frame, 11), jointPos(frame, 0)));
      expect(dot(wristFwd, toMid)).toBeGreaterThan(0.99);
    }
  });

  it('places the wrist joint at the requested position', () => {
    const p: Vec3 = [0.3, 1.1, -0.4];
    const frame = synthHand({ hand: 'left', position: p, rotation: randomQuat(rng(3)) });
    expect(length(sub(jointPos(frame, 0), p))).toBeLessThan(1e-9);
  });
});
