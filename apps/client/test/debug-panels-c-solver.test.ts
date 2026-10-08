// Hands workbench solver: for every default pose in library/poses, the solved
// SimShape synthesizes a hand that classifies as that pose (computeFeatures +
// matchesPose, and a PoseMatcher run past its enterMs), for each hand it applies to.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Handedness, PoseDef } from '@evolspace/protocol';
import { PoseMatcher, computeFeatures, matchesPose } from '@evolspace/input';
import {
  CANON_HEAD, RELAXED_SHAPE, canonPlacement, conditionTarget, orientRotation, scoreFeatures, seedShape, solvePose, synthShape,
} from '../src/debug/panels/hands/solver.ts';

const POSES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../library/poses');
const POSES: PoseDef[] = readdirSync(POSES_DIR).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(POSES_DIR, f), 'utf8')) as PoseDef);

describe('pose → synth spec solver', () => {
  it('finds the default poses', () => {
    expect(POSES.map((p) => p.id)).toEqual(expect.arrayContaining(['fist', 'open-palm', 'palm-up-open', 'pinch', 'pinch-middle', 'point', 'thumbs-up']));
  });

  for (const pose of POSES) {
    for (const hand of ['left', 'right'] as Handedness[]) {
      if (pose.hand !== 'either' && pose.hand !== hand) continue;
      it(`${pose.id} (${hand}) classifies as the pose`, () => {
        const r = solvePose(pose, hand, { poses: POSES });
        expect(r.ok, `violation ${r.violation}`).toBe(true);
        const frame = synthShape(r.shape, hand, canonPlacement(hand));
        const f = computeFeatures(frame, CANON_HEAD);
        expect(matchesPose(pose, f)).toBe(true);
        // The real matcher (debounce) starts it.
        const m = new PoseMatcher(POSES);
        const started: string[] = [];
        for (let t = 0; t <= (pose.enterMs ?? 60) + 100; t += 16) {
          for (const tr of m.update({ [hand]: frame }, CANON_HEAD, t)) if (tr.phase === 'start' && tr.hand === hand) started.push(tr.pose);
        }
        expect(started).toContain(pose.id);
        expect(m.active(hand)).toContain(pose.id);
      });
    }
  }

  it('push-to-talk and select poses are exclusive of the index pinch', () => {
    const r = solvePose(POSES.find((p) => p.id === 'pinch-middle')!, 'left', { poses: POSES });
    expect(r.alsoMatches).not.toContain('pinch');
  });

  it('seeds curls from condition midpoints (one-sided ranges closed by the natural range)', () => {
    expect(conditionTarget({ feature: 'curl.index', min: 0.6 })).toBeCloseTo(0.8);
    expect(conditionTarget({ feature: 'curl.index', max: 0.3 })).toBeCloseTo(0.15);
    const fist = seedShape(POSES.find((p) => p.id === 'fist')!);
    expect(fist.curl.index).toBeCloseTo(0.825);
    expect(fist.thumb).toBe('wrap');
    const pinch = seedShape(POSES.find((p) => p.id === 'pinch')!);
    expect(pinch.pinch).toBe('index');
  });

  it('scores violations in feature scale units', () => {
    const pose: PoseDef = { id: 'x', description: '', hand: 'either', source: 'manual', conditions: [{ feature: 'curl.index', min: 0.5 }, { feature: 'pinch.index', max: 0.02 }] };
    expect(scoreFeatures(pose, { 'curl.index': 0.4, 'pinch.index': 0.01 }).violation).toBeCloseTo(0.1);
    expect(scoreFeatures(pose, { 'curl.index': 0.6, 'pinch.index': 0.03 }).violation).toBeCloseTo(0.1); // 0.01 m / 0.1 scale
    expect(scoreFeatures(pose, { 'curl.index': 0.6, 'pinch.index': 0.01 }).slack).toBeCloseTo(0.1);
  });

  it('orientations are mirrored per hand (palm in = thumb up for both hands)', () => {
    for (const hand of ['left', 'right'] as Handedness[]) {
      const f = computeFeatures(synthShape({ ...RELAXED_SHAPE, curl: { ...RELAXED_SHAPE.curl }, orient: 'fwd-up' }, hand, canonPlacement(hand)), CANON_HEAD);
      expect(f['palm.up']).toBeGreaterThan(0.9);
      const q = orientRotation('fwd-in', hand);
      expect(Math.hypot(...q)).toBeCloseTo(1);
    }
  });
});
