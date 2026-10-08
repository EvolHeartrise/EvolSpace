// Inspector editors: transform (position / Euler° rotation / scale), props
// generated from the widget manifest's PropSpecs, extra props as JSON, ports
// with live values. Every edit is a scene op (undoable; drags = one step).

import * as THREE from 'three';
import { useState } from 'preact/hooks';
import { isTensor, type Entity, type PortSpec, type PropSpec, type Quat, type Vec3, type WidgetManifest } from '@evolspace/protocol';
import type { DebugContext } from '../../types.ts';
import { ColorField, JsonField, NumberField, SelectField, SliderField, Switch, TextField, Vec3Field, type EditInfo } from '../../ui/fields.tsx';
import { fmtNum, fmtValue } from '../../ui/format.ts';
import { usePoll, useNeed } from '../../ui/hooks.ts';
import { IconButton, Row } from '../../ui/kit.tsx';

// ------------------------------------------------------------------ transform

const RAD = 180 / Math.PI;

export function quatToEulerDeg(q: Quat): Vec3 {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]), 'XYZ');
  const r = (v: number) => {
    const d = Math.round(v * RAD * 1000) / 1000;
    return Object.is(d, -0) ? 0 : d;
  };
  return [r(e.x), r(e.y), r(e.z)];
}

export function eulerDegToQuat(d: Vec3): Quat {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d[0] / RAD, d[1] / RAD, d[2] / RAD, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

const uniformScale = { on: false };

export function TransformEditor({ ctx, e }: { ctx: DebugContext; e: Entity }) {
  const t = e.transform;
  const [uniform, setUniform] = useState(uniformScale.on);
  const up = (patch: Parameters<DebugContext['actions']['update']>[1], info: EditInfo) =>
    void ctx.actions.update(e.id, patch, { group: info.group, quiet: !info.final });
  const euler = quatToEulerDeg(t.rotation);
  return (
    <>
      <Row label="Position" title="meters, relative to the parent (or the anchor / space origin for roots)">
        <Vec3Field value={t.position} step={0.005} onChange={(v, info) => up({ transform: { position: v } }, info)} />
      </Row>
      <Row label="Rotation" title="Euler XYZ, degrees (stored as a quaternion)">
        <Vec3Field value={euler} step={0.5} onChange={(v, info) => up({ transform: { rotation: eulerDegToQuat(v) } }, info)} />
      </Row>
      <Row label={
        <span class="dbg-propname">
          <span class="n">Scale</span>
          <IconButton icon={uniform ? 'lock' : 'unlock'} class="sm" active={uniform} title="Uniform scale" onClick={() => { uniformScale.on = !uniform; setUniform(!uniform); }} />
        </span>
      }>
        <Vec3Field value={t.scale} step={0.005} min={0.0001} onChange={(v, info) => {
          if (uniform) {
            const i = v.findIndex((x, k) => x !== t.scale[k]);
            if (i >= 0 && t.scale[i] !== 0) {
              const k = v[i] / t.scale[i];
              v = [t.scale[0] * k, t.scale[1] * k, t.scale[2] * k];
            }
          }
          up({ transform: { scale: v } }, info);
        }} />
      </Row>
      <Row label="" dim>
        <span class="dbg-mono dim" style={{ fontSize: '10.5px' }} title="quaternion [x, y, z, w]">q [{t.rotation.map((x) => fmtNum(x, 3)).join(', ')}]</span>
        <span style={{ flex: 1 }} />
        <IconButton icon="refresh" class="sm" title="Reset rotation & scale" onClick={() => void ctx.actions.update(e.id, { transform: { rotation: [0, 0, 0, 1], scale: [1, 1, 1] } })} />
      </Row>
    </>
  );
}

// ------------------------------------------------------------------ props

function asVec3(v: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? (v as Vec3) : fallback;
}

export function PropEditor({ ctx, e, name, spec }: { ctx: DebugContext; e: Entity; name: string; spec: PropSpec }) {
  const has = Object.prototype.hasOwnProperty.call(e.props, name);
  const value = has ? e.props[name] : spec.default;
  // The server fills in defaults on add, so "set" means "differs from the default".
  const custom = has && spec.default !== undefined && JSON.stringify(e.props[name]) !== JSON.stringify(spec.default);
  const set = (v: unknown, info?: EditInfo) =>
    void ctx.actions.setProps(e.id, { [name]: v }, info ? { group: info.group, quiet: !info.final } : undefined);
  const theme = ctx.runtime.theme as unknown as Record<string, unknown>;
  const resolveColor = (n: string) => {
    const key = THEME_ALIASES[n] ?? n;
    return typeof theme[key] === 'string' ? theme[key] as string : undefined;
  };
  let field;
  switch (spec.type) {
    case 'number':
    case 'integer': {
      const integer = spec.type === 'integer';
      const n = typeof value === 'number' ? value : Number(value ?? 0);
      // A slider only when the range is human-sized relative to the values (size 0.001..20 → field).
      const sliderOk = spec.min !== undefined && spec.max !== undefined
        && spec.max - spec.min <= 10 * Math.max(1, Math.abs(Number(spec.default ?? 0)), Math.abs(n));
      field = sliderOk
        ? <SliderField value={n} min={spec.min!} max={spec.max!} step={spec.step} integer={integer} onChange={set} />
        : <NumberField value={n} min={spec.min} max={spec.max} step={spec.step ?? (integer ? 1 : 0.01)} integer={integer} onChange={set} />;
      break;
    }
    case 'boolean':
      field = <Switch checked={!!value} onChange={(v) => set(v)} />;
      break;
    case 'color':
      field = <ColorField value={String(value ?? '')} onChange={set} resolve={resolveColor} />;
      break;
    case 'vec3':
      field = <Vec3Field value={asVec3(value)} step={spec.step ?? 0.01} min={spec.min} max={spec.max} onChange={set} />;
      break;
    case 'enum':
      field = <SelectField value={String(value ?? '')} options={(spec.options ?? []).map((o) => ({ value: o }))} onChange={(v) => set(v)} placeholder="—" />;
      break;
    case 'json':
      field = <JsonField value={value ?? null} rows={10} onCommit={(v) => set(v === undefined ? null : v)} />;
      break;
    case 'channel':
      field = <ChannelField ctx={ctx} value={String(value ?? '')} onCommit={(v) => set(v)} />;
      break;
    default:
      field = <TextField value={String(value ?? '')} onCommit={(v) => set(v)} />;
  }
  const canReset = custom;
  return (
    <Row class={spec.type === 'json' ? 'top' : undefined} title={`${name}: ${spec.type}${spec.description ? ` — ${spec.description}` : ''}${spec.default !== undefined ? `\ndefault: ${JSON.stringify(spec.default)}` : ''}${has ? '' : '\n(not set: showing the default)'}`}
      label={
        <span class="dbg-propname">
          {custom ? <span class="def" title="differs from the default" /> : null}
          <span class="n" style={custom || spec.default === undefined ? undefined : { color: 'var(--dim)' }}>{name}</span>
          {canReset ? <IconButton icon="refresh" class="sm" title={`Reset to default (${fmtValue(spec.default, 40)})`} onClick={() => set(spec.default)} /> : null}
        </span>
      }>
      {field}
    </Row>
  );
}

/** Widget color tokens (library/widgets README) → runtime theme keys. */
const THEME_ALIASES: Record<string, string> = { secondary: 'accent2', dim: 'textDim', muted: 'textDim', bg: 'background' };

let datalistSeq = 0;
function ChannelField({ ctx, value, onCommit }: { ctx: DebugContext; value: string; onCommit: (v: string) => void }) {
  useNeed(ctx, 'channels');
  const [id] = useState(() => `dbg-ch-${++datalistSeq}`);
  const names = ctx.store.channels.value.map((c) => c.name);
  return (
    <>
      <TextField value={value} mono list={id} placeholder="channel.name" onCommit={onCommit} />
      <datalist id={id}>{names.map((n) => <option key={n} value={n} />)}</datalist>
    </>
  );
}

/** Props that the manifest doesn't declare (widgets may persist private state). */
export function ExtraProps({ ctx, e, manifest }: { ctx: DebugContext; e: Entity; manifest?: WidgetManifest }) {
  const declared = manifest?.props ?? {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.props)) if (!(k in declared)) extra[k] = v;
  if (!Object.keys(extra).length) return null;
  return (
    <Row class="top" label={<span title="Props not declared by the widget manifest (JSON object; keys can be changed or added, not removed)">extra</span>}>
      <JsonField value={extra} rows={8} onCommit={(v) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { ctx.toast('Extra props must be a JSON object', 'error'); return; }
        void ctx.actions.setProps(e.id, v as Record<string, unknown>);
      }} />
    </Row>
  );
}

// ------------------------------------------------------------------ ports (live values)

interface PortRow { name: string; spec: PortSpec; value: unknown; set: boolean; links: number }

export function PortsTable({ ctx, e, manifest }: { ctx: DebugContext; e: Entity; manifest?: WidgetManifest }) {
  const links = Object.values(ctx.store.scene.value.links);
  const read = (): { inputs: PortRow[]; outputs: PortRow[] } => {
    const rec = ctx.runtime.widgets.record(e.id);
    const inputs = Object.entries(manifest?.inputs ?? {}).map(([name, spec]) => {
      const set = !!rec?.inputs.has(name);
      return {
        name, spec, set,
        value: set ? rec!.inputs.get(name) : spec.default,
        links: links.filter((l) => l.to.kind === 'port' && l.to.entity === e.id && l.to.port === name).length,
      };
    });
    const outputs = Object.entries(manifest?.outputs ?? {}).map(([name, spec]) => {
      const v = ctx.runtime.links.lastOutput(e.id, name);
      return {
        name, spec, set: v !== undefined, value: v,
        links: links.filter((l) => l.from.kind === 'port' && l.from.entity === e.id && l.from.port === name).length,
      };
    });
    return { inputs, outputs };
  };
  const ports = usePoll(read, 250, [e.id, manifest?.hash, links.length]);
  if (!ports.inputs.length && !ports.outputs.length) return <div class="dbg-dim" style={{ padding: '4px 0', fontSize: '12px' }}>No ports.</div>;
  const table = (rows: PortRow[], kind: 'in' | 'out') => (
    <table class="dbg-ports">
      <tbody>
        {rows.map((p) => (
          <tr key={p.name} title={`${p.name}: ${p.spec.type}${p.spec.description ? ` — ${p.spec.description}` : ''}${p.links ? `\n${p.links} link(s)` : ''}`}>
            <td class="n">{p.name}{p.links ? <span class="dbg-count"> ·{p.links}</span> : null}</td>
            <td class="t">{p.spec.type}</td>
            <td class={`val${p.set ? '' : ' none'}`} title={valueTitle(p.value)}>
              {p.set ? fmtValue(p.value, 60) : kind === 'in' && p.value !== undefined ? `${fmtValue(p.value, 40)} (default)` : p.spec.type === 'event' ? '(event)' : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      {ports.inputs.length ? <><div class="dbg-sub">Inputs</div>{table(ports.inputs, 'in')}</> : null}
      {ports.outputs.length ? <><div class="dbg-sub">Outputs</div>{table(ports.outputs, 'out')}</> : null}
    </>
  );
}

function valueTitle(v: unknown): string {
  if (isTensor(v)) return `${v.dtype}[${v.shape.join(', ')}]`;
  try { return JSON.stringify(v, null, 1)?.slice(0, 2000) ?? String(v); } catch { return String(v); }
}
