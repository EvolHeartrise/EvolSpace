// PoseMatcher: turns per-frame hand features into debounced pose start/end
// transitions.
//
// Semantics (documented for pose authors in FEATURES.md):
// - A pose applies to a hand if pose.hand is that hand or 'either' ('either'
//   poses are tracked independently per hand and may be active on both).
// - Entering: all conditions must hold continuously for `enterMs` (default 60).
// - Exiting: while active, every bound is widened by exitSlack × scale(feature)
//   (default slack 0.15; scale per feature in FEATURE_INFO). The pose ends on
//   the first frame a widened condition fails.
// - A condition on a feature that is missing (e.g. hands.distance with one
//   hand tracked, or a misspelled name) never holds.
// - Tracking loss: active poses are held for `lostGraceMs` (default 100) so a
//   brief dropout doesn't drop a grab, then end.
// - Within one update, all 'end' transitions are emitted before 'start's.

import type { HandFeatures, HandFrame, Handedness, PoseDef, FeatureCondition } from '@evolspace/protocol';
import { computeFeatures, featureInfo, type HeadPose } from './features.ts';
import { isValidFrame } from './joints.ts';

export const DEFAULT_ENTER_MS = 60;
export const DEFAULT_EXIT_SLACK = 0.15;
export const HANDS: readonly Handedness[] = ['left', 'right'];

export interface PoseTransition {
  pose: string;
  hand: Handedness;
  phase: 'start' | 'end';
  /** tMs of the update that produced it. */
  t: number;
  /** For 'end': true when the hand stopped being tracked (vs. the pose being released). */
  lost?: boolean;
}

/** Hysteresis margin for one feature of a pose (0 when not active). */
export function conditionMargin(pose: PoseDef, feature: string): number {
  return (pose.exitSlack ?? DEFAULT_EXIT_SLACK) * featureInfo(feature).scale;
}

export function conditionHolds(c: FeatureCondition, features: HandFeatures, margin = 0): boolean {
  const v = features[c.feature];
  if (v === undefined || !Number.isFinite(v)) return false;
  if (c.min !== undefined && v < c.min - margin) return false;
  if (c.max !== undefined && v > c.max + margin) return false;
  return true;
}

/** Whether `features` satisfy `pose`. Pass active=true to apply the exit hysteresis. */
export function matchesPose(pose: PoseDef, features: HandFeatures, active = false): boolean {
  for (const c of pose.conditions) {
    if (!conditionHolds(c, features, active ? conditionMargin(pose, c.feature) : 0)) return false;
  }
  return true;
}

export const poseAppliesTo = (pose: PoseDef, hand: Handedness): boolean => pose.hand === 'either' || pose.hand === hand;

interface PoseState {
  active: boolean;
  /** tMs since when the (entry) conditions have held continuously, while inactive. */
  since: number | null;
}

interface HandState {
  poses: Map<string, PoseState>;
  lastSeen: number | null;
  features: HandFeatures | undefined;
}

export interface PoseMatcherOptions {
  /** How long a lost hand keeps its active poses before they end. Default 100 ms. */
  lostGraceMs?: number;
}

export type HandFrames = Partial<Record<Handedness, HandFrame>>;

export class PoseMatcher {
  private poses: PoseDef[] = [];
  /** Poses that apply to each hand, and their ids (rebuilt by setPoses, not per frame). */
  private applicable: Record<Handedness, { poses: PoseDef[]; ids: Set<string> }> = {
    left: { poses: [], ids: new Set() },
    right: { poses: [], ids: new Set() },
  };
  private hands: Record<Handedness, HandState> = {
    left: { poses: new Map(), lastSeen: null, features: undefined },
    right: { poses: new Map(), lastSeen: null, features: undefined },
  };
  private readonly lostGraceMs: number;

  constructor(poses: PoseDef[] = [], opts: PoseMatcherOptions = {}) {
    this.lostGraceMs = opts.lostGraceMs ?? 100;
    this.setPoses(poses);
  }

  /**
   * Replace the pose set. State of poses whose id survives is kept; poses that
   * were removed (or no longer apply to a hand) end on the next update.
   */
  setPoses(poses: PoseDef[]): void {
    this.poses = poses.slice();
    for (const hand of HANDS) {
      const list = this.poses.filter((p) => poseAppliesTo(p, hand));
      this.applicable[hand] = { poses: list, ids: new Set(list.map((p) => p.id)) };
    }
  }

  getPoses(): readonly PoseDef[] {
    return this.poses;
  }

  /** Ids of the poses currently active on `hand`. */
  active(hand: Handedness): string[] {
    const out: string[] = [];
    for (const [id, st] of this.hands[hand].poses) if (st.active) out.push(id);
    return out;
  }

  isActive(hand: Handedness, pose: string): boolean {
    return this.hands[hand].poses.get(pose)?.active ?? false;
  }

  /** Features computed for `hand` on the last update it was tracked (undefined if never/lost). */
  features(hand: Handedness): HandFeatures | undefined {
    return this.hands[hand].features;
  }

  /** Forget all state without emitting transitions. */
  reset(): void {
    for (const h of HANDS) this.hands[h] = { poses: new Map(), lastSeen: null, features: undefined };
  }

  update(frames: HandFrames, head: HeadPose, tMs: number): PoseTransition[] {
    const ends: PoseTransition[] = [];
    const starts: PoseTransition[] = [];
    for (const hand of HANDS) {
      const hs = this.hands[hand];
      const frame = frames[hand];
      const { poses: applicable, ids } = this.applicable[hand];

      // Poses removed from the set (or no longer applicable) end now.
      for (const [id, st] of hs.poses) {
        if (!ids.has(id)) {
          if (st.active) ends.push({ pose: id, hand, phase: 'end', t: tMs });
          hs.poses.delete(id);
        }
      }

      if (!isValidFrame(frame)) {
        // (tMs < lastSeen: the clock base changed; don't hold poses forever.)
        const lost = hs.lastSeen === null || tMs - hs.lastSeen > this.lostGraceMs || tMs < hs.lastSeen;
        for (const [id, st] of hs.poses) {
          st.since = null;
          if (lost && st.active) {
            st.active = false;
            ends.push({ pose: id, hand, phase: 'end', t: tMs, lost: true });
          }
        }
        if (lost) hs.features = undefined;
        continue;
      }

      hs.lastSeen = tMs;
      const other = frames[hand === 'left' ? 'right' : 'left'];
      const features = computeFeatures(frame, head, isValidFrame(other) ? other : undefined);
      hs.features = features;

      for (const pose of applicable) {
        let st = hs.poses.get(pose.id);
        if (!st) {
          st = { active: false, since: null };
          hs.poses.set(pose.id, st);
        }
        if (st.active) {
          if (!matchesPose(pose, features, true)) {
            st.active = false;
            st.since = null;
            ends.push({ pose: pose.id, hand, phase: 'end', t: tMs });
          }
        } else if (matchesPose(pose, features, false)) {
          if (st.since === null || tMs < st.since) st.since = tMs;
          if (tMs - st.since >= (pose.enterMs ?? DEFAULT_ENTER_MS)) {
            st.active = true;
            st.since = null;
            starts.push({ pose: pose.id, hand, phase: 'start', t: tMs });
          }
        } else {
          st.since = null;
        }
      }
    }
    return ends.concat(starts);
  }
}
