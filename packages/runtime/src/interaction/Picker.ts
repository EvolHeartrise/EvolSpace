// Hit testing against entities, in space coordinates.
//
// Broad phase: each entity has a cached node-local AABB of its own content
// (widget root or fallback; child entities excluded — they are tested on
// their own). A ray/point is transformed into the node frame and tested
// against that box: a few dozen flops per entity.
// Narrow phase (rays only, entities whose box was hit): precise raycast of the
// content's visible meshes; the first hit decides whether it's on an object
// registered via ctx.interactive() (→ hit.interactive). If nothing precise is
// hit, the box hit still counts (forgiving grabs), ranked after precise hits.
//
// Bounds refresh lazily: on content change (invalidate) or when older than
// `maxAgeMs` (animated widgets), so steady-state cost is tiny.

import * as THREE from 'three';
import type { Vec3 } from '@evolspace/protocol';
import type { Hit } from './types.ts';
import { effectivelyVisible } from '../util/object.ts';
import { now } from '../util/rate.ts';

export interface PickSource {
  entityIds(): Iterable<string>;
  nodeObject(id: string): THREE.Object3D | undefined;
  content(id: string): THREE.Object3D | null;
  interactives(id: string): ReadonlySet<THREE.Object3D> | undefined;
  /**
   * Is this registered interactive still part of the entity's content? (The
   * source may drop detached ones from its registry.) Default: a parent walk
   * up to content(id).
   */
  isLiveInteractive?(id: string, o: THREE.Object3D): boolean;
  /** Declared widget size, used when content has no geometry yet. */
  sizeHint(id: string): Vec3 | undefined;
}

interface BoundsEntry {
  box: THREE.Box3;
  empty: boolean;
  at: number;
  dirty: boolean;
}

interface Candidate {
  id: string;
  dist: number;
  precise: boolean;
  interactive: boolean;
  object?: string;
  point: THREE.Vector3;
  volume: number;
}

export class Picker {
  private bounds = new Map<string, BoundsEntry>();
  private raycaster = new THREE.Raycaster();
  private intersections: THREE.Intersection[] = [];
  private matricesStale = true;
  maxAgeMs = 1000;

  constructor(private root: THREE.Object3D, private src: PickSource) {
    this.raycaster.params.Line = { threshold: 0.006 };
    this.raycaster.params.Points = { threshold: 0.01 };
  }

  /** Call once per frame: world matrices are refreshed lazily on the first query. */
  beginFrame(): void {
    this.matricesStale = true;
  }

  invalidate(id: string): void {
    const b = this.bounds.get(id);
    if (b) b.dirty = true;
  }

  forget(id: string): void {
    this.bounds.delete(id);
  }

  private ensureMatrices(): void {
    if (!this.matricesStale) return;
    this.matricesStale = false;
    this.root.updateWorldMatrix(true, true);
  }

  /** Content bounds in the entity node's local frame (null if it has nothing hittable). */
  localBounds(id: string, t = now()): THREE.Box3 | null {
    const node = this.src.nodeObject(id);
    if (!node) return null;
    let b = this.bounds.get(id);
    if (!b) this.bounds.set(id, (b = { box: new THREE.Box3(), empty: true, at: -Infinity, dirty: true }));
    if (b.dirty || t - b.at > this.maxAgeMs) {
      this.ensureMatrices();
      computeLocalBounds(node, this.src.content(id), b.box);
      b.empty = b.box.isEmpty();
      if (b.empty) {
        const s = this.src.sizeHint(id);
        if (s) {
          b.box.min.set(-s[0] / 2, -s[1] / 2, -s[2] / 2);
          b.box.max.set(s[0] / 2, s[1] / 2, s[2] / 2);
          b.empty = false;
        }
      }
      // Give flat panels some thickness so rays at grazing angles and touches register.
      if (!b.empty) padThin(b.box, 0.004);
      b.at = t;
      b.dirty = false;
    }
    return b.empty ? null : b.box;
  }

  // ------------------------------------------------------------------ ray

  raycast(origin: Vec3, dir: Vec3): Hit | null {
    this.ensureMatrices();
    const t = now();
    // Ray in world coordinates.
    _worldRay.origin.set(origin[0], origin[1], origin[2]).applyMatrix4(this.root.matrixWorld);
    _worldRay.direction.set(dir[0], dir[1], dir[2]).transformDirection(this.root.matrixWorld);
    if (_worldRay.direction.lengthSq() < 1e-12) return null;

    let best: Candidate | null = null;
    for (const id of this.src.entityIds()) {
      const node = this.src.nodeObject(id);
      if (!node || !effectivelyVisible(node)) continue;
      const box = this.localBounds(id, t);
      if (!box) continue;
      _inv.copy(node.matrixWorld).invert();
      _localRay.copy(_worldRay).applyMatrix4(_inv);
      if (!_localRay.intersectBox(box, _p)) continue;
      _p.applyMatrix4(node.matrixWorld);
      const boxDist = _p.distanceTo(_worldRay.origin);
      // Cheap reject: a box hit farther than a precise hit we already have can't win.
      if (best && best.precise && boxDist > best.dist) continue;

      const c = this.narrow(id, boxDist, best);
      // Candidates alias scratch vectors; keep the winner's point in a stable slot.
      if (c && (!best || better(c, best))) best = { ...c, point: _bestRay.copy(c.point) };
    }
    return best ? this.toHit(best) : null;
  }

  private narrow(id: string, boxDist: number, best: Candidate | null): Candidate | null {
    const content = this.src.content(id);
    const list = this.intersections;
    list.length = 0;
    if (content) {
      this.raycaster.ray.copy(_worldRay);
      this.raycaster.near = 0;
      this.raycaster.far = Infinity;
      collectIntersections(content, this.raycaster, list);
    }
    if (list.length) {
      list.sort(byDistance);
      const first = list[0];
      if (best && best.precise && first.distance >= best.dist) return null;
      const inter = this.src.interactives(id);
      const io = inter && inter.size ? findInteractive(first.object, inter, content!) : null;
      return {
        id,
        dist: first.distance,
        precise: true,
        interactive: !!io,
        object: io ? io.name || io.uuid : first.object.name || undefined,
        point: _c1.copy(first.point),
        volume: 0,
      };
    }
    return { id, dist: boxDist, precise: false, interactive: false, point: _c2.copy(_p), volume: 0 };
  }

  // ------------------------------------------------------------------ touch

  touch(point: Vec3, radius: number): Hit | null {
    this.ensureMatrices();
    const t = now();
    _wp.set(point[0], point[1], point[2]).applyMatrix4(this.root.matrixWorld);
    let best: Candidate | null = null;
    for (const id of this.src.entityIds()) {
      const node = this.src.nodeObject(id);
      if (!node || !effectivelyVisible(node)) continue;
      const box = this.localBounds(id, t);
      if (!box) continue;
      _inv.copy(node.matrixWorld).invert();
      _lp.copy(_wp).applyMatrix4(_inv);
      box.clampPoint(_lp, _q).applyMatrix4(node.matrixWorld);
      const d = _q.distanceTo(_wp);
      if (d > radius) continue;
      // matrixWorld is fresh (ensureMatrices); getWorldScale() would walk the parents again.
      box.getSize(_size).multiply(_scale.setFromMatrixScale(node.matrixWorld));
      const volume = Math.abs(_size.x * _size.y * _size.z);
      let cand: Candidate = { id, dist: d, precise: false, interactive: false, point: _c1.copy(_q), volume };
      const inter = this.src.interactives(id);
      if (inter && inter.size) {
        const content = this.src.content(id);
        for (const o of inter) {
          // Skip parts the widget detached (rebuilt): their stale matrices would give phantom touches.
          if (!this.liveInteractive(id, o, content) || !effectivelyVisible(o)) continue;
          _box.setFromObject(o);
          if (_box.isEmpty()) continue;
          _box.clampPoint(_wp, _q2);
          const di = _q2.distanceTo(_wp);
          if (di <= radius && (!cand.interactive || di < cand.dist)) {
            _box.getSize(_size);
            cand = { id, dist: di, precise: true, interactive: true, object: o.name || o.uuid, point: _c2.copy(_q2), volume: Math.abs(_size.x * _size.y * _size.z) };
          }
        }
      }
      if (!best || betterTouch(cand, best)) {
        // Candidates alias scratch vectors; copy the point into the stable slot.
        best = { ...cand, point: _best.copy(cand.point) };
      }
    }
    return best ? this.toHit(best) : null;
  }

  private liveInteractive(id: string, o: THREE.Object3D, content: THREE.Object3D | null): boolean {
    if (this.src.isLiveInteractive) return this.src.isLiveInteractive(id, o);
    if (!content) return false;
    for (let cur: THREE.Object3D | null = o; cur; cur = cur.parent) if (cur === content) return true;
    return false;
  }

  private toHit(c: Candidate): Hit {
    _inv.copy(this.root.matrixWorld).invert();
    _p2.copy(c.point).applyMatrix4(_inv);
    const hit: Hit = { entity: c.id, point: [_p2.x, _p2.y, _p2.z], distance: c.dist, interactive: c.interactive };
    if (c.object) hit.object = c.object;
    return hit;
  }

  /** World-space bounds of an entity including its child entities. */
  subtreeBounds(id: string, out: THREE.Box3): THREE.Box3 | null {
    const node = this.src.nodeObject(id);
    if (!node) return null;
    this.ensureMatrices();
    out.makeEmpty();
    node.updateWorldMatrix(true, true);
    expandWorld(node, out);
    if (out.isEmpty()) {
      const lb = this.localBounds(id);
      if (!lb) return null;
      out.copy(lb).applyMatrix4(node.matrixWorld);
    }
    return out;
  }
}

function better(a: Candidate, b: Candidate): boolean {
  if (a.precise !== b.precise) return a.precise;
  return a.dist < b.dist;
}

function betterTouch(a: Candidate, b: Candidate): boolean {
  // Interactive parts win over plain bounds; then nearest; then the most specific (smallest) box.
  if (a.interactive !== b.interactive) return a.interactive;
  if (Math.abs(a.dist - b.dist) > 1e-4) return a.dist < b.dist;
  return a.volume < b.volume;
}

const byDistance = (a: THREE.Intersection, b: THREE.Intersection) => a.distance - b.distance;

function findInteractive(o: THREE.Object3D, set: ReadonlySet<THREE.Object3D>, stop: THREE.Object3D): THREE.Object3D | null {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (set.has(cur)) return cur;
    if (cur === stop) return null;
    cur = cur.parent;
  }
  return null;
}

/** Precise raycast that skips invisible subtrees (three's Raycaster does not). */
function collectIntersections(o: THREE.Object3D, rc: THREE.Raycaster, out: THREE.Intersection[]): void {
  if (!o.visible) return;
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (g) {
    // three's raycast trusts cached bounding spheres; drop them if the data changed.
    if (g.attributes?.position) syncGeometry(g);
    if ((o as THREE.InstancedMesh).isInstancedMesh) syncInstanced(o as THREE.InstancedMesh);
    try { o.raycast(rc, out); } catch { /* malformed geometry: ignore */ }
  }
  const ch = o.children;
  for (let i = 0; i < ch.length; i++) collectIntersections(ch[i], rc, out);
}

/** AABB of `content` expressed in `node`'s local frame. */
function computeLocalBounds(node: THREE.Object3D, content: THREE.Object3D | null, out: THREE.Box3): void {
  out.makeEmpty();
  if (!content) return;
  _inv2.copy(node.matrixWorld).invert();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const b = objectBox(o);
    if (b) {
      _m.multiplyMatrices(_inv2, o.matrixWorld);
      out.union(_box2.copy(b).applyMatrix4(_m));
    }
    for (let i = 0; i < o.children.length; i++) visit(o.children[i]);
  };
  visit(content);
}

function expandWorld(o: THREE.Object3D, out: THREE.Box3): void {
  if (!o.visible) return;
  const b = objectBox(o);
  if (b) out.union(_box2.copy(b).applyMatrix4(o.matrixWorld));
  for (let i = 0; i < o.children.length; i++) expandWorld(o.children[i], out);
}

/**
 * Fresh object-local bounds of a mesh-like object (null: nothing to bound).
 * An InstancedMesh uses its own boundingBox (all instances); anything else
 * its geometry's.
 */
export function objectBox(o: THREE.Object3D): THREE.Box3 | null {
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!g || !g.attributes?.position) return null;
  syncGeometry(g);
  if ((o as THREE.InstancedMesh).isInstancedMesh) {
    const im = o as THREE.InstancedMesh;
    syncInstanced(im);
    if (!im.boundingBox) im.computeBoundingBox();
    return im.boundingBox && !im.boundingBox.isEmpty() ? im.boundingBox : null;
  }
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox && !g.boundingBox.isEmpty() ? g.boundingBox : null;
}

// Cached bounds are only trusted while the data they were computed from is
// unchanged: a widget that rewrites a position attribute (needsUpdate → version
// bump, or a new attribute) or moves instances invalidates them. Stamps are
// per object, so this is a WeakMap lookup and a few compares.
interface GeoStamp { pos: unknown; ver: number }
interface InstStamp { geo: number; mat: number; count: number }
const geoStamps = new WeakMap<THREE.BufferGeometry, GeoStamp>();
const instStamps = new WeakMap<THREE.InstancedMesh, InstStamp>();
let geoEpoch = 0;
const geoEpochs = new WeakMap<THREE.BufferGeometry, number>();

function attrVersion(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  return (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (a as THREE.InterleavedBufferAttribute).data.version
    : (a as THREE.BufferAttribute).version;
}

/** Drop a geometry's cached bounds if its position data changed since they were computed. */
export function syncGeometry(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position;
  if (!pos) return;
  const ver = attrVersion(pos);
  const st = geoStamps.get(g);
  if (!st) {
    geoStamps.set(g, { pos, ver });
    geoEpochs.set(g, ++geoEpoch);
    return;
  }
  if (st.pos === pos && st.ver === ver) return;
  st.pos = pos;
  st.ver = ver;
  g.boundingBox = null;
  g.boundingSphere = null;
  geoEpochs.set(g, ++geoEpoch);
}

/** Drop an InstancedMesh's cached bounds if instances or the geometry changed. */
function syncInstanced(im: THREE.InstancedMesh): void {
  const geo = geoEpochs.get(im.geometry) ?? 0;
  const mat = im.instanceMatrix.version;
  const count = im.count;
  const st = instStamps.get(im);
  if (!st) {
    // A box computed before we started tracking may predate setMatrixAt calls.
    instStamps.set(im, { geo, mat, count });
    im.boundingBox = null;
    return;
  }
  if (st.geo === geo && st.mat === mat && st.count === count) return;
  st.geo = geo;
  st.mat = mat;
  st.count = count;
  im.boundingBox = null;
  im.boundingSphere = null;
}

function padThin(b: THREE.Box3, min: number): void {
  for (const ax of ['x', 'y', 'z'] as const) {
    const d = b.max[ax] - b.min[ax];
    if (d < min) {
      const c = (b.max[ax] + b.min[ax]) / 2;
      b.min[ax] = c - min / 2;
      b.max[ax] = c + min / 2;
    }
  }
}

const _worldRay = new THREE.Ray();
const _localRay = new THREE.Ray();
const _inv = new THREE.Matrix4();
const _inv2 = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Vector3();
const _q2 = new THREE.Vector3();
const _wp = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _best = new THREE.Vector3();
const _bestRay = new THREE.Vector3();
const _size = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _box = new THREE.Box3();
const _box2 = new THREE.Box3();
