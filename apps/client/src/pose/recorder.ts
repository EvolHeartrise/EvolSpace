// Pose recording (server 'pose.record' → client 'pose.recording').
//
// Shows a countdown, then samples hand features at ~30 Hz for N seconds and
// replies with the feature frames; the server derives a PoseDef from them.
// Driven by tick() from the render loop (deterministic and testable), not by
// timers, so sampling always sees the freshest tracked hands.

import type { ClientMessage, HandFeatures, HandFrame, Handedness, ServerMessage } from '@evolspace/protocol';
import type { Pose } from '../math/space.ts';

export type PoseRecordRequest = Extract<ServerMessage, { type: 'pose.record' }>;

export type RecorderUiEvent =
  | { phase: 'countdown'; name: string; hand: Handedness | 'either'; secondsLeft: number }
  | { phase: 'recording'; name: string; hand: Handedness | 'either'; progress: number }
  | { phase: 'done'; name: string; hand: Handedness; samples: number }
  | { phase: 'error'; name: string; message: string };

export interface PoseRecorderDeps {
  /** Latest hands (space coords) + head. */
  frames(): { hands: Partial<Record<Handedness, HandFrame>>; head: Pose };
  /** computeFeatures from @evolspace/input (injected for testability). */
  features(frame: HandFrame, head: Pose, other?: HandFrame): HandFeatures;
  send(m: ClientMessage): void;
  ui(e: RecorderUiEvent): void;
}

export const SAMPLE_HZ = 30;

interface Active {
  req: PoseRecordRequest;
  startMs: number;      // first tick
  recordFromMs: number; // countdown end
  recordToMs: number;
  /** Scheduled time of the next sample (fixed 30 Hz grid, independent of frame rate). */
  nextSampleMs: number;
  lastSecondsLeft: number;
  samples: Record<Handedness, HandFeatures[]>;
  /** Timing driven by someone else (the runtime's RecordingUi): sample until complete(). */
  external: boolean;
}

export class PoseRecorder {
  private active: Active | null = null;
  private pendingReq: PoseRecordRequest | null = null;
  private pendingExternal = false;

  constructor(private readonly deps: PoseRecorderDeps) {}

  get busy(): boolean {
    return this.active !== null || this.pendingReq !== null;
  }

  /** Begin a recording; replaces (and abandons) any recording in progress. */
  start(req: PoseRecordRequest): void {
    if (this.active) this.deps.ui({ phase: 'error', name: this.active.req.name, message: 'superseded by a new recording' });
    this.active = null;
    this.pendingReq = req; // timing starts on the next tick so it is frame-aligned
    this.pendingExternal = false;
  }

  /**
   * External timing: start sampling now (the countdown was shown elsewhere) and
   * keep sampling until complete(). Used when the runtime's RecordingUi drives
   * the phases, so the samples line up exactly with what the user saw.
   */
  startSampling(req: PoseRecordRequest): void {
    this.active = null;
    this.pendingReq = req;
    this.pendingExternal = true;
  }

  /** Finish an externally timed recording now and send the result. */
  complete(requestId?: string): void {
    const a = this.active;
    if (a && (!requestId || a.req.requestId === requestId)) this.finish(a);
    else if (this.pendingReq && (!requestId || this.pendingReq.requestId === requestId)) {
      // Completed before the first tick: send an empty (but well-formed) result.
      const req = this.pendingReq;
      this.pendingReq = null;
      this.finish({ req, startMs: 0, recordFromMs: 0, recordToMs: 0, nextSampleMs: 0, lastSecondsLeft: 0, samples: { left: [], right: [] }, external: true });
    }
  }

  cancel(): void {
    if (this.active || this.pendingReq) {
      const name = (this.active?.req ?? this.pendingReq)!.name;
      this.deps.ui({ phase: 'error', name, message: 'cancelled' });
    }
    this.active = null;
    this.pendingReq = null;
  }

  /** Call every frame with a monotonic time in ms. */
  tick(tMs: number): void {
    if (this.pendingReq) {
      const req = this.pendingReq;
      this.pendingReq = null;
      const external = this.pendingExternal;
      const countdownMs = external ? 0 : Math.max(0, req.countdown) * 1000;
      const durMs = external ? Infinity : Math.max(0.1, req.seconds) * 1000;
      this.active = {
        req, startMs: tMs, recordFromMs: tMs + countdownMs, recordToMs: tMs + countdownMs + durMs,
        nextSampleMs: tMs + countdownMs, lastSecondsLeft: -1, samples: { left: [], right: [] }, external,
      };
    }
    const a = this.active;
    if (!a) return;
    const { req } = a;
    if (a.external && a.nextSampleMs - tMs > (2 * 1000) / SAMPLE_HZ) {
      // The frame clock jumped backwards (time base changed, e.g. entering XR
      // mid-recording): rebase the sampling grid instead of stalling.
      a.recordFromMs = Math.min(a.recordFromMs, tMs);
      a.nextSampleMs = tMs;
    }

    if (tMs < a.recordFromMs) {
      const left = Math.ceil((a.recordFromMs - tMs) / 1000);
      if (left !== a.lastSecondsLeft) {
        a.lastSecondsLeft = left;
        this.deps.ui({ phase: 'countdown', name: req.name, hand: req.hand, secondsLeft: left });
      }
      return;
    }

    if (tMs <= a.recordToMs) {
      const period = 1000 / SAMPLE_HZ;
      if (tMs >= a.nextSampleMs - 1) {
        // Advance on a fixed grid so the average rate is 30 Hz at any frame rate;
        // after a stall, resync instead of bursting.
        a.nextSampleMs = tMs - a.nextSampleMs > period ? tMs + period : a.nextSampleMs + period;
        this.sample(a);
        if (a.external) return;
        const progress = Math.min(1, (tMs - a.recordFromMs) / (a.recordToMs - a.recordFromMs));
        this.deps.ui({ phase: 'recording', name: req.name, hand: req.hand, progress });
      }
      return;
    }

    this.finish(a);
  }

  private sample(a: Active): void {
    const { hands, head } = this.deps.frames();
    const want: Handedness[] = a.req.hand === 'either' ? ['right', 'left'] : [a.req.hand];
    for (const h of want) {
      const f = hands[h];
      if (!f) continue;
      const other = hands[h === 'left' ? 'right' : 'left'];
      a.samples[h].push(this.deps.features(f, head, other));
    }
  }

  private finish(a: Active): void {
    this.active = null;
    const { req } = a;
    // For 'either', use the hand that was tracked more (ties → right).
    const hand: Handedness = req.hand !== 'either'
      ? req.hand
      : a.samples.left.length > a.samples.right.length ? 'left' : 'right';
    const frames = a.samples[hand];
    this.deps.send({ type: 'pose.recording', requestId: req.requestId, name: req.name, hand, frames });
    if (frames.length === 0) {
      this.deps.ui({ phase: 'error', name: req.name, message: `no ${req.hand === 'either' ? '' : req.hand + ' '}hand tracked during recording` });
    } else {
      this.deps.ui({ phase: 'done', name: req.name, hand, samples: frames.length });
    }
  }
}
