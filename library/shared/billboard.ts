// Billboarding: turn an object to face the viewer, using the camera that is
// actually rendering (XR eye camera, desktop camera or the mirror's camera).
//
// Implemented with onBeforeRender on the object's renderables, computed once
// per rendered frame (both XR eyes share one orientation → no stereo
// mismatch). Allocation-free per frame.

import type * as THREE from 'three';

export type BillboardMode = 'off' | 'yaw' | 'full';
export const BILLBOARD_MODES = ['off', 'yaw', 'full'] as const;

export class Billboard {
  private lastFrame = -1;
  private target: THREE.Vector3;
  private hooked: Array<{ o: THREE.Object3D; own: boolean; orig: THREE.Object3D['onBeforeRender'] }> = [];

  constructor(T: typeof THREE, private pivot: THREE.Object3D, private mode: BillboardMode = 'yaw') {
    this.target = new T.Vector3();
  }

  setMode(mode: BillboardMode): void {
    this.mode = mode;
    if (mode === 'off') this.pivot.quaternion.identity();
    this.refresh();
  }

  /**
   * (Re)attach to every renderable under the pivot. Call after adding/removing children.
   * Existing onBeforeRender hooks are CHAINED, never replaced: troika Text does
   * its per-frame material setup there, and replacing it makes text invisible.
   */
  attach(): void {
    this.detach();
    const self = this;
    this.pivot.traverse((o) => {
      const r = o as THREE.Mesh;
      if (!(r.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints)) return;
      const own = Object.prototype.hasOwnProperty.call(o, 'onBeforeRender');
      const orig = o.onBeforeRender;
      o.onBeforeRender = function (this: THREE.Object3D, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ...rest: unknown[]) {
        self.face(renderer, camera);
        (orig as (...a: unknown[]) => void).call(this, renderer, scene, camera, ...rest);
      } as THREE.Object3D['onBeforeRender'];
      this.hooked.push({ o, own, orig });
    });
  }

  /** attach() when billboarding is on, detach() when off. Call after (re)building the pivot's children. */
  refresh(): void {
    if (this.mode === 'off') this.detach();
    else this.attach();
  }

  /** Remove the hooks, restoring whatever was there before. */
  detach(): void {
    for (const { o, own, orig } of this.hooked) {
      if (own) o.onBeforeRender = orig;
      else delete (o as { onBeforeRender?: unknown }).onBeforeRender; // falls back to the prototype method
    }
    this.hooked.length = 0;
  }

  /** Orient toward a camera now (also used by tests). `frame` dedups multiple calls per rendered frame. */
  face(renderer: { info?: { render?: { frame?: number } } } | null, camera: THREE.Camera): void {
    if (this.mode === 'off') return;
    const frame = renderer?.info?.render?.frame ?? -2;
    if (frame >= 0 && frame === this.lastFrame) return;
    this.lastFrame = frame;
    const e = camera.matrixWorld.elements;
    this.target.set(e[12], e[13], e[14]);
    const pivot = this.pivot;
    pivot.parent?.updateWorldMatrix(true, false);
    if (this.mode === 'yaw') {
      // Same height as the pivot → +Z turns only around world up.
      const pe = pivot.matrixWorld.elements;
      pivot.updateWorldMatrix(false, false);
      this.target.y = pe[13];
    }
    pivot.lookAt(this.target);
    pivot.updateMatrixWorld(true);
  }
}

