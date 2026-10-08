// Agent I/O state: Claude's current status (from Claude Code hooks) and the
// recent messages shown in the XR agent panel.
import type { AgentMessage, AgentState, AgentStatus, ServerMessage } from '@evolspace/protocol';
import { shortId } from './util/ids.ts';

const STATES: readonly AgentState[] = ['idle', 'listening', 'transcribing', 'thinking', 'working', 'error'];
const KINDS: readonly AgentMessage['kind'][] = ['reply', 'info', 'error', 'heard'];

export function isAgentState(s: unknown): s is AgentState {
  return typeof s === 'string' && (STATES as readonly string[]).includes(s);
}
export function isMessageKind(s: unknown): s is AgentMessage['kind'] {
  return typeof s === 'string' && (KINDS as readonly string[]).includes(s);
}

export class AgentHub {
  private _status: AgentStatus = { state: 'idle', since: Date.now() };
  private messages: AgentMessage[] = [];

  constructor(
    private readonly broadcast: (m: ServerMessage) => void,
    private readonly keep = 50,
  ) {}

  get status(): AgentStatus { return this._status; }
  recent(): AgentMessage[] { return [...this.messages]; }

  setStatus(state: AgentState, detail?: string): AgentStatus {
    const prev = this._status;
    // Keep `since` stable when only the detail changes (e.g. successive tools while working).
    const since = prev.state === state ? prev.since : Date.now();
    this._status = detail ? { state, detail, since } : { state, since };
    if (prev.state !== state || prev.detail !== detail) this.broadcast({ type: 'agent.status', status: this._status });
    return this._status;
  }

  say(text: string, kind: AgentMessage['kind'] = 'reply'): AgentMessage {
    const message: AgentMessage = { id: shortId('m', (id) => this.messages.some((m) => m.id === id), 6), text, kind, ts: Date.now() };
    this.messages.push(message);
    if (this.messages.length > this.keep) this.messages.splice(0, this.messages.length - this.keep);
    this.broadcast({ type: 'agent.message', message });
    return message;
  }
}
