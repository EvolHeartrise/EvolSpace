// Camera tools of the View panel: follow the headset (the desktop camera locks
// to the headset head pose, smoothed, FOV fitted so the headset's whole view
// is visible, with a letterbox frame marking it; Esc / a movement key / a
// look-drag / the wheel exits), a one-shot jump to the headset view, and the
// camera pose as a ScreenshotView 'camera' JSON (space coordinates).

import * as THREE from 'three';
import { signal } from '@preact/signals';
import type { ScreenshotView, UserPose } from '@evolspace/protocol';
import type { DebugContext } from '../../types.ts';

const RAD = Math.PI / 180;

/** Headset head pose (space coords) → world pose through the space root's world matrix. */
export function headsetWorldPose(pose: Pick<UserPose, 'head'>, rootWorld: THREE.Matrix4, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  outPos.fromArray(pose.head.position).applyMatrix4(rootWorld);
  const rq = _q.setFromRotationMatrix(_m.extractRotation(rootWorld));
  outQuat.fromArray(pose.head.rotation).premultiply(rq).normalize();
}
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/**
 * Vertical FOV (deg) for a viewport of `viewAspect` that shows the whole
 * headset view (vertical FOV `headVfov`, aspect `headAspect`): equal when the
 * viewport is wider, larger when it is narrower (so the sides fit).
 */
export function fitFov(headVfov: number, headAspect: number, viewAspect: number): number {
  if (!(headVfov > 0) || !(headAspect > 0) || !(viewAspect > 0)) return headVfov;
  if (viewAspect >= headAspect) return headVfov;
  const tH = Math.tan((headVfov * RAD) / 2) * headAspect; // tan of half the horizontal FOV
  return (2 * Math.atan(tH / viewAspect)) / RAD;
}

/** The headset view's rectangle inside a viewport of w×h px rendered with vertical FOV `camVfov`. */
export function headsetFrameRect(headVfov: number, headAspect: number, camVfov: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const rh = h * Math.tan((headVfov * RAD) / 2) / Math.tan((camVfov * RAD) / 2);
  const rw = rh * headAspect;
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

/** Exponential smoothing factor for a half-life (s); 0 half-life = snap. */
export function smoothK(dt: number, halfLife: number): number {
  return halfLife <= 0 ? 1 : 1 - Math.pow(0.5, dt / halfLife);
}

/** One smoothing step toward the target (in place). */
export function followStep(cur: { p: THREE.Vector3; q: THREE.Quaternion }, target: { p: THREE.Vector3; q: THREE.Quaternion }, dt: number, halfLife: number): void {
  const k = smoothK(dt, halfLife);
  cur.p.lerp(target.p, k);
  cur.q.slerp(target.q, k);
}

/** Camera pose as a ScreenshotView 'camera' (space coords, rounded). */
export function cameraView(camera: THREE.PerspectiveCamera, root: THREE.Object3D): Extract<ScreenshotView, { kind: 'camera' }> {
  camera.updateMatrixWorld();
  root.updateWorldMatrix(true, false);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4().multiplyMatrices(inv, camera.matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const r = (v: number, k = 1000) => Math.round(v * k) / k;
  return { kind: 'camera', position: [r(p.x), r(p.y), r(p.z)], rotation: [r(q.x, 1e5), r(q.y, 1e5), r(q.z, 1e5), r(q.w, 1e5)], fov: r(camera.fov, 10) };
}

export const following = signal(false);
/** Smoothing half-life (s). */
export const followHalfLife = signal(0.12);

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

export class FollowHeadset {
  private readonly cur = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private readonly target = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private readonly fwd = new THREE.Vector3();
  private savedFov: number | null = null;
  private frameEl: HTMLDivElement | null = null;
  private releaseNeed: (() => void) | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly ctx: DebugContext) {
    this.offs.push(ctx.client.onFrame((dt) => this.tick(dt)));
    const onKey = (ev: KeyboardEvent) => {
      if (!following.peek()) return;
      if (ev.key === 'Escape' || MOVE_KEYS.has(ev.code)) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); } // don't also clear the selection
        this.stop();
      }
    };
    const onPointer = (ev: PointerEvent) => { if (following.peek() && (ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.altKey))) this.stop(); };
    const onWheel = () => { if (following.peek()) this.stop(); };
    window.addEventListener('keydown', onKey, true);
    const canvas = ctx.renderer.domElement;
    canvas.addEventListener('pointerdown', onPointer, true);
    canvas.addEventListener('wheel', onWheel, { capture: true, passive: true });
    this.offs.push(() => {
      window.removeEventListener('keydown', onKey, true);
      canvas.removeEventListener('pointerdown', onPointer, true);
      canvas.removeEventListener('wheel', onWheel, true);
    });
  }

  private pose(): UserPose | null {
    return this.ctx.store.userPose.peek();
  }

  start(): boolean {
    if (following.peek()) return true;
    this.releaseNeed = this.ctx.store.need('userPose');
    const cam = this.ctx.camera;
    this.cur.p.copy(cam.position);
    this.cur.q.copy(cam.quaternion);
    this.savedFov = cam.fov;
    following.value = true;
    return true;
  }

  stop(): void {
    if (!following.peek()) return;
    following.value = false;
    const cam = this.ctx.camera;
    if (this.savedFov !== null) { cam.fov = this.savedFov; cam.updateProjectionMatrix(); }
    this.savedFov = null;
    this.syncDesktop(cam.position, this.cur.q);
    this.frameEl?.remove();
    this.frameEl = null;
    this.releaseNeed?.();
    this.releaseNeed = null;
  }

  /** One-shot: put the camera at the headset's eyes (FOV fitted). */
  jump(): boolean {
    const pose = this.pose();
    if (!pose) return false;
    const root = this.ctx.runtime.root;
    root.updateWorldMatrix(true, false);
    headsetWorldPose(pose, root.matrixWorld, this.target.p, this.target.q);
    const cam = this.ctx.camera;
    if (pose.fov) { cam.fov = fitFov(pose.fov, pose.aspect ?? cam.aspect, cam.aspect); cam.updateProjectionMatrix(); }
    this.syncDesktop(this.target.p, this.target.q);
    cam.quaternion.copy(this.target.q);
    return true;
  }

  private syncDesktop(p: THREE.Vector3, q: THREE.Quaternion): void {
    const d = this.ctx.client.desktop;
    this.fwd.set(0, 0, -1).applyQuaternion(q).add(p);
    if (d) d.lookFrom(p, this.fwd);
    else { this.ctx.camera.position.copy(p); this.ctx.camera.quaternion.copy(q); }
  }

  private tick(dt: number): void {
    if (!following.peek()) return;
    const pose = this.pose();
    const cam = this.ctx.camera;
    if (!pose) { this.hideFrame(); return; }
    const root = this.ctx.runtime.root;
    root.updateWorldMatrix(true, false);
    headsetWorldPose(pose, root.matrixWorld, this.target.p, this.target.q);
    followStep(this.cur, this.target, dt, followHalfLife.peek());
    // Keep the fly controls' yaw/pitch in sync (no jump on exit), then apply the full pose (with roll).
    this.syncDesktop(this.cur.p, this.cur.q);
    cam.position.copy(this.cur.p);
    cam.quaternion.copy(this.cur.q);
    if (pose.fov) {
      const fov = fitFov(pose.fov, pose.aspect ?? cam.aspect, cam.aspect);
      if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
      this.showFrame(pose.fov, pose.aspect ?? cam.aspect);
    } else this.hideFrame();
    cam.updateMatrixWorld();
  }

  private showFrame(headVfov: number, headAspect: number): void {
    const host = this.ctx.renderer.domElement.parentElement;
    if (!host) return;
    if (!this.frameEl) {
      this.frameEl = document.createElement('div');
      this.frameEl.className = 'vw-frame';
      this.frameEl.innerHTML = '<span class="tag">Headset view · Esc to exit</span>';
      host.appendChild(this.frameEl);
    }
    const w = host.clientWidth, h = host.clientHeight;
    const r = headsetFrameRect(headVfov, headAspect, this.ctx.camera.fov, w, h);
    const s = this.frameEl.style;
    s.display = 'block';
    s.left = `${r.x.toFixed(1)}px`; s.top = `${r.y.toFixed(1)}px`; s.width = `${r.w.toFixed(1)}px`; s.height = `${r.h.toFixed(1)}px`;
  }

  private hideFrame(): void {
    if (this.frameEl) this.frameEl.style.display = 'none';
  }

  dispose(): void {
    this.stop();
    for (const o of this.offs) o();
  }
}
