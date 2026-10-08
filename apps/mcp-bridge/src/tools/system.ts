// Generic command execution and health/status of the server and the bridge itself.
import { z } from 'zod';
import { isServerDown } from '../api.ts';
import { ago, compactJson, truncate } from '../format.ts';
import { defineTool, errorResult, text } from '../tool.ts';

export const commandTool = defineTool({
  name: 'command',
  title: 'Run command',
  description:
    'Run a named command through the server command registry (same as gestures/voice use), e.g. undo, redo, delete {entity}, duplicate {entity}, ' +
    'workspace.save {name}, broadcast {name, args} (forward a client command such as session.mode {mode:"ar"} or select {entity} to the headset).',
  input: z.strictObject({
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  async handler(a, ctx) {
    const r = await ctx.api.post<{ ok?: boolean; result?: unknown; error?: string }>('/api/command', { name: a.name, ...(a.args && { args: a.args }) });
    if (r.ok === false) return errorResult(`command ${a.name} failed: ${r.error ?? compactJson(r.result)}`);
    return `command ${a.name} ok${r.result !== undefined ? `: ${truncate(compactJson(r.result), 2000)}` : ''}`;
  },
});

export const serverStatusTool = defineTool({
  name: 'server_status',
  title: 'Server status',
  readOnly: true,
  description: 'Is the EvolSpace server up, which clients (headset, mirror, …) are connected, and the state of the voice→Claude channel in this bridge.',
  input: z.strictObject({}),
  async handler(_a, ctx) {
    const ch = ctx.channelStats();
    const chLine = ch
      ? `voice channel: ${ch.connected ? 'connected' : 'disconnected'}, ${ch.delivered} request(s) delivered` +
        (ch.lastAsk ? `, last "${truncate(ch.lastAsk.text, 60)}" ${ago(ch.lastAsk.at)}` : '') +
        (ch.lastError && !ch.connected ? `, last error: ${ch.lastError}` : '')
      : 'voice channel: not started (MCP client not initialized)';
    try {
      const h = await ctx.api.get<{
        ok?: boolean; version?: string; clients?: Array<{ role: string; primary?: boolean }>;
        workspace?: string; sceneVersion?: number; uptimeSec?: number;
      }>('/api/health', { timeoutMs: 3000 });
      const clients = (h.clients ?? []).map((c) => `${c.role}${c.primary ? '*' : ''}`);
      const xr = (h.clients ?? []).some((c) => c.role === 'xr');
      const extra = [
        h.workspace !== undefined ? `workspace "${h.workspace}"` : '',
        h.sceneVersion !== undefined ? `scene v${h.sceneVersion}` : '',
        h.uptimeSec !== undefined ? `up ${h.uptimeSec < 120 ? `${h.uptimeSec}s` : `${Math.round(h.uptimeSec / 60)}m`}` : '',
      ].filter(Boolean).join(', ');
      return [
        `server: up at ${ctx.api.baseUrl}${h.version ? ` (v${h.version})` : ''}${extra ? ` · ${extra}` : ''}`,
        `clients: ${clients.join(', ') || 'none'} (*=primary)${xr ? '' : ' — no headset connected'}`,
        chLine,
        `repo: ${ctx.repoRoot}`,
      ].join('\n');
    } catch (e) {
      if (isServerDown(e)) return { ...text(`${(e as Error).message}\n${chLine}`), isError: true };
      throw e;
    }
  },
});

export const systemTools = [commandTool, serverStatusTool];
