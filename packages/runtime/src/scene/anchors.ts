// Anchor frames for root entities (and system UI): head, hand joints, and
// lazy head-follow. All frames are children of the space root, posed in space
// coordinates every frame by the runtime. An anchored entity is simply
// parented to its frame, so its own transform is relative to that frame.

import * as THREE from 'three';
import { HAND_JOINTS, type Handedness, type HandFrame, type Quat, type Vec3 } from '@evolspace/protocol';
import { smoothing, yawOnly } from '../util/math.ts';

export interface HandPoseLite {
  position: Vec3;
  rotation: Quat;
  tracked: boolean;
}

export class AnchorRig {
  /** Rigidly follows the head pose. */
  readonly head = new THREE.Group();
  private handFrames: Partial<Record<Handedness, HandFrame | undefined>> = {};
  private handPoses: Partial<Record<Handedness, HandPoseLite | undefined>> = {};
  private handGroups = new Map<string, { group: THREE.Group; hand: Handedness; jointIndex: number }>();

  constructor(private root: THREE.Object3D) {
    this.head.name = 'anchor:head';
    root.add(this.head);
  }

  setHead(position: Vec3, rotation: Quat): void {
    this.head.position.set(position[0], position[1], position[2]);
    this.head.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
  }

  setHandPose(hand: Handedness, pose: HandPoseLite | undefined): void {
    this.handPoses[hand] = pose;
  }

  setHandFrame(hand: Handedness, frame: HandFrame | undefined): void {
    this.handFrames[hand] = frame;
  }

  /** Frame for a hand joint (default wrist). Hidden while that hand is untracked. */
  handGroup(hand: Handedness, joint = 'wrist'): THREE.Group {
    const key = `${hand}:${joint}`;
    let g = this.handGroups.get(key);
    if (!g) {
      const idx = Math.max(0, (HAND_JOINTS as readonly string[]).indexOf(joint));
      g = { group: new THREE.Group(), hand, jointIndex: idx };
      g.group.name = `anchor:${key}`;
      g.group.visible = false;
      this.root.add(g.group);
      this.handGroups.set(key, g);
    }
    return g.group;
  }

  /** Pose all hand frames from the latest data. Call once per frame. */
  update(): void {
    for (const g of this.handGroups.values()) {
      const frame = this.handFrames[g.hand];
      if (frame && frame.joints.length >= (g.jointIndex + 1) * 7) {
        const o = g.jointIndex * 7;
        const j = frame.joints;
        g.group.position.set(j[o], j[o + 1], j[o + 2]);
        g.group.quaternion.set(j[o + 3], j[o + 4], j[o + 5], j[o + 6]);
        g.group.visible = true;
        continue;
      }
      const pose = this.handPoses[g.hand];
      if (pose && pose.tracked && g.jointIndex === 0) {
        g.group.position.set(pose.position[0], pose.position[1], pose.position[2]);
        g.group.quaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
        g.group.visible = true;
      } else {
        g.group.visible = false;
      }
    }
  }

  dispose(): void {
    this.root.remove(this.head);
    for (const g of this.handGroups.values()) this.root.remove(g.group);
    this.handGroups.clear();
  }
}

export interface LazyFollowOptions {
  /** Start re-centering when the content is more than this many degrees off the view center. */
  angleDeg?: number;
  /** …or when the follow frame drifted this far (m) from the head (user walked away). */
  maxDrift?: number;
  /** Smoothing rate (1/s) while re-centering. */
  rate?: number;
}

/**
 * A frame that tracks the head lazily: it stays put while the content is
 * comfortably in view and glides back (position + yaw only, so panels stay
 * upright) once it drifts out. Content is placed relative to `frame`.
 */
export class LazyFollower {
  readonly frame = new THREE.Group();
  private initialized = false;
  private recentering = false;
  private readonly cosThreshold: number;
  private readonly maxDrift: number;
  private readonly rate: number;

  constructor(opts: LazyFollowOptions = {}) {
    this.frame.name = 'anchor:lazy';
    this.cosThreshold = Math.cos(((opts.angleDeg ?? 32) * Math.PI) / 180);
    this.maxDrift = opts.maxDrift ?? 0.35;
    this.rate = opts.rate ?? 4;
  }

  /** Jump to the target on the next update (e.g. when a panel is opened). */
  snap(): void {
    this.initialized = false;
  }

  get moving(): boolean {
    return this.recentering;
  }

  /**
   * @param headPos / headQuat head pose in the frame's parent coordinates
   * @param offset content position relative to the frame (where it should sit in front of the user)
   */
  update(headPos: THREE.Vector3, headQuat: THREE.Quaternion, offset: THREE.Vector3, dt: number): void {
    yawOnly(headQuat, _targetQ);
    if (!this.initialized) {
      this.frame.position.copy(headPos);
      this.frame.quaternion.copy(_targetQ);
      this.initialized = true;
      this.recentering = false;
      return;
    }
    if (!this.recentering) {
      _content.copy(offset).applyQuaternion(this.frame.quaternion).add(this.frame.position);
      _dir.subVectors(_content, headPos);
      const len = _dir.length();
      _fwd.set(0, 0, -1).applyQuaternion(headQuat);
      const offAxis = len > 1e-3 && _dir.dot(_fwd) / len < this.cosThreshold;
      const drifted = this.frame.position.distanceTo(headPos) > this.maxDrift;
      if (offAxis || drifted) this.recentering = true;
    }
    if (this.recentering) {
      const a = smoothing(this.rate, dt);
      this.frame.position.lerp(headPos, a);
      this.frame.quaternion.slerp(_targetQ, a);
      if (this.frame.position.distanceTo(headPos) < 0.01 && this.frame.quaternion.angleTo(_targetQ) < 0.02) {
        this.recentering = false;
      }
    }
  }
}

const _targetQ = new THREE.Quaternion();
const _content = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
