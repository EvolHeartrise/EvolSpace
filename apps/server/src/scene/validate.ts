// Structural + prop validation for scene ops. Error messages are written for
// Claude: they say what was wrong, what was expected and, where cheap, what the
// valid choices are.
import type { AnchorRef, PortRef, PropSpec, Transform, WidgetManifest, InteractionBinding } from '@evolspace/protocol';
import { ID_RE } from '../util/ids.ts';

export class SceneError extends Error {
  constructor(message: string, public opIndex?: number) {
    super(message);
    this.name = 'SceneError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'string') return `string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)}`;
  if (typeof v === 'object') return 'object';
  return `${typeof v} ${String(v)}`;
}

export function checkId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new SceneError(`${what} must be 1-64 chars of [A-Za-z0-9_.:-], got ${describe(id)}`);
  }
  return id;
}

export function isVec(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every(isFiniteNum);
}

/** Validates a partial transform; returns it unchanged (typed). */
export function checkPartialTransform(t: unknown, what = 'transform'): Partial<Transform> {
  if (t === undefined) return {};
  if (!isObj(t)) throw new SceneError(`${what} must be an object {position?, rotation?, scale?}, got ${describe(t)}`);
  for (const key of Object.keys(t)) {
    if (!['position', 'rotation', 'scale'].includes(key)) throw new SceneError(`${what} has unknown field '${key}' (allowed: position, rotation, scale)`);
  }
  if (t.position !== undefined && !isVec(t.position, 3)) throw new SceneError(`${what}.position must be [x, y, z] (meters), got ${describe(t.position)}`);
  if (t.rotation !== undefined && !isVec(t.rotation, 4)) throw new SceneError(`${what}.rotation must be a quaternion [x, y, z, w], got ${describe(t.rotation)}`);
  if (t.scale !== undefined && !isVec(t.scale, 3)) throw new SceneError(`${what}.scale must be [x, y, z], got ${describe(t.scale)}`);
  return t as Partial<Transform>;
}

export function mergeTransform(base: Transform, patch: Partial<Transform>): Transform {
  return {
    position: [...(patch.position ?? base.position)] as Transform['position'],
    rotation: normalizeQuat(patch.rotation ?? base.rotation),
    scale: [...(patch.scale ?? base.scale)] as Transform['scale'],
  };
}

function normalizeQuat(q: readonly number[]): Transform['rotation'] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-9) return [0, 0, 0, 1];
  if (Math.abs(len - 1) < 1e-6) return [q[0], q[1], q[2], q[3]];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function checkAnchor(a: unknown): AnchorRef {
  if (!isObj(a)) throw new SceneError(`anchor must be {kind:'space'|'head'|'hand', ...}, got ${describe(a)}`);
  switch (a.kind) {
    case 'space': return { kind: 'space' };
    case 'head':
      if (a.lazy !== undefined && typeof a.lazy !== 'boolean') throw new SceneError(`anchor.lazy must be boolean`);
      return a as AnchorRef;
    case 'hand':
      if (a.hand !== 'left' && a.hand !== 'right') throw new SceneError(`anchor.hand must be 'left' or 'right', got ${describe(a.hand)}`);
      if (a.joint !== undefined && typeof a.joint !== 'string') throw new SceneError(`anchor.joint must be a joint name string`);
      return a as AnchorRef;
    default:
      throw new SceneError(`anchor.kind must be 'space', 'head' or 'hand', got ${describe(a.kind)}`);
  }
}

const TARGETS = ['ray', 'touch', 'near', 'none'];
const ACTIONS = ['grab', 'scale', 'widget', 'command', 'channel'];

export function checkInteractions(v: unknown): InteractionBinding[] {
  if (!Array.isArray(v)) throw new SceneError(`interactions must be an array of InteractionBinding, got ${describe(v)}`);
  v.forEach((b, i) => {
    const where = `interactions[${i}]`;
    if (!isObj(b)) throw new SceneError(`${where} must be an object`);
    if (typeof b.id !== 'string' || !b.id) throw new SceneError(`${where}.id must be a non-empty string`);
    if (typeof b.pose !== 'string' || !b.pose) throw new SceneError(`${where}.pose must be a pose id`);
    if (!TARGETS.includes(b.target as string)) throw new SceneError(`${where}.target must be one of ${TARGETS.join(', ')}`);
    if (!isObj(b.action) || !ACTIONS.includes(b.action.type as string)) throw new SceneError(`${where}.action.type must be one of ${ACTIONS.join(', ')}`);
  });
  return v as InteractionBinding[];
}

export function checkTags(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) throw new SceneError(`tags must be an array of strings, got ${describe(v)}`);
  return v as string[];
}

const CHANNEL_RE = /^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/;
export function isChannelName(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 200 && CHANNEL_RE.test(s);
}

export function checkPortRefShape(p: unknown, what: string): PortRef {
  if (!isObj(p)) throw new SceneError(`${what} must be {kind:'port', entity, port} or {kind:'channel', channel}, got ${describe(p)}`);
  if (p.kind === 'port') {
    if (typeof p.entity !== 'string' || !p.entity) throw new SceneError(`${what}.entity must be an entity id`);
    if (typeof p.port !== 'string' || !p.port) throw new SceneError(`${what}.port must be a port name`);
    return { kind: 'port', entity: p.entity, port: p.port };
  }
  if (p.kind === 'channel') {
    if (!isChannelName(p.channel)) throw new SceneError(`${what}.channel must be a dot-separated channel name like "interp.ctl.layer", got ${describe(p.channel)}`);
    return { kind: 'channel', channel: p.channel };
  }
  throw new SceneError(`${what}.kind must be 'port' or 'channel', got ${describe(p.kind)}`);
}

/**
 * Check that a link transform is a syntactically valid JS expression of `x`.
 * Only compiles (never runs) it.
 */
export function checkLinkTransform(t: unknown): string | undefined {
  if (t === undefined || t === null || t === '') return undefined;
  if (typeof t !== 'string') throw new SceneError(`link.transform must be a JS expression string of x, got ${describe(t)}`);
  if (t.length > 2000) throw new SceneError(`link.transform is too long (max 2000 chars)`);
  try {
    // eslint-disable-next-line no-new-func
    new Function('x', `"use strict"; return (${t}\n);`);
  } catch (e) {
    throw new SceneError(`link.transform is not a valid JS expression of x: ${(e as Error).message} — e.g. "Math.round(x * 10)"`);
  }
  return t;
}

function checkPropValue(spec: PropSpec, v: unknown): string | null {
  if (v === null) return null; // explicit "unset" is always allowed
  switch (spec.type) {
    case 'number':
      if (!isFiniteNum(v)) return 'a finite number';
      break;
    case 'integer':
      if (!isFiniteNum(v) || !Number.isInteger(v)) return 'an integer';
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return 'a boolean';
      return null;
    case 'string':
    case 'channel':
      if (typeof v !== 'string') return spec.type === 'channel' ? 'a channel name string' : 'a string';
      return null;
    case 'color':
      if (typeof v !== 'string' && !isFiniteNum(v)) return 'a color (CSS string like "#4af" or a number)';
      return null;
    case 'vec3':
      if (!isVec(v, 3)) return 'a vec3 [x, y, z]';
      return null;
    case 'enum':
      if (typeof v !== 'string' || (spec.options && !spec.options.includes(v))) return `one of ${JSON.stringify(spec.options ?? [])}`;
      return null;
    case 'json':
    default:
      return null;
  }
  // numeric range check
  const n = v as number;
  if (spec.min !== undefined && n < spec.min) return `>= ${spec.min}`;
  if (spec.max !== undefined && n > spec.max) return `<= ${spec.max}`;
  return null;
}

export interface PropCheck {
  errors: string[];
  warnings: string[];
}

/** Validate prop values against a manifest. Unknown props are warnings (widgets may persist private state). */
export function checkProps(manifest: WidgetManifest | undefined, widget: string, props: Record<string, unknown>): PropCheck {
  const out: PropCheck = { errors: [], warnings: [] };
  if (!manifest || !manifest.hash) return out; // unknown/unbuilt widget: nothing to validate against
  const specs = manifest.props ?? {};
  for (const [k, v] of Object.entries(props)) {
    const spec = specs[k];
    if (!spec) {
      const known = Object.keys(specs);
      out.warnings.push(`widget '${widget}' has no prop '${k}'${known.length ? ` (props: ${known.join(', ')})` : ''}`);
      continue;
    }
    const expected = checkPropValue(spec, v);
    if (expected) out.errors.push(`prop '${k}' of widget '${widget}' must be ${expected}, got ${describe(v)}`);
  }
  return out;
}

/** Deep-cloned defaults for every prop spec that declares one. */
export function propDefaults(manifest: WidgetManifest | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!manifest) return out;
  for (const [k, spec] of Object.entries(manifest.props ?? {})) {
    if (spec.default !== undefined) out[k] = structuredClone(spec.default);
  }
  return out;
}

export { isObj, isFiniteNum };
