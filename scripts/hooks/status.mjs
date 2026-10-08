#!/usr/bin/env node
// Claude Code hook → EvolSpace "Claude is working" indicator.
//
// Usage (from .claude/settings.json):  node scripts/hooks/status.mjs <HookEvent>
// Reads the hook JSON from stdin, maps it to {state, detail} and POSTs it to
// <EVOL_URL>/api/agent/status. Contract with Claude Code: NEVER print to stdout
// (for UserPromptSubmit/SessionStart stdout would be injected into Claude's
// context), always exit 0, and never take long — a hard deadline kills the
// process after HARD_TIMEOUT_MS even if the server hangs or is down.
//
// Env: EVOL_URL (default http://127.0.0.1:8787), EVOL_STATUS_HOOK=0 disables.
// Dependency-free on purpose: plain Node built-ins, starts in ~50 ms.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARD_TIMEOUT_MS = 400;
const DEFAULT_URL = 'http://127.0.0.1:8787';

/** Truncate and collapse whitespace for a one-line headset label. */
export function short(s, max = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// File names too generic to identify what is being edited on their own.
const GENERIC = new Set(['widget.ts', 'index.ts', 'main.ts', 'source.json', 'package.json', 'readme.md', 'commands.json', 'config.json', '__init__.py']);

/** "D:\\Git\\EvolSpace\\library\\widgets\\slider\\widget.ts" → "slider/widget.ts"; "foo/bar.ts" → "bar.ts". */
export function fileLabel(p) {
  if (!p || typeof p !== 'string') return 'file';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const base = parts.at(-1) ?? p;
  return GENERIC.has(base.toLowerCase()) && parts.length > 1 ? `${parts.at(-2)}/${base}` : base;
}

/** Strip leading `cd <dir> &&` noise so the label shows the real command. */
function commandLabel(cmd) {
  const first = String(cmd ?? '').split(/\r?\n/)[0] ?? '';
  return short(first.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, ''), 50);
}

const EVOLSPACE_TOOLS = {
  scene: () => 'Looking at the scene',
  spawn: (i) => `Spawning ${i.widget ?? 'widget'}`,
  update: (i) => `Updating ${i.id ?? 'entity'}`,
  remove: () => 'Removing entities',
  link: (i) => `Linking ${i.from ?? ''} → ${i.to ?? ''}`.trim(),
  unlink: () => 'Removing link',
  undo: () => 'Undoing',
  redo: () => 'Redoing',
  prefab: (i) => (i.id ? `Placing ${i.id}` : 'Listing prefabs'),
  workspace: (i) => `Workspace: ${i.action ?? 'list'}${i.name ? ` ${i.name}` : ''}`,
  widgets: () => 'Checking widget catalog',
  widget_info: (i) => `Inspecting ${i.id ?? ''} widget`,
  widget_build: (i) => `Building ${i.id ?? ''} widget`,
  thumbnail: (i) => `Rendering ${i.id ?? ''} thumbnail`,
  screenshot: () => 'Taking screenshot',
  user: () => 'Checking where you are',
  say: () => 'Replying',
  status: () => null, // the tool sets its own status line; don't flicker
  events: () => 'Reading event log',
  channels: () => 'Listing data channels',
  channel_get: (i) => `Reading ${i.name ?? 'channel'}`,
  channel_set: (i) => `Publishing ${i.name ?? 'channel'}`,
  sources: (i) => `Sources: ${i.action ?? 'list'}${i.id ? ` ${i.id}` : ''}`,
  pose_record: (i) => `Recording pose ${i.name ?? ''}`,
  gestures: () => 'Checking gestures',
  voice_simulate: () => 'Testing voice command',
  command: (i) => `Running command ${i.name ?? ''}`,
  server_status: () => 'Checking server',
};

/** Short human description of a tool call, or null to skip the update. */
export function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Running: ${commandLabel(i.command)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${fileLabel(i.file_path)}`;
    case 'Write':
      return `Writing ${fileLabel(i.file_path)}`;
    case 'Read':
      return `Reading ${fileLabel(i.file_path)}`;
    case 'NotebookEdit':
      return `Editing ${fileLabel(i.notebook_path)}`;
    case 'Grep':
      return `Searching for "${short(i.pattern, 40)}"`;
    case 'Glob':
      return `Finding files ${short(i.pattern, 40)}`;
    case 'WebFetch': {
      try { return `Fetching ${new URL(i.url).host}`; } catch { return 'Fetching a web page'; }
    }
    case 'WebSearch':
      return `Searching the web: ${short(i.query, 40)}`;
    case 'Task':
    case 'Agent':
      return `Delegating: ${short(i.description ?? i.subagent_type ?? 'subtask', 45)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Planning';
    case 'Skill':
      return `Using skill ${short(i.skill ?? i.name ?? '', 40)}`.trim();
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''));
  if (m) {
    const [, server, tool] = m;
    if (server === 'evolspace' && EVOLSPACE_TOOLS[tool]) return EVOLSPACE_TOOLS[tool](i);
    return `Using ${server} ${tool.replace(/_/g, ' ')}`;
  }
  return `Using ${short(name, 40) || 'a tool'}`;
}

/**
 * The user-visible text of a prompt. Channel events (voice requests) are queued as
 * prompts wrapped in `<channel source="evolspace" kind="voice" …>text</channel>`;
 * show just the text in the headset.
 */
export function promptText(prompt) {
  const s = String(prompt ?? '');
  const m = /^\s*<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(s);
  return m ? m[1] : s;
}

/**
 * Map a hook event + payload to an agent status update, or null for "no update".
 * AgentState (packages/protocol/src/messages.ts): idle|listening|transcribing|thinking|working|error.
 */
export function mapHookEvent(event, payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ev = event || p.hook_event_name;
  switch (ev) {
    case 'UserPromptSubmit': {
      const prompt = short(promptText(p.prompt), 50);
      return { state: 'thinking', detail: prompt ? `Thinking about: ${prompt}` : 'Thinking' };
    }
    case 'PreToolUse': {
      const detail = describeTool(p.tool_name, p.tool_input);
      return detail ? { state: 'working', detail: short(detail, 70) } : null;
    }
    case 'Stop':
      return { state: 'idle' };
    case 'StopFailure':
      return { state: 'error', detail: short(`Stopped: ${p.error_details || p.error || 'API error'}`, 70) };
    case 'Notification':
      switch (p.notification_type) {
        case 'permission_prompt':
          return { state: 'working', detail: 'Needs your permission in the terminal' };
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          return { state: 'working', detail: 'Waiting for your input in the terminal' };
        case 'idle_prompt':
        case 'agent_completed':
          return { state: 'idle' };
        default:
          return null; // auth_success, quota notices, …: nothing to show
      }
    case 'SessionStart':
      return { state: 'idle', detail: 'Claude Code session started' };
    case 'SessionEnd':
      return { state: 'idle', detail: 'Claude Code session ended' };
    default:
      return null;
  }
}

/**
 * Read the hook payload. Resolves at EOF, or as soon as the bytes so far parse as
 * a complete JSON document — so a caller that keeps stdin open cannot make us burn
 * the whole deadline before POSTing — or when `signal` aborts.
 */
export async function readStdin(signal, stream = process.stdin) {
  if (stream.isTTY) return '';
  const chunks = [];
  return new Promise((resolve) => {
    let settled = false;
    const text = () => Buffer.concat(chunks).toString('utf8');
    const done = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      resolve(text());
    };
    stream.on('data', (c) => {
      chunks.push(c);
      try { JSON.parse(text()); done(); } catch { /* incomplete: keep reading */ }
    });
    stream.on('end', done);
    stream.on('error', done);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.EVOL_STATUS_HOOK === '0') return;
  const deadline = AbortSignal.timeout(HARD_TIMEOUT_MS - 50);
  const raw = await readStdin(deadline);
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { /* malformed: use event arg only */ }
  const status = mapHookEvent(argv[0], payload);
  if (!status) return;
  const base = (env.EVOL_URL || DEFAULT_URL).replace(/\/+$/, '');
  await fetch(`${base}/api/agent/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(status),
    signal: deadline,
  }).then((r) => r.body?.cancel(), () => {});
}

const invokedDirectly = (() => {
  try { return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
})();

if (invokedDirectly) {
  // Hard deadline: whatever happens (hung socket, slow DNS), exit 0 quickly.
  setTimeout(() => process.exit(0), HARD_TIMEOUT_MS).unref();
  main().then(() => process.exit(0), () => process.exit(0));
}
