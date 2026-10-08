// Integration with the real @evolspace/input package (built by another
// component). Skipped when the package can't be loaded, so the server suite
// stays green while it is under construction.
import { describe, it, expect } from 'vitest';
import type { HandFrame } from '@evolspace/protocol';
import { loadInput } from '../src/gestures/input.ts';
import { UserState } from '../src/user.ts';

const input = await loadInput().catch(() => null);
const synth = input ? ((await import('@evolspace/input' as string)) as { synthHand?: (spec: unknown) => HandFrame }).synthHand : undefined;

describe.skipIf(!input || !synth)('real @evolspace/input', () => {
  it('summarizes a synthetic hand into rounded features', async () => {
    const frame = synth!({ hand: 'right', position: [0.2, 1.2, -0.3] });
    const user = new UserState();
    user.setPose({ t: 1, mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: { right: frame } });
    const s = (await user.summary()) as { hands: { right: { tracked: boolean; features?: Record<string, number> } }; featuresError?: string };
    expect(s.featuresError).toBeUndefined();
    expect(s.hands.right.tracked).toBe(true);
    const f = s.hands.right.features!;
    expect(Object.keys(f).some((k) => k.startsWith('curl.'))).toBe(true);
    for (const v of Object.values(f)) expect(Number.isFinite(v)).toBe(true);
  });

  it('derives a PoseDef from feature samples', () => {
    const samples = [{ 'curl.index': 0.8, 'curl.middle': 0.1 }, { 'curl.index': 0.85, 'curl.middle': 0.12 }];
    const pose = input!.derivePose(samples, { id: 'test-pose', hand: 'right' });
    expect(pose.id).toBe('test-pose');
    expect(Array.isArray(pose.conditions)).toBe(true);
  });
});
