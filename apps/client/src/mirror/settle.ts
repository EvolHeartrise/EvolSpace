// "Wait until the scene is done loading" for screenshots.
//
// Half-loaded screenshots are useless, so before capturing we:
//   1. await the runtime's own idle signal, if it offers one (pending widget
//      imports / async create());
//   2. await every troika text mesh that is syncing (font fetch + SDF layout);
//   3. await images backing textures;
//   4. step frames (update + render) until the scene graph's structure
//      (object count, vertex counts, pending work) has been stable for a quiet
//      period and at least a couple of frames — this also catches widgets that
//      build geometry a frame or two after create().
// Everything is bounded by maxMs; the report says if we gave up.
import type * as THREE from 'three';

export interface SettleOptions {
  /** Scene graphs to inspect. */
  roots: THREE.Object3D[];
  /** Advance one frame: runtime.update(...) + renderer.render(...). */
  step: () => void;
  /** Optional runtime-provided "no pending widget loads" promise factory. */
  runtimeIdle?: () => Promise<unknown>;
  /** Timestamp (performance.now()) of the latest scene-affecting network message. */
  lastActivity?: () => number;
  /**
   * Optional "everything that should exist has been created" check (e.g. every
   * scene entity has a rendered object). While false we keep waiting, but only
   * for up to `loadGraceMs`, because an entity may legitimately render nothing.
   */
  isLoaded?: () => boolean;
  /** Default 4000. */
  loadGraceMs?: number;
  /** Structure must be unchanged this long (ms). Default 150. */
  quietMs?: number;
  /** Minimum frames stepped. Default 3. */
  minFrames?: number;
  /** Give up after this long (ms). Default 8000. */
  maxMs?: number;
}

export interface SettleReport {
  ms: number;
  frames: number;
  timedOut: boolean;
  /** Text meshes still syncing / images still loading when we stopped. */
  pending: number;
}

interface TroikaLike extends THREE.Object3D {
  sync(cb?: () => void): void;
  _needsSync?: boolean;
  _isSyncing?: boolean;
}

function isTroikaText(o: THREE.Object3D): o is TroikaLike {
  return typeof (o as Partial<TroikaLike>).sync === 'function' && 'textRenderInfo' in o;
}

/** Starts syncing any troika text that needs it; returns promises for all in-flight syncs. */
export function pendingTextSyncs(roots: THREE.Object3D[]): Promise<void>[] {
  const out: Promise<void>[] = [];
  for (const root of roots) {
    root.traverse((o) => {
      if (!isTroikaText(o)) return;
      if (o._needsSync) {
        out.push(new Promise<void>((resolve) => o.sync(resolve)));
      } else if (o._isSyncing) {
        out.push(new Promise<void>((resolve) => {
          const done = (): void => { o.removeEventListener('synccomplete' as never, done); resolve(); };
          o.addEventListener('synccomplete' as never, done);
        }));
      }
    });
  }
  return out;
}

/** Images (HTMLImageElement) referenced by textures that have not finished loading. */
export function pendingImages(roots: THREE.Object3D[]): Promise<void>[] {
  const seen = new Set<unknown>();
  const out: Promise<void>[] = [];
  const check = (tex: unknown): void => {
    const img = (tex as { image?: unknown } | null)?.image;
    if (!img || seen.has(img) || typeof HTMLImageElement === 'undefined' || !(img instanceof HTMLImageElement)) return;
    seen.add(img);
    if (!img.complete) out.push(img.decode().catch(() => undefined));
  };
  for (const root of roots) {
    root.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        for (const v of Object.values(m)) if ((v as { isTexture?: boolean } | null)?.isTexture) check(v);
      }
    });
  }
  return out;
}

/** Cheap structural fingerprint of the scene graphs. Animation does not change it; loading does. */
export function structureSignature(roots: THREE.Object3D[]): string {
  let objects = 0, visible = 0, verts = 0, materials = 0;
  for (const root of roots) {
    root.traverse((o) => {
      objects++;
      if (o.visible) visible++;
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const pos = g?.attributes?.position;
      if (pos) verts += pos.count;
      // Instanced meshes grow by count, not vertices.
      const inst = (o as THREE.InstancedMesh).count;
      if (typeof inst === 'number' && (o as THREE.InstancedMesh).isInstancedMesh) verts += inst * 7919;
      if ((o as THREE.Mesh).material) materials++;
    });
  }
  return `${objects}/${visible}/${verts}/${materials}`;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    // rAF can be throttled in some headless configurations; never wait > 50 ms.
    const t = setTimeout(resolve, 50);
    requestAnimationFrame(() => { clearTimeout(t); resolve(); });
  });

function race(ps: Promise<unknown>[], ms: number): Promise<boolean> {
  if (ps.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), Math.max(0, ms));
    void Promise.all(ps).then(() => { clearTimeout(t); resolve(true); });
  });
}

export async function settle(opts: SettleOptions): Promise<SettleReport> {
  const quietMs = opts.quietMs ?? 150;
  const minFrames = opts.minFrames ?? 3;
  const maxMs = opts.maxMs ?? 8000;
  const loadGrace = opts.loadGraceMs ?? 4000;
  const t0 = performance.now();
  const deadline = t0 + maxMs;
  let frames = 0;
  let lastSig = '';
  let lastChange = t0;
  let pending = 0;

  for (;;) {
    const now = performance.now();
    if (now >= deadline) return { ms: now - t0, frames, timedOut: true, pending };

    if (opts.runtimeIdle) await race([opts.runtimeIdle()], deadline - now);
    const waits = [...pendingTextSyncs(opts.roots), ...pendingImages(opts.roots)];
    pending = waits.length;
    if (waits.length) {
      lastChange = performance.now();
      if (await race(waits, deadline - performance.now())) pending = 0;
    }

    opts.step();
    frames++;
    const sig = structureSignature(opts.roots);
    const t = performance.now();
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = t;
    }
    const activity = opts.lastActivity?.() ?? 0;
    const quietSince = Math.max(lastChange, activity);
    const loaded = !opts.isLoaded || t - t0 >= loadGrace || opts.isLoaded();
    if (frames >= minFrames && t - quietSince >= quietMs && pending === 0 && loaded) {
      return { ms: t - t0, frames, timedOut: false, pending: 0 };
    }
    await nextFrame();
  }
}
