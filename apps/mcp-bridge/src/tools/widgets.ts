// Widget catalog, build diagnostics and visual feedback (thumbnails, screenshots).
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { PortSpec, PropSpec, ScreenshotRequest, ScreenshotView, ServerEvent, WidgetManifest } from '@evolspace/protocol';
import { clock, compactJson, truncate, vec } from '../format.ts';
import { defineTool, imageResult, propsSchema, ToolError, vec3, type ToolContext } from '../tool.ts';
import { suggest } from './common.ts';
import { extractServerMessage } from '../api.ts';

function portList(ports: Record<string, PortSpec> | undefined): string {
  return Object.entries(ports ?? {}).map(([k, p]) => `${k}:${p.type}`).join(' ');
}

function propList(props: Record<string, PropSpec> | undefined): string {
  return Object.entries(props ?? {})
    .map(([k, p]) => `${k}:${p.type === 'enum' && p.options ? p.options.join('|') : p.type}`)
    .join(' ');
}

function propDetail(name: string, p: PropSpec): string {
  const bits = [p.type === 'enum' && p.options ? `enum(${p.options.join('|')})` : p.type];
  if (p.default !== undefined) bits.push(`default ${compactJson(p.default)}`);
  if (p.min !== undefined || p.max !== undefined) bits.push(`range ${p.min ?? '-∞'}..${p.max ?? '∞'}${p.step ? ` step ${p.step}` : ''}`);
  return `  ${name}: ${bits.join(', ')}${p.description ? ` — ${p.description}` : ''}`;
}

export const widgetsTool = defineTool({
  name: 'widgets',
  title: 'Widget catalog',
  readOnly: true,
  description:
    'List available widgets: `id — description | props | in | out`. Widgets are code in library/widgets/<id>/widget.ts (hot-reloaded on save); ' +
    'create a new widget by writing a new folder. filter matches id/description.',
  input: z.strictObject({ filter: z.string().optional() }),
  async handler(args, ctx) {
    let list = await ctx.api.get<WidgetManifest[]>('/api/widgets');
    if (!Array.isArray(list)) list = [];
    const f = args.filter?.toLowerCase();
    if (f) list = list.filter((w) => w.id.toLowerCase().includes(f) || (w.description ?? '').toLowerCase().includes(f));
    if (!list.length) return f ? `No widget matches "${args.filter}".` : 'No widgets in library/widgets.';
    const lines = list
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => {
        const parts = [`${w.id} — ${truncate(w.description ?? '', 140)}`];
        const props = propList(w.props), ins = portList(w.inputs), outs = portList(w.outputs);
        if (props) parts.push(`props: ${props}`);
        if (ins) parts.push(`in: ${ins}`);
        if (outs) parts.push(`out: ${outs}`);
        if (w.error) parts.push(`BUILD ERROR: ${truncate(w.error.split('\n')[0] ?? '', 120)}`);
        return parts.join(' | ');
      });
    return `${list.length} widgets (details: widget_info):\n${lines.join('\n')}`;
  },
});

async function recentWidgetEvents(ctx: ToolContext, widget: string, max = 6): Promise<ServerEvent[]> {
  try {
    const r = await ctx.api.get<{ events: ServerEvent[] }>('/api/events', {
      // No `since` → the most recent events of these types.
      query: { limit: 500, wait: 0, types: 'client.error,widget.build' },
      timeoutMs: 4000,
    });
    return (r.events ?? []).filter((e) => e.data?.widget === widget || e.data?.id === widget).slice(-max);
  } catch {
    return [];
  }
}

export const widgetInfoTool = defineTool({
  name: 'widget_info',
  title: 'Widget details',
  readOnly: true,
  description:
    'Full manifest of one widget (props with defaults/ranges, ports, interactions), its source file paths, current build status/error, and recent client errors from the headset for it.',
  input: z.strictObject({ id: z.string().min(1) }),
  async handler(args, ctx) {
    let w: WidgetManifest & { source?: string };
    try {
      w = await ctx.api.get(`/api/widgets/${encodeURIComponent(args.id)}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        const all = await ctx.api.get<WidgetManifest[]>('/api/widgets').catch(() => [] as WidgetManifest[]);
        const s = suggest(args.id, all.map((m) => m.id));
        throw new ToolError(`No widget "${args.id}".${s.length ? ` Did you mean ${s.join(', ')}?` : ''} To create it, write ${ctx.repoRoot}/library/widgets/${args.id}/widget.ts.`);
      }
      throw e;
    }
    const dir = `${ctx.repoRoot}/library/widgets/${w.id}`;
    let files: string[] = [];
    try {
      files = (await readdir(dir)).sort();
    } catch {
      /* folder may be elsewhere */
    }
    const out = [`widget ${w.id}${w.version ? ` v${w.version}` : ''} — ${w.description ?? ''}`];
    out.push(`source: ${dir}/widget.ts${files.length ? `  (folder: ${files.join(', ')})` : ''}`);
    if (w.size) out.push(`size: ${vec(w.size)} m`);
    const props = Object.entries(w.props ?? {});
    out.push(props.length ? 'props:' : 'props: none');
    for (const [k, p] of props) out.push(propDetail(k, p));
    for (const [label, ports] of [['inputs', w.inputs], ['outputs', w.outputs]] as const) {
      const entries = Object.entries(ports ?? {});
      out.push(entries.length ? `${label}:` : `${label}: none`);
      for (const [k, p] of entries) out.push(`  ${k}: ${p.type}${p.default !== undefined ? ` (default ${compactJson(p.default)})` : ''}${p.description ? ` — ${p.description}` : ''}`);
    }
    if (w.interactions?.length) {
      out.push('interactions:');
      for (const b of w.interactions) out.push(`  ${b.id}: pose ${b.pose} (${b.hand ?? 'either'}, ${b.target}) → ${compactJson(b.action)}`);
    }
    out.push(w.error ? `build: ERROR (last good bundle still served)\n${truncate(w.error, 3000)}` : `build: ok (hash ${w.hash})`);
    const evs = await recentWidgetEvents(ctx, w.id);
    if (evs.length) {
      out.push('recent events:');
      for (const e of evs) out.push(`  #${e.seq} ${clock(e.ts)} ${e.type}: ${truncate(compactJson(e.data), 400)}`);
    } else out.push('recent client errors: none');
    return out.join('\n');
  },
});

export const widgetBuildTool = defineTool({
  name: 'widget_build',
  title: 'Rebuild widget',
  description: 'Force a rebuild of library/widgets/<id> (normally automatic on save) and return the compile/evaluate errors, if any.',
  input: z.strictObject({ id: z.string().min(1) }),
  async handler(args, ctx) {
    const r = await ctx.api.post<{ ok: boolean; error?: string; manifest?: WidgetManifest }>(
      `/api/widgets/${encodeURIComponent(args.id)}/build`, undefined, { timeoutMs: 60_000 },
    );
    if (r.ok) return `build ok: ${args.id}${r.manifest?.hash ? ` (hash ${r.manifest.hash})` : ''}. Clients reload it automatically; take a screenshot to check visuals.`;
    return `build FAILED: ${args.id}\n${truncate(r.error ?? 'unknown error', 4000)}`;
  },
});

/** PNG endpoints may answer JSON {error} with a 200; turn that into an error. */
function expectPng(r: { contentType: string; bytes: Uint8Array }, what: string): Uint8Array {
  const isPng = r.bytes.length > 8 && r.bytes[0] === 0x89 && r.bytes[1] === 0x50 && r.bytes[2] === 0x4e && r.bytes[3] === 0x47;
  if (isPng) return r.bytes;
  const msg = extractServerMessage(new TextDecoder().decode(r.bytes.subarray(0, 4000)));
  throw new ToolError(`${what} failed: ${msg || `unexpected ${r.contentType || 'response'}`}`);
}

export const thumbnailTool = defineTool({
  name: 'thumbnail',
  title: 'Widget thumbnail',
  description: 'Render a widget alone (default props unless props given) in the studio scene, save it as library/widgets/<id>/thumbnail.png, and return the image.',
  input: z.strictObject({
    id: z.string().min(1),
    props: propsSchema.optional().describe('Props to render the thumbnail with (e.g. representative sample data)'),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.binary('POST', `/api/widgets/${encodeURIComponent(args.id)}/thumbnail`, {
      ...(args.props && { body: { props: args.props } }),
      timeoutMs: 90_000,
    });
    const png = expectPng(r, 'thumbnail');
    return imageResult(png, `thumbnail of widget ${args.id} (saved to library/widgets/${args.id}/thumbnail.png)`);
  },
});

export const screenshotTool = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  readOnly: true,
  description:
    'Render the space with the headless mirror and return a PNG. view: "user" (what the user sees, default), "entity" (auto-framed entity; needs entity), ' +
    '"widget" (widget alone in a studio scene; needs widget, optional props), "camera" (needs position; lookAt or rotation). ' +
    'Use after building or changing visuals to check them. First call may take a few seconds (mirror start-up).',
  input: z.strictObject({
    view: z.enum(['user', 'entity', 'widget', 'camera']).optional(),
    entity: z.string().optional(),
    widget: z.string().optional(),
    props: propsSchema.optional().describe('widget view: props to render with'),
    position: vec3.optional().describe('camera view: camera position (space coords)'),
    lookAt: vec3.optional().describe('camera view: point to look at'),
    rotation: z.array(z.number()).length(4).optional().describe('camera view: quaternion [x,y,z,w]'),
    fov: z.number().min(10).max(150).optional().describe('camera view: vertical FOV degrees'),
    direction: vec3.optional().describe('entity/widget views: direction from the target toward the camera'),
    padding: z.number().min(0).max(5).optional().describe('entity view: framing padding factor'),
    width: z.number().int().min(64).max(2048).optional().describe('default 1024'),
    height: z.number().int().min(64).max(2048).optional().describe('default 768'),
    hands: z.boolean().optional().describe('Draw ghost hands at tracked hand poses (default true for user view)'),
    labels: z.boolean().optional().describe('Overlay entity ids/names'),
    background: z.string().optional().describe('"scene", "transparent" or a CSS color'),
  }),
  async handler(args, ctx) {
    const kind = args.view ?? (args.entity ? 'entity' : args.widget ? 'widget' : args.position ? 'camera' : 'user');
    let view: ScreenshotView;
    switch (kind) {
      case 'user':
        view = { kind };
        break;
      case 'entity':
        if (!args.entity) throw new ToolError('view "entity" needs entity (id).');
        view = { kind, entity: args.entity, ...(args.direction && { direction: args.direction as never }), ...(args.padding !== undefined && { padding: args.padding }) };
        break;
      case 'widget':
        if (!args.widget) throw new ToolError('view "widget" needs widget (id).');
        view = { kind, widget: args.widget, ...(args.props && { props: args.props }), ...(args.direction && { direction: args.direction as never }) };
        break;
      case 'camera':
        if (!args.position) throw new ToolError('view "camera" needs position (and lookAt or rotation).');
        view = {
          kind,
          position: args.position as never,
          ...(args.lookAt && { lookAt: args.lookAt as never }),
          ...(args.rotation && { rotation: args.rotation as never }),
          ...(args.fov !== undefined && { fov: args.fov }),
        };
        break;
    }
    const width = args.width ?? 1024, height = args.height ?? 768;
    const req: ScreenshotRequest = { view, width, height };
    if (args.hands !== undefined) req.hands = args.hands;
    if (args.labels !== undefined) req.labels = args.labels;
    if (args.background !== undefined) req.background = args.background;
    const r = await ctx.api.binary('POST', '/api/screenshot', { body: req, timeoutMs: 90_000 });
    const png = expectPng(r, 'screenshot');
    const target = view.kind === 'entity' ? ` of ${view.entity}` : view.kind === 'widget' ? ` of widget ${view.widget}` : view.kind === 'camera' ? ` from ${vec(view.position)}` : '';
    return imageResult(png, `screenshot (${view.kind} view${target}, ${width}x${height}${req.labels ? ', labels' : ''})`);
  },
});

export const widgetTools = [widgetsTool, widgetInfoTool, widgetBuildTool, thumbnailTool, screenshotTool];
