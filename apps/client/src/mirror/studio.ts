// The "studio": a neutral stage for rendering one widget alone (thumbnails,
// widget testing). Mid-grey background (readable for both light and dark
// widgets), a soft grid floor under the subject that fades out with distance,
// and gentle lights for any widget that uses lit materials.
import * as THREE from 'three';
import { niceGridStep } from './framing.ts';

export const STUDIO_BACKGROUND = '#3a3f47';
const GRID_MAJOR = '#59606b';
const GRID_MINOR = '#4a5059';

export class StudioStage {
  readonly scene = new THREE.Scene();
  private grid: THREE.LineSegments | null = null;
  private readonly bg = new THREE.Color(STUDIO_BACKGROUND);

  constructor() {
    this.scene.name = 'mirror-studio';
    this.scene.background = this.bg;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444a55, 1.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1.5, 3, 2);
    this.scene.add(hemi, key);
  }

  /**
   * Fits the floor grid + fog to a subject. `box` is the subject's world bounds,
   * `cameraDistance` the camera's distance to it.
   */
  layout(box: THREE.Box3, cameraDistance: number, showGrid: boolean): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    this.scene.fog = null;
    if (!showGrid || box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, size.y * 0.5, 0.05);
    const step = niceGridStep(extent);
    const half = Math.max(cameraDistance * 4, extent * 6);
    const center = box.getCenter(new THREE.Vector3());
    // Slightly below the subject so coplanar bottoms don't z-fight with the grid.
    const y = box.min.y - Math.max(size.y * 0.02, 0.002);
    this.grid = buildGrid(half, step, center.x, y, center.z);
    this.scene.add(this.grid);
    this.scene.fog = new THREE.Fog(this.bg, cameraDistance * 1.2, cameraDistance + half * 0.6);
  }

  setBackground(bg: THREE.Color | null): void {
    this.scene.background = bg;
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(bg ?? this.bg);
  }

  resetBackground(): void {
    this.setBackground(this.bg);
  }
}

/** Grid lines snapped to multiples of `step` in world space; every 5th line brighter. */
function buildGrid(half: number, step: number, cx: number, y: number, cz: number): THREE.LineSegments {
  const n = Math.min(400, Math.ceil(half / step));
  const ox = Math.round(cx / step) * step;
  const oz = Math.round(cz / step) * step;
  const positions: number[] = [];
  const colors: number[] = [];
  const major = new THREE.Color(GRID_MAJOR);
  const minor = new THREE.Color(GRID_MINOR);
  for (let i = -n; i <= n; i++) {
    const c = i % 5 === 0 ? major : minor;
    const ext = n * step;
    positions.push(ox + i * step, y, oz - ext, ox + i * step, y, oz + ext);
    positions.push(ox - ext, y, oz + i * step, ox + ext, y, oz + i * step);
    for (let k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, fog: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = 'mirror-studio-grid';
  lines.renderOrder = -1;
  return lines;
}
