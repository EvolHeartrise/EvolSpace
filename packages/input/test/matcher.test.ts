import { describe, expect, it } from 'vitest';
import type { HandFrame, PoseDef } from '@evolspace/protocol';
import { PoseMatcher, conditionMargin, matchesPose, type PoseTransition } from '../src/matcher.ts';
import { HEAD, shape } from './helpers.ts';

const PINCH: PoseDef = {
  id: 'pinch', description: '', hand: 'either', source: 'manual', enterMs: 30, exitSlack: 0.15,
  conditions: [{ feature: 'pinch.index', max: 0.025 }],
};
const FIST: PoseDef = {
  id: 'fist', description: '', hand: 'right', source: 'manual', enterMs: 0,
  conditions: [{ feature: 'curl.index', min: 0.7 }, { feature: 'curl.middle', min: 0.7 }],
};

/** Right/left hand pinching with a given thumb–index gap (meters). */
const pinchGap = (gap: number, hand: 'left' | 'right' = 'right'): HandFrame => shape('pinch', hand, { pinchGap: gap });
const open = (hand: 'left' | 'right' = 'right') => shape('open', hand);

const brief = (ts: PoseTransition[]) => ts.map((t) => `${t.hand}:${t.pose}:${t.phase}`);

describe('PoseMatcher', () => {
  it('debounces entry by enterMs', () => {
    const m = new PoseMatcher([PINCH]);
    expect(m.update({ right: open() }, HEAD, 0)).toEqual([]);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 10)).toEqual([]);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 30)).toEqual([]);
    expect(brief(m.update({ right: pinchGap(0.01) }, HEAD, 40))).toEqual(['right:pinch:start']);
    expect(m.active('right')).toEqual(['pinch']);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 50)).toEqual([]);
  });

  it('a flicker during entry restarts the debounce', () => {
    const m = new PoseMatcher([PINCH]);
    m.update({ right: pinchGap(0.01) }, HEAD, 0);
    m.update({ right: open() }, HEAD, 20);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 35)).toEqual([]);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 60)).toEqual([]);
    expect(brief(m.update({ right: pinchGap(0.01) }, HEAD, 65))).toEqual(['right:pinch:start']);
  });

  it('applies exit hysteresis = exitSlack × feature scale', () => {
    expect(conditionMargin(PINCH, 'pinch.index')).toBeCloseTo(0.015, 6); // 0.15 × 0.1 m
    const m = new PoseMatcher([PINCH]);
    m.update({ right: pinchGap(0.01) }, HEAD, 0);
    expect(brief(m.update({ right: pinchGap(0.01) }, HEAD, 30))).toEqual(['right:pinch:start']);
    // 3.5 cm is outside the entry range (2.5 cm) but inside the widened exit range (4 cm).
    expect(m.update({ right: pinchGap(0.035) }, HEAD, 40)).toEqual([]);
    expect(m.isActive('right', 'pinch')).toBe(true);
    expect(brief(m.update({ right: pinchGap(0.045) }, HEAD, 50))).toEqual(['right:pinch:end']);
    // Re-entry needs the strict range again.
    m.update({ right: pinchGap(0.035) }, HEAD, 60);
    expect(m.update({ right: pinchGap(0.035) }, HEAD, 200)).toEqual([]);
  });

  it("'either' poses are tracked per hand; hand-specific poses only on their hand", () => {
    const m = new PoseMatcher([PINCH, FIST]);
    const t1 = m.update({ left: pinchGap(0.01, 'left'), right: shape('fist', 'right') }, HEAD, 0);
    expect(brief(t1)).toEqual(['right:fist:start']);
    const t2 = m.update({ left: pinchGap(0.01, 'left'), right: pinchGap(0.01, 'right') }, HEAD, 40);
    expect(brief(t2)).toEqual(['right:fist:end', 'left:pinch:start']);
    const t3 = m.update({ left: pinchGap(0.01, 'left'), right: pinchGap(0.01, 'right') }, HEAD, 80);
    expect(brief(t3)).toEqual(['right:pinch:start']);
    expect(m.active('left')).toEqual(['pinch']);
    expect(m.active('right')).toEqual(['pinch']);
    // Left fist is not a pose (FIST is right-only).
    const t4 = m.update({ left: shape('fist', 'left'), right: pinchGap(0.01, 'right') }, HEAD, 100);
    expect(brief(t4)).toEqual(['left:pinch:end']);
    expect(m.active('left')).toEqual([]);
  });

  it('emits ends before starts within one update', () => {
    const m = new PoseMatcher([PINCH, FIST]);
    m.update({ right: pinchGap(0.01) }, HEAD, 0);
    m.update({ right: pinchGap(0.01) }, HEAD, 30);
    expect(brief(m.update({ right: shape('fist', 'right') }, HEAD, 40))).toEqual(['right:pinch:end', 'right:fist:start']);
  });

  it('holds poses through brief tracking loss, then ends them as lost', () => {
    const m = new PoseMatcher([PINCH], { lostGraceMs: 100 });
    m.update({ right: pinchGap(0.01) }, HEAD, 0);
    m.update({ right: pinchGap(0.01) }, HEAD, 30);
    expect(m.update({}, HEAD, 80)).toEqual([]);
    expect(m.isActive('right', 'pinch')).toBe(true);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 120)).toEqual([]); // back before the grace expired
    m.update({}, HEAD, 150);
    const t = m.update({}, HEAD, 260);
    expect(t).toEqual([{ pose: 'pinch', hand: 'right', phase: 'end', t: 260, lost: true }]);
    expect(m.features('right')).toBeUndefined();
  });

  it('setPoses keeps surviving pose state and ends removed poses', () => {
    const m = new PoseMatcher([PINCH, FIST]);
    m.update({ right: pinchGap(0.01) }, HEAD, 0);
    m.update({ right: pinchGap(0.01) }, HEAD, 30);
    m.setPoses([PINCH, FIST]);
    expect(m.update({ right: pinchGap(0.01) }, HEAD, 40)).toEqual([]);
    m.setPoses([FIST]);
    expect(brief(m.update({ right: pinchGap(0.01) }, HEAD, 50))).toEqual(['right:pinch:end']);
  });

  it('survives the clock going backwards (new time base)', () => {
    const m = new PoseMatcher([PINCH], { lostGraceMs: 100 });
    // Entry started at a large t, then time restarts near 0: entry must still complete.
    m.update({ right: pinchGap(0.01) }, HEAD, 100_000);
    m.update({ right: pinchGap(0.01) }, HEAD, 5);
    expect(brief(m.update({ right: pinchGap(0.01) }, HEAD, 40))).toEqual(['right:pinch:start']);
    // Hand lost while the clock jumps back: poses must not be held forever.
    m.update({ right: pinchGap(0.01) }, HEAD, 50_000);
    expect(brief(m.update({}, HEAD, 10))).toEqual(['right:pinch:end']);
  });

  it('conditions on missing features never hold', () => {
    const twoHands: PoseDef = { id: 'apart', description: '', hand: 'either', source: 'manual', enterMs: 0, conditions: [{ feature: 'hands.distance', min: 0.1 }] };
    const typo: PoseDef = { id: 'typo', description: '', hand: 'either', source: 'manual', enterMs: 0, conditions: [{ feature: 'curl.indx', max: 1 }] };
    const m = new PoseMatcher([twoHands, typo]);
    expect(m.update({ right: open() }, HEAD, 0)).toEqual([]);
    expect(brief(m.update({ right: open('right'), left: open('left') }, HEAD, 10))).toEqual(['left:apart:start', 'right:apart:start']);
    expect(matchesPose(typo, { 'curl.index': 0.5 })).toBe(false);
  });
});
