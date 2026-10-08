// Agent panel: Claude's live status (same states/colors/motion as the XR orb),
// the conversation (replies, notices, errors, what voice heard, asks typed or
// sent by widgets, voice routing results), and a composer:
//   - "Ask Claude": ClientMessage {type:'agent.ask', text, context} — the server
//     records an agent.ask event and the MCP bridge pushes it into Claude Code
//     exactly like a voice request (context carries the current selection).
//   - "Simulate voice": POST /api/voice/simulate (runs the fast path for real,
//     or hands the text to Claude flagged simulated) → shows the routing.
//   - Hold-to-talk: the client's real push-to-talk (command voice.ptt start/end).
// Right side: the fast-path voice commands (GET /api/voice/commands) and a
// dry-run phrase tester (client-side replica of the server matcher, see
// agent/voice-match.ts — /api/voice/simulate has no dry-run).
// (Whether the MCP bridge is attached is not detectable: it talks plain HTTP,
// it is not a WebSocket client in /api/health.)

import { signal } from '@preact/signals';
import type { AgentState, ServerMessage, VoiceCommand } from '@evolspace/protocol';
import { SYSTEM_STYLE } from '@evolspace/runtime';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { definePanel } from '../registry.ts';
import type { DebugContext, PanelProps } from '../types.ts';
import { entityLabel } from '../entity.ts';
import { fmtTime, prettyJson } from '../ui/format.ts';
import { copyText, useInterval } from '../ui/hooks.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, IconButton, SearchBox } from '../ui/kit.tsx';
import { ensureCss } from './events/css.ts';
import { AGENT_CSS } from './agent/styles.ts';
import { compileCommands, dryRun, type DryRun } from './agent/voice-match.ts';

type OrbState = AgentState | 'offline';

/** Same labels as the XR orb (packages/runtime/src/system/AgentOrb.ts). */
const LABELS: Record<OrbState, string> = {
  idle: 'Claude · idle',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Claude is thinking',
  working: 'Claude is working',
  error: 'Claude · error',
  offline: 'Server offline',
};

export interface RouteItem {
  id: string;
  ts: number;
  source: 'simulate' | 'voice';
  text: string;
  route: 'fastpath' | 'agent' | 'none' | 'error';
  command?: string;
  error?: string;
}

// Module-level: survives tab switches.
const mode = signal<'ask' | 'simulate'>('ask');
const draft = signal('');
const withSelection = signal(true);
const history = signal<string[]>([]);
const routes = signal<RouteItem[]>([]);
const voiceCmds = signal<VoiceCommand[] | null>(null);
const voiceCmdsError = signal<string | null>(null);
const testPhrase = signal('');
const ptt = signal<{ holding: boolean; since: number; frames: number; awaiting: boolean }>({ holding: false, since: 0, frames: 0, awaiting: false });

let routeSeq = 0;
function addRoute(r: Omit<RouteItem, 'id'>) {
  routes.value = [...routes.value, { ...r, id: `r${++routeSeq}` }].slice(-100);
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// ------------------------------------------------------------------ status

export function Orb({ state, size }: { state: OrbState; size?: number }) {
  const c = (SYSTEM_STYLE.agent as Record<string, string>)[state] ?? SYSTEM_STYLE.agent.idle;
  return (
    <span class={`dbg-orb ${state}`} style={{ '--c': c, ...(size ? { transform: `scale(${size / 26})` } : {}) }} aria-hidden="true">
      <span class="halo" /><span class="arc" /><span class="dots"><i /><i /><i /></span><span class="core" />
    </span>
  );
}

function StatusHeader({ ctx }: { ctx: DebugContext }) {
  const st = ctx.store.agentStatus.value;
  const conn = ctx.store.conn.value;
  const [, setNow] = useState(0);
  useInterval(() => setNow(Date.now()), 1000);
  const state: OrbState = !conn.connected ? 'offline' : st?.state ?? 'idle';
  const since = st?.since;
  return (
    <div class="dbg-ag-head">
      <Orb state={state} />
      <div class="st">
        <div class="s" style={{ color: state === 'idle' || state === 'offline' ? 'var(--text)' : (SYSTEM_STYLE.agent as Record<string, string>)[state] }}>
          {LABELS[state]}
          {since && state !== 'offline' ? <span class="el" title={new Date(since).toLocaleString()}>{fmtElapsed(Date.now() - since)}</span> : null}
        </div>
        <div class="dt" title={st?.detail}>{state === 'offline' ? 'Reconnecting to the EvolSpace server…' : st?.detail || (state === 'idle' ? 'Waiting for a request' : '—')}</div>
      </div>
      <IconButton icon="refresh" class="sm" title="Reload status + recent messages" onClick={() => void ctx.store.refresh('agent').catch((e: Error) => ctx.toast(e.message, 'error'))} />
    </div>
  );
}

// ------------------------------------------------------------------ timeline

interface Item {
  key: string;
  ts: number;
  kind: 'reply' | 'info' | 'error' | 'heard' | 'ask' | 'route';
  text: string;
  who?: string;
  route?: RouteItem;
}

function timeline(ctx: DebugContext): Item[] {
  const items: Item[] = ctx.store.agentMessages.value.map((m) => ({ key: m.id, ts: m.ts, kind: m.kind, text: m.text }));
  for (const e of ctx.store.events.value) {
    if (e.type !== 'agent.ask') continue;
    const c = { ...((e.data.context ?? {}) as Record<string, unknown>), ...e.data };
    // Voice asks already show as 'heard' messages (+ the route).
    if (c.utteranceId || c.utterance_id || c.kind === 'voice' || c.source === 'voice' || c.simulated) continue;
    const who = c.kind === 'debug' ? 'you' : typeof c.widget === 'string' ? c.widget : typeof c.kind === 'string' ? c.kind : 'ask';
    items.push({ key: `ev${e.seq}-${e.ts}`, ts: e.ts, kind: 'ask', text: String(e.data.text ?? ''), who });
  }
  for (const r of routes.value) items.push({ key: r.id, ts: r.ts, kind: 'route', text: r.text, route: r });
  items.sort((a, b) => a.ts - b.ts);
  return items.slice(-250);
}

function RouteChip({ r }: { r: RouteItem }) {
  return (
    <span class="dbg-ag-route" title={r.error ?? `${r.source}: “${r.text}”`}>
      <Icon name={r.source === 'voice' ? 'mic' : 'play'} size={11} />
      {r.source === 'simulate' ? 'simulated' : 'voice'}
      <span>→</span>
      <span class={`r ${r.route}`}>{r.route === 'fastpath' ? `fastpath · ${r.command ?? '?'}` : r.route === 'agent' ? 'Claude' : r.route === 'error' ? 'failed' : `none${r.command ? ` · ${r.command}` : ''}`}</span>
      {r.error ? <span class="r error">{r.error.slice(0, 60)}</span> : null}
    </span>
  );
}

function Messages({ ctx }: { ctx: DebugContext }) {
  const items = timeline(ctx);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = items.at(-1)?.key;
  useLayoutEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [last, items.length]);
  if (!items.length) {
    return (
      <div class="dbg-ag-msgs" ref={box}>
        <div class="dbg-empty" style={{ padding: '12px' }}><Icon name="bot" size={24} /><div class="t">No messages yet</div>
          <div class="d">Claude's replies (the <span class="dbg-mono">say</span> tool), what voice heard and routing results appear here.</div></div>
      </div>
    );
  }
  return (
    <div class="dbg-ag-msgs" ref={box} onScroll={() => { const el = box.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {items.map((it) => (
        <div key={it.key} class={`dbg-ag-m ${it.kind}`}>
          {it.kind === 'route' && it.route ? <RouteChip r={it.route} /> : (
            <>
              <span class="who">
                {it.kind === 'reply' ? <><Icon name="bot" size={11} />Claude</> : it.kind === 'heard' ? <><Icon name="mic" size={11} />heard</>
                  : it.kind === 'ask' ? <>{it.who}</> : it.kind === 'error' ? <><Icon name="alert" size={11} />error</> : <Icon name="dot" size={11} />}
              </span>
              <span class="b">{it.text}</span>
            </>
          )}
          <span class="tm" title={new Date(it.ts).toLocaleString()}>{fmtTime(it.ts).slice(0, 8)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ composer

function selectionContext(ctx: DebugContext): Record<string, unknown> | undefined {
  const e = ctx.store.selectedEntity.value;
  if (!e || !withSelection.value) return undefined;
  return { selected: e.id, selected_name: entityLabel(e), selected_widget: e.widget };
}

async function send(ctx: DebugContext): Promise<void> {
  const text = draft.value.trim();
  if (!text) return;
  history.value = [...history.value.filter((h) => h !== text), text].slice(-30);
  const sel = selectionContext(ctx);
  if (mode.value === 'ask') {
    // kind 'debug' → <channel kind="debug" selected=…>: typed at the desktop dashboard.
    const context: Record<string, unknown> = { kind: 'debug', ...(sel ?? {}) };
    try {
      if (ctx.net.connected) ctx.net.send({ type: 'agent.ask', text, context });
      else await ctx.api.command('agent.ask', { text, context });
      draft.value = '';
      ctx.toast(`Sent to Claude${sel ? ` (selected ${String(sel.selected)})` : ''}`);
    } catch (e) {
      ctx.toast(`agent.ask failed: ${(e as Error).message}`, 'error');
    }
    return;
  }
  try {
    const r = await ctx.api.simulateVoice(text, sel ? { selected: sel.selected } : undefined);
    addRoute({ ts: Date.now(), source: 'simulate', text, route: r.route, ...(r.command ? { command: r.command } : {}) });
    draft.value = '';
  } catch (e) {
    addRoute({ ts: Date.now(), source: 'simulate', text, route: 'error', error: (e as Error).message });
  }
}

function PttButton({ ctx }: { ctx: DebugContext }) {
  const p = ptt.value;
  const st = ctx.store.agentStatus.value?.state;
  const readState = () => (ctx.client.state() as { ptt?: { active?: boolean; framesSent?: number }; mic?: { state?: string; error?: string | null } });
  useInterval(() => {
    const s = readState();
    ptt.value = { ...ptt.peek(), frames: s.ptt?.framesSent ?? 0 };
  }, p.holding ? 100 : null);
  const start = (ev: PointerEvent) => {
    if (ev.button !== 0 || ptt.peek().holding) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    ctx.client.command('voice.ptt', undefined, 'start');
    ptt.value = { holding: true, since: Date.now(), frames: 0, awaiting: false };
    setTimeout(() => {
      const s = readState();
      if (ptt.peek().holding && !s.ptt?.active && s.mic?.error) ctx.toast(`Microphone: ${s.mic.error}`, 'error');
    }, 900);
  };
  const end = () => {
    if (!ptt.peek().holding) return;
    ctx.client.command('voice.ptt', undefined, 'end');
    const held = Date.now() - ptt.peek().since;
    ptt.value = { ...ptt.peek(), holding: false, awaiting: held > 250 };
    if (held > 250) setTimeout(() => { if (ptt.peek().awaiting) ptt.value = { ...ptt.peek(), awaiting: false }; }, 15_000);
  };
  const busy = !p.holding && (p.awaiting || st === 'transcribing');
  const label = p.holding ? `Listening ${(p.frames * 0.1).toFixed(1)} s` : busy ? 'Transcribing…' : 'Talk';
  return (
    <button type="button" class={`dbg-ptt${p.holding ? ' on' : ''}${busy ? ' busy' : ''}`}
      title="Hold to talk: the client's real push-to-talk (voice.ptt start/end) — mic → server → STT → fast path or Claude. The V key in the 3D view does the same."
      onPointerDown={start} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <Icon name="mic" size={14} />{label}
    </button>
  );
}

function Composer({ ctx }: { ctx: DebugContext }) {
  const sel = ctx.store.selectedEntity.value;
  const histIdx = useRef<number | null>(null);
  const simulate = mode.value === 'simulate';
  return (
    <div class="dbg-ag-comp">
      <div class="dbg-seg" role="tablist">
        <button type="button" class={simulate ? '' : 'on'} title="Send the text to Claude Code (agent.ask → MCP bridge channel), like a voice request" onClick={() => { mode.value = 'ask'; }}>
          <Icon name="bot" size={12} />Ask
        </button>
        <button type="button" class={simulate ? 'on' : ''} title="Route the text like a transcript (POST /api/voice/simulate): a matching fast-path command RUNS for real; otherwise it goes to Claude flagged simulated" onClick={() => { mode.value = 'simulate'; }}>
          <Icon name="play" size={12} />Simulate
        </button>
      </div>
      <input type="text" class="dbg-text" value={draft.value} spellcheck={false}
        placeholder={simulate ? 'Utterance, e.g. “undo”' : 'Ask Claude…'}
        onInput={(e) => { draft.value = (e.currentTarget as HTMLInputElement).value; histIdx.current = null; }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void send(ctx); histIdx.current = null; }
          else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.value.length) {
            e.preventDefault();
            const h = history.value;
            let i = histIdx.current ?? h.length;
            i = Math.max(0, Math.min(h.length, i + (e.key === 'ArrowUp' ? -1 : 1)));
            histIdx.current = i;
            draft.value = h[i] ?? '';
          }
        }} />
      {sel ? (
        <span class="dbg-ag-ctx" title={withSelection.value ? `Sent with context selected=${sel.id}` : 'Selection not included — click + to include it'}
          style={withSelection.value ? undefined : { opacity: 0.5, textDecoration: 'line-through' }}>
          {sel.id}
          <button type="button" title={withSelection.value ? 'Don’t include the selection' : 'Include the selection'} onClick={() => { withSelection.value = !withSelection.value; }}>
            <Icon name={withSelection.value ? 'x' : 'plus'} size={11} />
          </button>
        </span>
      ) : null}
      <button type="button" class="dbg-btn primary dbg-ag-send" disabled={!draft.value.trim()} title={simulate ? 'Simulate (Enter)' : 'Send to Claude (Enter)'} onClick={() => void send(ctx)}>
        <Icon name={simulate ? 'play' : 'chevronRight'} size={14} />
      </button>
      <PttButton ctx={ctx} />
    </div>
  );
}

// ------------------------------------------------------------------ voice commands + tester

function DryRunResult({ r, phrase }: { r: DryRun | null; phrase: string }) {
  if (!r || !phrase.trim()) return <div class="dbg-ag-res"><span class="k">Type a phrase to see which fast-path command it would match (dry run — nothing is executed).</span></div>;
  return (
    <div class="dbg-ag-res">
      <div class="l1">
        {r.route === 'agent' ? <><Badge kind="info">→ Claude</Badge><span class="k">no fast-path command matches</span></>
          : r.route === 'none' ? <><Badge kind="warn">{r.match.command.id}</Badge><span class="k" style={{ color: 'var(--accent2)' }}>matches, but {r.error} (nothing would run)</span></>
          : <><Badge kind="ok">{r.match.command.id}</Badge><span class="dbg-mono" style={{ color: 'var(--accent2)' }}>{r.noop ? '(discard utterance)' : `${r.run} ${r.args ? JSON.stringify(r.args) : ''}`}</span></>}
      </div>
      {r.route !== 'agent' ? <div class="forms" title={r.match.pattern}>pattern <span style={{ color: 'var(--dim)' }}>{r.match.pattern}</span> on “{r.match.text}”</div> : null}
      <div class="forms" title={r.forms.join('\n')}>tried: {r.forms.map((f) => `“${f}”`).join(' · ') || '—'}</div>
    </div>
  );
}

function VoiceSide({ ctx }: { ctx: DebugContext }) {
  const cmds = voiceCmds.value;
  const load = () => {
    ctx.api.voiceCommands().then((c) => { voiceCmds.value = c; voiceCmdsError.value = null; }).catch((e: Error) => { voiceCmdsError.value = e.message; });
  };
  useEffect(load, []);
  const compiled = useMemo(() => compileCommands(cmds ?? []), [cmds]);
  const sel = ctx.store.selection.value;
  const phrase = testPhrase.value;
  const r = useMemo(() => (phrase.trim() ? dryRun(phrase, compiled, sel ? { selected: sel } : undefined) : null), [phrase, compiled, sel]);
  const hitId = r && r.route !== 'agent' ? r.match.command.id : null;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hitId) return;
    list.current?.querySelector<HTMLElement>(`[data-cmd="${CSS.escape(hitId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hitId]);
  return (
    <div class="dbg-ag-side">
      <div class="dbg-ag-test">
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <SearchBox value={phrase} onInput={(v) => { testPhrase.value = v; }} placeholder="Test a phrase (dry run), e.g. “okay undo please”" />
          {phrase.trim() ? <IconButton icon="play" class="sm" title="Simulate it for real (Simulate voice mode)" onClick={() => { mode.value = 'simulate'; draft.value = phrase; }} /> : null}
          <IconButton icon="refresh" class="sm" title="Reload commands (library/voice/commands.json hot-reloads on the server)" onClick={load} />
        </div>
        <DryRunResult r={r} phrase={phrase} />
      </div>
      <div class="dbg-ag-cmds" ref={list}>
        <div class="dbg-sub" style={{ margin: '6px 10px 2px', display: 'flex', gap: '6px' }}>Fast-path voice commands <span class="dbg-count">{cmds?.length ?? '…'}</span></div>
        {voiceCmdsError.value ? <div class="dbg-dim" style={{ padding: '6px 10px', color: 'var(--neg)', fontSize: '12px' }}>{voiceCmdsError.value}</div> : null}
        {compiled.map((c) => (
          <div key={c.def.id} data-cmd={c.def.id} class={`dbg-ag-cmd${c.def.id === hitId ? ' hit' : ''}`}>
            <div class="h">
              <span class="id">{c.def.id}</span>
              <span class="run" title={prettyJson(c.def.args ?? {})}>→ {c.def.command}{c.def.args ? ` ${JSON.stringify(c.def.args)}` : ''}</span>
            </div>
            {c.def.description ? <div class="ds">{c.def.description}</div> : null}
            <div class="ps">
              {c.def.patterns.map((p, i) => (
                <span key={i} class={`p${c.def.id === hitId && r && r.route !== 'agent' && r.match.patternIndex === i ? ' hit' : ''}${c.regexes[i] ? '' : ' bad'}`}
                  title={c.regexes[i] ? `^(?:${p})$ (case-insensitive) — click to copy` : c.errors.join('\n')}
                  onClick={() => void copyText(p).then((ok) => ok && ctx.toast('Pattern copied'))}>{p}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ panel

function AgentPanel({ ctx }: PanelProps) {
  ensureCss('agent', AGENT_CSS);
  return (
    <div class="dbg-ag">
      <div class="dbg-ag-main">
        <StatusHeader ctx={ctx} />
        <Messages ctx={ctx} />
        <Composer ctx={ctx} />
      </div>
      <VoiceSide ctx={ctx} />
    </div>
  );
}

export default definePanel({
  id: 'agent',
  title: 'Agent',
  dock: 'bottom',
  order: 30,
  icon: 'bot',
  component: AgentPanel,
  init: (ctx) => {
    // voice.result goes only to the client that spoke: our hold-to-talk results.
    const off = ctx.net.on('voice.result', (m: Extract<ServerMessage, { type: 'voice.result' }>) => {
      ptt.value = { ...ptt.peek(), awaiting: false };
      addRoute({ ts: Date.now(), source: 'voice', text: m.text, route: m.route, ...(m.command ? { command: m.command } : {}) });
    });
    return off;
  },
  badge: (ctx) => {
    const s = ctx.store.agentStatus.value?.state;
    return s && s !== 'idle' ? (s === 'error' ? '!err' : s === 'working' || s === 'thinking' ? '…' : null) : null;
  },
});

/** Tests only. */
export const __agentState = { mode, draft, routes, voiceCmds, testPhrase, ptt, withSelection };
