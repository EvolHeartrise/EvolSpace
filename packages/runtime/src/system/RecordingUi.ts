// Pose-recording countdown UI, driven by the server's pose.record message.
// The runtime only shows the UI and announces phases; the client does the
// actual sampling via `onPhase`:
//   'countdown'  get ready (N, N-1, … 1)
//   'recording'  start sampling hand features now
//   'done'       stop sampling, send pose.recording {requestId, name, hand, frames}
//   'cancelled'  stop sampling, discard
// Phase timing advances in update(dt), i.e. with the render loop.

import * as THREE from 'three';
import type { ServerMessage } from '@evolspace/protocol';
import type { RuntimeText, RuntimeUiKit } from '../ui/UiKit.ts';

export type RecordRequest = Extract<ServerMessage, { type: 'pose.record' }>;
export type RecordPhase = 'countdown' | 'recording' | 'done' | 'cancelled';
export type RecordPhaseListener = (phase: RecordPhase, req: RecordRequest) => void;

const RING_R = 0.05;

export class RecordingUi {
  readonly group = new THREE.Group();
  private req: RecordRequest | null = null;
  private phase: RecordPhase | null = null;
  private clock = 0;
  private listeners = new Set<RecordPhaseListener>();
  private big: RuntimeText;
  private caption: RuntimeText;
  private ringBg: THREE.Mesh;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private lastShown = '';
  private doneHold = 0;

  constructor(private ui: RuntimeUiKit) {
    this.group.name = 'recording-ui';
    this.group.visible = false;
    const th = ui.theme;
    const bg = ui.panel(0.3, 0.17, { radius: 0.016 });
    this.ringBg = new THREE.Mesh(new THREE.RingGeometry(RING_R * 0.9, RING_R, 64), ui.material(th.border, { doubleSide: true }));
    this.ringBg.position.set(0, 0.018, 0.001);
    this.ringMat = new THREE.MeshBasicMaterial({ color: th.negative, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(RING_R * 0.9, RING_R, 64, 1, Math.PI / 2, Math.PI * 2), this.ringMat);
    this.ring.position.copy(this.ringBg.position).setZ(0.002);
    this.big = ui.textEx('', { size: 0.04, weight: 'semibold', anchorX: 'center', anchorY: 'middle', color: th.text });
    this.big.position.set(0, 0.018, 0.003);
    this.caption = ui.textEx('', { size: 0.012, anchorX: 'center', anchorY: 'middle', color: th.textDim, maxWidth: 0.27, textAlign: 'center' });
    this.caption.position.set(0, -0.058, 0.002);
    this.group.add(bg, this.ringBg, this.ring, this.big, this.caption);
    this.group.traverse((o) => { o.raycast = () => {}; });
  }

  onPhase(cb: RecordPhaseListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  get active(): boolean {
    return this.req !== null && (this.phase === 'countdown' || this.phase === 'recording');
  }

  get currentPhase(): RecordPhase | null {
    return this.phase;
  }

  get request(): RecordRequest | null {
    return this.req;
  }

  start(req: RecordRequest): void {
    if (this.active && this.req) this.emit('cancelled', this.req);
    this.req = req;
    this.clock = 0;
    this.lastShown = '';
    this.group.visible = true;
    this.setPhase(req.countdown > 0 ? 'countdown' : 'recording');
  }

  cancel(): void {
    if (!this.req || !this.active) return;
    this.setPhase('cancelled');
    this.finish(1);
  }

  private setPhase(p: RecordPhase): void {
    this.phase = p;
    if (this.req) this.emit(p, this.req);
  }

  private emit(p: RecordPhase, req: RecordRequest): void {
    for (const cb of [...this.listeners]) {
      try { cb(p, req); } catch (err) { console.error('recording phase listener threw', err); }
    }
  }

  private finish(holdSeconds: number): void {
    this.doneHold = holdSeconds;
  }

  update(dt: number): void {
    const req = this.req;
    if (!req) return;
    const th = this.ui.theme;
    this.clock += dt;
    if (this.phase === 'countdown') {
      const left = req.countdown - this.clock;
      if (left <= 0) {
        this.clock = 0;
        this.setPhase('recording');
      } else {
        this.show(String(Math.ceil(left)), `Get ready: “${req.name}” (${req.hand} hand)`);
        this.ringMat.color.set(th.accent);
        this.setRing(1 - (left % 1));
      }
    }
    if (this.phase === 'recording') {
      const p = req.seconds > 0 ? this.clock / req.seconds : 1;
      if (p >= 1) {
        this.setPhase('done');
        this.finish(1.2);
      } else {
        this.show('REC', `Hold the pose · ${Math.max(0, req.seconds - this.clock).toFixed(1)}s`);
        this.ringMat.color.set(th.negative);
        this.setRing(p);
      }
    }
    if (this.phase === 'done' || this.phase === 'cancelled') {
      this.show(this.phase === 'done' ? 'Done' : 'Cancelled', this.phase === 'done' ? `Recorded “${req.name}”` : '');
      this.setRing(this.phase === 'done' ? 1 : 0);
      this.ringMat.color.set(this.phase === 'done' ? th.positive : th.textDim);
      this.doneHold -= dt;
      if (this.doneHold <= 0) {
        this.req = null;
        this.phase = null;
        this.group.visible = false;
      }
    }
  }

  private show(big: string, caption: string): void {
    const key = big + '|' + caption;
    if (key === this.lastShown) return;
    this.lastShown = key;
    this.big.set(big);
    this.caption.set(caption);
  }

  private setRing(p: number): void {
    // Sweep the progress arc via the draw range: RingGeometry with one phi
    // segment emits 6 indices per theta segment, in angular order.
    const idx = this.ring.geometry.index;
    const total = idx ? idx.count : 64 * 6;
    const n = Math.max(0, Math.min(total, Math.round((total * Math.max(0, Math.min(1, p))) / 6) * 6));
    this.ring.geometry.setDrawRange(0, n);
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.ringBg.geometry.dispose();
    this.ringMat.dispose();
    this.big.dispose();
    this.caption.dispose();
  }
}
