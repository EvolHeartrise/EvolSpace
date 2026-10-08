// resid-flow scene graph. Owns every three.js object of the widget and keeps
// the draw-call count small and constant:
//   frames (lines + fills) 2 · trajectories 1 · nodes 1 (instanced) · ticks 1
//   (instanced) · attention arcs 1 · lens (fill, outline, handle) 3 · hover
//   frame 1 · readout ~5 · a handful of texts.
// Geometry buffers only grow (rebuilds on new samples reuse them); per-frame
// work is a few uniform writes and the lens slide animation — no allocation.
//
// Picking: rendered meshes have raycasting disabled. Instead there is one
// invisible "slab" proxy per layer (registered with ctx.interactive) whose
// custom raycast hits nodes of that layer (or the plane footprint) in O(T),
// and whose thin bounding box is the touch target for direct pinches. The
// lens handle is a real, interactive mesh.

import type * as THREE_NS from 'three';
import type { Theme, UiKit } from '@evolspace/protocol';
import type { InterpData, LensReadout } from './data.ts';
import { displayToken, fitText } from './data.ts';
import type { RGB, ColorSpec } from './colors.ts';
import { layerY, rayStack, type Layout, type RayHit, type RibbonBuffers, type TickBuffers } from './layout.ts';
import { nodeMaterial, ribbonMaterial, tickMaterial, type RibbonUniforms } from './shaders.ts';
import { ReadoutPanel } from './readout.ts';

type ThreeLib = typeof THREE_NS;
type Text = THREE_NS.Mesh & { set(text: string): void };

const noRaycast = () => {};

export interface ViewEnv {
  THREE: ThreeLib;
  ui: UiKit;
  theme: Theme;
  /** ctx.interactive */
  interactive(obj: THREE_NS.Object3D): void;
  isMirror: boolean;
}

export interface Style {
  tubeWidth: number;
  nodeSize: number;
  showParticles: boolean;
  showDelta: boolean;
  showAttn: boolean;
  showLabels: boolean;
  showReadout: boolean;
  dimOthers: boolean;
  flowSpeed: number;
}

/** Names of interactive objects (InteractionEvent.objectName). */
export const HANDLE_NAME = 'lens-handle';
export const SLAB_PREFIX = 'layer:';

/** Ray pick radius around nodes (m, local). */
export const NODE_PICK_RADIUS = 0.018;
/** Half thickness of a layer's touch slab (m). */
const SLAB_HALF = 0.012;
const MARGIN = 0.02;

// Layout of the texts around the stack (widget-local meters). Nothing may overlap at any
// lens layer: the header lives above the top plane and ends left of the readout column;
// the readout panel (right of the lens handle/label) is kept between the top and bottom
// planes (clamped in update()), so it never reaches the header.
/** Readout panel's left edge, from the plane's right edge. */
export const READOUT_X = 0.12;
const HEADER_SIZE = 0.024;
const SUB_SIZE = 0.014;
const STATUS_SIZE = 0.012;
const LENS_LABEL_SIZE = 0.016;
/** How far the readout may reach above the top plane / below the bottom plane. */
export const READOUT_OVERHANG = 0.02;
/** Conservative Inter advance (em) for single-line fitting (wide glyphs, digits). */
const SANS_ADV = 0.6;
const fitChars = (width: number, size: number): number => Math.max(4, Math.floor(width / (size * SANS_ADV)));

interface GrowMesh<T extends THREE_NS.Object3D> {
  obj: T | null;
  cap: number;
}

export class ResidView {
  readonly group: THREE_NS.Group;
  private readonly THREE: ThreeLib;
  private readonly ui: UiKit;
  private readonly theme: Theme;

  // materials (owned)
  private readonly ribbonMat: THREE_NS.ShaderMaterial & { uniforms: RibbonUniforms };
  private readonly arcMat: THREE_NS.ShaderMaterial & { uniforms: RibbonUniforms };
  private readonly nodeMat: THREE_NS.ShaderMaterial;
  private readonly tickMat: THREE_NS.ShaderMaterial;
  private readonly frameLineMat: THREE_NS.LineBasicMaterial;
  private readonly frameFillMat: THREE_NS.MeshBasicMaterial;
  private readonly lensLineMat: THREE_NS.LineBasicMaterial;
  private readonly lensFillMat: THREE_NS.MeshBasicMaterial;
  private readonly hoverLineMat: THREE_NS.LineBasicMaterial;
  private readonly handleMat: THREE_NS.MeshBasicMaterial;
  private readonly handleHoverMat: THREE_NS.MeshBasicMaterial;
  private readonly proxyMat: THREE_NS.MeshBasicMaterial;
  private readonly quad: THREE_NS.PlaneGeometry;

  // geometry objects
  private frames: THREE_NS.LineSegments | null = null;
  private fills: THREE_NS.Mesh | null = null;
  private framesKey = '';
  private ribbons: GrowMesh<THREE_NS.Mesh> = { obj: null, cap: 0 };
  private arcs: GrowMesh<THREE_NS.Mesh> = { obj: null, cap: 0 };
  private nodes: GrowMesh<THREE_NS.InstancedMesh> = { obj: null, cap: 0 };
  private ticks: GrowMesh<THREE_NS.InstancedMesh> = { obj: null, cap: 0 };
  private slabs: THREE_NS.Mesh[] = [];
  private slabGeo: THREE_NS.BufferGeometry | null = null;

  // lens
  readonly lens: THREE_NS.Group;
  private readonly lensFill: THREE_NS.Mesh;
  private readonly lensLine: THREE_NS.LineLoop;
  readonly handle: THREE_NS.Mesh;
  private readonly lensLabel: Text;
  private readonly hoverFrame: THREE_NS.LineLoop;
  readonly readout: ReadoutPanel;

  // texts
  private readonly header: Text;
  private readonly subheader: Text;
  private readonly status: Text;
  private readonly selLabel: Text;
  private readonly hoverLabel: Text;
  private layerLabels: Text[] = [];

  // waiting state
  private readonly waiting: THREE_NS.Group;
  private readonly waitingText: Text;

  // state
  private layout: Layout | null = null;
  /** Unfitted header lines (title, subtitle, status). */
  private readonly headerRaw: [string, string, string] = ['', '', ''];
  private lensTarget = 0;
  private lensCur = 0;
  private lensLayer = -1;
  private lensSnap = true;
  private style: Style;
  private readonly rayHit: RayHit = { distance: 0, x: 0, y: 0, z: 0, token: -1, layer: -1 };
  /** Bumped whenever node positions change (invalidates the ray cache). */
  private layoutRev = 0;
  private readonly rayCache = { rev: -1, ray: new Float64Array(6), mw: new Float64Array(16), hit: false };
  private readonly invM: THREE_NS.Matrix4;
  private readonly lRay: THREE_NS.Ray;

  constructor(private env: ViewEnv, style: Style) {
    const THREE = (this.THREE = env.THREE);
    this.ui = env.ui;
    this.theme = env.theme;
    this.style = { ...style };
    const th = env.theme;

    this.group = new THREE.Group();
    this.group.name = 'resid-flow';
    this.invM = new THREE.Matrix4();
    this.lRay = new THREE.Ray();

    this.ribbonMat = ribbonMaterial(THREE);
    this.arcMat = ribbonMaterial(THREE);
    this.arcMat.uniforms.uSpeed.value = 0.9;
    this.arcMat.uniforms.uPeriod.value = 0.55;
    this.arcMat.uniforms.uDim.value = 0;
    this.arcMat.uniforms.uMinWidth.value = 0.0008;
    this.nodeMat = nodeMaterial(THREE);
    this.tickMat = tickMaterial(THREE, new THREE.Color(th.accent), new THREE.Color(th.accent2));
    this.frameLineMat = new THREE.LineBasicMaterial({ color: th.border, transparent: true, opacity: 0.75, depthWrite: false });
    this.frameFillMat = new THREE.MeshBasicMaterial({ color: th.surface, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    this.lensLineMat = new THREE.LineBasicMaterial({ color: th.accent });
    this.lensFillMat = new THREE.MeshBasicMaterial({ color: th.accent, transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide });
    this.hoverLineMat = new THREE.LineBasicMaterial({ color: th.text, transparent: true, opacity: 0.8, depthWrite: false });
    this.handleMat = new THREE.MeshBasicMaterial({ color: th.accent });
    this.handleHoverMat = new THREE.MeshBasicMaterial({ color: th.text });
    this.proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    this.quad = new THREE.PlaneGeometry(1, 1);

    // Lens (positioned by y only).
    this.lens = new THREE.Group();
    this.lens.name = 'lens';
    const unitSquare = new THREE.BufferGeometry();
    unitSquare.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
    this.lensLine = new THREE.LineLoop(unitSquare, this.lensLineMat);
    this.lensLine.raycast = noRaycast;
    this.lensLine.frustumCulled = false;
    const fillGeo = new THREE.PlaneGeometry(1, 1);
    fillGeo.rotateX(-Math.PI / 2);
    this.lensFill = new THREE.Mesh(fillGeo, this.lensFillMat);
    this.lensFill.raycast = noRaycast;
    this.lensFill.renderOrder = 2;
    this.handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.007, 0.026, 4, 10), this.handleMat);
    this.handle.name = HANDLE_NAME;
    this.lensLabel = this.ui.text('', { size: LENS_LABEL_SIZE, color: th.accent, anchorX: 'left', anchorY: 'middle' });
    this.readout = new ReadoutPanel(THREE, this.ui, th);
    this.lens.add(this.lensFill, this.lensLine, this.handle, this.lensLabel, this.readout.group);
    this.group.add(this.lens);
    env.interactive(this.handle);

    this.hoverFrame = new THREE.LineLoop(unitSquare.clone(), this.hoverLineMat);
    this.hoverFrame.raycast = noRaycast;
    this.hoverFrame.visible = false;
    this.hoverFrame.frustumCulled = false;
    this.group.add(this.hoverFrame);

    // Header texts are fitted to one line (setHeader); no maxWidth, so they never wrap downwards.
    this.header = this.ui.text('', { size: HEADER_SIZE, color: th.text, anchorX: 'left', anchorY: 'bottom' });
    this.subheader = this.ui.text('', { size: SUB_SIZE, color: th.textDim, anchorX: 'left', anchorY: 'top' });
    this.status = this.ui.text('', { size: STATUS_SIZE, color: th.textDim, anchorX: 'left', anchorY: 'top' });
    this.selLabel = this.ui.text('', { size: 0.016, color: th.text, anchorX: 'left', anchorY: 'bottom' });
    this.hoverLabel = this.ui.text('', { size: 0.014, color: th.text, anchorX: 'left', anchorY: 'bottom' });
    this.group.add(this.header, this.subheader, this.status, this.selLabel, this.hoverLabel);
    for (const t of [this.header, this.subheader, this.status]) t.raycast = noRaycast;
    this.selLabel.visible = false;
    this.hoverLabel.visible = false;
    // Labels that float next to nodes must not occlude them for the picker
    // (a hover label appearing in front of a neighbor node would steal the ray and flicker).
    this.selLabel.raycast = noRaycast;
    this.hoverLabel.raycast = noRaycast;
    this.lensLabel.raycast = noRaycast;

    // Waiting panel.
    this.waiting = new THREE.Group();
    this.waiting.name = 'waiting';
    const wp = this.ui.panel(0.5, 0.26, { opacity: 0.9 });
    this.waitingText = this.ui.text('', { size: 0.016, color: th.text, anchorX: 'left', anchorY: 'top', maxWidth: 0.46, font: 'mono' });
    this.waitingText.position.set(-0.23, 0.11, 0.002);
    this.waiting.add(wp, this.waitingText);
    this.group.add(this.waiting);
    this.lens.visible = false;
  }

  // ---------------------------------------------------------------- style

  setStyle(s: Style): void {
    this.style = { ...s };
    this.layoutRev++; // pick radius depends on nodeSize
    const r = this.ribbonMat.uniforms;
    r.uWidth.value = s.tubeWidth;
    r.uMinWidth.value = s.tubeWidth * 0.3;
    r.uParticles.value = s.showParticles ? 1 : 0;
    r.uSpeed.value = s.flowSpeed;
    r.uDim.value = s.dimOthers ? 1 : 0;
    this.arcMat.uniforms.uWidth.value = s.tubeWidth * 0.9;
    this.arcMat.uniforms.uParticles.value = s.showParticles ? 1 : 0;
    const nu = this.nodeMat.uniforms;
    nu.uSize.value = s.nodeSize;
    nu.uDim.value = s.dimOthers ? 1 : 0;
    const tu = this.tickMat.uniforms;
    tu.uNodeSize.value = s.nodeSize;
    tu.uBarW.value = Math.max(0.0015, s.nodeSize * 0.22);
    tu.uBarH.value = Math.max(0.012, (this.layout?.spacing ?? 0.08) * 0.42);
    if (this.ticks.obj) this.ticks.obj.visible = s.showDelta && this.ticks.obj.count > 0;
    if (this.arcs.obj) this.arcs.obj.visible = s.showAttn;
    this.readout.group.visible = s.showReadout;
    for (const t of this.layerLabels) t.visible = s.showLabels && t.userData.used === true;
  }

  // ---------------------------------------------------------------- layout

  /** Show the waiting panel (no usable P.resid.proj). */
  showWaiting(text: string): void {
    this.layout = null;
    this.layoutRev++;
    this.waiting.visible = true;
    this.waitingText.set(text);
    for (const o of [this.frames, this.fills, this.ribbons.obj, this.nodes.obj, this.ticks.obj, this.arcs.obj]) if (o) o.visible = false;
    for (const s of this.slabs) s.visible = false;
    this.lens.visible = false;
    this.hoverFrame.visible = false;
    this.selLabel.visible = false;
    this.hoverLabel.visible = false;
    for (const t of this.layerLabels) t.visible = false;
    this.header.set('resid-flow');
    this.subheader.set('');
    this.status.set('');
    this.header.position.set(-0.25, 0.15, 0);
  }

  /**
   * Rebuild everything that depends on node positions: frames, trajectories,
   * nodes, slabs, labels. `nodeColor` is [L1 × T × 3] linear RGB.
   */
  setLayout(L: Layout, data: InterpData, nodeColor: Float32Array, traj: RibbonBuffers): void {
    const THREE = this.THREE;
    const firstLayout = !this.layout;
    this.layout = L;
    this.layoutRev++;
    this.waiting.visible = false;
    this.lens.visible = true;
    this.buildFrames(L);

    // Trajectories.
    this.ribbons = this.uploadRibbons(this.ribbons, traj, this.ribbonMat, 'trajectories', L);

    // Nodes.
    const n = L.nodeCount;
    if (!this.nodes.obj || this.nodes.cap < n) {
      const cap = Math.max(64, Math.ceil(n * 1.5));
      const geo = this.quad.clone();
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
      const mesh = new THREE.InstancedMesh(geo, this.nodeMat, cap);
      mesh.name = 'nodes';
      mesh.raycast = noRaycast;
      mesh.frustumCulled = false;
      this.replace(this.nodes.obj, mesh);
      this.nodes = { obj: mesh, cap };
    }
    const nm = this.nodes.obj!;
    const mat = nm.instanceMatrix.array as Float32Array;
    const info = (nm.geometry.getAttribute('aInfo') as THREE_NS.InstancedBufferAttribute).array as Float32Array;
    const col = (nm.geometry.getAttribute('aColor') as THREE_NS.InstancedBufferAttribute).array as Float32Array;
    for (let k = 0; k < n; k++) {
      const l = L.nodeLayer[k], t = L.nodeToken[k], i = l * L.T + t;
      const o = k * 16;
      mat[o] = 1; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = 1; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = 1; mat[o + 11] = 0;
      mat[o + 12] = L.pos[i * 3]; mat[o + 13] = L.pos[i * 3 + 1]; mat[o + 14] = L.pos[i * 3 + 2]; mat[o + 15] = 1;
      info[k * 4] = t; info[k * 4 + 1] = l; info[k * 4 + 2] = L.normN[i]; info[k * 4 + 3] = 0;
      col[k * 3] = nodeColor[i * 3]; col[k * 3 + 1] = nodeColor[i * 3 + 1]; col[k * 3 + 2] = nodeColor[i * 3 + 2];
    }
    nm.count = n;
    nm.instanceMatrix.needsUpdate = true;
    nm.geometry.getAttribute('aInfo').needsUpdate = true;
    nm.geometry.getAttribute('aColor').needsUpdate = true;
    this.setBounds(nm, L, this.style.nodeSize * 1.5);
    nm.visible = n > 0;

    this.buildSlabs(L);
    this.buildLayerLabels(L, data);

    // Lens geometry follows the plane size.
    const s = L.width + 0.02;
    this.lensLine.scale.set(s, 1, s);
    this.lensFill.scale.set(s, 1, s);
    this.hoverFrame.scale.set(s, 1, s);
    this.handle.position.set(L.width / 2 + 0.035, 0, 0);
    this.lensLabel.position.set(L.width / 2 + 0.052, 0, 0);
    this.readout.group.position.set(L.width / 2 + READOUT_X, 0, 0);
    this.tickMat.uniforms.uBarH.value = Math.max(0.012, L.spacing * 0.42);

    // Header above the stack's front edge (clear of the lens plane and the arcs above it).
    const top = layerY(L, L.L1 - 1) + Math.max(0.06, L.spacing * 0.9);
    this.header.position.set(-L.width / 2, top + 0.008, L.width / 2);
    this.subheader.position.set(-L.width / 2, top, L.width / 2);
    this.status.position.set(-L.width / 2, layerY(L, 0) - 0.03, L.width / 2);
    if (firstLayout) this.lensSnap = true;
    this.setStyle(this.style);
    this.fitHeader();
    this.placeReadout();
  }

  /** Width available to header/status lines: from the stack's left edge to just before the readout column. */
  headerWidth(): number {
    return (this.layout?.width ?? 0.5) + READOUT_X - 0.015;
  }

  /** Single-line fit of the header texts (word-boundary truncation with an ellipsis). */
  private fitHeader(): void {
    const w = this.headerWidth();
    this.header.set(fitText(this.headerRaw[0], fitChars(w, HEADER_SIZE)));
    this.subheader.set(fitText(this.headerRaw[1], fitChars(w, SUB_SIZE)));
    this.status.set(fitText(this.headerRaw[2], fitChars(w, STATUS_SIZE)));
  }

  /**
   * Keep the readout panel next to the lens but inside the stack's vertical extent
   * (± READOUT_OVERHANG), so at the top layer it cannot rise into the header and at
   * the bottom it does not hang below the stack. Cheap; runs every frame.
   */
  private placeReadout(): void {
    const L = this.layout;
    if (!L) return;
    const h = this.readout.height;
    const hi = layerY(L, L.L1 - 1) + READOUT_OVERHANG - h / 2;
    const lo = layerY(L, 0) - READOUT_OVERHANG + h / 2;
    const y = lo > hi ? hi : Math.min(hi, Math.max(lo, this.lensCur));
    this.readout.group.position.y = y - this.lensCur;
  }

  private replace(old: THREE_NS.Object3D | null, next: THREE_NS.Object3D): void {
    if (old) {
      this.group.remove(old);
      const g = (old as THREE_NS.Mesh).geometry;
      g?.dispose();
      (old as THREE_NS.InstancedMesh).dispose?.();
    }
    this.group.add(next);
  }

  /**
   * Bounds for picking/culling/framing. Plain meshes get the layout extents
   * (their buffers hold stale tails). An InstancedMesh gets the layout extents as
   * its own (all-instances) box, but its GEOMETRY box must bound ONE instance:
   * generic bounds code (the runtime's framing/picker, three's
   * InstancedMesh.computeBoundingBox) unions geometry box × instance matrix, so
   * the layout box there would inflate the subtree by a whole stack per side
   * (entity screenshots then framed the rig at a third of the image).
   * `instanceHalf`: half-extent of one shader-sized instance around its origin.
   */
  private setBounds(obj: THREE_NS.Mesh | THREE_NS.InstancedMesh, L: Layout, instanceHalf = 0): void {
    const THREE = this.THREE;
    const h = L.width / 2 + 0.03;
    const y0 = layerY(L, 0) - L.spacing, y1 = layerY(L, L.L1 - 1) + L.spacing;
    const box = new THREE.Box3(new THREE.Vector3(-h, y0, -h), new THREE.Vector3(h, y1, h));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if ((obj as THREE_NS.InstancedMesh).isInstancedMesh) {
      (obj as THREE_NS.InstancedMesh).boundingBox = box;
      (obj as THREE_NS.InstancedMesh).boundingSphere = sphere;
      const e = Math.max(1e-3, instanceHalf);
      obj.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-e, -e, -e), new THREE.Vector3(e, e, e));
      obj.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), e * Math.sqrt(3));
      return;
    }
    obj.geometry.boundingBox = box.clone();
    obj.geometry.boundingSphere = sphere.clone();
  }

  private buildFrames(L: Layout): void {
    const key = `${L.L1}|${L.width}|${L.spacing}`;
    if (key === this.framesKey && this.frames) return;
    this.framesKey = key;
    const THREE = this.THREE;
    const h = L.width / 2;
    const lines = new Float32Array(L.L1 * 8 * 3);
    const quads = new Float32Array(L.L1 * 4 * 3);
    const idx: number[] = [];
    for (let l = 0; l < L.L1; l++) {
      const y = layerY(L, l);
      const c = [[-h, -h], [h, -h], [h, h], [-h, h]];
      for (let e = 0; e < 4; e++) {
        const a = c[e], b = c[(e + 1) % 4], o = (l * 8 + e * 2) * 3;
        lines.set([a[0], y, a[1], b[0], y, b[1]], o);
      }
      for (let v = 0; v < 4; v++) quads.set([c[v][0], y, c[v][1]], (l * 4 + v) * 3);
      const b = l * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(quads, 3));
    fg.setIndex(idx);
    const frames = new THREE.LineSegments(lg, this.frameLineMat);
    frames.name = 'frames';
    frames.raycast = noRaycast;
    const fills = new THREE.Mesh(fg, this.frameFillMat);
    fills.name = 'frame-fills';
    fills.raycast = noRaycast;
    fills.renderOrder = 1;
    if (this.frames) this.replace(this.frames, frames); else this.group.add(frames);
    if (this.fills) this.replace(this.fills, fills); else this.group.add(fills);
    this.frames = frames;
    this.fills = fills;
  }

  private uploadRibbons(slot: GrowMesh<THREE_NS.Mesh>, b: RibbonBuffers, mat: THREE_NS.Material, name: string, L: Layout): GrowMesh<THREE_NS.Mesh> {
    const THREE = this.THREE;
    let out = slot;
    if (!slot.obj || slot.obj.geometry.getAttribute('position').array !== b.position || (slot.obj.geometry.index?.array ?? null) !== b.index) {
      // Buffers grew (or first build): new geometry, old GPU buffers released.
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
      geo.setAttribute('aTangent', new THREE.BufferAttribute(b.tangent, 3));
      geo.setAttribute('aData', new THREE.BufferAttribute(b.data, 4));
      geo.setAttribute('aColor', new THREE.BufferAttribute(b.color, 3));
      geo.setIndex(new THREE.BufferAttribute(b.index, 1));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.raycast = noRaycast;
      mesh.frustumCulled = false;
      this.replace(slot.obj, mesh);
      out = { obj: mesh, cap: b.position.length / 3 };
    } else {
      const g = slot.obj.geometry;
      for (const a of ['position', 'aTangent', 'aData', 'aColor']) g.getAttribute(a).needsUpdate = true;
      g.index!.needsUpdate = true;
    }
    out.obj!.geometry.setDrawRange(0, b.indexCount);
    out.obj!.visible = b.indexCount > 0;
    this.setBounds(out.obj!, L);
    return out;
  }

  private buildSlabs(L: Layout): void {
    const THREE = this.THREE;
    const half = L.width / 2 + MARGIN;
    const sh = Math.min(SLAB_HALF, L.spacing * 0.45) + L.maxYOffset;
    // One shared proxy geometry (only its bounding box matters: the touch target).
    if (this.slabGeo) this.slabGeo.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-half, -sh, -half, half, sh, half], 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.slabGeo = g;
    // Pool grows only: interactive registrations cannot be revoked, so
    // unused slabs are hidden instead of removed.
    while (this.slabs.length < L.L1) {
      const m = new THREE.Mesh(g, this.proxyMat);
      const self = this;
      m.raycast = function (this: THREE_NS.Mesh, rc: THREE_NS.Raycaster, out: THREE_NS.Intersection[]) {
        self.raycastSlab(this, rc, out);
      };
      this.slabs.push(m);
      this.group.add(m);
      this.env.interactive(m);
    }
    for (let l = 0; l < this.slabs.length; l++) {
      const m = this.slabs[l];
      m.geometry = g;
      m.visible = l < L.L1;
      m.name = `${SLAB_PREFIX}${l}`;
      m.userData.layer = l;
      m.position.set(0, layerY(L, l), 0);
      m.updateMatrix();
    }
  }

  /**
   * Custom raycast of a layer proxy. The whole stack is resolved once per ray
   * (rayStack: nodes first, then the first plane crossed) and cached for the
   * remaining slabs of the same raycast pass; only the winning layer's slab
   * reports an intersection, so an interior node is not shadowed by the
   * footprint of a nearer plane.
   */
  private raycastSlab(m: THREE_NS.Mesh, rc: THREE_NS.Raycaster, out: THREE_NS.Intersection[]): void {
    const L = this.layout;
    if (!L || !m.visible) return;
    const layer = m.userData.layer as number;
    if (layer >= L.L1) return;
    const hit = this.stackHit(rc.ray, L);
    if (!hit || hit.layer !== layer) return;
    const p = new this.THREE.Vector3(hit.x, hit.y, hit.z).applyMatrix4(this.group.matrixWorld);
    const distance = p.distanceTo(rc.ray.origin);
    if (distance < rc.near || distance > rc.far) return;
    out.push({ distance, point: p, object: m } as THREE_NS.Intersection);
  }

  /** rayStack() for a world ray, memoized on (ray, group world matrix, layout revision). */
  private stackHit(ray: THREE_NS.Ray, L: Layout): RayHit | null {
    const c = this.rayCache;
    this.group.updateWorldMatrix(true, false);
    const mw = this.group.matrixWorld.elements;
    const o = ray.origin, dir = ray.direction;
    let same = c.rev === this.layoutRev && c.ray[0] === o.x && c.ray[1] === o.y && c.ray[2] === o.z
      && c.ray[3] === dir.x && c.ray[4] === dir.y && c.ray[5] === dir.z;
    for (let i = 0; same && i < 16; i++) same = c.mw[i] === mw[i];
    if (same) return c.hit ? this.rayHit : null;
    c.rev = this.layoutRev;
    c.ray[0] = o.x; c.ray[1] = o.y; c.ray[2] = o.z; c.ray[3] = dir.x; c.ray[4] = dir.y; c.ray[5] = dir.z;
    for (let i = 0; i < 16; i++) c.mw[i] = mw[i];
    c.hit = false;
    // Ray into the view group's frame (= layout frame).
    this.invM.copy(this.group.matrixWorld).invert();
    this.lRay.copy(ray).applyMatrix4(this.invM);
    const d = this.lRay.direction;
    const len = d.length();
    if (len < 1e-9) return null;
    d.multiplyScalar(1 / len);
    const lo = this.lRay.origin;
    const direct = Math.max(0.006, this.style.nodeSize * 0.6);
    c.hit = !!rayStack(L, lo.x, lo.y, lo.z, d.x, d.y, d.z, direct, NODE_PICK_RADIUS, MARGIN, this.rayHit);
    return c.hit ? this.rayHit : null;
  }

  /** Layer label: its name, plus the magnification when normalization enlarged it ("embed ×3.2"). */
  layerText(L: Layout, data: InterpData, l: number): string {
    const name = data.layerLabel(l);
    const g = L.gain[l];
    if (!(g > 1.05)) return name;
    return `${name} ×${g >= 9.95 ? Math.round(g) : g.toFixed(1)}`;
  }

  private buildLayerLabels(L: Layout, data: InterpData): void {
    // Label every k-th layer so dense stacks stay legible; always first and last.
    const stride = Math.max(1, Math.ceil(L.L1 / 12));
    const want: number[] = [];
    for (let l = 0; l < L.L1; l++) if (l % stride === 0 || l === L.L1 - 1) want.push(l);
    while (this.layerLabels.length < want.length) {
      const t = this.ui.text('', { size: 0.014, color: this.theme.textDim, anchorX: 'right', anchorY: 'middle', font: 'mono' });
      this.layerLabels.push(t);
      this.group.add(t);
    }
    for (let i = 0; i < this.layerLabels.length; i++) {
      const t = this.layerLabels[i];
      const used = i < want.length;
      t.userData.used = used;
      t.visible = used && this.style.showLabels;
      if (!used) continue;
      const l = want[i];
      t.set(this.layerText(L, data, l));
      t.position.set(-L.width / 2 - 0.014, layerY(L, l), L.width / 2);
    }
  }

  // ---------------------------------------------------------------- per-sample extras

  setTicks(b: TickBuffers | null): void {
    const THREE = this.THREE;
    const L = this.layout;
    if (!b || !L || !b.count) {
      if (this.ticks.obj) { this.ticks.obj.count = 0; this.ticks.obj.visible = false; }
      return;
    }
    const n = b.count;
    if (!this.ticks.obj || this.ticks.cap < n) {
      const cap = Math.max(64, Math.ceil(n * 1.5));
      const geo = this.quad.clone();
      geo.setAttribute('aTick', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      const mesh = new THREE.InstancedMesh(geo, this.tickMat, cap);
      mesh.name = 'delta-ticks';
      mesh.raycast = noRaycast;
      mesh.frustumCulled = false;
      this.replace(this.ticks.obj, mesh);
      this.ticks = { obj: mesh, cap };
    }
    const tm = this.ticks.obj!;
    const mat = tm.instanceMatrix.array as Float32Array;
    const info = (tm.geometry.getAttribute('aTick') as THREE_NS.InstancedBufferAttribute).array as Float32Array;
    for (let k = 0; k < n; k++) {
      const o = k * 16;
      mat[o] = 1; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = 1; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = 1; mat[o + 11] = 0;
      mat[o + 12] = b.center[k * 3]; mat[o + 13] = b.center[k * 3 + 1]; mat[o + 14] = b.center[k * 3 + 2]; mat[o + 15] = 1;
      info[k * 4] = b.info[k * 4]; info[k * 4 + 1] = b.info[k * 4 + 1]; info[k * 4 + 2] = b.info[k * 4 + 2]; info[k * 4 + 3] = b.info[k * 4 + 3];
    }
    tm.count = n;
    tm.instanceMatrix.needsUpdate = true;
    tm.geometry.getAttribute('aTick').needsUpdate = true;
    // Tick bars sit beside the node: x up to nodeSize·0.75 + a few bar widths, height up to uBarH.
    const tu = this.tickMat.uniforms;
    this.setBounds(tm, L, tu.uNodeSize.value * 0.75 + tu.uBarW.value * 3 + tu.uBarH.value);
    tm.visible = this.style.showDelta;
  }

  setArcs(b: RibbonBuffers | null): void {
    const L = this.layout;
    if (!b || !L || !b.indexCount) {
      if (this.arcs.obj) this.arcs.obj.visible = false;
      return;
    }
    this.arcs = this.uploadRibbons(this.arcs, b, this.arcMat, 'attn-arcs', L);
    this.arcs.obj!.visible = this.style.showAttn;
  }

  // ---------------------------------------------------------------- selection & hover

  /** Move the lens to `layer` (animated unless snapping) and update dependent uniforms. */
  setLens(layer: number, label: string): void {
    const L = this.layout;
    if (!L) return;
    this.lensLayer = layer;
    this.lensTarget = layerY(L, layer);
    if (this.lensSnap || this.env.isMirror) {
      this.lensCur = this.lensTarget;
      this.lensSnap = false;
    }
    this.lens.position.y = this.lensCur;
    this.lensLabel.set(fitText(label, 7)); // room between the handle and the readout column
    this.placeReadout();
    this.nodeMat.uniforms.uLensLayer.value = layer;
    this.tickMat.uniforms.uLensLayer.value = layer;
  }

  /** Selected token (−1 = none) and its label at the lens layer. */
  setSelectedToken(token: number, label: string): void {
    const L = this.layout;
    this.ribbonMat.uniforms.uSel.value = token;
    this.nodeMat.uniforms.uSel.value = token;
    this.tickMat.uniforms.uSel.value = token;
    if (!L || token < 0 || token >= L.T || this.lensLayer < 0) {
      this.selLabel.visible = false;
      return;
    }
    const i = this.lensLayer * L.T + token;
    if (L.nodeOf[i] < 0) {
      this.selLabel.visible = false;
      return;
    }
    this.selLabel.set(label);
    this.selLabel.position.set(L.pos[i * 3] + 0.012, L.pos[i * 3 + 1] + 0.012, L.pos[i * 3 + 2]);
    this.selLabel.visible = true;
  }

  /** Hover feedback: a token (with label) or a layer (outline + label); nulls clear. */
  setHover(token: number, layer: number, label: string, handle: boolean): void {
    const L = this.layout;
    this.ribbonMat.uniforms.uHover.value = token;
    this.nodeMat.uniforms.uHover.value = token;
    this.handle.material = handle ? this.handleHoverMat : this.handleMat;
    this.hoverFrame.visible = false;
    this.hoverLabel.visible = false;
    if (!L) return;
    if (token >= 0 && layer >= 0) {
      const i = layer * L.T + token;
      if (L.nodeOf[i] >= 0) {
        this.hoverLabel.set(label);
        this.hoverLabel.position.set(L.pos[i * 3] + 0.012, L.pos[i * 3 + 1] + 0.012, L.pos[i * 3 + 2]);
        this.hoverLabel.visible = true;
      }
    } else if (layer >= 0 && layer !== this.lensLayer) {
      this.hoverFrame.position.y = layerY(L, layer);
      this.hoverFrame.visible = true;
      this.hoverLabel.set(label);
      this.hoverLabel.position.set(L.width / 2 + 0.02, layerY(L, layer) + 0.006, 0);
      this.hoverLabel.visible = true;
    }
  }

  setReadout(r: LensReadout | null, stale: boolean, fallbackTitle: string, waitingNote: string): void {
    this.readout.set(r, stale, fallbackTitle, waitingNote);
    this.placeReadout();
  }

  /** Header lines (title, subtitle, status); each is fitted to one line left of the readout column. */
  setHeader(title: string, sub: string, status: string): void {
    this.headerRaw[0] = title;
    this.headerRaw[1] = sub;
    this.headerRaw[2] = status;
    this.fitHeader();
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, t: number): void {
    this.ribbonMat.uniforms.uTime.value = t;
    this.arcMat.uniforms.uTime.value = t;
    const L = this.layout;
    if (!L) return;
    if (this.lensCur !== this.lensTarget) {
      const k = 1 - Math.exp(-Math.max(0, dt) * 16);
      this.lensCur += (this.lensTarget - this.lensCur) * k;
      if (Math.abs(this.lensTarget - this.lensCur) < 1e-4) this.lensCur = this.lensTarget;
      this.lens.position.y = this.lensCur;
      this.placeReadout();
    }
    this.ribbonMat.uniforms.uLens.value = (this.lensCur - L.y0) / L.spacing;
  }

  /** Local (layout-frame) position of the lens handle. */
  handlePosition(): [number, number, number] {
    return [this.handle.position.x, this.lensTarget, 0];
  }

  /** Object counts for tests/diagnostics. */
  stats(): { nodes: number; ribbonIndices: number; ticks: number; arcIndices: number; slabs: number; waiting: boolean } {
    return {
      nodes: this.nodes.obj?.visible ? this.nodes.obj.count : 0,
      ribbonIndices: this.ribbons.obj?.visible ? this.ribbons.obj.geometry.drawRange.count : 0,
      ticks: this.ticks.obj?.visible ? this.ticks.obj.count : 0,
      arcIndices: this.arcs.obj?.visible ? this.arcs.obj.geometry.drawRange.count : 0,
      slabs: this.slabs.filter((s) => s.visible).length,
      waiting: this.waiting.visible,
    };
  }

  /**
   * Release GPU resources this view created. The group stays attached so the
   * host's subtree sweep still finds the UiKit texts (troika) it owns; shared
   * UiKit panel geometry/materials are never touched here.
   */
  dispose(): void {
    const geos = new Set<THREE_NS.BufferGeometry>();
    for (const o of [this.frames, this.fills, this.ribbons.obj, this.arcs.obj, this.nodes.obj, this.ticks.obj, this.lensLine, this.lensFill, this.handle, this.hoverFrame]) {
      if (o) geos.add(o.geometry);
    }
    if (this.slabGeo) geos.add(this.slabGeo);
    for (const g of geos) g.dispose();
    this.nodes.obj?.dispose();
    this.ticks.obj?.dispose();
    for (const m of [this.ribbonMat, this.arcMat, this.nodeMat, this.tickMat, this.frameLineMat, this.frameFillMat, this.lensLineMat,
      this.lensFillMat, this.hoverLineMat, this.handleMat, this.handleHoverMat, this.proxyMat]) m.dispose();
    this.quad.dispose();
    this.readout.dispose();
  }
}

/** Theme → linear RGB color spec (via THREE.Color so it follows three's color management). */
export function themeColors(THREE: ThreeLib, theme: Theme): ColorSpec & { accent: RGB } {
  const c = (hex: string): RGB => {
    const k = new THREE.Color(hex);
    return [k.r, k.g, k.b];
  };
  return {
    palette: theme.palette.map(c),
    sequential: theme.sequential.map(c),
    diverging: [c(theme.diverging[0]), c(theme.diverging[1]), c(theme.diverging[2])],
    accent: c(theme.accent),
  };
}

export { displayToken };
