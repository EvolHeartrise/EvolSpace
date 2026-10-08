// @evolspace/input — hand features, poses, hand rays and the interaction
// engine. Pure TypeScript (no DOM / WebXR / three): imported by the browser
// runtime and by the Node server. See ../README.md and ../FEATURES.md.

export {
  computeFeatures, featureInfo, palmBasis, palmCenter, fingerAngles, thumbAngles, flexionDeg,
  FEATURE_INFO, FEATURE_NAMES, FINGER_JOINT_MAX_DEG, FINGER_CURL_SPAN_DEG, THUMB_JOINT_MAX_DEG, THUMB_CURL_SPAN_DEG,
  type HeadPose, type FeatureInfo, type PalmBasis, type FingerAngles,
} from './features.ts';
export {
  handRay, pinchPoint, contactPoint, rayAnchor, rayRotation, shoulderPosition, OneEuroFilter, RaySmoother,
  DEFAULT_SHOULDER_OFFSET, type Ray, type HandRayOptions, type OneEuroOptions, type RaySmootherOptions,
} from './ray.ts';
export {
  PoseMatcher, matchesPose, conditionHolds, conditionMargin, poseAppliesTo, DEFAULT_ENTER_MS, DEFAULT_EXIT_SLACK, HANDS,
  type PoseTransition, type PoseMatcherOptions, type HandFrames,
} from './matcher.ts';
export { derivePose, featureStats, type DerivePoseOptions, type FeatureStats } from './derive.ts';
export { synthHand, wristRotation, palmNormalOf, HAND_SHAPES, type SynthHandSpec } from './synth.ts';
export {
  InteractionEngine, type Hit, type InteractionHost, type InteractionEngineOptions, type SessionInfo,
} from './engine.ts';
export {
  validatePoseDef, validateInteractionSet, validateInteractionBinding, type ValidationResult,
} from './validate.ts';
export {
  JOINT_INDEX, JOINT_COUNT, JOINT_STRIDE, FINGERS, LONG_FINGERS, FINGER_BASE, jointPos, jointRot, tipIndex, isValidFrame,
} from './joints.ts';
export * as math from './math.ts';
