// In-world performance panel: fps (+ frame time), draw calls, triangles,
// geometries/textures. A CanvasTexture quad redrawn twice per second (cheap:
// one draw call, no font loading), parented to the camera so it is visible in
// both XR (head-locked, lower-left of view) and desktop.

import * as THREE from 'three';

const W = 256, H = 128;

export class PerfOverlay {
  readonly object: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private frames = 0;
  private windowStart = 0;
  private worstMs = 0;
  private lastFrame = 0;
  private stats = { fps: 0, worstMs: 0, calls: 0, triangles: 0, geometries: 0, textures: 0 };

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), mat);
    this.object.name = 'evol.perf';
    this.object.renderOrder = 10_000;
    this.object.frustumCulled = false;
    this.object.position.set(-0.2, 0.1, -0.6); // upper-left of view (the agent orb sits lower-left)
    this.object.visible = false;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  set visible(v: boolean) {
    this.object.visible = v;
  }

  /** Snapshot for tests / __evol.state(). */
  get snapshot(): Readonly<typeof this.stats> {
    return this.stats;
  }

  /**
   * Call once per rendered frame *after* renderer.render (renderer.info holds that frame's counts).
   * @param now ms timestamp
   */
  frame(now: number): void {
    if (this.lastFrame) this.worstMs = Math.max(this.worstMs, now - this.lastFrame);
    this.lastFrame = now;
    this.frames++;
    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed < 500) return;
    const info = this.renderer.info;
    this.stats = {
      fps: (this.frames * 1000) / elapsed,
      worstMs: this.worstMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
    this.frames = 0;
    this.windowStart = now;
    this.worstMs = 0;
    if (this.object.visible) this.draw();
  }

  private draw(): void {
    const c = this.ctx, s = this.stats;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(14,19,27,0.82)';
    roundRect(c, 0, 0, W, H, 14);
    c.fill();
    const fpsColor = s.fps >= 70 ? '#45d49b' : s.fps >= 55 ? '#ffb547' : '#ff5d6c';
    c.font = 'bold 34px ui-monospace, monospace';
    c.fillStyle = fpsColor;
    c.fillText(`${s.fps.toFixed(0)} fps`, 14, 42);
    c.font = '18px ui-monospace, monospace';
    c.fillStyle = '#8d99ab';
    c.fillText(`worst ${s.worstMs.toFixed(1)} ms`, 150, 40);
    c.fillStyle = '#e9eef5';
    c.fillText(`draws ${s.calls}`, 14, 76);
    c.fillText(`tris  ${fmt(s.triangles)}`, 132, 76);
    c.fillText(`geo   ${s.geometries}`, 14, 106);
    c.fillText(`tex   ${s.textures}`, 132, 106);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    (this.object.material as THREE.Material).dispose();
    this.object.geometry.dispose();
    this.object.removeFromParent();
  }
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
