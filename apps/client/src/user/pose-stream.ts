// Builds the UserPose (protocol messages.ts) the primary xr client streams to
// the server at ~30 Hz: head, view FOV, hands, per-hand focus, gaze, selection.
// Values are rounded (mm / 1e-4) to keep the JSON compact (~half the bytes).

import type { HandFrame, Handedness, UserPose, VoiceContext, Vec3 } from '@evolspace/protocol';
import { round, type Pose } from '../math/space.ts';

export interface RayHitLike {
  entity: string;
  point: Vec3;
}

export interface PoseInputs {
  t: number;
  mode: UserPose['mode'];
  head: Pose;
  fov?: number;
  aspect?: number;
  hands: Partial<Record<Handedness, HandFrame>>;
  /** InteractionEngine.rays() */
  rays: Partial<Record<Handedness, { hit: RayHitLike | null } | undefined>>;
  gaze: RayHitLike | null;
  selected: string | null;
}

const r3 = (v: ArrayLike<number>): Vec3 => [round(v[0], 4), round(v[1], 4), round(v[2], 4)];
const r4 = (q: ArrayLike<number>): [number, number, number, number] => [round(q[0], 4), round(q[1], 4), round(q[2], 4), round(q[3], 4)];
const hit = (h: RayHitLike | null | undefined) => (h ? { entity: h.entity, point: r3(h.point) } : null);

export function compactHand(f: HandFrame): HandFrame {
  return { hand: f.hand, joints: f.joints.map((v) => round(v, 4)), radii: f.radii.map((v) => round(v, 4)) };
}

export function buildUserPose(i: PoseInputs): UserPose {
  const hands: UserPose['hands'] = {};
  const focus: NonNullable<UserPose['focus']> = {};
  for (const h of ['left', 'right'] as const) {
    const f = i.hands[h];
    if (f) hands[h] = compactHand(f);
    if (i.rays[h] !== undefined) focus[h] = hit(i.rays[h]?.hit);
  }
  const pose: UserPose = {
    t: Math.round(i.t),
    mode: i.mode,
    head: { position: r3(i.head.position), rotation: r4(i.head.rotation) },
    hands,
    focus,
    gaze: hit(i.gaze),
    selected: i.selected,
  };
  if (i.fov !== undefined) pose.fov = round(i.fov, 2);
  if (i.aspect !== undefined) pose.aspect = round(i.aspect, 4);
  return pose;
}

export function voiceContextOf(p: UserPose): VoiceContext {
  return { focus: p.focus, gaze: p.gaze, selected: p.selected ?? null, head: p.head };
}

/** Fixed-rate gate (30 Hz by default) that tolerates frame-rate jitter. */
export class RateGate {
  private next = -Infinity;
  constructor(readonly hz = 30) {}
  /** True if a send is due at `tMs`; advances the schedule. */
  due(tMs: number): boolean {
    const period = 1000 / this.hz;
    // Not yet due — unless the clock jumped backwards (frame time base changed,
    // e.g. window rAF ↔ XR rAF), in which case resync instead of stalling.
    if (tMs < this.next - 1 && this.next - tMs <= 2 * period) return false;
    this.next = tMs - this.next > period || this.next - tMs > period ? tMs + period : this.next + period;
    return true;
  }
}
