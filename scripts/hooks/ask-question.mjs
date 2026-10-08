#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher "AskUserQuestion") → answer Claude's questions in EvolSpace.
//
// When an EvolSpace client (headset or desktop dashboard) is connected, the question is published on
// `agent.question` and an `agent-question` card is spawned in front of the user (head-lazy HUD).
// The hook then waits for `agent.answer`:
//   {id, answers}       → permissionDecision "allow" + updatedInput {questions, answers}: Claude gets the
//                         answer and the terminal dialog never opens (documented AskUserQuestion hook flow).
//   {id, terminal:true} → permissionDecision "ask": the normal terminal dialog opens.
//   no answer by the deadline (EVOL_ASK_WAIT_S, default 120 s) → "ask" as well.
// Claude Code cannot show the terminal dialog while a PreToolUse hook runs, so the two are sequential
// (XR first, then terminal), not a race. Without the server or a client: exit at once, no output
// → the terminal dialog as usual. Either way the card is removed when the hook ends.
//
// Env: EVOL_URL (default http://127.0.0.1:8787), EVOL_ASK_HOOK=0 disables, EVOL_ASK_WAIT_S.
// Dependency-free (Node built-ins + fetch).

import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const URL_ = (process.env.EVOL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WAIT_S = Number(process.env.EVOL_ASK_WAIT_S) > 0 ? Number(process.env.EVOL_ASK_WAIT_S) : 120;

async function api(method, path, body, timeoutMs = 3000) {
  const r = await fetch(URL_ + path, {
    method, signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

/** Validate an answers map against the questions: every question answered with known label(s). */
export function validAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of questions) {
    const v = answers[q.question];
    if (typeof v !== 'string' || !v) return null;
    const labels = new Set((q.options ?? []).map((o) => o.label));
    const picked = q.multiSelect ? v.split(/,\s*/) : [v];
    if (!picked.every((l) => labels.has(l))) return null;
    out[q.question] = v;
  }
  return out;
}

/** Resolve with the first agent.answer value for `id` (SSE), or null at the deadline. */
function waitForAnswer(id, deadline) {
  return new Promise((resolve) => {
    const u = new URL(`${URL_}/api/channels/agent.answer/events`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    const req = (u.protocol === 'https:' ? https : http).get(u, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          try { const v = JSON.parse(data); if (v && v.id === id) finish(v); } catch { /* not ours */ }
        }
      });
      res.on('end', () => finish(null));
    });
    req.on('error', () => finish(null));
  });
}

function emit(decision, input, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
      ...(input ? { updatedInput: input } : {}),
    },
  }));
}

async function main() {
  if (process.env.EVOL_ASK_HOOK === '0') return;
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const hook = JSON.parse(raw || '{}');
  if (hook.tool_name !== 'AskUserQuestion') return;
  const questions = hook.tool_input?.questions;
  if (!Array.isArray(questions) || !questions.length) return;

  // Only when someone is in EvolSpace to answer: otherwise the terminal dialog, right away.
  let health;
  try { health = await api('GET', '/api/health', undefined, 1500); } catch { return; }
  const people = (health.clients ?? []).filter((c) => c.role === 'xr' || c.role === 'desktop');
  if (!people.length) return;

  const id = randomUUID();
  const expiresAt = Date.now() + WAIT_S * 1000;
  let entity = null;
  try {
    await api('PUT', '/api/channels/agent.question?producer=ask-hook', { id, questions, status: 'open', expiresAt });
    const res = await api('POST', '/api/scene/ops', {
      source: 'agent',
      ops: [{ op: 'add', entity: { widget: 'agent-question', name: 'Claude asks', anchor: { kind: 'head', lazy: true }, transform: { position: [0, -0.08, -0.65], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } }],
    });
    entity = res.ids?.[0] ?? null;
    await api('POST', '/api/agent/status', { state: 'thinking', detail: 'Question for you: answer on the card' }).catch(() => {});
  } catch {
    return; // EvolSpace not usable: plain terminal dialog
  }

  const reply = await waitForAnswer(id, expiresAt);
  const answers = reply && !reply.terminal ? validAnswers(questions, reply.answers) : null;
  const reason = answers ? 'answered in EvolSpace' : reply?.terminal ? 'terminal' : 'timeout';
  // close the card (and the question) whatever happened
  await api('PUT', '/api/channels/agent.question?producer=ask-hook', { id, questions, status: 'closed', reason }).catch(() => {});
  if (entity) await api('POST', '/api/scene/ops', { source: 'agent', ops: [{ op: 'remove', id: entity }] }).catch(() => {});

  if (answers) emit('allow', { ...hook.tool_input, answers }, 'Answered in EvolSpace');
  else {
    if (!reply) await api('POST', '/api/agent/say', { text: 'No answer in time — the question is in the terminal now.', kind: 'info' }).catch(() => {});
    emit('ask', undefined, reply?.terminal ? 'Answer in the terminal (chosen in EvolSpace)' : 'No answer in EvolSpace in time');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { /* never break the tool call: no output = normal dialog */ });
}
