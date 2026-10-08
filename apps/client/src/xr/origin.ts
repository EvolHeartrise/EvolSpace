// Space origin: where the shared EvolSpace frame sits in the XR reference space.
//
// Policy (same in VR and AR so both modes share coordinates):
//   1. If the session supports anchors and we have a persisted anchor handle
//      (localStorage), restore it; the origin follows the anchor every frame
//      (the headset re-localizes it, so content stays put across sessions,
//      recenters and mode switches).
//   2. Otherwise, on the first tracked frame, place the origin at the user's
//      feet facing their head direction and, if anchors are supported, anchor +
//      persist it.
//   3. Without anchor support the origin is a plain pose in local-floor
//      (identity until the user recalibrates).
// 'origin.recalibrate' re-places it at the user's feet facing their gaze.
//
// No boundary/bounded-floor assumptions: users can pace a large room freely.

import { clonePose, invertPose, originFromHead, IDENTITY_POSE, type Pose } from '../math/space.ts';

export const ANCHOR_STORAGE_KEY = 'evolspace.origin.anchor';

export type OriginStatus =
  | 'floor'       // local-floor identity (no anchors)
  | 'manual'      // recalibrated pose without anchor support
  | 'restoring'   // waiting for a persisted anchor
  | 'anchoring'   // creating a new anchor
  | 'anchored';   // following a (persistent) anchor

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Storage that never throws (private mode / blocked storage). */
export function safeStorage(): KeyValueStore {
  const mem = new Map<string, string>();
  const ls = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  return {
    getItem: (k) => { try { return ls ? ls.getItem(k) : mem.get(k) ?? null; } catch { return mem.get(k) ?? null; } },
    setItem: (k, v) => { mem.set(k, v); try { ls?.setItem(k, v); } catch { /* ignore */ } },
    removeItem: (k) => { mem.delete(k); try { ls?.removeItem(k); } catch { /* ignore */ } },
  };
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export class SpaceOrigin {
  /** Pose of the space origin in the XR reference space (world). */
  readonly pose: Pose = clonePose(IDENTITY_POSE);
  /** Inverse of `pose` (world → space). Kept in sync. */
  readonly inverse: Pose = clonePose(IDENTITY_POSE);
  status: OriginStatus = 'floor';
  /** Bumps whenever the origin jumps (recalibrate / anchor restore) — consumers can re-sync. */
  revision = 0;

  private session: XRSession | null = null;
  private anchor: XRAnchor | null = null;
  /** Previous anchor, kept until its replacement exists (then deleted). */
  private retiring: XRAnchor | null = null;
  private anchorsSupported = false;
  /** Work to do on the next XR frame (anchor creation needs an XRFrame). */
  private pendingPlace: Pose | 'from-head' | null = null;
  /** Bumps on session start/end: async results from another session are discarded. */
  private generation = 0;
  /**
   * Bumps whenever a newer placement is decided (recalibrate, anchor creation).
   * Async results (restorePersistentAnchor / createAnchor) that resolve after a
   * newer placement are stale and must not pull the origin back.
   */
  private placement = 0;

  constructor(private readonly store: KeyValueStore = safeStorage(), private readonly log: Log = () => {}) {}

  /** Set the origin directly (desktop mode, tests). */
  set(p: Pose): void {
    this.assign(p);
    this.revision++;
  }

  onSessionStart(session: XRSession): void {
    this.session = session;
    this.anchor = null;
    const gen = ++this.generation;
    const s = session as XRSession & { restorePersistentAnchor?: (uuid: string) => Promise<XRAnchor> };
    // Chromium doesn't expose enabledFeatures everywhere; treat the anchor API presence as support.
    const enabled = (session as { enabledFeatures?: string[] }).enabledFeatures;
    this.anchorsSupported = enabled ? enabled.includes('anchors') : typeof (globalThis as { XRAnchor?: unknown }).XRAnchor !== 'undefined';
    const handle = this.store.getItem(ANCHOR_STORAGE_KEY);
    if (this.anchorsSupported && handle && s.restorePersistentAnchor) {
      this.status = 'restoring';
      const placement = this.placement;
      s.restorePersistentAnchor(handle).then(
        (a) => {
          if (gen !== this.generation || placement !== this.placement) {
            // Session ended, or the user recalibrated while the anchor was being
            // restored: the newer placement wins (persist() replaces the stored handle).
            if (gen === this.generation) a?.delete?.();
            return;
          }
          this.anchor = a;
          this.status = 'anchored';
          this.log('info', 'space origin restored from persistent anchor');
        },
        (e) => {
          if (gen !== this.generation || placement !== this.placement) return;
          this.log('warn', `persistent anchor restore failed (${(e as Error)?.message ?? e}); re-anchoring at your feet`);
          this.store.removeItem(ANCHOR_STORAGE_KEY);
          this.pendingPlace = 'from-head';
          this.status = 'anchoring';
        },
      );
    } else if (this.anchorsSupported) {
      this.pendingPlace = 'from-head';
      this.status = 'anchoring';
    } else {
      // No anchors: keep the last pose (recalibrated during this page's lifetime) or local-floor identity.
      this.status = this.status === 'manual' ? 'manual' : 'floor';
    }
  }

  onSessionEnd(): void {
    this.generation++;
    this.session = null;
    this.anchor = null;
    this.retiring = null;
    this.pendingPlace = null;
    // Keep `pose`: desktop preview continues in the same coordinates.
  }

  /** Re-place the origin at the user's feet facing their head direction. */
  recalibrate(head: Pose): void {
    const target = originFromHead(head);
    this.placement++;
    if (this.session && this.anchorsSupported) {
      this.pendingPlace = target;
      this.status = 'anchoring';
    } else {
      this.set(target);
      this.status = this.session ? 'manual' : this.status;
    }
  }

  /** Per XR frame: follow the anchor, perform pending anchor creation. `head` in world coords. */
  update(frame: XRFrame, refSpace: XRReferenceSpace, head: Pose | null): void {
    if (this.pendingPlace) {
      const target = this.pendingPlace === 'from-head' ? (head ? originFromHead(head) : null) : this.pendingPlace;
      if (target) {
        this.pendingPlace = null;
        this.set(target); // show immediately; the anchor refines it once created
        // Stop following the old anchor right away (it would pull the origin back).
        if (this.anchor) { this.retiring?.delete(); this.retiring = this.anchor; this.anchor = null; }
        this.createAnchor(frame, refSpace, target);
      }
    }
    if (this.anchor) {
      const p = frame.getPose(this.anchor.anchorSpace, refSpace);
      if (p) {
        const { position: t, orientation: q } = p.transform;
        this.assign({ position: [t.x, t.y, t.z], rotation: [q.x, q.y, q.z, q.w] });
      }
      // Tracking lost → keep the last pose.
    }
  }

  private createAnchor(frame: XRFrame, refSpace: XRReferenceSpace, target: Pose): void {
    const create = (frame as { createAnchor?: XRFrame['createAnchor'] }).createAnchor;
    if (!create) { this.status = 'manual'; return; }
    const gen = this.generation;
    const placement = ++this.placement;
    const [x, y, z] = target.position;
    const [qx, qy, qz, qw] = target.rotation;
    const xf = new XRRigidTransform({ x, y, z }, { x: qx, y: qy, z: qz, w: qw });
    Promise.resolve(create.call(frame, xf, refSpace)).then(
      async (anchor) => {
        if (!anchor) throw new Error('createAnchor returned nothing');
        // Stale: session ended, or a newer recalibration superseded this one.
        if (gen !== this.generation || placement !== this.placement) { anchor.delete(); return; }
        this.anchor?.delete();
        this.anchor = anchor;
        this.retiring?.delete();
        this.retiring = null;
        this.status = 'anchored';
        this.revision++;
        await this.persist(anchor);
      },
      (e) => {
        if (gen !== this.generation || placement !== this.placement) return;
        this.status = 'manual';
        this.log('warn', `anchor creation failed (${(e as Error)?.message ?? e}); using an unanchored origin`);
      },
    );
  }

  private async persist(anchor: XRAnchor): Promise<void> {
    const a = anchor as XRAnchor & { requestPersistentHandle?: () => Promise<string> };
    const s = this.session as (XRSession & { deletePersistentAnchor?: (uuid: string) => Promise<void> }) | null;
    if (!a.requestPersistentHandle) return;
    try {
      const handle = await a.requestPersistentHandle();
      const old = this.store.getItem(ANCHOR_STORAGE_KEY);
      this.store.setItem(ANCHOR_STORAGE_KEY, handle);
      if (old && old !== handle && s?.deletePersistentAnchor) await s.deletePersistentAnchor(old).catch(() => {});
      this.log('info', 'space origin anchored (persistent)');
    } catch (e) {
      this.log('warn', `could not persist anchor: ${(e as Error)?.message ?? e}`);
    }
  }

  private assign(p: Pose): void {
    for (let i = 0; i < 3; i++) this.pose.position[i] = p.position[i];
    for (let i = 0; i < 4; i++) this.pose.rotation[i] = p.rotation[i];
    invertPose(this.pose, this.inverse);
  }
}
