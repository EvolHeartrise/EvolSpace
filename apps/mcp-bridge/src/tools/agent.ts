// Talking to the user and reading their state; gestures and voice.
import { z } from 'zod';
import type { InteractionSet, PoseDef, SceneState, UserPose } from '@evolspace/protocol';
import type { EvolApi } from '../api.ts';
import { compactJson, num, rotate, truncate, vec } from '../format.ts';
import { defineTool } from '../tool.ts';

export const sayTool = defineTool({
  name: 'say',
  title: 'Say in XR',
  description:
    'Show a message to the user in the XR agent panel. This is how you answer voice requests (they cannot see the terminal). ' +
    'Keep it short and spoken-style (1–3 sentences). kind: reply (default) | info | error.',
  input: z.strictObject({
    text: z.string().min(1).max(4000),
    kind: z.enum(['reply', 'info', 'error']).optional(),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.post<{ id?: string }>('/api/agent/say', { text: args.text, kind: args.kind ?? 'reply' });
    return `shown in XR${r.id ? ` (${r.id})` : ''}`;
  },
});

export const statusTool = defineTool({
  name: 'status',
  title: 'Set status line',
  description:
    'Set the "Claude is working" indicator in XR (state + short detail, e.g. "Building weather widget"). Hooks set it automatically per tool; ' +
    'use this for a more meaningful line during long tasks.',
  input: z.strictObject({
    detail: z.string().max(120).optional(),
    state: z.enum(['idle', 'thinking', 'working', 'error']).optional().describe('default working'),
  }),
  async handler(args, ctx) {
    const state = args.state ?? 'working';
    await ctx.api.post('/api/agent/status', { state, ...(args.detail && { detail: args.detail }) });
    return `status: ${state}${args.detail ? ` — ${args.detail}` : ''}`;
  },
});

// ---------------------------------------------------------------- user

async function entityLabels(api: EvolApi): Promise<(id: string) => string> {
  try {
    const scene = await api.get<SceneState>('/api/scene', { timeoutMs: 3000 });
    return (id) => {
      const e = scene.entities?.[id];
      return e ? `${id} (${e.widget}${e.name ? ` "${e.name}"` : ''})` : id;
    };
  } catch {
    return (id) => id;
  }
}

function summarizeHand(h: unknown): string {
  if (!h || typeof h !== 'object') return 'not tracked';
  // Server summary shape (apps/server/src/user.ts): {tracked, wrist:{position,rotation}, features, poses}.
  const o = h as Record<string, unknown>;
  if (o.tracked === false) return 'not tracked';
  const parts: string[] = [];
  const wrist = o.wrist as { position?: number[] } | undefined;
  if (Array.isArray(wrist?.position)) parts.push(`wrist ${vec(wrist.position)}`);
  else if (Array.isArray(o.joints) && o.joints.length >= 3) parts.push(`wrist ${vec(o.joints.slice(0, 3) as number[])}`);
  if (Array.isArray(o.position)) parts.push(`at ${vec(o.position as number[])}`);
  // Features may be top-level numbers or nested under `features`.
  const feats = (typeof o.features === 'object' && o.features ? o.features : o) as Record<string, unknown>;
  const numeric = Object.entries(feats).filter(([k, v]) => typeof v === 'number' && k !== 't');
  const pick = numeric.filter(([k]) => /^(curl\.|pinch\.index|palm\.)/.test(k));
  if (pick.length) parts.push(pick.map(([k, v]) => `${k}=${num(v as number, 2)}`).join(' '));
  for (const key of ['poses', 'activePoses', 'active']) if (Array.isArray(o[key]) && (o[key] as unknown[]).length) parts.push(`poses: ${(o[key] as string[]).join(', ')}`);
  return parts.join('; ') || 'tracked';
}

export const userTool = defineTool({
  name: 'user',
  title: 'User state',
  readOnly: true,
  description:
    "The user's current state from the headset: XR mode, head position and facing, hand tracking (key features, active poses), what each hand ray and the gaze hit, and the selected entity. " +
    'Use it to resolve "this"/"here" and to place things where the user is looking.',
  input: z.strictObject({ raw: z.boolean().optional().describe('Return the raw JSON') }),
  async handler(args, ctx) {
    // ageMs is added by the server's summary (the pose's own `t` is the headset's clock).
    const u = await ctx.api.get<(UserPose & { ageMs?: number; featuresError?: string }) | null>('/api/user', args.raw ? { query: { raw: 1 } } : {});
    if (!u || !u.head) return 'No XR client connected (no user pose). The user may not be in the headset.';
    if (args.raw) return compactJson(u);
    const label = await entityLabels(ctx.api);
    const fwd = rotate(u.head.rotation, [0, 0, -1]);
    const age = typeof u.ageMs === 'number' ? ` · pose age ${u.ageMs < 1000 ? `${Math.round(u.ageMs)}ms` : `${num(u.ageMs / 1000, 1)}s`}${u.ageMs > 5000 ? ' (stale: headset idle or disconnected?)' : ''}` : '';
    const lines = [
      `mode ${u.mode}${u.fov ? ` · fov ${num(u.fov, 0)}°` : ''}${age}`,
      `head ${vec(u.head.position)} facing ${vec(fwd)}`,
    ];
    if (u.featuresError) lines.push(`note: ${u.featuresError}`);
    for (const hand of ['left', 'right'] as const) {
      const f = u.focus?.[hand];
      lines.push(`${hand} hand: ${summarizeHand(u.hands?.[hand])}${f ? ` · ray → ${label(f.entity)} at ${vec(f.point)}` : ''}`);
    }
    lines.push(`gaze: ${u.gaze ? `${label(u.gaze.entity)} at ${vec(u.gaze.point)}` : 'nothing'}`);
    lines.push(`selected: ${u.selected ? label(u.selected) : 'none'}`);
    return lines.join('\n');
  },
});

// ---------------------------------------------------------------- gestures & voice

function poseLine(p: PoseDef): string {
  const conds = (p.conditions ?? [])
    .map((c) => `${c.min !== undefined ? `${num(c.min, 3)}≤` : ''}${c.feature}${c.max !== undefined ? `≤${num(c.max, 3)}` : ''}`)
    .join(', ');
  return `${p.id} (${p.hand}, ${p.source}) — ${p.description ?? ''}${conds ? ` | ${conds}` : ''}`;
}

export const gesturesTool = defineTool({
  name: 'gestures',
  title: 'Poses & interactions',
  readOnly: true,
  description:
    'List hand poses (library/poses/*.json: conditions over hand features) and interaction sets (library/interactions/*.json: pose → action bindings). ' +
    'Edit those files to change gestures; the server hot-reloads them. Feature definitions: packages/input/FEATURES.md.',
  input: z.strictObject({}),
  async handler(_args, ctx) {
    const g = await ctx.api.get<{ poses: PoseDef[]; interactions: Record<string, InteractionSet> }>('/api/gestures');
    const out = [`poses (${ctx.repoRoot}/library/poses):`];
    for (const p of g.poses ?? []) out.push(`  ${poseLine(p)}`);
    out.push(`interaction sets (${ctx.repoRoot}/library/interactions):`);
    for (const [name, set] of Object.entries(g.interactions ?? {})) {
      out.push(`  ${name} [${set.scope}] — ${set.description ?? ''}`);
      for (const b of set.bindings ?? []) {
        const a = b.action;
        const act = a.type === 'command' ? `command ${a.command}${a.args ? ' ' + compactJson(a.args) : ''}`
          : a.type === 'widget' ? `widget:${a.handler}`
          : a.type === 'channel' ? `channel #${a.channel}=${compactJson(a.value)}`
          : a.type;
        out.push(`    ${b.id}: ${b.pose} (${b.hand ?? 'either'}, target ${b.target}${b.priority ? `, prio ${b.priority}` : ''}) → ${act}`);
      }
    }
    return out.join('\n');
  },
});

export const poseRecordTool = defineTool({
  name: 'pose_record',
  title: 'Record hand pose',
  description:
    'Record a new hand pose from the user: the headset shows a countdown, then samples the hand for `seconds`, and the server derives a PoseDef saved to library/poses/<name>.json. ' +
    'Tell the user (say) what to do before calling. Bind it to an action by editing library/interactions/*.json.',
  input: z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/, 'lowercase id: letters, digits, - _').describe('Pose id = file name'),
    hand: z.enum(['left', 'right', 'either']),
    seconds: z.number().min(0.5).max(15).optional().describe('Sampling duration, default 3'),
    countdown: z.number().int().min(0).max(10).optional().describe('Countdown seconds before sampling, default 3'),
    description: z.string().optional(),
  }),
  async handler(args, ctx) {
    const seconds = args.seconds ?? 3, countdown = args.countdown ?? 3;
    const pose = await ctx.api.post<PoseDef>(
      '/api/gestures/record',
      { name: args.name, hand: args.hand, seconds, countdown, ...(args.description && { description: args.description }) },
      { timeoutMs: (seconds + countdown + 30) * 1000 },
    );
    return `recorded pose → library/poses/${pose.id ?? args.name}.json\n${poseLine(pose)}`;
  },
});

export const voiceSimulateTool = defineTool({
  name: 'voice_simulate',
  title: 'Simulate voice',
  description:
    'Route text as if the user had spoken it: shows whether it hits a fast-path voice command (library/voice/commands.json) or goes to you (agent). Runs the matched command. ' +
    'Text routed to the agent comes back to you as a channel event with simulated="true": that is your own test, not the user, so do not act on it.',
  input: z.strictObject({
    text: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional().describe('VoiceContext, e.g. {"selected":"e-3"}'),
  }),
  async handler(args, ctx) {
    const r = await ctx.api.post<{ route: string; command?: string }>('/api/voice/simulate', { text: args.text, ...(args.context && { context: args.context }) });
    const note = r.route === 'agent' ? ' — it will also arrive as a channel event marked simulated="true"; ignore that one' : '';
    return `"${truncate(args.text, 120)}" → ${r.route}${r.command ? ` (command ${r.command})` : ''}${note}`;
  },
});

export const agentTools = [sayTool, statusTool, userTool, gesturesTool, poseRecordTool, voiceSimulateTool];

