// Prop defaults + validation against a widget's PropSpecs. Lenient by design:
// a bad value falls back to the default (with a warning) rather than breaking
// the widget, and undeclared props pass through untouched.

import type { PropSpec } from '@evolspace/protocol';
import { cloneJson } from '../util/equal.ts';

export interface PropIssue {
  prop: string;
  message: string;
}

export interface ResolvedProps {
  props: Record<string, unknown>;
  issues: PropIssue[];
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CSS_COLOR = /^(rgb|rgba|hsl|hsla)\(|^[a-z]+$/i;

export function resolveProps(specs: Record<string, PropSpec> | undefined, raw: Record<string, unknown>): ResolvedProps {
  const issues: PropIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) out[k] = raw[k];
  if (!specs) return { props: out, issues };
  for (const [name, spec] of Object.entries(specs)) {
    const has = Object.prototype.hasOwnProperty.call(raw, name) && raw[name] !== undefined;
    if (!has) {
      if (spec.default !== undefined) out[name] = cloneJson(spec.default);
      else if (spec.type === 'enum' && spec.options?.length) out[name] = spec.options[0];
      continue;
    }
    const r = coerce(spec, raw[name]);
    if (r.ok) {
      out[name] = r.value;
      if (r.note) issues.push({ prop: name, message: r.note });
    } else {
      issues.push({ prop: name, message: r.error });
      const fallback = spec.default !== undefined ? cloneJson(spec.default) : spec.type === 'enum' ? spec.options?.[0] : undefined;
      if (fallback === undefined) delete out[name];
      else out[name] = fallback;
    }
  }
  return { props: out, issues };
}

type Coerced = { ok: true; value: unknown; note?: string } | { ok: false; error: string };

function clamp(spec: PropSpec, v: number): { value: number; note?: string } {
  let x = v;
  if (spec.min !== undefined && x < spec.min) x = spec.min;
  if (spec.max !== undefined && x > spec.max) x = spec.max;
  return x === v ? { value: x } : { value: x, note: `clamped ${v} to ${x}` };
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

export function coerce(spec: PropSpec, v: unknown): Coerced {
  switch (spec.type) {
    case 'number': {
      const n = toNumber(v);
      if (n === undefined) return { ok: false, error: `expected number, got ${describe(v)}` };
      return { ok: true, ...clamp(spec, n) };
    }
    case 'integer': {
      const n = toNumber(v);
      if (n === undefined) return { ok: false, error: `expected integer, got ${describe(v)}` };
      return { ok: true, ...clamp(spec, Math.round(n)) };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (v === 'true' || v === 1) return { ok: true, value: true };
      if (v === 'false' || v === 0) return { ok: true, value: false };
      return { ok: false, error: `expected boolean, got ${describe(v)}` };
    case 'string':
    case 'channel':
      if (typeof v === 'string') return { ok: true, value: v };
      if (typeof v === 'number' || typeof v === 'boolean') return { ok: true, value: String(v) };
      return { ok: false, error: `expected string, got ${describe(v)}` };
    case 'color':
      if (typeof v === 'string' && (HEX.test(v) || CSS_COLOR.test(v))) return { ok: true, value: v };
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) {
        return { ok: true, value: '#' + v.toString(16).padStart(6, '0') };
      }
      return { ok: false, error: `expected color (#rrggbb), got ${describe(v)}` };
    case 'vec3': {
      if (Array.isArray(v) && v.length === 3) {
        const a = v.map(toNumber);
        if (a.every((x) => x !== undefined)) return { ok: true, value: a as number[] };
      }
      const n = toNumber(v);
      if (n !== undefined) return { ok: true, value: [n, n, n] };
      return { ok: false, error: `expected [x, y, z], got ${describe(v)}` };
    }
    case 'enum': {
      const opts = spec.options ?? [];
      if (typeof v === 'string' && opts.includes(v)) return { ok: true, value: v };
      if (typeof v === 'string') {
        const ci = opts.find((o) => o.toLowerCase() === v.toLowerCase());
        if (ci) return { ok: true, value: ci };
      }
      return { ok: false, error: `expected one of ${opts.join('|')}, got ${describe(v)}` };
    }
    case 'json':
    default:
      return { ok: true, value: v };
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
  return typeof v === 'object' ? 'object' : `${typeof v} ${String(v)}`;
}
