import { describe, it, expect } from 'vitest';
import { PoseRecorder, type RecorderUiEvent, type PoseRecordRequest } from '../src/pose/recorder.ts';
import type { ClientMessage, HandFrame, Handedness } from '@evolspace/protocol';

const frame = (hand: Handedness, x: number): HandFrame => ({ hand, joints: new Array(175).fill(x), radii: new Array(25).fill(0.01) });

function setup(hands: Partial<Record<Handedness, HandFrame>>) {
  const sent: ClientMessage[] = [];
  const ui: RecorderUiEvent[] = [];
  let n = 0;
  const rec = new PoseRecorder({
    frames: () => ({ hands, head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] } }),
    features: (f, _head, other) => ({ 'curl.index': f.joints[0], n: n++, hasOther: other ? 1 : 0 }),
    send: (m) => sent.push(m),
    ui: (e) => ui.push(e),
  });
  return { sent, ui, rec };
}

const req = (o: Partial<PoseRecordRequest> = {}): PoseRecordRequest =>
  ({ type: 'pose.record', requestId: 'r1', name: 'peace', hand: 'right', seconds: 2, countdown: 3, ...o });

/** Simulate a render loop at `hz` from t0 for `ms`. */
function run(rec: PoseRecorder, hz: number, ms: number, t0 = 0) {
  for (let t = t0; t <= t0 + ms; t += 1000 / hz) rec.tick(t);
}

describe('PoseRecorder', () => {
  it('counts down, samples at ~30 Hz for N seconds, then replies', () => {
    const { sent, ui, rec } = setup({ right: frame('right', 0.7), left: frame('left', 0.1) });
    rec.start(req());
    run(rec, 90, 5500);
    const countdown = ui.filter((e) => e.phase === 'countdown').map((e) => (e as { secondsLeft: number }).secondsLeft);
    expect(countdown).toEqual([3, 2, 1]);
    expect(sent).toHaveLength(1);
    const m = sent[0] as Extract<ClientMessage, { type: 'pose.recording' }>;
    expect(m).toMatchObject({ type: 'pose.recording', requestId: 'r1', name: 'peace', hand: 'right' });
    expect(m.frames.length).toBeGreaterThanOrEqual(58);
    expect(m.frames.length).toBeLessThanOrEqual(62);
    expect(m.frames.every((f) => f['curl.index'] === 0.7 && f.hasOther === 1)).toBe(true);
    expect(ui.at(-1)).toMatchObject({ phase: 'done', hand: 'right' });
    expect(rec.busy).toBe(false);
  });

  it("'either' picks the tracked hand", () => {
    const { sent, rec } = setup({ left: frame('left', 0.2) });
    rec.start(req({ hand: 'either', countdown: 0, seconds: 1 }));
    run(rec, 72, 1200);
    const m = sent[0] as Extract<ClientMessage, { type: 'pose.recording' }>;
    expect(m.hand).toBe('left');
    expect(m.frames.length).toBeGreaterThanOrEqual(29);
  });

  it('reports an error when the hand is never tracked (still replies so the server does not hang)', () => {
    const { sent, ui, rec } = setup({});
    rec.start(req({ countdown: 0, seconds: 0.5 }));
    run(rec, 60, 700);
    expect((sent[0] as { frames: unknown[] }).frames).toEqual([]);
    expect(ui.at(-1)?.phase).toBe('error');
  });

  it('external timing samples until complete() and emits no countdown', () => {
    const { sent, ui, rec } = setup({ right: frame('right', 0.3) });
    rec.startSampling(req({ countdown: 3, seconds: 2 }));
    run(rec, 90, 1000);
    expect(sent).toHaveLength(0);
    rec.complete('other-request'); // ignored
    expect(sent).toHaveLength(0);
    rec.complete('r1');
    const m = sent[0] as Extract<ClientMessage, { type: 'pose.recording' }>;
    expect(m.frames.length).toBeGreaterThanOrEqual(29);
    expect(m.frames.length).toBeLessThanOrEqual(31);
    expect(ui.some((e) => e.phase === 'countdown' || e.phase === 'recording')).toBe(false);
    expect(rec.busy).toBe(false);
  });

  it('external timing keeps sampling when the frame clock jumps backwards', () => {
    const { sent, rec } = setup({ right: frame('right', 0.3) });
    rec.startSampling(req());
    run(rec, 90, 500, 80_000);
    run(rec, 90, 500, 0); // new time base
    rec.complete('r1');
    const m = sent[0] as Extract<ClientMessage, { type: 'pose.recording' }>;
    expect(m.frames.length).toBeGreaterThanOrEqual(29);
  });

  it('a new request supersedes the running one', () => {
    const { sent, rec } = setup({ right: frame('right', 1) });
    rec.start(req({ requestId: 'a' }));
    run(rec, 30, 1000);
    rec.start(req({ requestId: 'b', countdown: 0, seconds: 0.2 }));
    run(rec, 30, 500, 1100);
    expect(sent.map((m) => (m as { requestId: string }).requestId)).toEqual(['b']);
  });
});
