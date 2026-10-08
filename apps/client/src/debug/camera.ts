// Desktop camera helpers for the debug dashboard: animated framing of an
// entity (keeps the current viewing direction) and spawn placement in front of
// the camera. The camera lives in world coordinates; entities in space
// coordinates (runtime.root = space origin).

import * as THREE from 'three';
import type { Transform } from '@evolspace/protocol';
import type { DebugClientPort } from './types.ts';
import type { StoreCamera } from './store.ts';

/**
 * Camera position that frames a bounding sphere (center, radius) along the
 * viewing direction `forward` (unit), for a vertical FOV (deg) and aspect.
 */
export function framePosition(center: THREE.Vector3, radius: number, forward: THREE.Vector3, fovDeg: number, aspect: number, padding = 1.35): THREE.Vector3 {
  const vfov = THREE.MathUtils.degToRad(fovDeg);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const half = Math.min(vfov, hfov) / 2;
  const r = Math.max(radius, 0.05);
  const dist = Math.max(0.25, (r * padding) / Math.sin(half));
  return center.clone().addScaledVector(forward, -dist);
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class DebugCamera implements StoreCamera {
  private anim: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t0: number; ms: number } | null = null;
  private readonly off: () => void;

  constructor(private readonly client: DebugClientPort) {
    this.off = client.onFrame((_dt, tMs) => this.tick(tMs));
  }

  dispose(): void {
    this.off();
  }

  /** Fly to frame an entity subtree. False when it has no bounds (yet). */
  frame(id: string): boolean {
    const box = this.client.runtime.frameEntity(id);
    if (!box || box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = this.client.camera;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const to = framePosition(sphere.center, sphere.radius, forward, cam.fov, cam.aspect);
    this.flyTo(to, sphere.center);
    return true;
  }

  /** Fly to frame several entities (default: every root). False when nothing has bounds. */
  frameAll(ids?: string[]): boolean {
    const rt = this.client.runtime;
    const list = ids ?? Object.values(rt.sceneState.entities).filter((e) => !e.parent).map((e) => e.id);
    const box = new THREE.Box3();
    for (const id of list) {
      const b = rt.frameEntity(id);
      if (b && !b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = this.client.camera;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.flyTo(framePosition(sphere.center, sphere.radius, forward, cam.fov, cam.aspect, 1.1), sphere.center);
    return true;
  }

  /** Animate the camera to `position` looking at `target` (world coords). */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, ms = 380): void {
    const cam = this.client.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const dist = Math.max(0.5, cam.position.distanceTo(target));
    this.anim = {
      from: cam.position.clone(), to: position.clone(),
      fromTarget: cam.position.clone().addScaledVector(fwd, dist), toTarget: target.clone(),
      t0: performance.now(), ms,
    };
  }

  private tick(_tMs: number): void {
    const a = this.anim;
    if (!a) return;
    const k = Math.min(1, (performance.now() - a.t0) / a.ms);
    const e = easeInOut(k);
    const p = a.from.clone().lerp(a.to, e);
    const t = a.fromTarget.clone().lerp(a.toTarget, e);
    this.look(p, t);
    if (k >= 1) this.anim = null;
  }

  private look(position: THREE.Vector3, target: THREE.Vector3): void {
    const d = this.client.desktop;
    if (d) d.lookFrom(position, target);
    else {
      this.client.camera.position.copy(position);
      this.client.camera.lookAt(target);
    }
  }

  /** ~`distance` m in front of the camera (space coords), yawed to face it. */
  spawnTransform(distance = 1.2): Transform {
    const cam = this.client.camera;
    cam.updateMatrixWorld();
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    const worldPos = camPos.clone().addScaledVector(fwd, distance);
    const yaw = Math.atan2(camPos.x - worldPos.x, camPos.z - worldPos.z); // +Z of the entity faces the camera
    const worldQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const root = this.client.runtime.root;
    root.updateWorldMatrix(true, false);
    const local = root.worldToLocal(worldPos.clone());
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const q = rootQ.invert().multiply(worldQ);
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      position: [r(local.x), r(local.y), r(local.z)],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [1, 1, 1],
    };
  }
}
