// Read-only "which binding would fire" explainer for the Hands workbench. It
// mirrors InteractionEngine's resolution (packages/input/src/engine.ts) from
// public data only — current ray/touch hits, the entity's own bindings, its
// widget's default bindings, the interaction sets and the running sessions —
// so it never touches the engine's state. Scope order: entity > widget
// default > entity-default sets > global sets; inside a scope the highest
// priority wins (ties: first declared, touch-hit entity before ray-hit).

import type { Entity, Handedness, InteractionBinding, InteractionSet, TargetMode } from '@evolspace/protocol';

export type Scope = 'entity' | 'widget' | 'entity-default' | 'global';

export interface HitLike {
  entity: string;
  interactive: boolean;
  object?: string;
}

export interface SessionLike {
  hand: Handedness;
  pose: string;
  binding: string;
  action: string;
  target?: string;
  mode?: 'grab' | 'scale';
}

export interface ExplainInput {
  hand: Handedness;
  pose: string;
  rayHit: HitLike | null;
  touchHit: HitLike | null;
  getEntity(id: string): Entity | undefined;
  widgetBindings(widget: string): InteractionBinding[];
  sets: Record<string, InteractionSet>;
  /** Is `pose` active on the given hand (for hand: 'both'). */
  poseActive(hand: Handedness, pose: string): boolean;
  sessions: SessionLike[];
}

export interface Considered {
  scope: Scope;
  binding: InteractionBinding;
  owner?: string;
  ok: boolean;
  reason?: string;
  target?: string;
  via?: 'touch' | 'ray';
}

export interface Explanation {
  winner: Considered | null;
  considered: Considered[];
}

const otherHand = (h: Handedness): Handedness => (h === 'left' ? 'right' : 'left');

function isWithin(get: (id: string) => Entity | undefined, id: string, ancestor: string): boolean {
  let cur: string | null | undefined = id;
  for (let i = 0; cur && i < 64; i++) {
    if (cur === ancestor) return true;
    cur = get(cur)?.parent;
  }
  return false;
}

export function explainPose(inp: ExplainInput): Explanation {
  const { hand, pose } = inp;
  const considered: Considered[] = [];
  const target = (mode: TargetMode): { hit: HitLike | null; via?: 'touch' | 'ray' } => {
    switch (mode) {
      case 'ray': return { hit: inp.rayHit, ...(inp.rayHit ? { via: 'ray' as const } : {}) };
      case 'touch': return { hit: inp.touchHit, ...(inp.touchHit ? { via: 'touch' as const } : {}) };
      case 'near': return inp.touchHit ? { hit: inp.touchHit, via: 'touch' } : { hit: inp.rayHit, ...(inp.rayHit ? { via: 'ray' as const } : {}) };
      default: return { hit: null };
    }
  };
  const manipulated = (entity: string) => inp.sessions.some((s) => (s.action === 'grab' || s.action === 'scale') && s.target === entity);
  const grabToScale = (hitEntity: string) => {
    const o = otherHand(hand);
    return inp.sessions.find((s) => s.hand === o && s.action === 'grab' && (s.mode ?? 'grab') === 'grab' && s.target && isWithin(inp.getEntity, hitEntity, s.target));
  };

  const consider = (scope: Scope, b: InteractionBinding, owner?: string): Considered | null => {
    if (b.pose !== pose) return null;
    const bh = b.hand ?? 'either';
    const base: Considered = { scope, binding: b, ok: false, ...(owner ? { owner } : {}) };
    if (bh !== 'either' && bh !== 'both' && bh !== hand) return null; // not for this hand: not worth listing
    if (bh === 'both' && !inp.poseActive(otherHand(hand), pose)) return { ...base, reason: 'needs both hands' };
    const scoped = scope !== 'global';
    const mode: TargetMode = owner !== undefined && b.target === 'none' ? 'near' : b.target;
    const { hit, via } = target(mode);
    const withHit = { ...base, ...(hit ? { target: hit.entity } : {}), ...(via ? { via } : {}) };
    if (scoped && !hit) return { ...withHit, reason: `no ${mode} target` };
    if (owner !== undefined && hit?.entity !== owner) return { ...withHit, reason: 'target is another entity' };
    switch (b.action.type) {
      case 'widget':
        if (!hit?.interactive) return { ...withHit, reason: 'not an interactive part' };
        break;
      case 'grab': {
        const e = hit ? inp.getEntity(hit.entity) : undefined;
        if (!hit || !e) return { ...withHit, reason: 'no target' };
        if (e.locked) return { ...withHit, reason: 'entity locked' };
        if (manipulated(hit.entity)) return { ...withHit, reason: 'already manipulated' };
        break;
      }
      case 'scale': {
        if (!hit) return { ...withHit, reason: 'no target' };
        const g = grabToScale(hit.entity);
        if (!g) return { ...withHit, reason: 'other hand not grabbing it' };
        if (inp.getEntity(g.target!)?.locked) return { ...withHit, reason: 'entity locked' };
        return { ...withHit, target: g.target, ok: true };
      }
      default: break;
    }
    return { ...withHit, ok: true };
  };

  const collect = (scope: Scope, list: Array<{ b: InteractionBinding; owner?: string }>): Considered | null => {
    let best: Considered | null = null;
    for (const { b, owner } of list) {
      const c = consider(scope, b, owner);
      if (!c) continue;
      considered.push(c);
      if (c.ok && (!best || (b.priority ?? 0) > (best.binding.priority ?? 0))) best = c;
    }
    return best;
  };

  const hitIds: string[] = [];
  for (const h of [inp.touchHit, inp.rayHit]) if (h && !hitIds.includes(h.entity)) hitIds.push(h.entity);
  const ents = hitIds.map((id) => inp.getEntity(id)).filter((e): e is Entity => !!e);
  const setScope = (scope: InteractionSet['scope']) =>
    Object.keys(inp.sets).sort().flatMap((name) => (inp.sets[name].scope === scope ? inp.sets[name].bindings : []).map((b) => ({ b })));

  const winner =
    collect('entity', ents.flatMap((e) => (e.interactions ?? []).map((b) => ({ b, owner: e.id })))) ??
    collect('widget', ents.flatMap((e) => inp.widgetBindings(e.widget).map((b) => ({ b, owner: e.id })))) ??
    collect('entity-default', setScope('entity-default')) ??
    collect('global', setScope('global'));
  return { winner, considered };
}

/** Short human description of a binding's action. */
export function describeAction(b: InteractionBinding): string {
  const a = b.action;
  switch (a.type) {
    case 'grab': return 'grab';
    case 'scale': return 'two-hand scale';
    case 'widget': return `widget:${a.handler}`;
    case 'command': return `⌘ ${a.command}`;
    case 'channel': return `#${a.channel} ← ${JSON.stringify(a.value)}`;
    default: return (a as { type: string }).type;
  }
}
