// Links panel logic (pure): readable endpoints, filtering, transform
// validation (compiled exactly like the runtime LinkEngine), loose port type
// checks, the link.add op of the "New link" form, link errors from the event
// log and the live source value of a link.

import type { Entity, Link, PortRef, PortType, SceneOp, SceneState, ServerEvent, WidgetManifest } from '@evolspace/protocol';
import { compileTransform } from '@evolspace/runtime';

// ------------------------------------------------------------------ endpoints

export interface EndpointView {
  kind: 'port' | 'channel';
  /** "gain" / "#interp.meta" */
  label: string;
  /** Port name (ports only). */
  port?: string;
  entity?: Entity;
  /** Raw "e-12.value" / "#name". */
  raw: string;
  missing: boolean;
}

export function entityName(e: Pick<Entity, 'name' | 'widget'>): string {
  return e.name?.trim() || e.widget;
}

export function refRaw(r: PortRef): string {
  return r.kind === 'port' ? `${r.entity}.${r.port}` : `#${r.channel}`;
}

export function endpointView(scene: Pick<SceneState, 'entities'>, r: PortRef): EndpointView {
  if (r.kind === 'channel') return { kind: 'channel', label: `#${r.channel}`, raw: refRaw(r), missing: false };
  const e = scene.entities[r.entity];
  return { kind: 'port', label: e ? entityName(e) : r.entity, port: r.port, ...(e ? { entity: e } : {}), raw: refRaw(r), missing: !e };
}

/** One-line readable form: "gain.value → readout.value" (with "ƒ transform"). */
export function linkText(scene: Pick<SceneState, 'entities'>, l: Pick<Link, 'from' | 'to' | 'transform'>): string {
  const f = endpointView(scene, l.from), t = endpointView(scene, l.to);
  const s = (v: EndpointView) => (v.kind === 'port' ? `${v.label}.${v.port}` : v.label);
  return `${s(f)} → ${s(t)}${l.transform ? ` ƒ ${l.transform}` : ''}`;
}

/** Text a filter query is matched against (names, ids, ports, channels, transform, link id). */
export function linkSearchText(scene: Pick<SceneState, 'entities'>, l: Link): string {
  const parts = [l.id, linkText(scene, l), refRaw(l.from), refRaw(l.to)];
  for (const r of [l.from, l.to]) if (r.kind === 'port') { const e = scene.entities[r.entity]; if (e) parts.push(e.widget); }
  return parts.join(' ').toLowerCase();
}

export function filterLinks(scene: SceneState, q: string, opts: { errors?: ReadonlyMap<string, unknown> | null } = {}): Link[] {
  const s = q.trim().toLowerCase();
  const terms = s ? s.split(/\s+/) : [];
  return Object.values(scene.links).filter((l) => {
    if (opts.errors && !opts.errors.has(l.id)) return false;
    if (!terms.length) return true;
    const hay = linkSearchText(scene, l);
    return terms.every((t) => hay.includes(t));
  });
}

// ------------------------------------------------------------------ transforms

export interface TransformCheck {
  ok: boolean;
  error?: string;
  fn?: (x: unknown) => unknown;
}

/** Compile a transform expression of `x` exactly as the runtime does. Empty = identity (ok). */
export function checkTransform(expr: string): TransformCheck {
  const src = expr.trim();
  if (!src) return { ok: true };
  const c = compileTransform(src);
  if (c.error || !c.fn) return { ok: false, error: (c.error ?? 'does not compile').replace(/^transform ".*" does not compile: /s, '') };
  return { ok: true, fn: c.fn };
}

export interface Preview {
  /** The transform was applied to a sample value. */
  ran: boolean;
  value?: unknown;
  error?: string;
  /** Transform returned undefined: the runtime drops the value. */
  dropped?: boolean;
}

/** Apply a transform to a sample (the link's current source value) for a live preview. */
export function previewTransform(expr: string, sample: unknown): Preview {
  const c = checkTransform(expr);
  if (!c.ok) return { ran: false, error: c.error };
  if (!c.fn || sample === undefined) return { ran: false };
  try {
    const v = c.fn(sample);
    return v === undefined ? { ran: true, dropped: true } : { ran: true, value: v };
  } catch (e) {
    return { ran: true, error: `throws: ${(e as Error)?.message ?? String(e)}` };
  }
}

// ------------------------------------------------------------------ port types

/** The kind of value a JSON/tensor channel currently carries, as a PortType. */
export function channelPortType(info: { kind: 'json' | 'tensor' } | undefined): PortType | undefined {
  return info ? (info.kind === 'tensor' ? 'tensor' : 'json') : undefined;
}

/**
 * Loose compatibility check between an output and an input type. Returns a
 * warning (or null). A transform can convert, so a mismatch with a transform is
 * only a hint.
 */
export function typeWarning(from: PortType | undefined, to: PortType | undefined, hasTransform: boolean): string | null {
  if (!from || !to || from === to || from === 'any' || to === 'any') return null;
  if (from === 'event') return null; // triggers carry an optional payload; most inputs accept a pulse
  if (to === 'json' && from !== 'tensor') return null;
  if (from === 'json' && to !== 'tensor' && to !== 'event') return hasTransform ? null : `json → ${to}: make sure the value is a ${to} (or add a transform)`;
  if (to === 'event') return null;
  if ((from === 'number' && to === 'boolean') || (from === 'boolean' && to === 'number')) return hasTransform ? null : `${from} → ${to}: values are coerced; consider a transform (e.g. ${to === 'boolean' ? 'x > 0.5' : 'x ? 1 : 0'})`;
  if (to === 'string') return hasTransform ? null : `${from} → string: consider a transform (e.g. String(x))`;
  return `type mismatch: ${from} → ${to}${hasTransform ? ' (the transform must convert it)' : ''}`;
}

// ------------------------------------------------------------------ new-link form

export interface EndDraft {
  kind: 'port' | 'channel';
  entity: string;
  port: string;
  channel: string;
}

export const emptyEnd = (kind: 'port' | 'channel' = 'port', entity = ''): EndDraft => ({ kind, entity, port: '', channel: '' });

export interface LinkDraft {
  from: EndDraft;
  to: EndDraft;
  transform: string;
}

export interface DraftCheck {
  op: (SceneOp & { op: 'link.add' }) | null;
  /** Blocking problems (the Create button is disabled). */
  errors: string[];
  /** Non-blocking (shown in amber). */
  warnings: string[];
}

export interface DraftEnv {
  scene: Pick<SceneState, 'entities' | 'links'>;
  catalog: Record<string, WidgetManifest>;
  channels?: ReadonlyArray<{ name: string; kind: 'json' | 'tensor' }>;
}

const CHANNEL_RE = /^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/;

function endRef(d: EndDraft, side: 'from' | 'to', env: DraftEnv, errors: string[], warnings: string[]): { ref: PortRef | null; type?: PortType } {
  const S = side === 'from' ? 'From' : 'To';
  if (d.kind === 'channel') {
    const ch = d.channel.trim().replace(/^#/, '');
    if (!ch) { errors.push(`${S}: channel name required`); return { ref: null }; }
    if (!CHANNEL_RE.test(ch)) { errors.push(`${S}: invalid channel name (dot-separated [A-Za-z0-9_:-])`); return { ref: null }; }
    const info = env.channels?.find((c) => c.name === ch);
    if (side === 'from' && env.channels && !info) warnings.push(`#${ch} has no value yet (the link fires once something publishes)`);
    return { ref: { kind: 'channel', channel: ch }, type: channelPortType(info) };
  }
  if (!d.entity) { errors.push(`${S}: pick an entity`); return { ref: null }; }
  const e = env.scene.entities[d.entity];
  if (!e) { errors.push(`${S}: entity ${d.entity} does not exist`); return { ref: null }; }
  if (!d.port.trim()) { errors.push(`${S}: pick ${side === 'from' ? 'an output' : 'an input'} port`); return { ref: null }; }
  const m = env.catalog[e.widget];
  const ports = side === 'from' ? m?.outputs : m?.inputs;
  const spec = ports?.[d.port];
  if (m && !spec) errors.push(`${S}: '${e.widget}' has no ${side === 'from' ? 'output' : 'input'} '${d.port}'`);
  if (!m) warnings.push(`${S}: widget '${e.widget}' is not in the catalog; port not checked`);
  return { ref: { kind: 'port', entity: d.entity, port: d.port.trim() }, type: spec?.type };
}

/** Validate the form and build the link.add op (undoable through the scene op log). */
export function checkDraft(d: LinkDraft, env: DraftEnv): DraftCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const from = endRef(d.from, 'from', env, errors, warnings);
  const to = endRef(d.to, 'to', env, errors, warnings);
  if (d.from.kind === 'channel' && d.to.kind === 'channel') errors.push('channel → channel links are not supported (one end must be a port)');
  const tf = checkTransform(d.transform);
  if (!tf.ok) errors.push(`transform: ${tf.error}`);
  if (from.ref && to.ref) {
    if (from.ref.kind === 'port' && to.ref.kind === 'port' && from.ref.entity === to.ref.entity && from.ref.port === to.ref.port) errors.push('a link cannot connect a port to itself');
    const dup = Object.values(env.scene.links).find((l) => JSON.stringify(l.from) === JSON.stringify(from.ref) && JSON.stringify(l.to) === JSON.stringify(to.ref));
    if (dup) warnings.push(`an identical link already exists (${dup.id})`);
    const w = typeWarning(from.type, to.type, !!d.transform.trim());
    if (w) warnings.push(w);
  }
  if (errors.length || !from.ref || !to.ref) return { op: null, errors, warnings };
  const t = d.transform.trim();
  return { op: { op: 'link.add', link: { from: from.ref, to: to.ref, ...(t ? { transform: t } : {}) } }, errors, warnings };
}

// ------------------------------------------------------------------ errors & live values

export interface LinkError {
  message: string;
  ts: number;
  count: number;
}

const LINK_MSG = /^link (\S+?): ([\s\S]*)$/;

/** Latest error per link id from client.error events ("link <id>: …", reported by any client's LinkEngine). */
export function linkErrors(events: readonly ServerEvent[], since = 0): Map<string, LinkError> {
  const out = new Map<string, LinkError>();
  for (const e of events) {
    if (e.type !== 'client.error' || e.ts < since) continue;
    const m = LINK_MSG.exec(String(e.data.message ?? ''));
    if (!m) continue;
    const prev = out.get(m[1]);
    out.set(m[1], { message: m[2], ts: e.ts, count: (prev?.count ?? 0) + 1 });
  }
  return out;
}

export interface LinkSourcePort {
  links: { lastOutput(entity: string, port: string): unknown };
  channels?: { get(name: string): unknown; seq(name: string): number };
}

export interface SourceValue {
  value: unknown;
  /** Channel seq (changes on every received value); undefined for ports (compare value identity). */
  seq?: number;
}

/** The latest value at a link's source (output port cache or the client's channel cache). */
export function sourceValue(rt: LinkSourcePort, l: Pick<Link, 'from'>): SourceValue {
  if (l.from.kind === 'port') {
    const v = rt.links.lastOutput(l.from.entity, l.from.port);
    return { value: v };
  }
  const v = rt.channels?.get(l.from.channel);
  return { value: v, seq: rt.channels?.seq(l.from.channel) ?? 0 };
}
