// Hand poses and interaction bindings. ONE system drives everything: the
// standard interactions (pinch-grab, ray select, two-hand scale, push-to-talk)
// are just bindings in library/interactions/*.json referencing poses in
// library/poses/*.json, so the agent can redefine any of them.

import type { Handedness, Vec3, Quat } from './scene.ts';

/** The 25 WebXR hand joints, in XRHand iteration order. */
export const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
] as const;
export type HandJoint = (typeof HAND_JOINTS)[number];

/**
 * One tracked hand at one instant, in space coordinates.
 * joints: 25 × [px, py, pz, qx, qy, qz, qw] flattened (length 175), HAND_JOINTS order.
 * radii: 25 joint radii (meters).
 */
export interface HandFrame {
  hand: Handedness;
  joints: number[];
  radii: number[];
}

export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

/**
 * Named scalar features computed from a HandFrame (+ head pose). Poses are
 * conjunctions of ranges over these. Feature names:
 *   curl.<finger>           0 = straight, 1 = fully curled
 *   pinch.<finger>          thumb-tip to <finger>-tip distance in meters (index|middle|ring|pinky)
 *   spread.<a>-<b>          angle in degrees between adjacent finger directions
 *                           (thumb-index | index-middle | middle-ring | ring-pinky)
 *   palm.up                 dot(palm normal, world up)          -1..1
 *   palm.towardHead         dot(palm normal, dir wrist→head)    -1..1
 *   point.forward           dot(index direction, head forward)  -1..1
 *   hands.distance          (two-hand only) wrist-to-wrist distance, meters
 * The input package is the source of truth for exact definitions; it MUST
 * document them in packages/input/FEATURES.md.
 */
export type HandFeatures = Record<string, number>;

export interface FeatureCondition {
  feature: string;
  min?: number;
  max?: number;
}

export interface PoseDef {
  /** = file name in library/poses/<id>.json */
  id: string;
  description: string;
  hand: Handedness | 'either';
  /** All must hold for the pose to be active. */
  conditions: FeatureCondition[];
  /** Pose must hold this long before 'start' fires (debounce). Default 60. */
  enterMs?: number;
  /** Ranges are widened by this fraction while active (hysteresis). Default 0.15. */
  exitSlack?: number;
  source: 'builtin' | 'recorded' | 'manual';
  /** For recorded poses: the per-feature mean/std the conditions were derived from. */
  stats?: Record<string, { mean: number; std: number }>;
}

/** How a binding picks its target entity when its pose starts. */
export type TargetMode =
  | 'ray'    // hand ray (from wrist/index direction) hit
  | 'touch'  // index tip / pinch point within an entity's bounds
  | 'near'   // ray or touch, whichever hits (touch preferred)
  | 'none';  // global, no target

export type InteractionAction =
  /** Entity follows the hand rigidly while the pose holds. */
  | { type: 'grab' }
  /** Two-handed: scale + rotate + translate the target while both hands hold the pose. */
  | { type: 'scale' }
  /** Delivers InteractionEvents (start/move/end) to the widget's onInteraction(handler). */
  | { type: 'widget'; handler: string }
  /** Runs a named client/server command, e.g. 'voice.ptt', 'undo', 'redo', 'agent.panel.toggle', 'select'. */
  | { type: 'command'; command: string; args?: Record<string, unknown> }
  /** Publishes a value to a data channel on start (and `endValue` on end, if given). */
  | { type: 'channel'; channel: string; value: unknown; endValue?: unknown };

export interface InteractionBinding {
  id: string;
  description?: string;
  /** Pose id from library/poses. For two-handed actions both hands must match. */
  pose: string;
  hand?: Handedness | 'either' | 'both';
  target: TargetMode;
  action: InteractionAction;
  /** Higher wins among bindings at the same scope. Scope order always wins first: entity > widget default > global. */
  priority?: number;
}

/** Delivered to WidgetInstance.onInteraction for 'widget' actions and for press/hover. */
export interface InteractionEvent {
  handler: string;
  phase: 'start' | 'move' | 'end' | 'cancel';
  hand: Handedness;
  /** Hit / pinch point in the widget's local coordinates. */
  localPoint: Vec3;
  /** Same point in space coordinates. */
  point: Vec3;
  /** The THREE.Object3D name/uuid that was hit, if any. */
  objectName?: string;
  /** Pointer pose in space coordinates (pinch point + ray direction rotation). */
  pointer: { position: Vec3; rotation: Quat };
}

/** library/interactions/<file>.json */
export interface InteractionSet {
  description: string;
  /** 'global' bindings apply everywhere; 'entity-default' apply to every entity unless overridden or locked. */
  scope: 'global' | 'entity-default';
  bindings: InteractionBinding[];
}

/** Event a client reports when a pose starts/ends (logged; the agent can inspect). */
export interface PoseEvent {
  pose: string;
  hand: Handedness;
  phase: 'start' | 'end';
  t: number;
  /** Binding that fired, if any, and its target. */
  binding?: string;
  target?: string;
}
