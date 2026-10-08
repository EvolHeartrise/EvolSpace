// Joint indexing helpers over the flat HandFrame layout
// (25 joints × [px, py, pz, qx, qy, qz, qw], HAND_JOINTS order).

import { HAND_JOINTS } from '@evolspace/protocol';
import type { Finger, HandFrame, HandJoint, Quat, Vec3 } from '@evolspace/protocol';

export const JOINT_COUNT = HAND_JOINTS.length; // 25
export const JOINT_STRIDE = 7;

/** Joint name → index in HAND_JOINTS. */
export const JOINT_INDEX: Readonly<Record<HandJoint, number>> = Object.freeze(
  Object.fromEntries(HAND_JOINTS.map((j, i) => [j, i])) as Record<HandJoint, number>,
);

export const FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
/** The four non-thumb fingers. */
export const LONG_FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
export type LongFinger = (typeof LONG_FINGERS)[number];

/**
 * Index of each finger's first joint. Thumb: metacarpal, proximal, distal, tip (4 joints).
 * Long fingers: metacarpal, proximal, intermediate, distal, tip (5 joints).
 */
export const FINGER_BASE: Readonly<Record<Finger, number>> = {
  thumb: 1,
  index: 5,
  middle: 10,
  ring: 15,
  pinky: 20,
};

/** Index of a finger's tip joint. */
export const tipIndex = (f: Finger): number => (f === 'thumb' ? 4 : FINGER_BASE[f] + 4);

export const WRIST = 0;
export const THUMB_METACARPAL = 1;
export const THUMB_PROXIMAL = 2;
export const THUMB_DISTAL = 3;
export const THUMB_TIP = 4;
export const INDEX_PROXIMAL = 6; // index knuckle (MCP joint)
export const INDEX_TIP = 9;
export const MIDDLE_PROXIMAL = 11;
export const PINKY_PROXIMAL = 21;

export function jointPos(frame: HandFrame, i: number): Vec3 {
  const o = i * JOINT_STRIDE;
  const j = frame.joints;
  return [j[o], j[o + 1], j[o + 2]];
}

export function jointRot(frame: HandFrame, i: number): Quat {
  const o = i * JOINT_STRIDE + 3;
  const j = frame.joints;
  return [j[o], j[o + 1], j[o + 2], j[o + 3]];
}

/** True when the frame has the expected layout (25 joints × 7 numbers) with finite values. */
export function isValidFrame(frame: HandFrame | undefined | null): frame is HandFrame {
  if (!frame || !Array.isArray(frame.joints) || frame.joints.length !== JOINT_COUNT * JOINT_STRIDE) return false;
  for (let i = 0; i < frame.joints.length; i++) if (!Number.isFinite(frame.joints[i])) return false;
  return true;
}
