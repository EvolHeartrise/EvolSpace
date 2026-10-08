// InteractionEngine: poses → bindings → actions.
//
// Every update the engine (1) computes a smoothed hand ray and the ray/touch
// hits per hand, (2) runs the PoseMatcher, (3) resolves a binding for every
// pose that starts and runs its action, (4) drives ongoing actions (grab /
// two-hand scale / widget drags) and (5) reports hover/poke.
//
// Binding resolution (see library/interactions/README.md for the author's view):
//   scopes in order: entity.interactions → widget default interactions →
//   'entity-default' sets → 'global' sets. The first scope with a matching
//   binding wins; inside a scope the highest `priority` wins (ties: first
//   declared; touch-hit entity before ray-hit entity).
//   A binding matches when its pose and hand match and its action can run:
//   - entity / widget / entity-default bindings need their target mode to hit
//     an entity (for entity/widget scopes: that very entity; target 'none' is
//     treated as 'near' there).
//   - widget: only on hits whose object was registered via ctx.interactive().
//   - grab: not on locked entities, nor on one another hand is manipulating.
//   - scale: not on locked entities; only when the OTHER hand is grabbing the
//     hit entity (or an ancestor of it) — the scale then takes over that grab.
//   - hand 'both': the other hand must have the same pose active.
//
// The engine is throttle-free and deterministic given tMs: the host decides
// how often to send ops for setEntityTransform('move').

import type {
  Entity, HandFrame, Handedness, InteractionBinding, InteractionEvent, InteractionSet, PoseDef, PoseEvent, TargetMode,
  Transform, Vec3, Quat,
} from '@evolspace/protocol';
import {
  add, applyFrame, clamp, cloneTransform, dot, length, lookRotation, normalize, qFromAxisAngle, qFromUnitVectors,
  qConj, qMul, qNormalize, qRotate, relativeTo, scale, sub, UP, addScaled, type Pose,
} from './math.ts';
import { HANDS, PoseMatcher, type HandFrames, type PoseTransition } from './matcher.ts';
import type { HeadPose } from './features.ts';
import { INDEX_TIP, WRIST, isValidFrame, jointPos, jointRot } from './joints.ts';
import { RaySmoother, contactPoint, handRay, pinchPoint, type HandRayOptions, type Ray, type RaySmootherOptions } from './ray.ts';

export interface Hit {
  entity: string;
  point: Vec3;
  distance: number;
  /** Name (or uuid) of the THREE object that was hit. */
  object?: string;
  /** True when the hit object was registered via ctx.interactive(). */
  interactive: boolean;
}

export interface InteractionHost {
  raycast(origin: Vec3, dir: Vec3): Hit | null;
  touch(point: Vec3, radius: number): Hit | null;
  getEntity(id: string): Entity | undefined;
  /** Entity transform in space coordinates. */
  getWorldTransform(id: string): Transform;
  widgetBindings(widget: string): InteractionBinding[];
  /**
   * Set an entity's transform, given in SPACE coordinates (same frame as
   * getWorldTransform; the host converts to parent-local). The host previews
   * locally and sends ops on move (throttled) / end.
   */
  setEntityTransform(id: string, t: Transform, phase: 'start' | 'move' | 'end'): void;
  deliver(id: string, e: InteractionEvent): void;
  /** Held commands get start + end; one-shot commands may ignore 'end'. */
  runCommand(name: string, args: Record<string, unknown> | undefined, phase: 'start' | 'end'): void;
  publish(channel: string, value: unknown): void;
  poseEvent(e: PoseEvent): void;
  /** Current near target of each hand (touch hit, else ray hit), every update; null when nothing / not tracked. */
  hover?(hand: Handedness, hit: Hit | null): void;
}

export interface InteractionEngineOptions {
  /** Radius around the contact point (pinch point / index tip) for 'touch' targets. Default 0.03 m. */
  touchRadius?: number;
  /** Deliver 'press' start/end when the extended index tip pokes an interactive object. Default true. */
  poke?: boolean;
  /** Poke contact radius around the index tip. Default 0.012 m. */
  pokeRadius?: number;
  /** Poke release radius (hysteresis). Default 0.025 m. */
  pokeReleaseRadius?: number;
  /** Deliver 'hover' start/move/end to widgets when a hand's near target is an interactive object. Default true. */
  hoverEvents?: boolean;
  /** Two-hand scale rotation: 'yaw' (about world up; default), 'full' (3-DoF), 'none'. */
  scaleRotation?: 'yaw' | 'full' | 'none';
  /** Clamp for every world-scale axis during two-hand scale. Default [0.01, 100]. */
  scaleLimits?: [number, number];
  ray?: HandRayOptions;
  smoothing?: RaySmootherOptions;
  /** Passed to the PoseMatcher. Default 100 ms. */
  lostGraceMs?: number;
}

type Scope = 'entity' | 'widget' | 'entity-default' | 'global';
type Via = 'touch' | 'ray';

interface Manip {
  entity: string;
  mode: 'grab' | 'scale';
  /** Hands taking part and how each acquired the entity (decides the grab pointer). */
  hands: Map<Handedness, Via>;
  /** grab: the grabbing hand and the entity's transform relative to its pointer. */
  grabHand: Handedness;
  offset: Transform;
  /** scale: reference pinch points + entity transform at takeover. */
  scaleRef?: { left: Vec3; right: Vec3; t0: Transform };
  last: Transform;
  dead: boolean;
  /** tMs of the update that created it (no 'move' in that same update). */
  startedAt: number;
}

interface Session {
  hand: Handedness;
  pose: string;
  binding: InteractionBinding;
  scope: Scope;
  target: Hit | null;
  via: Via | null;
  manip?: Manip;
  /** Args used for start, reused for end (commands). */
  args?: Record<string, unknown>;
  /** Widget drag plane (ray sessions). */
  plane?: { point: Vec3; normal: Vec3 };
  /** tMs of the update the session started in. */
  startedAt: number;
}

type Candidate = Omit<Session, 'hand' | 'pose' | 'startedAt'>;

interface Contact {
  entity: string;
  object?: string;
}

interface HandRuntime {
  frame: HandFrame | undefined;
  smoother: RaySmoother;
  ray: Ray | null;
  rayHit: Hit | null;
  touchHit: Hit | null;
  hover: Contact | null;
  poke: Contact | null;
}

export interface SessionInfo {
  hand: Handedness;
  pose: string;
  binding: string;
  scope: Scope;
  action: InteractionBinding['action']['type'];
  target?: string;
  /** For grab/scale: current manipulation mode. */
  mode?: 'grab' | 'scale';
}

const other = (h: Handedness): Handedness => (h === 'left' ? 'right' : 'left');
const key = (hand: Handedness, pose: string) => `${hand}:${pose}`;
const sameContact = (a: Contact | null, b: Contact | null) => a?.entity === b?.entity && a?.object === b?.object;

export class InteractionEngine {
  readonly matcher: PoseMatcher;
  private sets: Record<string, InteractionSet> = {};
  private readonly hands: Record<Handedness, HandRuntime>;
  private readonly sessions = new Map<string, Session>();
  private readonly manips = new Set<Manip>();
  private head: HeadPose = { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] };
  private t = 0;
  private readonly opts: Required<Omit<InteractionEngineOptions, 'ray' | 'smoothing' | 'lostGraceMs'>> & {
    ray: HandRayOptions;
  };

  constructor(private readonly host: InteractionHost, opts: InteractionEngineOptions = {}) {
    this.opts = {
      touchRadius: opts.touchRadius ?? 0.03,
      poke: opts.poke ?? true,
      pokeRadius: opts.pokeRadius ?? 0.012,
      pokeReleaseRadius: opts.pokeReleaseRadius ?? 0.025,
      hoverEvents: opts.hoverEvents ?? true,
      scaleRotation: opts.scaleRotation ?? 'yaw',
      scaleLimits: opts.scaleLimits ?? [0.01, 100],
      ray: opts.ray ?? {},
    };
    this.matcher = new PoseMatcher([], { lostGraceMs: opts.lostGraceMs });
    const mk = (): HandRuntime => ({
      frame: undefined, smoother: new RaySmoother(opts.smoothing), ray: null, rayHit: null, touchHit: null, hover: null, poke: null,
    });
    this.hands = { left: mk(), right: mk() };
  }

  setPoses(poses: PoseDef[]): void {
    this.matcher.setPoses(poses);
  }

  setInteractions(sets: Record<string, InteractionSet>): void {
    this.sets = { ...sets };
  }

  /** Smoothed ray + ray hit per tracked hand. */
  rays(): Partial<Record<Handedness, { origin: Vec3; direction: Vec3; hit: Hit | null }>> {
    const out: Partial<Record<Handedness, { origin: Vec3; direction: Vec3; hit: Hit | null }>> = {};
    for (const h of HANDS) {
      const hs = this.hands[h];
      if (hs.frame && hs.ray) out[h] = { origin: hs.ray.origin, direction: hs.ray.direction, hit: hs.rayHit };
    }
    return out;
  }

  /** Active pose ids per hand. */
  activePoses(hand: Handedness): string[] {
    return this.matcher.active(hand);
  }

  /** Running binding sessions (for HUDs, debugging, tests). */
  activeSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      hand: s.hand,
      pose: s.pose,
      binding: s.binding.id,
      scope: s.scope,
      action: s.binding.action.type,
      target: s.manip?.entity ?? s.target?.entity,
      mode: s.manip?.mode,
    }));
  }

  update(frames: HandFrames, head: HeadPose, tMs: number): void {
    this.head = head;
    this.t = tMs;

    // 1. Rays and hits.
    for (const hand of HANDS) {
      const hs = this.hands[hand];
      const frame = frames[hand];
      if (!isValidFrame(frame)) {
        hs.frame = undefined;
        hs.ray = null;
        hs.rayHit = null;
        hs.touchHit = null;
        hs.smoother.reset();
        continue;
      }
      hs.frame = frame;
      hs.ray = hs.smoother.update(handRay(frame, head, this.opts.ray), tMs);
      hs.rayHit = this.host.raycast(hs.ray.origin, hs.ray.direction);
      hs.touchHit = this.host.touch(contactPoint(frame), this.opts.touchRadius);
    }

    // Host callbacks (commands, widgets, ops) may throw. Each step is isolated so
    // one failure can't skip the remaining transitions of this update — the
    // matcher has already emitted them, so a skipped 'end' would leave a grab or
    // push-to-talk running forever. The first error is rethrown at the end.
    let error: unknown = null;
    const guard = (fn: () => void): void => {
      try { fn(); } catch (e) { error ??= e; }
    };

    // 2–3. Pose transitions → bindings.
    const transitions = this.matcher.update(frames, head, tMs);
    for (const tr of transitions) guard(() => (tr.phase === 'end' ? this.onPoseEnd(tr) : this.onPoseStart(tr)));

    // 4. Ongoing actions.
    for (const m of this.manips) guard(() => this.driveManip(m));
    for (const s of this.sessions.values()) {
      if (s.binding.action.type === 'widget' && s.startedAt !== tMs && this.hands[s.hand].frame) guard(() => this.deliverWidget(s, 'move'));
    }

    // 5. Hover + poke.
    for (const hand of HANDS) guard(() => this.updateHoverAndPoke(hand));
    if (error !== null) throw error;
  }

  /**
   * End every running session (e.g. when the XR session ends). Widget sessions
   * get 'cancel'. Poses that are still held stay active in the matcher without
   * a session, so they do NOT re-trigger their bindings; they fire again only
   * after being released and re-made.
   */
  cancelAll(): void {
    let error: unknown = null;
    const guard = (fn: () => void): void => {
      try { fn(); } catch (e) { error ??= e; }
    };
    for (const s of [...this.sessions.values()]) guard(() => this.endSession(s, true));
    for (const hand of HANDS) {
      const hs = this.hands[hand];
      const { hover, poke } = hs;
      hs.hover = null;
      hs.poke = null;
      if (hover) guard(() => this.deliverContact(hand, hover, 'hover', 'end', null));
      if (poke) guard(() => this.deliverContact(hand, poke, 'press', 'cancel', null));
    }
    if (error !== null) throw error;
  }

  // ------------------------------------------------------------ resolution

  private targetFor(hand: Handedness, mode: TargetMode): { hit: Hit | null; via: Via | null } {
    const hs = this.hands[hand];
    switch (mode) {
      case 'ray': return { hit: hs.rayHit, via: hs.rayHit ? 'ray' : null };
      case 'touch': return { hit: hs.touchHit, via: hs.touchHit ? 'touch' : null };
      case 'near':
        if (hs.touchHit) return { hit: hs.touchHit, via: 'touch' };
        return { hit: hs.rayHit, via: hs.rayHit ? 'ray' : null };
      default: return { hit: null, via: null };
    }
  }

  /** True when `id` is `ancestor` or one of its descendants. */
  private isWithin(id: string, ancestor: string): boolean {
    let cur: string | null | undefined = id;
    for (let i = 0; cur && i < 64; i++) {
      if (cur === ancestor) return true;
      cur = this.host.getEntity(cur)?.parent;
    }
    return false;
  }

  private manipOf(entity: string): Manip | undefined {
    for (const m of this.manips) if (!m.dead && m.entity === entity) return m;
    return undefined;
  }

  private handMatches(binding: InteractionBinding, hand: Handedness, pose: string): boolean {
    const bh = binding.hand ?? 'either';
    if (bh === 'either') return true;
    if (bh === 'both') return this.matcher.isActive(other(hand), pose);
    return bh === hand;
  }

  private consider(
    scope: Scope, binding: InteractionBinding, hand: Handedness, pose: string, owner?: string,
  ): Candidate | null {
    if (binding.pose !== pose || !this.handMatches(binding, hand, pose)) return null;
    const scoped = scope !== 'global';
    const mode: TargetMode = owner !== undefined && binding.target === 'none' ? 'near' : binding.target;
    const { hit, via } = this.targetFor(hand, mode);
    if (scoped && !hit) return null;
    if (owner !== undefined && hit?.entity !== owner) return null;
    const action = binding.action;
    switch (action.type) {
      case 'widget':
        if (!hit || !hit.interactive) return null;
        break;
      case 'grab': {
        if (!hit) return null;
        const e = this.host.getEntity(hit.entity);
        if (!e || e.locked || this.manipOf(hit.entity)) return null;
        break;
      }
      case 'scale': {
        if (!hit) return null;
        const m = this.findGrabToScale(hand, hit.entity);
        if (!m) return null;
        const e = this.host.getEntity(m.entity);
        if (!e || e.locked) return null;
        return { binding, scope, target: hit, via, manip: m };
      }
      default:
        break;
    }
    return { binding, scope, target: hit, via };
  }

  /** The other hand's one-hand grab on `entity` or one of its ancestors. */
  private findGrabToScale(hand: Handedness, hitEntity: string): Manip | undefined {
    const o = other(hand);
    for (const m of this.manips) {
      if (m.dead || m.mode !== 'grab' || m.grabHand !== o || m.hands.has(hand)) continue;
      if (this.isWithin(hitEntity, m.entity)) return m;
    }
    return undefined;
  }

  private resolve(hand: Handedness, pose: string): Candidate | null {
    const hs = this.hands[hand];
    const hitEntities: string[] = [];
    for (const h of [hs.touchHit, hs.rayHit]) if (h && !hitEntities.includes(h.entity)) hitEntities.push(h.entity);

    const pick = (cands: Array<Candidate>) => {
      let best: Candidate | null = null;
      for (const c of cands) if (!best || (c.binding.priority ?? 0) > (best.binding.priority ?? 0)) best = c;
      return best;
    };
    const collect = (scope: Scope, list: Iterable<{ b: InteractionBinding; owner?: string }>) => {
      const out: Array<Candidate> = [];
      for (const { b, owner } of list) {
        const c = this.consider(scope, b, hand, pose, owner);
        if (c) out.push(c);
      }
      return pick(out);
    };

    const entities = hitEntities.map((id) => this.host.getEntity(id)).filter((e): e is Entity => !!e);
    const entityScope = entities.flatMap((e) => (e.interactions ?? []).map((b) => ({ b, owner: e.id })));
    const widgetScope = entities.flatMap((e) => this.host.widgetBindings(e.widget).map((b) => ({ b, owner: e.id })));
    const setScope = (scope: InteractionSet['scope']) =>
      Object.keys(this.sets).sort().flatMap((name) => (this.sets[name].scope === scope ? this.sets[name].bindings : []).map((b) => ({ b })));

    return (
      collect('entity', entityScope) ??
      collect('widget', widgetScope) ??
      collect('entity-default', setScope('entity-default')) ??
      collect('global', setScope('global'))
    );
  }

  // ------------------------------------------------------------ pose start / end

  private onPoseStart(tr: PoseTransition): void {
    const { hand, pose } = tr;
    const r = this.resolve(hand, pose);
    const ev: PoseEvent = { pose, hand, phase: 'start', t: tr.t };
    if (!r) {
      this.host.poseEvent(ev);
      return;
    }
    const s: Session = { hand, pose, ...r, startedAt: tr.t };
    this.sessions.set(key(hand, pose), s);
    ev.binding = s.binding.id;
    const targetEntity = s.manip?.entity ?? s.target?.entity;
    if (targetEntity) ev.target = targetEntity;
    this.host.poseEvent(ev);
    this.startAction(s);
  }

  private onPoseEnd(tr: PoseTransition): void {
    const s = this.sessions.get(key(tr.hand, tr.pose));
    const ev: PoseEvent = { pose: tr.pose, hand: tr.hand, phase: 'end', t: tr.t };
    if (s) {
      ev.binding = s.binding.id;
      const targetEntity = s.manip?.entity ?? s.target?.entity;
      if (targetEntity) ev.target = targetEntity;
    }
    this.host.poseEvent(ev);
    if (s) this.endSession(s, !!tr.lost);
    // Two-handed ('both') bindings on the other hand end when either hand lets go
    // (scale is handled by its manipulation, which falls back to a one-hand grab).
    const os = this.sessions.get(key(other(tr.hand), tr.pose));
    if (os && os.binding.hand === 'both' && os.binding.action.type !== 'scale') {
      this.host.poseEvent({ pose: os.pose, hand: os.hand, phase: 'end', t: tr.t, binding: os.binding.id, ...(os.target ? { target: os.target.entity } : {}) });
      this.endSession(os, !!tr.lost);
    }
  }

  private startAction(s: Session): void {
    const a = s.binding.action;
    switch (a.type) {
      case 'grab': {
        const id = s.target!.entity;
        const t0 = cloneTransform(this.host.getWorldTransform(id));
        const via = s.via ?? 'ray';
        const m: Manip = {
          entity: id, mode: 'grab', hands: new Map([[s.hand, via]]), grabHand: s.hand,
          offset: relativeTo(this.pointer(s.hand, via), t0), last: t0, dead: false, startedAt: this.t,
        };
        this.manips.add(m);
        s.manip = m;
        this.host.setEntityTransform(id, cloneTransform(t0), 'start');
        break;
      }
      case 'scale': {
        const m = s.manip!;
        m.hands.set(s.hand, s.via ?? 'ray');
        m.mode = 'scale';
        m.scaleRef = { left: this.pinchOf('left'), right: this.pinchOf('right'), t0: cloneTransform(m.last) };
        break;
      }
      case 'widget': {
        const hit = s.target!;
        if (s.via === 'ray') {
          const wt = this.host.getWorldTransform(hit.entity);
          s.plane = { point: hit.point, normal: normalize(qRotate(wt.rotation, [0, 0, 1])) };
        }
        // Ray drags start at the hit point (moves stay on its plane). Touch drags
        // report the hand's contact point throughout — the host's touch hit point
        // may be clamped onto the object's surface, which would make the first
        // 'move' jump by up to the touch radius.
        this.deliverWidget(s, 'start', s.via === 'touch' ? undefined : hit.point);
        break;
      }
      case 'command': {
        const args: Record<string, unknown> = { ...(a.args ?? {}), hand: s.hand };
        if (s.target) {
          args.entity = s.target.entity;
          args.point = s.target.point;
        } else if (s.binding.target !== 'none' && !('entity' in args)) {
          // A targeted binding that hit nothing: say so explicitly (e.g. 'select' → clear selection).
          args.entity = null;
        }
        s.args = args;
        this.host.runCommand(a.command, args, 'start');
        break;
      }
      case 'channel':
        this.host.publish(a.channel, a.value);
        break;
    }
  }

  private endSession(s: Session, lost: boolean): void {
    this.sessions.delete(key(s.hand, s.pose));
    const a = s.binding.action;
    switch (a.type) {
      case 'grab':
      case 'scale':
        if (s.manip) this.releaseHand(s.manip, s.hand);
        break;
      case 'widget':
        this.deliverWidget(s, lost ? 'cancel' : 'end');
        break;
      case 'command':
        this.host.runCommand(a.command, s.args, 'end');
        break;
      case 'channel':
        if (a.endValue !== undefined) this.host.publish(a.channel, a.endValue);
        break;
    }
  }

  /** A hand lets go of a manipulation: scale falls back to a one-hand grab; the last hand ends it. */
  private releaseHand(m: Manip, hand: Handedness): void {
    if (!m.hands.delete(hand)) return;
    if (m.hands.size > 0 && !m.dead) {
      const [rest, via] = [...m.hands.entries()][0];
      m.mode = 'grab';
      m.grabHand = rest;
      m.scaleRef = undefined;
      m.offset = relativeTo(this.pointer(rest, via), m.last);
      return;
    }
    this.manips.delete(m);
    if (!m.dead) this.host.setEntityTransform(m.entity, cloneTransform(m.last), 'end');
    m.dead = true;
  }

  // ------------------------------------------------------------ continuous actions

  /** Rigid pointer frame the grabbed entity is attached to. */
  private pointer(hand: Handedness, via: Via): Pose {
    const hs = this.hands[hand];
    if (via === 'ray' && hs.ray) return { position: hs.ray.origin, rotation: lookRotation(hs.ray.direction) };
    if (hs.frame) return { position: pinchPoint(hs.frame), rotation: jointRot(hs.frame, WRIST) };
    return { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  }

  private pinchOf(hand: Handedness): Vec3 {
    const f = this.hands[hand].frame;
    return f ? pinchPoint(f) : [0, 0, 0];
  }

  private driveManip(m: Manip): void {
    if (m.dead || m.startedAt === this.t) return;
    if (!this.host.getEntity(m.entity)) {
      // Entity deleted mid-gesture: drop silently.
      m.dead = true;
      this.manips.delete(m);
      return;
    }
    for (const h of m.hands.keys()) if (!this.hands[h].frame) return; // hand briefly lost: hold
    let t: Transform;
    if (m.mode === 'grab') {
      t = applyFrame(this.pointer(m.grabHand, m.hands.get(m.grabHand)!), m.offset);
    } else {
      // Pivot about the hands only when both hands are actually on the object
      // (touch). For ray-acquired (distant) objects the hands' midpoint is far
      // from the object: scaling about it would push the object away / swing it
      // around the user, so scale and rotate about the object's own origin.
      let allTouch = true;
      for (const via of m.hands.values()) if (via !== 'touch') allTouch = false;
      t = this.scaleTransform(m.scaleRef!, this.pinchOf('left'), this.pinchOf('right'), allTouch ? 'hands' : 'object');
    }
    m.last = t;
    this.host.setEntityTransform(m.entity, cloneTransform(t), 'move');
  }

  /**
   * Two-hand translate / rotate / uniform scale. Translation follows the
   * midpoint between the pinch points; rotation and scale pivot about that
   * midpoint ('hands') or about the entity's origin ('object').
   */
  private scaleTransform(ref: NonNullable<Manip['scaleRef']>, l: Vec3, r: Vec3, pivot: 'hands' | 'object'): Transform {
    const m0 = scale(add(ref.left, ref.right), 0.5);
    const m1 = scale(add(l, r), 0.5);
    const v0 = sub(ref.right, ref.left);
    const v1 = sub(r, l);
    const t0 = ref.t0;
    let s = length(v0) > 1e-3 ? length(v1) / length(v0) : 1;
    const [lo, hi] = this.opts.scaleLimits;
    const minAxis = Math.min(...t0.scale.map(Math.abs));
    const maxAxis = Math.max(...t0.scale.map(Math.abs));
    if (minAxis > 0) s = clamp(s, lo / minAxis, hi / maxAxis);
    let rot: Quat = [0, 0, 0, 1];
    if (this.opts.scaleRotation === 'yaw') {
      const h0 = Math.hypot(v0[0], v0[2]);
      const h1 = Math.hypot(v1[0], v1[2]);
      if (h0 > 1e-3 && h1 > 1e-3) rot = qFromAxisAngle(UP, Math.atan2(v1[0], v1[2]) - Math.atan2(v0[0], v0[2]));
    } else if (this.opts.scaleRotation === 'full' && length(v0) > 1e-3 && length(v1) > 1e-3) {
      rot = qFromUnitVectors(normalize(v0), normalize(v1));
    }
    return {
      position: pivot === 'hands'
        ? add(m1, qRotate(rot, scale(sub(t0.position, m0), s)))
        : add(t0.position, sub(m1, m0)),
      rotation: qNormalize(qMul(rot, t0.rotation)),
      scale: [t0.scale[0] * s, t0.scale[1] * s, t0.scale[2] * s],
    };
  }

  /** Current interaction point of a widget session. */
  private widgetPoint(s: Session): Vec3 {
    const hs = this.hands[s.hand];
    if (!hs.frame) return s.target!.point;
    if (s.via === 'ray' && hs.ray) {
      const { origin, direction } = hs.ray;
      if (s.plane) {
        const denom = dot(direction, s.plane.normal);
        if (Math.abs(denom) > 0.1) {
          const d = dot(sub(s.plane.point, origin), s.plane.normal) / denom;
          if (d > 0) return addScaled(origin, direction, d);
        }
      }
      return addScaled(origin, direction, s.target!.distance);
    }
    return contactPoint(hs.frame);
  }

  private pointerPose(hand: Handedness, at: Vec3): { position: Vec3; rotation: Quat } {
    const hs = this.hands[hand];
    return { position: at, rotation: hs.ray ? lookRotation(hs.ray.direction) : [0, 0, 0, 1] };
  }

  private toLocal(entity: string, p: Vec3): Vec3 {
    const wt = this.host.getWorldTransform(entity);
    const local = qRotate(qConj(wt.rotation), sub(p, wt.position));
    return [local[0] / (wt.scale[0] || 1), local[1] / (wt.scale[1] || 1), local[2] / (wt.scale[2] || 1)];
  }

  private deliverWidget(s: Session, phase: InteractionEvent['phase'], at?: Vec3): void {
    const a = s.binding.action;
    if (a.type !== 'widget' || !s.target) return;
    const id = s.target.entity;
    if (!this.host.getEntity(id)) return;
    const point = at ?? this.widgetPoint(s);
    const e: InteractionEvent = {
      handler: a.handler, phase, hand: s.hand, localPoint: this.toLocal(id, point), point,
      pointer: this.pointerPose(s.hand, this.hands[s.hand].frame ? contactPoint(this.hands[s.hand].frame!) : point),
    };
    if (s.target.object !== undefined) e.objectName = s.target.object;
    this.host.deliver(id, e);
  }

  // ------------------------------------------------------------ hover & poke

  private deliverContact(hand: Handedness, c: Contact, handler: string, phase: InteractionEvent['phase'], point: Vec3 | null): void {
    if (!this.host.getEntity(c.entity)) return;
    const hs = this.hands[hand];
    const p = point ?? (hs.frame ? contactPoint(hs.frame) : [0, 0, 0]);
    const e: InteractionEvent = {
      handler, phase, hand, point: p, localPoint: this.toLocal(c.entity, p), pointer: this.pointerPose(hand, p),
    };
    if (c.object !== undefined) e.objectName = c.object;
    this.host.deliver(c.entity, e);
  }

  private updateHoverAndPoke(hand: Handedness): void {
    const hs = this.hands[hand];
    const near = hs.frame ? hs.touchHit ?? hs.rayHit : null;
    this.host.hover?.(hand, near);

    if (this.opts.hoverEvents) {
      const next: Contact | null = near && near.interactive ? { entity: near.entity, object: near.object } : null;
      if (!sameContact(hs.hover, next)) {
        if (hs.hover) this.deliverContact(hand, hs.hover, 'hover', 'end', null);
        if (next) this.deliverContact(hand, next, 'hover', 'start', near!.point);
        hs.hover = next;
      } else if (next) {
        this.deliverContact(hand, next, 'hover', 'move', near!.point);
      }
    }

    if (this.opts.poke) this.updatePoke(hand);
  }

  private updatePoke(hand: Handedness): void {
    const hs = this.hands[hand];
    const f = this.matcher.features(hand);
    if (!hs.frame || !f) {
      if (hs.poke) this.deliverContact(hand, hs.poke, 'press', 'cancel', null);
      hs.poke = null;
      return;
    }
    const tip = jointPos(hs.frame, INDEX_TIP);
    if (hs.poke) {
      const hit = this.host.touch(tip, this.opts.pokeReleaseRadius);
      if (!hit || !sameContact(hs.poke, { entity: hit.entity, object: hit.object })) {
        this.deliverContact(hand, hs.poke, 'press', 'end', tip);
        hs.poke = null;
      }
      return;
    }
    // Only an extended, non-pinching index finger pokes.
    if ((f['curl.index'] ?? 1) > 0.35 || (f['pinch.index'] ?? 0) < 0.04) return;
    const hit = this.host.touch(tip, this.opts.pokeRadius);
    if (hit && hit.interactive) {
      hs.poke = { entity: hit.entity, object: hit.object };
      this.deliverContact(hand, hs.poke, 'press', 'start', hit.point);
    }
  }

  /** Current time of the last update (ms). */
  get time(): number {
    return this.t;
  }

  /** Head pose of the last update. */
  get headPose(): HeadPose {
    return this.head;
  }
}
