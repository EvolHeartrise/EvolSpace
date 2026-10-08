// Scene tools: inspect and edit the live scene (entities, links, undo, prefabs, workspaces).
import { readdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Entity, Link, Prefab, SceneOp, SceneState, SceneSummary, SceneSummaryNode } from '@evolspace/protocol';
import { compactJson, inlineProps, vec } from '../format.ts';
import { formatRef, parseRef, RefError, sameRef } from '../refs.ts';
import {
  anchorSchema, defineTool, propsSchema, rotationSchema, scaleSchema, ToolError, vec3, type ToolContext,
} from '../tool.ts';
import {
  anchorLabel, applyOps, Catalog, FALLBACK_POSITION, getScene, partialTransform, placeInFrontOfUser, requireEntity, suggest, toAnchor,
  warningLines,
} from './common.ts';

// One catalog cache per API base URL (tests use several fake servers).
const catalogs = new WeakMap<object, Catalog>();
function catalog(ctx: ToolContext): Catalog {
  let c = catalogs.get(ctx.api);
  if (!c) catalogs.set(ctx.api, (c = new Catalog(ctx.api)));
  return c;
}

// ---------------------------------------------------------------- scene

/** Normalize the server's summary ref strings ("channel:x" or "#x", "e-1.port") to the link tool's syntax. */
function refText(ref: string): string {
  return ref.startsWith('channel:') ? `#${ref.slice('channel:'.length)}` : ref;
}

function renderSummary(s: SceneSummary, rootFilter?: string): string {
  const lines: string[] = [];
  const shown = new Set<string>();
  let count = 0;
  const walk = (n: SceneSummaryNode, depth: number) => {
    count++;
    shown.add(n.id);
    const name = n.name ? ` "${n.name}"` : '';
    const props = inlineProps(n.props, 240);
    lines.push(`${'  '.repeat(depth)}${n.id}${name} ${n.widget} @${vec(n.position)}${props ? ' ' + props : ''}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  let roots = s.roots ?? [];
  if (rootFilter) {
    const find = (ns: SceneSummaryNode[]): SceneSummaryNode | undefined => {
      for (const n of ns) {
        if (n.id === rootFilter) return n;
        const f = find(n.children ?? []);
        if (f) return f;
      }
    };
    const hit = find(roots);
    if (!hit) throw new ToolError(`No entity "${rootFilter}" in the scene summary.`);
    roots = [hit];
  }
  for (const r of roots) walk(r, 0);
  // Summary link ends are strings in ref syntax ("e-1.value", "#chan"); keep links touching shown entities.
  const touchesShown = (ref: string) => {
    if (ref.startsWith('#') || ref.startsWith('channel:')) return false;
    const dot = ref.lastIndexOf('.');
    return dot > 0 && shown.has(ref.slice(0, dot));
  };
  const links = (s.links ?? []).filter((l) => !rootFilter || touchesShown(l.from) || touchesShown(l.to));
  const header = `scene v${s.version} · workspace "${s.workspace}" · ${count} entit${count === 1 ? 'y' : 'ies'} · ${links.length} link${links.length === 1 ? '' : 's'}`;
  const out = [header, ...(lines.length ? lines : ['(empty)'])];
  if (links.length) {
    out.push('links:');
    for (const l of links) out.push(`  ${l.id}: ${refText(l.from)} → ${refText(l.to)}${l.transform ? `  [${l.transform}]` : ''}`);
  }
  return out.join('\n');
}

function subtree(scene: SceneState, rootId: string): SceneState {
  requireEntity(scene, rootId);
  const keep = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of Object.values(scene.entities)) if (e.parent && keep.has(e.parent) && !keep.has(e.id)) { keep.add(e.id); grew = true; }
  }
  const touches = (l: Link) => [l.from, l.to].some((r) => r.kind === 'port' && keep.has(r.entity));
  return {
    ...scene,
    entities: Object.fromEntries(Object.entries(scene.entities).filter(([id]) => keep.has(id))),
    links: Object.fromEntries(Object.entries(scene.links).filter(([, l]) => touches(l))),
  };
}

export const sceneTool = defineTool({
  name: 'scene',
  title: 'Scene overview',
  readOnly: true,
  description:
    'Show the live scene. Default: compact tree, one line per entity: `id "name" widget @(x,y,z) {props}` (meters, Y up, user faces -Z at start) plus links. ' +
    'full=true returns the raw SceneState JSON (transforms, anchors, interactions). entity=<id> limits output to that subtree.',
  input: z.strictObject({
    full: z.boolean().optional().describe('Return full JSON instead of the summary'),
    entity: z.string().optional().describe('Only this entity and its descendants'),
  }),
  async handler(args, ctx) {
    if (args.full) {
      let scene = await getScene(ctx.api);
      if (args.entity) scene = subtree(scene, args.entity);
      return compactJson(scene);
    }
    const s = await ctx.api.get<SceneSummary>('/api/scene/summary');
    return renderSummary(s, args.entity);
  },
});

// ---------------------------------------------------------------- spawn / update / remove

export const spawnTool = defineTool({
  name: 'spawn',
  title: 'Spawn widget',
  description:
    'Add an entity (a widget instance) to the scene; returns its id. Root entities without a position are placed ~0.8 m in front of the user, facing them ' +
    '(no headset connected: at eye height in front of the space origin). ' +
    'Children (parent set) are positioned relative to the parent. See the widgets tool for available widget ids and their props.',
  input: z.strictObject({
    widget: z.string().min(1).describe('Widget id (folder under library/widgets)'),
    props: propsSchema.optional().describe('Widget props; unspecified props use widget defaults'),
    position: vec3.optional().describe('[x,y,z] meters (space coords, or relative to parent/anchor)'),
    rotation: rotationSchema.optional(),
    scale: scaleSchema.optional(),
    name: z.string().optional().describe('Human-friendly name (how the user may refer to it by voice)'),
    parent: z.string().optional().describe('Parent entity id'),
    anchor: anchorSchema.optional(),
    tags: z.array(z.string()).optional(),
    locked: z.boolean().optional().describe('Ignore grab/scale gestures'),
  }),
  async handler(args, ctx) {
    const entity: Partial<Entity> & { widget: string } = { widget: args.widget, props: args.props ?? {} };
    if (args.name) entity.name = args.name;
    if (args.parent) entity.parent = args.parent;
    if (args.anchor) entity.anchor = toAnchor(args.anchor);
    if (args.tags) entity.tags = args.tags;
    if (args.locked !== undefined) entity.locked = args.locked;
    // Catalog lookup is best-effort: used for placement distance and warnings, never blocks the spawn.
    const all = await catalog(ctx).list().catch(() => undefined);
    const w = all?.find((m) => m.id === args.widget);

    const t = partialTransform(args);
    let placed = '';
    if (!t.position && !args.parent) {
      if (!args.anchor || args.anchor === 'space') {
        // Bigger widgets go further away so they fit in view.
        const s = w?.size ? Math.max(...w.size) * (t.scale ? Math.max(...t.scale) : 1) : 0.3;
        const dist = Math.min(3, Math.max(0.8, 0.5 + s));
        const p = await placeInFrontOfUser(ctx.api, dist);
        if (p) {
          t.position = p.position;
          t.rotation ??= p.rotation;
          placed = ' (in front of the user)';
        } else {
          t.position = [FALLBACK_POSITION[0], FALLBACK_POSITION[1], -dist];
          placed = ' (no headset pose: default spot in front of the space origin)';
        }
      } else if (args.anchor === 'head' || args.anchor === 'head-lazy') {
        t.position = [0, -0.1, -0.7]; // slightly below eye level, arm's length
      }
    }
    if (Object.keys(t).length) entity.transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...t };

    const { version, ids, warnings } = await applyOps(ctx.api, [{ op: 'add', entity }]);
    const id = ids[0] ?? '(unknown id)';
    let msg = `spawned ${id} (${args.widget}${args.name ? ` "${args.name}"` : ''})` +
      (t.position ? ` at ${vec(t.position)}${placed}` : '') + ` · scene v${version}`;
    // The server's own validation notes (e.g. undeclared props) take precedence over our local check.
    msg += warningLines(warnings);
    if (all) {
      if (!w) {
        const s = suggest(args.widget, all.map((m) => m.id));
        msg += `\nwarning: widget "${args.widget}" is not in the catalog (renders as an error box)${s.length ? `; did you mean ${s.join(', ')}?` : ''}`;
      } else {
        if (w.error) msg += `\nwarning: widget "${w.id}" has a build error (last good bundle used): ${w.error.split('\n')[0]}`;
        const unknown = Object.keys(args.props ?? {}).filter((k) => !(k in (w.props ?? {})));
        if (unknown.length && !warnings.length) msg += `\nnote: props not declared by "${w.id}": ${unknown.join(', ')} (declared: ${Object.keys(w.props ?? {}).join(', ') || 'none'})`;
      }
    }
    return msg;
  },
});

export const updateTool = defineTool({
  name: 'update',
  title: 'Update entity',
  description:
    'Change an entity. props are shallow-merged into existing props; position/rotation/scale replace only the given components; other fields replace. ' +
    'parent=null makes it a root entity.',
  input: z.strictObject({
    id: z.string().min(1),
    props: propsSchema.optional(),
    position: vec3.optional(),
    rotation: rotationSchema.optional(),
    scale: scaleSchema.optional(),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    parent: z.string().nullable().optional(),
    anchor: anchorSchema.optional(),
    tags: z.array(z.string()).optional(),
    locked: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { id, props, position, rotation, scale, anchor, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    if (props) patch.props = props;
    if (anchor) patch.anchor = toAnchor(anchor);
    const t = partialTransform({ position, rotation, scale });
    if (Object.keys(t).length) patch.transform = t;
    if (!Object.keys(patch).length) throw new ToolError('Nothing to update: pass at least one of props, position, rotation, scale, name, visible, parent, anchor, tags, locked.');
    const { version, warnings } = await applyOps(ctx.api, [{ op: 'update', id, patch }]);
    return `updated ${id} (${Object.keys(patch).join(', ')}) · scene v${version}${warningLines(warnings)}`;
  },
});

export const removeTool = defineTool({
  name: 'remove',
  title: 'Remove entities',
  destructive: true,
  description: 'Remove one or more entities (with their descendants and any links touching them). Undoable with undo. To remove a link use unlink.',
  input: z.strictObject({
    id: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('Entity id or list of ids'),
  }),
  async handler(args, ctx) {
    const ids = Array.isArray(args.id) ? args.id : [args.id];
    const { version } = await applyOps(ctx.api, ids.map((id) => ({ op: 'remove', id }) as SceneOp));
    return `removed ${ids.join(', ')} · scene v${version}`;
  },
});

// ---------------------------------------------------------------- links

function parseOrThrow(ref: string) {
  try {
    return parseRef(ref);
  } catch (e) {
    throw new ToolError((e as RefError).message);
  }
}

export const linkTool = defineTool({
  name: 'link',
  title: 'Link ports/channels',
  description:
    'Connect a source to a destination so values flow live. Refs: "e-12.value" = port "value" of entity e-12; "#name" = data channel. ' +
    'port→port runs on the headset; #channel→port feeds server data (Python etc.) into a widget input; port→#channel publishes a widget output to the data bus. ' +
    'transform: optional pure JS expression of x, e.g. "Math.round(x*10)" or "x > 0.5".',
  input: z.strictObject({
    from: z.string().describe('Source: "<entity>.<outputPort>" or "#channel"'),
    to: z.string().describe('Destination: "<entity>.<inputPort>" or "#channel"'),
    transform: z.string().optional(),
  }),
  async handler(args, ctx) {
    const from = parseOrThrow(args.from);
    const to = parseOrThrow(args.to);
    if (from.kind === 'channel' && to.kind === 'channel') throw new ToolError('channel→channel links are not supported; at least one end must be an entity port.');
    if (args.transform) {
      try {
        new Function('x', `return (${args.transform});`);
      } catch (e) {
        throw new ToolError(`transform is not a valid JS expression: ${(e as Error).message}`);
      }
    }
    // Validate ports against the widget manifests so mistakes surface now, not as silent no-ops in XR.
    const scene = await getScene(ctx.api);
    for (const [ref, dir] of [[from, 'outputs'], [to, 'inputs']] as const) {
      if (ref.kind !== 'port') continue;
      const e = requireEntity(scene, ref.entity);
      const w = await catalog(ctx).get(e.widget).catch(() => undefined);
      if (!w) continue; // unknown/broken widget: let the server decide
      const ports = w[dir] ?? {};
      if (!(ref.port in ports)) {
        const avail = Object.entries(ports).map(([p, s]) => `${p}:${s.type}`).join(', ') || 'none';
        throw new ToolError(`${ref.entity} (${e.widget}) has no ${dir === 'outputs' ? 'output' : 'input'} port "${ref.port}". Available ${dir}: ${avail}.`);
      }
    }
    const link: Omit<Link, 'id' | 'enabled'> = { from, to };
    if (args.transform) link.transform = args.transform;
    const { version, ids, warnings } = await applyOps(ctx.api, [{ op: 'link.add', link }]);
    return `linked ${ids[0] ?? '(unknown id)'}: ${formatRef(from)} → ${formatRef(to)}${args.transform ? ` [${args.transform}]` : ''} · scene v${version}${warningLines(warnings)}`;
  },
});

export const unlinkTool = defineTool({
  name: 'unlink',
  title: 'Remove links',
  destructive: true,
  description: 'Remove a link by id, or every link matching from and/or to refs (same syntax as link).',
  input: z.strictObject({
    id: z.string().optional().describe('Link id (see scene tool)'),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  async handler(args, ctx) {
    let ids: string[];
    if (args.id) ids = [args.id];
    else {
      if (!args.from && !args.to) throw new ToolError('Pass id, or from and/or to.');
      const from = args.from ? parseOrThrow(args.from) : undefined;
      const to = args.to ? parseOrThrow(args.to) : undefined;
      const scene = await getScene(ctx.api);
      ids = Object.values(scene.links)
        .filter((l) => (!from || sameRef(l.from, from)) && (!to || sameRef(l.to, to)))
        .map((l) => l.id);
      if (!ids.length) throw new ToolError(`No link matches ${args.from ?? '*'} → ${args.to ?? '*'}.`);
    }
    const { version } = await applyOps(ctx.api, ids.map((id) => ({ op: 'link.remove', id }) as SceneOp));
    return `unlinked ${ids.join(', ')} · scene v${version}`;
  },
});

// ---------------------------------------------------------------- undo / redo

function historyTool(kind: 'undo' | 'redo') {
  return defineTool({
    name: kind,
    title: kind === 'undo' ? 'Undo' : 'Redo',
    description: kind === 'undo'
      ? 'Undo the last scene change(s) (any source: you, the user, voice). steps defaults to 1.'
      : 'Redo previously undone scene change(s). steps defaults to 1.',
    input: z.strictObject({ steps: z.number().int().min(1).max(50).optional() }),
    async handler(args, ctx) {
      let version = -1;
      const steps = args.steps ?? 1;
      for (let i = 0; i < steps; i++) version = (await ctx.api.post<{ version: number }>(`/api/scene/${kind}`)).version;
      return `${kind} ×${steps} · scene v${version}`;
    },
  });
}
export const undoTool = historyTool('undo');
export const redoTool = historyTool('redo');

// ---------------------------------------------------------------- prefabs

async function listPrefabs(repoRoot: string): Promise<string> {
  const dir = `${repoRoot}/library/prefabs`;
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* no folder */
  }
  if (!files.length) return `No prefabs in ${dir}. A prefab is a JSON file (Prefab type in packages/protocol/src/scene.ts).`;
  const lines = await Promise.all(files.map(async (f) => {
    const id = f.slice(0, -5);
    try {
      const p = JSON.parse(await readFile(`${dir}/${f}`, 'utf8')) as Prefab;
      return `${id} — ${p.description ?? ''} (${p.entities?.length ?? 0} entities: ${[...new Set((p.entities ?? []).map((e) => e.widget))].join(', ')})`;
    } catch (e) {
      return `${id} — (invalid JSON: ${(e as Error).message})`;
    }
  }));
  return `prefabs (${dir}):\n${lines.join('\n')}`;
}

export const prefabTool = defineTool({
  name: 'prefab',
  title: 'Prefabs',
  description:
    'Without id: list prefabs (library/prefabs/*.json). With id: instantiate it; root(s) placed in front of the user unless position/parent is given. ' +
    'props maps prefab-local entity ids to prop overrides. Returns prefab-local id → new entity id.',
  input: z.strictObject({
    id: z.string().optional().describe('Prefab id (file name without .json)'),
    position: vec3.optional(),
    rotation: rotationSchema.optional(),
    scale: scaleSchema.optional(),
    parent: z.string().optional(),
    props: z.record(z.string(), propsSchema).optional(),
  }),
  async handler(args, ctx) {
    if (!args.id) return listPrefabs(ctx.repoRoot);
    const t = partialTransform(args);
    if (!t.position && !args.parent) {
      const p = await placeInFrontOfUser(ctx.api, 1.2); // prefabs tend to be groups: a bit further
      if (p) { t.position = p.position; t.rotation ??= p.rotation; }
      else t.position = [FALLBACK_POSITION[0], FALLBACK_POSITION[1], -1.2];
    }
    const body: Record<string, unknown> = {};
    if (Object.keys(t).length) body.transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...t };
    if (args.parent) body.parent = args.parent;
    if (args.props) body.props = args.props;
    const r = await ctx.api.post<{ ids: Record<string, string> }>(`/api/prefabs/${encodeURIComponent(args.id)}/instantiate`, body);
    const pairs = Object.entries(r.ids ?? {}).map(([local, id]) => `${local}→${id}`);
    return `instantiated prefab ${args.id}${t.position ? ` at ${vec(t.position)}` : ''}: ${pairs.join(', ') || '(no ids returned)'}`;
  },
});

// ---------------------------------------------------------------- workspaces

export const workspaceTool = defineTool({
  name: 'workspace',
  title: 'Workspaces',
  description: 'Saved scenes. list (default) | save [name] (defaults to current) | load name | new name (empty scene).',
  input: z.strictObject({
    action: z.enum(['list', 'save', 'load', 'new']).optional(),
    name: z.string().regex(/^[\w.-]+$/, 'letters, digits, _ . - only').optional(),
  }),
  async handler(args, ctx) {
    const action = args.action ?? 'list';
    const ws = await ctx.api.get<{ current: string; list: string[] }>('/api/workspaces');
    if (action === 'list') return `current: ${ws.current}\nsaved: ${(ws.list ?? []).join(', ') || '(none)'}`;
    const name = args.name ?? (action === 'save' ? ws.current : undefined);
    if (!name) throw new ToolError(`workspace ${action} needs a name.`);
    await ctx.api.post(`/api/workspaces/${encodeURIComponent(name)}/${action}`);
    return `workspace ${action === 'new' ? 'created' : action === 'save' ? 'saved' : 'loaded'}: ${name}`;
  },
});

export const sceneTools = [sceneTool, spawnTool, updateTool, removeTool, linkTool, unlinkTool, undoTool, redoTool, prefabTool, workspaceTool];

/** Exposed for tests. */
export const _internal = { renderSummary, subtree, anchorLabel };
