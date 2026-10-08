// Pure camera math for the mirror (no DOM; unit-tested under Node).
//
// Conventions (space coordinates = three.js world coordinates in the mirror,
// because the mirror never moves the runtime's root group):
// - `direction` in entity/widget views points FROM the subject TOWARD the
//   camera, i.e. [0, 0, 1] looks at the subject's front from +Z.
// - FOVs are vertical, in degrees.
import * as THREE from 'three';
import type { Quat, UserPose, Vec3 } from '@evolspace/protocol';

export const DEFAULT_USER_FOV = 90;
export const DEFAULT_CAMERA_FOV = 60;
export const DEFAULT_FRAMING_FOV = 40;
export const DEFAULT_PADDING = 0.15;

export interface CameraPlacement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  near: number;
  far: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Orientation that makes a camera at `from` look at `to` (three cameras look down -Z). */
export function lookRotation(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const dir = to.clone().sub(from);
  if (dir.lengthSq() < 1e-12) return new THREE.Quaternion();
  dir.normalize();
  // Avoid a degenerate basis when looking straight up/down.
  const up = Math.abs(dir.dot(UP)) > 0.999 ? new THREE.Vector3(0, 0, dir.y > 0 ? 1 : -1) : UP;
  const m = new THREE.Matrix4().lookAt(from, to, up);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export function userCamera(pose: UserPose): CameraPlacement {
  const [x, y, z] = pose.head.position;
  const [qx, qy, qz, qw] = pose.head.rotation;
  return {
    position: new THREE.Vector3(x, y, z),
    quaternion: new THREE.Quaternion(qx, qy, qz, qw).normalize(),
    fov: pose.fov && pose.fov > 1 && pose.fov < 179 ? pose.fov : DEFAULT_USER_FOV,
    near: 0.02,
    far: 500,
  };
}

/**
 * Explicit camera. Orientation precedence: rotation > lookAt > `fallbackTarget`
 * (the centre of the scene's content, if any) > looking down -Z.
 */
export function explicitCamera(
  view: { position: Vec3; lookAt?: Vec3; rotation?: Quat; fov?: number },
  fallbackTarget: THREE.Vector3 | null,
): CameraPlacement {
  const position = new THREE.Vector3(...view.position);
  let quaternion: THREE.Quaternion;
  if (view.rotation) quaternion = new THREE.Quaternion(...view.rotation).normalize();
  else if (view.lookAt) quaternion = lookRotation(position, new THREE.Vector3(...view.lookAt));
  else if (fallbackTarget && fallbackTarget.distanceToSquared(position) > 1e-6) quaternion = lookRotation(position, fallbackTarget);
  else quaternion = new THREE.Quaternion();
  return { position, quaternion, fov: view.fov ?? DEFAULT_CAMERA_FOV, near: 0.02, far: 500 };
}

/**
 * Places a camera so that `box` fills the view, seen from `direction`
 * (subject → camera). `padding` is the fractional margin kept on each side
 * (0.15 = the box spans ~85% of the tighter image dimension).
 *
 * Tight fit: for each of the 8 box corners we compute the minimum camera
 * distance at which the corner projects inside the padded frustum, and take
 * the maximum. This frames flat panels much better than a bounding sphere.
 */
export function frameBox(
  box: THREE.Box3,
  direction: THREE.Vector3,
  opts: { fov?: number; aspect: number; padding?: number },
): CameraPlacement {
  const fov = opts.fov ?? DEFAULT_FRAMING_FOV;
  const padding = opts.padding ?? DEFAULT_PADDING;
  const center = box.getCenter(new THREE.Vector3());
  const dir = direction.lengthSq() > 1e-12 ? direction.clone().normalize() : new THREE.Vector3(0, 0, 1);

  // Camera basis: back = dir (camera looks along -dir), right, up.
  const q = lookRotation(center.clone().add(dir), center);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

  const scale = 1 / (1 + 2 * padding);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * scale;
  const tanH = tanV * opts.aspect;

  let dist = 0;
  let maxBack = 0;
  const size = box.getSize(new THREE.Vector3());
  const radius = size.length() / 2;
  if (radius < 1e-6) {
    dist = 0.5; // degenerate (point) box: arbitrary but sane distance
  } else {
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const x = corner.dot(right);
      const y = corner.dot(up);
      const z = corner.dot(dir); // > 0: closer to the camera than the centre
      maxBack = Math.max(maxBack, z);
      dist = Math.max(dist, z + Math.abs(x) / tanH, z + Math.abs(y) / tanV);
    }
  }
  // Never put the camera inside the box.
  dist = Math.max(dist, maxBack + 0.01);
  const position = center.clone().addScaledVector(dir, dist);
  const near = Math.max(0.005, (dist - radius) * 0.5);
  const far = dist + radius * 4 + 10;
  return { position, quaternion: q, fov, near, far };
}

export function applyPlacement(cam: THREE.PerspectiveCamera, p: CameraPlacement, aspect: number): void {
  cam.position.copy(p.position);
  cam.quaternion.copy(p.quaternion);
  cam.fov = p.fov;
  cam.near = p.near;
  cam.far = p.far;
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

/** A "nice" grid cell size (1/2/5 × 10^n) so a subject of `extent` meters spans ~4–10 cells. */
export function niceGridStep(extent: number): number {
  const raw = Math.max(extent, 1e-3) / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}
