// Compact scene tree for the agent (GET /api/scene/summary): large prop values
// are elided so a scene with tensors/long strings stays small in Claude's context.
import type { Entity, Link, PortRef, SceneState, SceneSummary, SceneSummaryNode } from '@evolspace/protocol';
import { roundVec } from './math.ts';

const MAX_STRING = 120;
const MAX_ARRAY = 16;
const MAX_JSON = 400;

export function elideValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length} chars)` : v;
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) return `[array(${v.length}) elided]`;
    return v.map(elideValue);
  }
  if (v && typeof v === 'object') {
    const json = JSON.stringify(v);
    if (json.length > MAX_JSON) return `{object, ${Object.keys(v).length} keys, ${json.length} chars elided}`;
  }
  return v;
}

const portStr = (p: PortRef): string => (p.kind === 'port' ? `${p.entity}.${p.port}` : `channel:${p.channel}`);

export function summarizeScene(scene: SceneState): SceneSummary {
  const children = new Map<string | null, Entity[]>();
  for (const e of Object.values(scene.entities)) {
    const key = e.parent && scene.entities[e.parent] ? e.parent : null;
    const list = children.get(key);
    if (list) list.push(e); else children.set(key, [e]);
  }
  const node = (e: Entity): SceneSummaryNode => {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.props)) props[k] = elideValue(v);
    const n: SceneSummaryNode = { id: e.id, widget: e.widget, position: roundVec([...e.transform.position] as [number, number, number]), props };
    if (e.name) n.name = e.name;
    const kids = children.get(e.id);
    if (kids?.length) n.children = kids.map(node);
    return n;
  };
  return {
    version: scene.version,
    workspace: scene.workspace,
    roots: (children.get(null) ?? []).map(node),
    links: Object.values(scene.links).map((l: Link) => {
      const s: SceneSummary['links'][number] = { id: l.id, from: portStr(l.from), to: portStr(l.to) };
      if (l.transform) s.transform = l.transform;
      return s;
    }),
  };
}
