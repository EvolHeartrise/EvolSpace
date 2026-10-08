// Reads tracked hands from an XRFrame into HandFrames in SPACE coordinates.
// Prefers the batched XRFrame.fillPoses / fillJointRadii (one call per hand),
// falling back to per-joint getJointPose. Scratch buffers are reused; only the
// output HandFrame arrays are allocated per frame (consumers may retain them).

import { HAND_JOINTS, type HandFrame, type Handedness } from '@evolspace/protocol';
import { matricesToJoints, JOINT_COUNT, JOINT_STRIDE, quatRotate, quatMultiply, type Pose } from '../math/space.ts';

/** WebXR Hand Input batched APIs (Chromium/Quest); not in @types/webxr. */
interface XRFrameBatched extends XRFrame {
  fillPoses?(spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array): boolean;
  fillJointRadii?(jointSpaces: XRJointSpace[], radii: Float32Array): boolean;
}

interface HandCache {
  hand: XRHand;
  spaces: XRJointSpace[];
  /** All 25 joint spaces exist (checked once per XRHand, not per frame). */
  complete: boolean;
}

export class XrHandReader {
  private readonly matrices = new Float32Array(JOINT_COUNT * 16);
  private readonly radii = new Float32Array(JOINT_COUNT);
  private readonly cache = new Map<Handedness, HandCache>();
  private readonly tmp = [0, 0, 0, 0];

  /**
   * Fills `out` with the currently tracked hands (removes untracked ones).
   * @param toSpace world → space transform (inverse space origin)
   */
  read(frame: XRFrame, refSpace: XRReferenceSpace, toSpace: Pose, out: Partial<Record<Handedness, HandFrame>>): void {
    let seenL = false, seenR = false;
    for (const src of frame.session.inputSources) {
      const hand = src.hand;
      const h = src.handedness;
      if (!hand || (h !== 'left' && h !== 'right')) continue;
      const f = this.readHand(frame, refSpace, toSpace, h, hand);
      if (f) {
        out[h] = f;
        if (h === 'left') seenL = true; else seenR = true;
      }
    }
    if (!seenL) delete out.left;
    if (!seenR) delete out.right;
  }

  private spacesFor(h: Handedness, hand: XRHand): HandCache {
    const c = this.cache.get(h);
    if (c && c.hand === hand) return c;
    const spaces = HAND_JOINTS.map((name) => hand.get(name as XRHandJoint)!);
    const entry: HandCache = { hand, spaces, complete: spaces.every((sp) => !!sp) };
    this.cache.set(h, entry);
    return entry;
  }

  private readHand(frame: XRFrame, refSpace: XRReferenceSpace, toSpace: Pose, h: Handedness, hand: XRHand): HandFrame | null {
    const { spaces, complete } = this.spacesFor(h, hand);
    if (!complete) return null;
    const joints = new Array<number>(JOINT_COUNT * JOINT_STRIDE);
    const radii = new Array<number>(JOINT_COUNT);
    const bf = frame as XRFrameBatched;
    if (typeof bf.fillPoses === 'function' && typeof bf.fillJointRadii === 'function') {
      // fillPoses returns false when any joint is untracked.
      if (!bf.fillPoses(spaces, refSpace, this.matrices)) return null;
      if (!bf.fillJointRadii(spaces, this.radii)) return null;
      matricesToJoints(this.matrices, toSpace, joints);
      for (let j = 0; j < JOINT_COUNT; j++) radii[j] = this.radii[j];
      return { hand: h, joints, radii };
    }
    const tmp = this.tmp;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const p = frame.getJointPose?.(spaces[j], refSpace);
      if (!p) return null;
      const o = j * JOINT_STRIDE;
      const t = p.transform.position, q = p.transform.orientation;
      tmp[0] = t.x; tmp[1] = t.y; tmp[2] = t.z;
      quatRotate(toSpace.rotation, tmp, joints, o);
      joints[o] += toSpace.position[0]; joints[o + 1] += toSpace.position[1]; joints[o + 2] += toSpace.position[2];
      tmp[0] = q.x; tmp[1] = q.y; tmp[2] = q.z; tmp[3] = q.w;
      quatMultiply(toSpace.rotation, tmp, joints, o + 3);
      radii[j] = p.radius ?? 0.008;
    }
    return { hand: h, joints, radii };
  }
}
