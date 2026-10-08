// The default pose library (library/poses) classified against synthetic hands:
// every case must match exactly the expected set of poses.

import { describe, expect, it } from 'vitest';
import type { Handedness, PoseDef, Quat } from '@evolspace/protocol';
import { computeFeatures } from '../src/features.ts';
import { matchesPose, poseAppliesTo } from '../src/matcher.ts';
import { synthHand, HAND_SHAPES } from '../src/synth.ts';
import { validateInteractionSet, validatePoseDef } from '../src/validate.ts';
import { HEAD, ORIENT, jitterQuat, loadInteractionSets, loadPoses, rng, wristPos } from './helpers.ts';

const poses = loadPoses();
const HANDS: Handedness[] = ['left', 'right'];

interface Case {
  name: string;
  shape: keyof typeof HAND_SHAPES;
  orient: (h: Handedness) => Quat;
  expect: string[];
}

const CASES: Case[] = [
  { name: 'open palm down', shape: 'open', orient: ORIENT.palmDown, expect: ['open-palm'] },
  { name: 'open palm sideways', shape: 'open', orient: ORIENT.palmIn, expect: ['open-palm'] },
  { name: 'open palm up', shape: 'open', orient: ORIENT.palmUp, expect: ['open-palm', 'palm-up-open'] },
  { name: 'fist palm down', shape: 'fist', orient: ORIENT.palmDown, expect: ['fist'] },
  { name: 'fist palm sideways', shape: 'fist', orient: ORIENT.palmIn, expect: ['fist'] },
  { name: 'point forward', shape: 'point', orient: ORIENT.palmDown, expect: ['point'] },
  { name: 'point up', shape: 'point', orient: ORIENT.pointUp, expect: ['point'] },
  { name: 'pinch (ray posture)', shape: 'pinch', orient: ORIENT.pinchPosture, expect: ['pinch'] },
  { name: 'pinch palm down', shape: 'pinch', orient: ORIENT.palmDown, expect: ['pinch'] },
  // Quest system gesture (palm facing the head + index pinch) must NOT be our pinch.
  { name: 'pinch facing head', shape: 'pinch', orient: ORIENT.palmToHead, expect: [] },
  { name: 'pinch-middle', shape: 'pinch-middle', orient: ORIENT.pinchPosture, expect: ['pinch-middle'] },
  { name: 'pinch-middle facing head', shape: 'pinch-middle', orient: ORIENT.palmToHead, expect: ['pinch-middle'] },
  { name: 'thumbs up', shape: 'thumbs-up', orient: ORIENT.palmIn, expect: ['thumbs-up'] },
  { name: 'thumbs down', shape: 'thumbs-up', orient: ORIENT.thumbDown, expect: [] },
];

function matching(hand: Handedness, shapeName: keyof typeof HAND_SHAPES, rot: Quat, extra = {}): string[] {
  const frame = synthHand({ hand, position: wristPos(hand), rotation: rot, ...HAND_SHAPES[shapeName], ...extra });
  const f = computeFeatures(frame, HEAD);
  return poses.filter((p) => poseAppliesTo(p, hand) && matchesPose(p, f)).map((p) => p.id).sort();
}

describe('default pose library', () => {
  it('ships the required poses', () => {
    const ids = poses.map((p) => p.id);
    for (const id of ['pinch', 'pinch-middle', 'fist', 'point', 'open-palm', 'thumbs-up', 'palm-up-open']) expect(ids).toContain(id);
  });

  for (const c of CASES) {
    for (const hand of HANDS) {
      it(`${c.name} (${hand}) → [${c.expect.join(', ')}]`, () => {
        expect(matching(hand, c.shape, c.orient(hand))).toEqual([...c.expect].sort());
      });
    }
  }

  it('classification is robust to small orientation and curl jitter', () => {
    const r = rng(9);
    for (const c of CASES) {
      for (const hand of HANDS) {
        for (let k = 0; k < 10; k++) {
          const base = HAND_SHAPES[c.shape];
          const curl = Object.fromEntries(Object.entries(base.curl ?? {}).map(([f, v]) => [f, Math.min(1, Math.max(0, v + (r() - 0.5) * 0.08))]));
          const got = matching(hand, c.shape, jitterQuat(c.orient(hand), r, 6), { curl, pinchGap: 0.006 + r() * 0.01 });
          expect(got, `${c.name} ${hand} #${k}`).toEqual([...c.expect].sort());
        }
      }
    }
  });

  it('a relaxed (slightly curled) palm-up hand still counts as palm-up-open', () => {
    const r = rng(5);
    for (const hand of HANDS) {
      for (let k = 0; k < 10; k++) {
        const got = matching(hand, 'relaxed', jitterQuat(ORIENT.palmUp(hand), r, 8));
        expect(got).toContain('palm-up-open');
        expect(got).not.toContain('pinch');
      }
    }
  });

  it('pose files are valid, warning-free and named after their id', () => {
    for (const p of poses) {
      const v = validatePoseDef(p, p.id);
      expect(v.errors, p.id).toEqual([]);
      expect(v.warnings, p.id).toEqual([]);
      expect(p.source).toBe('builtin');
    }
  });

  it('interaction sets are valid and only reference existing poses', () => {
    const sets = loadInteractionSets();
    expect(Object.keys(sets).sort()).toEqual(expect.arrayContaining(['global', 'standard']));
    const ids = poses.map((p: PoseDef) => p.id);
    for (const [name, set] of Object.entries(sets)) {
      const v = validateInteractionSet(set, ids);
      expect(v.errors, name).toEqual([]);
      expect(v.warnings, name).toEqual([]);
    }
    expect(sets.standard.scope).toBe('entity-default');
    expect(sets.global.scope).toBe('global');
    const g = sets.global.bindings;
    expect(g.find((b) => b.action.type === 'command' && b.action.command === 'voice.ptt')).toMatchObject({ pose: 'pinch-middle', hand: 'left', target: 'none' });
    expect(g.find((b) => b.action.type === 'command' && b.action.command === 'select')).toMatchObject({ pose: 'pinch-middle', hand: 'right', target: 'ray' });
    expect(g.find((b) => b.action.type === 'command' && b.action.command === 'agent.panel.toggle')).toBeDefined();
  });
});
