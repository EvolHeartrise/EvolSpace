// Data bus, sources and the server event log.
import { z } from 'zod';
import { decodeTensorFrame, isTensor, tensorFromJson, type ChannelInfo, type ServerEvent, type SourceStatus, type TensorValue } from '@evolspace/protocol';
import { ago, bytes, clock, compactJson, formatTensor, truncate } from '../format.ts';
import { defineTool, ToolError } from '../tool.ts';

const TENSOR_MIME = 'application/x-evol-tensor';

export const channelsTool = defineTool({
  name: 'channels',
  title: 'List data channels',
  readOnly: true,
  description: 'List data-bus channels: name, kind (json | tensor dtype[shape]), size, publish count, last update, producer. prefix filters by name prefix (e.g. "interp.").',
  input: z.strictObject({ prefix: z.string().optional() }),
  async handler(args, ctx) {
    let list = await ctx.api.get<ChannelInfo[]>('/api/channels');
    if (!Array.isArray(list)) list = [];
    if (args.prefix) list = list.filter((c) => c.name.startsWith(args.prefix!));
    if (!list.length) return args.prefix ? `No channels with prefix "${args.prefix}".` : 'No channels yet.';
    const now = Date.now();
    const lines = list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const kind = c.kind === 'tensor' ? `${c.dtype ?? 'tensor'}[${(c.shape ?? []).join(',')}]` : 'json';
        return `${c.name}  ${kind} ${bytes(c.size ?? 0)} seq=${c.seq} ${ago(c.updatedAt, now)}${c.producer ? ` by ${c.producer}` : ''}${c.description ? ` — ${c.description}` : ''}`;
      });
    return lines.join('\n');
  },
});

export const channelGetTool = defineTool({
  name: 'channel_get',
  title: 'Read channel',
  readOnly: true,
  description:
    'Read a channel\'s latest value. JSON values are returned compactly (truncated unless full=true); tensors are summarized (dtype, shape, min/max/mean/std, first values).',
  input: z.strictObject({
    name: z.string().min(1),
    full: z.boolean().optional().describe('Do not truncate JSON (up to ~50k chars)'),
    preview: z.number().int().min(0).max(256).optional().describe('Tensor values to preview (default 12)'),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.binary('GET', `/api/channels/${encodeURIComponent(args.name)}`, { headers: { accept: `${TENSOR_MIME}, application/json` } });
    let tensor: TensorValue | undefined;
    let value: unknown;
    if (r.contentType.includes(TENSOR_MIME)) {
      tensor = decodeTensorFrame(r.bytes).tensor;
    } else {
      const txt = new TextDecoder().decode(r.bytes);
      try {
        value = txt.trim() ? JSON.parse(txt) : null;
      } catch {
        throw new ToolError(`channel ${args.name}: response is neither JSON nor a tensor frame (${r.contentType}).`);
      }
      // JSON-encoded tensor form {$tensor, dtype, shape, b64}
      if (isTensor(value) && typeof (value as { b64?: unknown }).b64 === 'string') tensor = tensorFromJson(value as never);
    }
    if (tensor) return `${args.name}: ${formatTensor(tensor, args.preview ?? 12)}`;
    return `${args.name} = ${truncate(compactJson(value), args.full ? 50_000 : 4000)}`;
  },
});

export const channelSetTool = defineTool({
  name: 'channel_set',
  title: 'Publish to channel',
  description: 'Publish a JSON value to a channel (creates it if new). Linked widgets and subscribers (Python, sources, …) receive it immediately.',
  input: z.strictObject({
    name: z.string().min(1),
    value: z.unknown().describe('Any JSON value'),
  }),
  async handler(args, ctx) {
    if (args.value === undefined) throw new ToolError('value is required (use null to clear).');
    await ctx.api.put(`/api/channels/${encodeURIComponent(args.name)}`, args.value);
    return `published ${args.name} = ${truncate(compactJson(args.value), 200)}`;
  },
});

export const sourcesTool = defineTool({
  name: 'sources',
  title: 'Data sources',
  description:
    'Supervised long-running data drivers (library/sources/<id>/source.json). action: list (default) | start | stop | restart | logs (needs id; lines default 40).',
  input: z.strictObject({
    action: z.enum(['list', 'start', 'stop', 'restart', 'logs']).optional(),
    id: z.string().optional(),
    lines: z.number().int().min(1).max(500).optional(),
  }),
  async handler(args, ctx) {
    const action = args.action ?? 'list';
    if (action === 'list') {
      const list = await ctx.api.get<SourceStatus[]>('/api/sources');
      if (!Array.isArray(list) || !list.length) return 'No sources (add library/sources/<id>/source.json).';
      return list
        .map((s) => {
          const exit = s.lastExit ? ` last exit ${s.lastExit.code ?? 'signal'} ${ago(s.lastExit.at)}` : '';
          const missing = s.missingSecrets?.length ? ` — missing secret(s) ${s.missingSecrets.join(', ')} (ask the user to add them to the secrets file)` : '';
          return `${s.id}: ${s.running ? `running pid ${s.pid ?? '?'}` : 'stopped'} restarts=${s.restarts}${exit}${missing}`;
        })
        .join('\n');
    }
    if (!args.id) throw new ToolError(`sources ${action} needs id.`);
    if (action === 'logs') {
      const list = await ctx.api.get<SourceStatus[]>('/api/sources');
      const s = (Array.isArray(list) ? list : []).find((x) => x.id === args.id);
      if (!s) throw new ToolError(`No source "${args.id}". Known: ${(list ?? []).map((x) => x.id).join(', ') || 'none'}.`);
      const tail = (s.logTail ?? []).slice(-(args.lines ?? 40));
      return `${s.id} (${s.running ? 'running' : 'stopped'}) last ${tail.length} log lines:\n${tail.join('\n') || '(empty)'}`;
    }
    const r = await ctx.api.post<Partial<SourceStatus>>(`/api/sources/${encodeURIComponent(args.id)}/${action}`, undefined, { timeoutMs: 30_000 });
    const missing = r?.missingSecrets?.length ? ` — not started: missing secret(s) ${r.missingSecrets.join(', ')}; the user adds them to ~/.config/evolspace/secrets.env (never ask them to say or paste the value)` : '';
    return `source ${args.id}: ${action} ok${r && typeof r.running === 'boolean' ? ` (${r.running ? 'running' : 'stopped'})` : ''}${missing}`;
  },
});

/** One event per line: `#seq hh:mm:ss type key=value …`. */
export function formatEvent(e: ServerEvent, maxChars = 300): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(truncate(v, 160)) : compactJson(v)}`);
  }
  return truncate(`#${e.seq} ${clock(e.ts)} ${e.type} ${parts.join(' ')}`.trimEnd(), maxChars);
}

export const eventsTool = defineTool({
  name: 'events',
  title: 'Server event log',
  readOnly: true,
  description:
    'Read the server event log (client errors/logs, widget builds, gesture reloads (gestures.load: errors/warnings after editing library/poses or library/interactions), voice utterances, pose events, widget events, source exits, scene changes, agent asks). ' +
    'Without since: the last `limit` events. With since: events after that cursor; wait (ms, ≤30000) long-polls for new ones. Ends with next=<cursor>.',
  input: z.strictObject({
    since: z.number().int().min(0).optional(),
    types: z.array(z.string()).optional().describe('e.g. ["client.error","widget.build"]'),
    wait: z.number().int().min(0).max(30_000).optional(),
    limit: z.number().int().min(1).max(500).optional().describe('default 30'),
  }),
  async handler(args, ctx) {
    const limit = args.limit ?? 30;
    const wait = args.wait ?? 0;
    // Without since the server returns the most recent `limit` events (and pins the cursor to the head when waiting).
    const r = await ctx.api.get<{ events: ServerEvent[]; next: number }>('/api/events', {
      query: { since: args.since, limit, wait, types: args.types?.length ? args.types.join(',') : undefined },
      timeoutMs: wait + 10_000,
    });
    const events = r.events ?? [];
    // With an explicit cursor show the oldest first (so paging works); otherwise the most recent.
    const shown = args.since !== undefined ? events.slice(0, limit) : events.slice(-limit);
    let next = r.next;
    if (args.since !== undefined && shown.length < events.length) {
      // Truncated page: derive a cursor with the server's own convention (next = last seq, or last seq + 1).
      const offset = Math.max(0, Math.min(1, r.next - events[events.length - 1]!.seq));
      next = shown[shown.length - 1]!.seq + offset;
    }
    const head = events.length > shown.length ? `(${events.length - shown.length} more not shown)\n` : '';
    return `${head}${shown.map((e) => formatEvent(e)).join('\n') || '(no events)'}\nnext=${next}`;
  },
});

export const dataTools = [channelsTool, channelGetTool, channelSetTool, sourcesTool, eventsTool];
