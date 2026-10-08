// Hand-ray visuals: a thin tapered beam from the pinch origin, a cursor dot at
// the hit point (constant apparent size), and a subtle bracket highlight on
// the hovered entity. Everything lives under the space root, in space coords.
//
// Two inputs per hand, kept apart on purpose:
//   ray hit  (setRays ← engine.rays())     → beam length + cursor dot
//   hover    (setHover ← host.hover())     → highlight / 'select' target; the
//            engine reports the near target there (touch preferred over ray).
// Without an engine calling hover(), the ray hit doubles as the hover target.

import * as THREE from 'three';
import type { Handedness, Theme } from '@evolspace/protocol';
import type { Hit, PointerRays } from './types.ts';
import { unitSphereGeometry } from '../ui/geometry.ts';
import { BoundsOutline } from '../ui/BoundsOutline.ts';

const IDLE_LENGTH = 0.3;
const HANDS: Handedness[] = ['left', 'right'];

interface HandVis {
  beam: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  dot: THREE.Mesh;
  dotMat: THREE.MeshBasicMaterial;
  /** From host.hover() (undefined = never reported → fall back to the ray hit). */
  hover: Hit | null | undefined;
  rayHit: Hit | null;
  ray: { origin: THREE.Vector3; dir: THREE.Vector3; valid: boolean };
}

export class PointerVisuals {
  readonly group = new THREE.Group();
  readonly highlight: BoundsOutline;
  private hands = new Map<Handedness, HandVis>();
  private readonly cAccent: THREE.Color;
  private readonly cText: THREE.Color;
  private readonly cDim: THREE.Color;

  constructor(theme: Theme) {
    this.group.name = 'pointer-visuals';
    this.cAccent = new THREE.Color(theme.accent);
    this.cText = new THREE.Color(theme.text);
    this.cDim = new THREE.Color(theme.textDim);
    // Unit-length beam along +Y, base at origin; scaled to length per frame.
    const beamGeom = new THREE.CylinderGeometry(0.0007, 0.0018, 1, 6, 1, true).translate(0, 0.5, 0);
    for (const h of HANDS) {
      const beamMat = new THREE.MeshBasicMaterial({ color: this.cDim, transparent: true, opacity: 0.35, depthWrite: false });
      const beam = new THREE.Mesh(beamGeom, beamMat);
      beam.name = `ray:${h}`;
      beam.visible = false;
      beam.raycast = () => {};
      beam.renderOrder = 5;
      const dotMat = new THREE.MeshBasicMaterial({ color: this.cAccent, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
      const dot = new THREE.Mesh(unitSphereGeometry(1), dotMat);
      dot.name = `cursor:${h}`;
      dot.visible = false;
      dot.raycast = () => {};
      dot.renderOrder = 11;
      this.group.add(beam, dot);
      this.hands.set(h, { beam, beamMat, dot, dotMat, hover: undefined, rayHit: null, ray: { origin: new THREE.Vector3(), dir: new THREE.Vector3(), valid: false } });
    }
    this.highlight = new BoundsOutline(theme.text, 0.35, 0.008);
    this.group.add(this.highlight.object);
  }

  setHover(hand: Handedness, hit: Hit | null): void {
    const h = this.hands.get(hand);
    if (h) h.hover = hit;
  }

  /** The hand's hover target: what host.hover() reported, else its ray hit. */
  hoverOf(hand: Handedness): Hit | null {
    const h = this.hands.get(hand);
    if (!h) return null;
    return h.hover !== undefined ? h.hover : h.rayHit;
  }

  setRays(rays: PointerRays): void {
    for (const hand of HANDS) {
      const h = this.hands.get(hand)!;
      const r = rays[hand];
      if (!r) {
        h.ray.valid = false;
        h.rayHit = null;
        continue;
      }
      h.ray.origin.set(r.origin[0], r.origin[1], r.origin[2]);
      h.ray.dir.set(r.direction[0], r.direction[1], r.direction[2]).normalize();
      h.ray.valid = h.ray.dir.lengthSq() > 0.5;
      h.rayHit = r.hit ?? null;
    }
  }

  /** Per frame. `viewPos` = head position in space coords (for constant-size cursor). */
  update(viewPos: THREE.Vector3, enabled: boolean): void {
    for (const h of this.hands.values()) {
      const show = enabled && h.ray.valid;
      h.beam.visible = show;
      h.dot.visible = false;
      if (!show) {
        // No ray (e.g. touch only): mark the touched point instead.
        const near = h.hover ?? null;
        if (enabled && near) this.placeDot(h, near, viewPos);
        continue;
      }
      const hit = h.rayHit;
      const len = hit ? Math.max(0.01, hit.distance) : IDLE_LENGTH;
      h.beam.position.copy(h.ray.origin);
      h.beam.quaternion.setFromUnitVectors(_up, h.ray.dir);
      h.beam.scale.set(1, len, 1);
      h.beamMat.color.copy(hit ? (hit.interactive ? this.cAccent : this.cText) : this.cDim);
      h.beamMat.opacity = hit ? 0.45 : 0.18;
      if (hit) this.placeDot(h, hit, viewPos);
    }
  }

  private placeDot(h: HandVis, hit: Hit, viewPos: THREE.Vector3): void {
    h.dot.position.set(hit.point[0], hit.point[1], hit.point[2]);
    const d = Math.max(0.1, h.dot.position.distanceTo(viewPos));
    h.dot.scale.setScalar(0.0035 * d);
    h.dotMat.color.copy(hit.interactive ? this.cAccent : this.cText);
    h.dot.visible = true;
  }

  /** The entity hovered by any hand (right preferred). */
  hoveredEntity(): string | null {
    return this.hoverOf('right')?.entity ?? this.hoverOf('left')?.entity ?? null;
  }

  dispose(): void {
    for (const h of this.hands.values()) {
      h.beamMat.dispose();
      h.dotMat.dispose();
    }
    (this.hands.get('left')?.beam.geometry as THREE.BufferGeometry | undefined)?.dispose();
    this.highlight.dispose();
    this.group.removeFromParent();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
