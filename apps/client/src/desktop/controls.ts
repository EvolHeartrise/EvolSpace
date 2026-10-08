// Desktop mode: fly/orbit camera + the mouse acting as the right hand, so the
// whole interaction stack (poses → bindings → grab/scale/widget/command) is
// exercisable without a headset.
//
//   RMB drag            look                 W A S D / Q E   move / down, up (Shift = fast)
//   MMB or Alt+LMB drag orbit around the point under the cursor
//   wheel               dolly (or push/pull the hand while pinching)
//   LMB hold            pinch (grab, press, …, whatever the bindings say)
//   Ctrl+LMB            'select' command on the entity under the cursor
//   V hold              push-to-talk           P perf overlay   H hide page panel
//
// The synthesized right hand sits at arm's length from the (estimated) shoulder
// on the line toward the point under the cursor, with its ray anchor exactly on
// that line, so the engine's Quest-style shoulder→hand ray passes through what
// the mouse points at.

import * as THREE from 'three';
import type { HandFrame, Vec3 } from '@evolspace/protocol';
import { invertPose, transformPoint, transformDirection, type Pose } from '../math/space.ts';

export interface DesktopHandInput {
  synthHand(spec: SynthSpecLike): HandFrame;
  /** The input package's shoulder estimate (origin of the shoulder→hand ray direction). */
  shoulderPosition(hand: 'left' | 'right', head: Pose): Vec3;
  /** The point on the hand the engine's ray passes through. */
  rayAnchor(frame: HandFrame): Vec3;
}

/** The subset of the input package's SynthHandSpec the desktop hand uses. */
export interface SynthSpecLike {
  hand: 'left' | 'right';
  position?: Vec3;
  rotation?: [number, number, number, number];
  curl?: Partial<Record<'thumb' | 'index' | 'middle' | 'ring' | 'pinky', number>>;
  spread?: number;
  thumbSpread?: number;
  pinch?: 'index' | 'middle' | 'ring' | 'pinky';
}

export interface DesktopDeps {
  input: DesktopHandInput;
  /** Current space origin pose in world (camera is in world, everything else in space). */
  origin(): Pose;
  /** Raycast in space coordinates against the scene. */
  raycast(origin: Vec3, dir: Vec3): { entity: string; point: Vec3; distance: number } | null;
  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void;
  ptt(phase: 'start' | 'end'): void;
  key?(key: string): void;
}

const RELAXED: Partial<SynthSpecLike> = { curl: { thumb: 0.15, index: 0.12, middle: 0.22, ring: 0.28, pinky: 0.32 }, spread: 6, thumbSpread: 25 };
const PINCHING: Partial<SynthSpecLike> = { pinch: 'index', curl: { middle: 0.2, ring: 0.28, pinky: 0.32 }, spread: 6 };

const ARM_MIN = 0.15, ARM_MAX = 0.75, ARM_DEFAULT = 0.45;

export class DesktopControls {
  enabled = true;
  /** Mouse is over the canvas → the desktop hand is "tracked". */
  hovering = false;
  pinching = false;
  readonly speed = { normal: 2.0, fast: 6.0 };
  /**
   * Extra keyboard filter: return true to ignore a key event (the debug
   * dashboard ignores keys while focus is in one of its form controls).
   * Text entry anywhere is always ignored.
   */
  keyFilter: ((ev: KeyboardEvent) => boolean) | null = null;

  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private ndc = new THREE.Vector2();
  private drag: { mode: 'look' | 'orbit'; x: number; y: number; pivot: THREE.Vector3; dist: number } | null = null;
  private armLength = ARM_DEFAULT;
  /** While pinching: depth (m from camera) of the grabbed point along the mouse ray. */
  private grabDepth = 0;
  private selecting = false;
  private pttHeld = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly dom: HTMLElement, private readonly camera: THREE.PerspectiveCamera, private readonly deps: DesktopDeps) {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    this.listen(dom, 'contextmenu', (ev) => ev.preventDefault());
    this.listen(dom, 'pointerdown', (ev) => this.onDown(ev as PointerEvent));
    this.listen(window, 'pointerup', (ev) => this.onUp(ev as PointerEvent));
    this.listen(window, 'pointermove', (ev) => this.onMove(ev as PointerEvent));
    this.listen(dom, 'pointerenter', () => { this.hovering = true; });
    this.listen(dom, 'pointerleave', () => { if (!this.pinching) this.hovering = false; });
    this.listen(dom, 'wheel', (ev) => this.onWheel(ev as WheelEvent), { passive: false });
    this.listen(window, 'keydown', (ev) => this.onKey(ev as KeyboardEvent, true));
    this.listen(window, 'keyup', (ev) => this.onKey(ev as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.releaseAll());
  }

  dispose(): void {
    this.releaseAll();
    for (const d of this.disposers) d();
  }

  /** Per-frame camera motion (world coordinates). */
  update(dt: number): void {
    if (!this.enabled) return;
    const k = this.keys;
    const v = new THREE.Vector3(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
      (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0),
    );
    if (v.lengthSq() > 0) {
      const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? this.speed.fast : this.speed.normal;
      v.normalize().multiplyScalar(speed * dt);
      // Horizontal motion follows yaw only (no flying into the floor when looking down).
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      const horiz = new THREE.Vector3(v.x, 0, v.z).applyQuaternion(yawQ);
      this.camera.position.add(horiz).add(new THREE.Vector3(0, v.y, 0));
    }
    this.applyRotation();
  }

  /**
   * The mouse-driven right hand in space coordinates, or null when the mouse is
   * outside the canvas.
   */
  hand(): HandFrame | null {
    if (!this.enabled || !this.hovering || this.drag) return null;
    const inv = invertPose(this.deps.origin());
    const head = this.headInSpace(inv);
    const { origin: rayO, dir } = this.mouseRay(inv);

    let target: Vec3;
    if (this.pinching) {
      target = [rayO[0] + dir[0] * this.grabDepth, rayO[1] + dir[1] * this.grabDepth, rayO[2] + dir[2] * this.grabDepth];
    } else {
      const hit = this.deps.raycast(rayO, dir);
      const depth = hit ? Math.max(0.2, hit.distance) : 3;
      target = [rayO[0] + dir[0] * depth, rayO[1] + dir[1] * depth, rayO[2] + dir[2] * depth];
      this.grabDepth = depth;
    }
    return this.placeHand(head, target);
  }

  /** Camera pose in space coordinates. */
  headInSpace(inv: Pose): Pose {
    const p = this.camera.getWorldPosition(new THREE.Vector3());
    const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const world: Pose = { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
    const pos = transformPoint(inv, world.position);
    const rot = new THREE.Quaternion(...inv.rotation).multiply(q);
    return { position: pos, rotation: [rot.x, rot.y, rot.z, rot.w] };
  }

  private mouseRay(inv: Pose): { origin: Vec3; dir: Vec3 } {
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    return { origin: transformPoint(inv, [o.x, o.y, o.z]), dir: transformDirection(inv, [d.x, d.y, d.z]) };
  }

  private placeHand(head: Pose, target: Vec3): HandFrame {
    return placeDesktopHand(this.deps.input, head, target, this.armLength, this.pinching);
  }

  // ------------------------------------------------------------------ events

  private onDown(ev: PointerEvent): void {
    if (!this.enabled) return;
    this.updateNdc(ev);
    this.hovering = true;
    const orbit = ev.button === 1 || (ev.button === 0 && ev.altKey);
    if (ev.button === 2 || orbit) {
      ev.preventDefault();
      const pivot = this.pivotUnderCursor();
      this.drag = { mode: orbit ? 'orbit' : 'look', x: ev.clientX, y: ev.clientY, pivot, dist: pivot.distanceTo(this.camera.position) };
      this.dom.setPointerCapture?.(ev.pointerId);
      return;
    }
    if (ev.button !== 0) return;
    this.dom.setPointerCapture?.(ev.pointerId);
    if (ev.ctrlKey || ev.metaKey) {
      // Select: a command on the entity under the cursor, not a pinch.
      const { origin, dir } = this.mouseRay(invertPose(this.deps.origin()));
      const hit = this.deps.raycast(origin, dir);
      this.selecting = true;
      this.deps.runCommand('select', { entity: hit?.entity ?? null }, 'start');
      return;
    }
    this.pinching = true;
  }

  private onUp(ev: PointerEvent): void {
    if (this.drag && (ev.button === 2 || ev.button === 1 || ev.button === 0)) {
      this.drag = null;
      return;
    }
    if (ev.button !== 0) return;
    if (this.selecting) {
      this.selecting = false;
      this.deps.runCommand('select', undefined, 'end');
    }
    this.pinching = false;
  }

  private onMove(ev: PointerEvent): void {
    if (!this.enabled) return;
    const d = this.drag;
    if (d) {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      d.x = ev.clientX; d.y = ev.clientY;
      this.yaw -= dx * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.004, -1.55, 1.55);
      this.applyRotation();
      if (d.mode === 'orbit') {
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion).multiplyScalar(d.dist);
        this.camera.position.copy(d.pivot).add(back);
      }
      return;
    }
    if (ev.target === this.dom || this.pinching) this.updateNdc(ev);
  }

  private onWheel(ev: WheelEvent): void {
    if (!this.enabled) return;
    ev.preventDefault();
    const notches = Math.sign(ev.deltaY) * Math.min(3, Math.abs(ev.deltaY) / 100 || 1);
    if (this.pinching) {
      this.armLength = THREE.MathUtils.clamp(this.armLength - notches * 0.03, ARM_MIN, ARM_MAX);
    } else {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(fwd, -notches * 0.3);
    }
  }

  private onKey(ev: KeyboardEvent, down: boolean): void {
    // Text entry swallows keys; checkboxes/buttons (the page panel) must not.
    if (isTextEntry(ev.target)) return;
    if (down && this.keyFilter?.(ev)) return;
    if (down) this.keys.add(ev.code); else this.keys.delete(ev.code);
    if (ev.code === 'KeyV') {
      if (down && !ev.repeat && !this.pttHeld) { this.pttHeld = true; this.deps.ptt('start'); }
      if (!down && this.pttHeld) { this.pttHeld = false; this.deps.ptt('end'); }
      return;
    }
    if (down && !ev.repeat && (ev.code === 'KeyP' || ev.code === 'KeyH')) this.deps.key?.(ev.code);
  }

  private releaseAll(): void {
    this.keys.clear();
    this.drag = null;
    if (this.pttHeld) { this.pttHeld = false; this.deps.ptt('end'); }
    if (this.selecting) { this.selecting = false; this.deps.runCommand('select', undefined, 'end'); }
    this.pinching = false;
  }

  // ------------------------------------------------------------------ helpers

  private pivotUnderCursor(): THREE.Vector3 {
    const inv = invertPose(this.deps.origin());
    const { origin, dir } = this.mouseRay(inv);
    const hit = this.deps.raycast(origin, dir);
    const dist = hit ? hit.distance : 2;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray.at(dist, new THREE.Vector3());
  }

  private updateNdc(ev: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private applyRotation(): void {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /**
   * Place the camera at `position` looking at `target` (world coordinates), no
   * roll. Keeps yaw/pitch in sync so the fly controls continue from there.
   */
  lookFrom(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): void {
    this.camera.position.set(position.x, position.y, position.z);
    const dx = target.x - position.x, dy = target.y - position.y, dz = target.z - position.z;
    if (dx * dx + dy * dy + dz * dz > 1e-12) {
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = THREE.MathUtils.clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.55, 1.55);
    }
    this.applyRotation();
  }

  /** Re-sync yaw/pitch after the camera was moved externally (e.g. leaving XR). */
  syncFromCamera(): void {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  private listen(t: EventTarget, type: string, fn: (ev: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn, opts));
  }
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True for elements where typing produces text (keyboard shortcuts must not fire there). */
export function isTextEntry(target: EventTarget | null): boolean {
  const t = target as (HTMLElement & { type?: string }) | null;
  if (!t || typeof t.tagName !== 'string') return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(String(t.type ?? 'text').toLowerCase());
}

// ------------------------------------------------------------------ small vector helpers

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Synthesize a right hand at `armLength` from the estimated shoulder whose
 * shoulder→anchor ray (the engine's hand-ray model) passes through `target`.
 * All coordinates in space frame.
 */
export function placeDesktopHand(input: DesktopHandInput, head: Pose, target: Vec3, armLength: number, pinching: boolean): HandFrame {
  const shoulder = input.shoulderPosition('right', head);
  const dir = norm(sub(target, shoulder));
  const anchorAt: Vec3 = [shoulder[0] + dir[0] * armLength, shoulder[1] + dir[1] * armLength, shoulder[2] + dir[2] * armLength];
  const shape = pinching ? PINCHING : RELAXED;
  const atOrigin = input.synthHand({ hand: 'right', ...shape, position: [0, 0, 0], rotation: fingersForward(dir) });
  const a = input.rayAnchor(atOrigin);
  return translateFrame(atOrigin, [anchorAt[0] - a[0], anchorAt[1] - a[1], anchorAt[2] - a[2]]);
}

/**
 * Wrist rotation (WebXR joint convention: -Z along the fingers, +Y back of the
 * hand) for fingers pointing along `dir` with the palm facing down-ish.
 */
export function fingersForward(dir: Vec3): [number, number, number, number] {
  const z = new THREE.Vector3(-dir[0], -dir[1], -dir[2]).normalize();
  const up = Math.abs(z.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const y = up.sub(z.clone().multiplyScalar(up.dot(z))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
}

/** Copy of a frame translated by `d` (positions only). */
export function translateFrame(f: HandFrame, d: Vec3): HandFrame {
  const joints = f.joints.slice();
  for (let o = 0; o < joints.length; o += 7) {
    joints[o] += d[0]; joints[o + 1] += d[1]; joints[o + 2] += d[2];
  }
  return { hand: f.hand, joints, radii: f.radii.slice() };
}
