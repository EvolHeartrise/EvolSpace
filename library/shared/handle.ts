// Interactive parts: draggable handles/knobs and pressable buttons.
//
// How hand input reaches a widget (see library/interactions/README.md):
//   - ctx.interactive(obj) marks a hit target. Only such parts get widget events.
//   - 'hover' start/move/end: a hand's near target is the part.
//   - 'press' start/end/cancel: pinch on the part (standard 'press' binding),
//     or an extended index finger poking it.
//   - custom handlers: a widget's default `interactions` can bind a pose to
//     {type:'widget', handler:'drag'}; that binding (widget scope) wins over
//     the standard press/grab for interactive parts. Pinching anything that is
//     NOT interactive still grabs the whole widget.
// InteractionEvent.localPoint is in ctx.root coordinates.
//
// DragHandle turns those events into start/move/end callbacks with points in
// ctx.root space and a tracked delta; PressTracker turns press events from
// any number of hands into clean down/up transitions. Both are allocation-free
// per event.

import type { Handedness, InteractionEvent, Vec3 } from '@evolspace/protocol';
import type * as THREE from 'three';

type Three = typeof THREE;

/** The default binding that makes interactive parts draggable with a pinch (use in WidgetDefinition.interactions). */
export function dragBinding(id = 'drag', handler = 'drag') {
  return {
    id,
    description: 'Pinch an interactive part (knob/handle) and move the hand to drag it.',
    pose: 'pinch',
    hand: 'either' as const,
    target: 'near' as const,
    action: { type: 'widget' as const, handler },
    priority: 10,
  };
}

export interface DragCallbacks {
  /** Drag began on part `part` (object name) at `p` (ctx.root coords). */
  onStart?(p: THREE.Vector3, part: string | undefined, e: InteractionEvent): void;
  /** `delta` = p − start point. Vectors are reused: copy them if you keep them. */
  onMove?(p: THREE.Vector3, delta: THREE.Vector3, e: InteractionEvent): void;
  onEnd?(cancelled: boolean, e: InteractionEvent): void;
  /** Hover state of the handle parts changed (any hand). */
  onHover?(hovered: boolean, part: string | undefined): void;
}

export interface DragHandleOptions extends DragCallbacks {
  /** Handlers treated as drags. Default ['drag', 'press'] (press = poke/pinch without a custom binding). */
  handlers?: string[];
  /** Restrict to these part names (object names). Default: any interactive part. */
  parts?: string[];
}

/**
 * One drag at a time (the first hand wins; other hands are ignored until it ends).
 * Call `handle(e)` from WidgetInstance.onInteraction; it returns true when consumed.
 */
export class DragHandle {
  readonly start: THREE.Vector3;
  readonly point: THREE.Vector3;
  readonly delta: THREE.Vector3;
  private hand: Handedness | null = null;
  private hoverHands = 0;
  private hoverPart: string | undefined;
  private readonly handlers: string[];

  constructor(T: Three, private opts: DragHandleOptions = {}) {
    this.start = new T.Vector3();
    this.point = new T.Vector3();
    this.delta = new T.Vector3();
    this.handlers = opts.handlers ?? ['drag', 'press'];
  }

  get dragging(): boolean {
    return this.hand !== null;
  }

  get hovered(): boolean {
    return this.hoverHands > 0;
  }

  handle(e: InteractionEvent): boolean {
    if (this.opts.parts && e.objectName !== undefined && !this.opts.parts.includes(e.objectName)) {
      // Moves/ends of an ongoing drag may report another part; only filter new contacts.
      if (e.phase === 'start' || e.handler === 'hover') return false;
    }
    if (e.handler === 'hover') {
      const bit = e.hand === 'left' ? 1 : 2;
      const before = this.hoverHands;
      if (e.phase === 'start' || e.phase === 'move') this.hoverHands |= bit;
      else this.hoverHands &= ~bit;
      if (!!before !== !!this.hoverHands || (e.phase === 'start' && e.objectName !== this.hoverPart)) {
        this.hoverPart = this.hoverHands ? e.objectName : undefined;
        this.opts.onHover?.(this.hoverHands > 0, this.hoverPart);
      }
      return true;
    }
    if (!this.handlers.includes(e.handler)) return false;
    const lp = e.localPoint;
    switch (e.phase) {
      case 'start':
        if (this.hand !== null) return true; // already dragging with another hand
        this.hand = e.hand;
        this.start.set(lp[0], lp[1], lp[2]);
        this.point.copy(this.start);
        this.delta.set(0, 0, 0);
        this.opts.onStart?.(this.point, e.objectName, e);
        return true;
      case 'move':
        if (this.hand !== e.hand) return true;
        this.point.set(lp[0], lp[1], lp[2]);
        this.delta.subVectors(this.point, this.start);
        this.opts.onMove?.(this.point, this.delta, e);
        return true;
      case 'end':
      case 'cancel':
        if (this.hand !== e.hand) return true;
        this.hand = null;
        this.opts.onEnd?.(e.phase === 'cancel', e);
        return true;
    }
    return false;
  }

  /** Abort an ongoing drag without callbacks (e.g. on rebuild). */
  reset(): void {
    this.hand = null;
    this.hoverHands = 0;
    this.hoverPart = undefined;
  }
}

/**
 * Press state across hands/handlers: `down` once when the first press starts,
 * `up` when the last one ends (cancelled = every contributing press was cancelled).
 */
export class PressTracker {
  private active = 0; // bitmask: left=1, right=2
  private anyCompleted = false;

  constructor(private handlers: string[] = ['press']) {}

  get pressed(): boolean {
    return this.active !== 0;
  }

  /** Returns 'down' | 'up' | 'cancel' on a transition, null otherwise. */
  handle(e: InteractionEvent): 'down' | 'up' | 'cancel' | null {
    if (!this.handlers.includes(e.handler)) return null;
    const bit = e.hand === 'left' ? 1 : 2;
    if (e.phase === 'start') {
      const was = this.active;
      this.active |= bit;
      if (!was) {
        this.anyCompleted = false;
        return 'down';
      }
      return null;
    }
    if (e.phase === 'end' || e.phase === 'cancel') {
      if (!(this.active & bit)) return null;
      this.active &= ~bit;
      if (e.phase === 'end') this.anyCompleted = true;
      if (!this.active) return this.anyCompleted ? 'up' : 'cancel';
    }
    return null;
  }

  reset(): void {
    this.active = 0;
    this.anyCompleted = false;
  }
}

/**
 * Visual states for a knob/handle mesh: idle / hover / active, by swapping
 * between preallocated materials and scaling (no per-frame allocation).
 */
export class KnobVisual {
  private hover = false;
  private activeState = false;
  constructor(
    private mesh: THREE.Mesh,
    private mats: { idle: THREE.Material; hover: THREE.Material; active: THREE.Material },
    private baseScale: number,
    private hoverScale = 1.25,
  ) {
    this.apply();
  }

  setHover(v: boolean): void {
    if (this.hover !== v) { this.hover = v; this.apply(); }
  }

  setActive(v: boolean): void {
    if (this.activeState !== v) { this.activeState = v; this.apply(); }
  }

  setBaseScale(s: number): void {
    this.baseScale = s;
    this.apply();
  }

  /** Dispose the three state materials (they are owned by the visual). */
  dispose(): void {
    this.mats.idle.dispose();
    this.mats.hover.dispose();
    this.mats.active.dispose();
  }

  private apply(): void {
    this.mesh.material = this.activeState ? this.mats.active : this.hover ? this.mats.hover : this.mats.idle;
    const s = this.baseScale * (this.activeState || this.hover ? this.hoverScale : 1);
    this.mesh.scale.setScalar(s);
  }
}

/** Project a delta onto a unit axis given as [x, y, z]. */
export function along(delta: THREE.Vector3, axis: Vec3): number {
  return delta.x * axis[0] + delta.y * axis[1] + delta.z * axis[2];
}
