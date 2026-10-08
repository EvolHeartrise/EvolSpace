// Simulated hands for tests and automation (window.__evol.sim). While set,
// they replace real/desktop hands in every mode, so Playwright can drive
// pinch-grabs deterministically through the real interaction engine.

import type { HandFrame, Handedness, Quat, Vec3 } from '@evolspace/protocol';
import { translateFrame, type SynthSpecLike } from '../desktop/controls.ts';

/** Anything with `hand` and `joints` is a HandFrame; anything else with `hand` is a synth spec. */
export type SimHandInput = HandFrame | (SynthSpecLike & Record<string, unknown>);

export function isHandFrame(x: unknown): x is HandFrame {
  return typeof x === 'object' && x !== null && Array.isArray((x as HandFrame).joints) && (x as HandFrame).joints.length === 175;
}

export class SimHands {
  private frames: Partial<Record<Handedness, HandFrame>> | null = null;

  constructor(
    private readonly synth: (spec: SynthSpecLike) => HandFrame,
    private readonly pinchPoint?: (frame: HandFrame) => Vec3,
  ) {}

  /** True while simulated hands override real input. */
  get active(): boolean {
    return this.frames !== null;
  }

  /**
   * Replace the simulated hands. Accepts one spec/frame, an array, or a
   * {left, right} record. Hands not mentioned are untracked. Returns the frames.
   */
  setHands(input: SimHandInput | SimHandInput[] | Partial<Record<Handedness, SimHandInput>>): Partial<Record<Handedness, HandFrame>> {
    const items: SimHandInput[] = Array.isArray(input)
      ? input
      : 'hand' in (input as object)
        ? [input as SimHandInput]
        : Object.entries(input as Record<string, SimHandInput>).map(([hand, v]) => ({ ...v, hand }) as SimHandInput);
    const out: Partial<Record<Handedness, HandFrame>> = {};
    for (const it of items) {
      const hand = it.hand;
      if (hand !== 'left' && hand !== 'right') throw new Error(`sim.setHands: invalid hand '${String(hand)}'`);
      out[hand] = isHandFrame(it) ? { hand, joints: it.joints.slice(), radii: it.radii?.length === 25 ? it.radii.slice() : new Array(25).fill(0.008) } : this.synth(it as SynthSpecLike);
    }
    this.frames = out;
    return out;
  }

  /**
   * Convenience for tests: put the hand's pinch point (thumb/index midpoint)
   * exactly at `point` (space coords), pinching or open. Default orientation: fingers
   * forward (-Z), palm down. Other simulated hands are kept.
   */
  setPinchAt(hand: Handedness, point: Vec3, pinching: boolean, rotation: Quat = [0, 0, 0, 1]): HandFrame {
    if (!this.pinchPoint) throw new Error('sim.setPinchAt: pinchPoint unavailable');
    const spec: SynthSpecLike = pinching
      ? { hand, rotation, position: [0, 0, 0], pinch: 'index', curl: { middle: 0.2, ring: 0.28, pinky: 0.32 }, spread: 6 }
      : { hand, rotation, position: [0, 0, 0], curl: { thumb: 0.15, index: 0.12, middle: 0.22, ring: 0.28, pinky: 0.32 }, spread: 6, thumbSpread: 25 };
    const atOrigin = this.synth(spec);
    const pp = this.pinchPoint(atOrigin);
    const f = translateFrame(atOrigin, [point[0] - pp[0], point[1] - pp[1], point[2] - pp[2]]);
    this.frames = { ...(this.frames ?? {}), [hand]: f };
    return f;
  }

  clearHands(): void {
    this.frames = null;
  }

  /** Current simulated hands (null = not overriding). */
  get(): Partial<Record<Handedness, HandFrame>> | null {
    return this.frames;
  }
}
