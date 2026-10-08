// Live readouts of both hands for the Hands panel (polled ~8 Hz): source,
// features (from the engine's matcher), active poses, binding sessions, ray /
// touch targets and the per-pose binding explanation.

import { signal } from '@preact/signals';
import type { HandFeatures, Handedness, InteractionSet, PoseDef, UserPose } from '@evolspace/protocol';
import { computeFeatures, contactPoint, matchesPose, poseAppliesTo } from '@evolspace/input';
import type { DebugContext } from '../../types.ts';
import { explainPose, type Explanation, type HitLike, type SessionLike } from './explain.ts';
import { HANDS, simState } from './driver.ts';

/** Poses + interaction sets as the runtime has them (gestures.defs). */
export const gestureDefs = signal<{ poses: PoseDef[]; interactions: Record<string, InteractionSet> } | null>(null);

export interface HandLive {
  hand: Handedness;
  tracked: boolean;
  source: 'sim' | 'sim (hooks)' | 'mouse' | 'xr' | null;
  features: HandFeatures | undefined;
  active: string[];
  sessions: SessionLike[];
  rayHit: HitLike | null;
  touchHit: HitLike | null;
  explain: Array<{ pose: string; active: boolean; firing: SessionLike | undefined; ex: Explanation }>;
}

export type LiveSnapshot = Record<Handedness, HandLive>;

export function readLive(ctx: DebugContext): LiveSnapshot {
  const c = ctx.client;
  const engine = ctx.engine;
  const defs = gestureDefs.peek() ?? ctx.runtime.gestures ?? { poses: [], interactions: {} };
  let sessions: SessionLike[] = [];
  let rays: ReturnType<typeof engine.rays> = {};
  try { sessions = engine.activeSessions(); rays = engine.rays(); } catch { /* engine not ready */ }
  const out = {} as LiveSnapshot;
  for (const hand of HANDS) {
    const frame = c.hands[hand];
    const simOn = simState[hand].peek().enabled;
    const source: HandLive['source'] = !frame ? null : simOn ? 'sim' : c.sim.active ? (hand === 'right' && c.desktop ? 'mouse' : 'sim (hooks)') : c.desktop ? 'mouse' : 'xr';
    const rayHit = rays[hand]?.hit ?? null;
    let touchHit: HitLike | null = null;
    if (frame) { try { touchHit = c.host.touch(contactPoint(frame), 0.03); } catch { /* scene not ready */ } }
    const active = engine.activePoses(hand);
    const mine = sessions.filter((s) => s.hand === hand);
    const explain = defs.poses.filter((p) => poseAppliesTo(p, hand)).map((p) => ({
      pose: p.id,
      active: active.includes(p.id),
      firing: mine.find((s) => s.pose === p.id),
      ex: explainPose({
        hand, pose: p.id, rayHit, touchHit,
        getEntity: (id) => ctx.runtime.entity(id),
        widgetBindings: (w) => c.host.widgetBindings(w),
        sets: defs.interactions,
        poseActive: (h, pose) => engine.activePoses(h).includes(pose),
        sessions,
      }),
    }));
    out[hand] = {
      hand, tracked: !!frame, source, features: engine.matcher.features(hand),
      active, sessions: mine, rayHit, touchHit, explain,
    };
  }
  return out;
}

/** The headset user's hands (store.userPose): features + matching poses (conditions only, no debounce). */
export function headsetHands(pose: UserPose | null, poses: PoseDef[]): Record<Handedness, { features: HandFeatures | undefined; poses: string[] }> {
  const out = { left: { features: undefined, poses: [] }, right: { features: undefined, poses: [] } } as Record<Handedness, { features: HandFeatures | undefined; poses: string[] }>;
  if (!pose) return out;
  for (const hand of HANDS) {
    const f = pose.hands?.[hand];
    if (!f || !Array.isArray(f.joints) || f.joints.length < 175) continue;
    const other = pose.hands?.[hand === 'left' ? 'right' : 'left'];
    try {
      const features = computeFeatures(f, pose.head, other && other.joints?.length >= 175 ? other : undefined);
      out[hand] = { features, poses: poses.filter((p) => poseAppliesTo(p, hand) && matchesPose(p, features)).map((p) => p.id) };
    } catch { /* malformed frame */ }
  }
  return out;
}
