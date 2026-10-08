// Debug overlays drawn only into screenshots: entity labels and ghost hands.
// Labels are canvas-texture sprites (no font loading, always legible, drawn on
// top of everything) scaled to a constant on-screen size.
import * as THREE from 'three';
import { HAND_JOINTS, type HandFrame } from '@evolspace/protocol';

export interface LabelSpec {
  /** First line, bold (e.g. entity name or widget id). */
  title: string;
  /** Further lines, dimmer (e.g. "slider · e12"). */
  lines?: string[];
  /** Anchor point in world space (label sits just above it). */
  position: THREE.Vector3;
}

const LABEL_FONT_PX = 26; // canvas resolution; on-screen size is set by `pixelHeight`

export class LabelLayer {
  readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];

  constructor() {
    this.group.name = 'mirror-labels';
  }

  set(labels: LabelSpec[]): void {
    this.clear();
    for (const l of labels) {
      const sprite = makeLabelSprite(l.title, l.lines ?? []);
      sprite.position.copy(l.position);
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
  }

  /** Scales every label so one text line is ~`linePx` pixels tall in a viewport `viewportHeight` px high. */
  fit(camera: THREE.PerspectiveCamera, viewportHeight: number, linePx = 15): void {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    for (const s of this.sprites) {
      const aspect = s.userData.aspect as number;
      const lines = s.userData.lines as number;
      const dist = Math.max(0.01, s.position.distanceTo(camPos));
      const worldPerPx = (2 * dist * tanHalf) / viewportHeight;
      const h = worldPerPx * linePx * lines * 1.35 + worldPerPx * 8;
      s.scale.set(h * aspect, h, 1);
      // Center horizontally, sit above the anchor (sprite center is its middle).
      s.center.set(0.5, -6 / (linePx * lines * 1.35 + 8)); // bottom edge ~6 px above the anchor
    }
  }

  clear(): void {
    for (const s of this.sprites) {
      s.material.map?.dispose();
      s.material.dispose();
      this.group.remove(s);
    }
    this.sprites.length = 0;
  }
}

function makeLabelSprite(title: string, lines: string[]): THREE.Sprite {
  const all = [title, ...lines];
  const pad = 8;
  const lineH = Math.round(LABEL_FONT_PX * 1.35);
  const measure = document.createElement('canvas').getContext('2d')!;
  let w = 0;
  all.forEach((t, i) => {
    measure.font = fontFor(i);
    w = Math.max(w, measure.measureText(t).width);
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w + pad * 2);
  canvas.height = lineH * all.length + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(16, 18, 22, 0.82)';
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 7);
  ctx.stroke();
  ctx.textBaseline = 'top';
  all.forEach((t, i) => {
    ctx.font = fontFor(i);
    ctx.fillStyle = i === 0 ? '#ffffff' : '#a9b4c2';
    ctx.fillText(t, pad, pad + i * lineH + (lineH - LABEL_FONT_PX) / 2);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10_000;
  sprite.userData.aspect = canvas.width / canvas.height;
  sprite.userData.lines = all.length;
  sprite.name = `mirror-label:${title}`;
  return sprite;
}

function fontFor(line: number): string {
  return `${line === 0 ? '600 ' : ''}${LABEL_FONT_PX}px ui-monospace, Consolas, "JetBrains Mono", monospace`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ ghost hands

export interface HandVisualLike {
  update(frame: HandFrame | undefined): void;
}

/** Bones as joint-index pairs (HAND_JOINTS order) for the fallback skeleton. */
const BONES: [number, number][] = (() => {
  const b: [number, number][] = [];
  const chains = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8, 9], [0, 10, 11, 12, 13, 14], [0, 15, 16, 17, 18, 19], [0, 20, 21, 22, 23, 24]];
  for (const c of chains) for (let i = 0; i + 1 < c.length; i++) b.push([c[i], c[i + 1]]);
  return b;
})();

/**
 * Self-contained ghost hand (joint spheres + bone lines). Used when the runtime's
 * createHandVisual is unavailable; the runtime's visual is preferred so
 * screenshots match what the user sees.
 */
export class FallbackHandVisual extends THREE.Group implements HandVisualLike {
  private readonly joints: THREE.InstancedMesh;
  private readonly bones: THREE.LineSegments;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(color = '#9fd3ff') {
    super();
    this.name = 'mirror-ghost-hand';
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false });
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), mat, HAND_JOINTS.length);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(BONES.length * 6), 3));
    this.bones = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    this.add(this.joints, this.bones);
    this.visible = false;
  }

  update(frame: HandFrame | undefined): void {
    if (!frame || frame.joints.length < HAND_JOINTS.length * 7) {
      this.visible = false;
      return;
    }
    this.visible = true;
    for (let i = 0; i < HAND_JOINTS.length; i++) {
      const o = i * 7;
      this.v.set(frame.joints[o], frame.joints[o + 1], frame.joints[o + 2]);
      const r = Math.max(0.004, frame.radii[i] ?? 0.008);
      this.s.set(r, r, r);
      this.m.compose(this.v, this.q, this.s);
      this.joints.setMatrixAt(i, this.m);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    const pos = this.bones.geometry.attributes.position as THREE.BufferAttribute;
    BONES.forEach(([a, b], k) => {
      pos.setXYZ(k * 2, frame.joints[a * 7], frame.joints[a * 7 + 1], frame.joints[a * 7 + 2]);
      pos.setXYZ(k * 2 + 1, frame.joints[b * 7], frame.joints[b * 7 + 1], frame.joints[b * 7 + 2]);
    });
    pos.needsUpdate = true;
    this.bones.geometry.computeBoundingSphere();
    this.joints.computeBoundingSphere();
  }
}
