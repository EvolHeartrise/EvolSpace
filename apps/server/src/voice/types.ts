// Contract between the server core and the voice component.
import type { ClientMessage, ServerMessage, ServerEventType, AgentState } from '@evolspace/protocol';

type VoiceBegin = Extract<ClientMessage, { type: 'voice.begin' }>;
type VoiceEnd = Extract<ClientMessage, { type: 'voice.end' }>;

export interface VoiceDeps {
  /** Absolute path of library/voice (commands.json lives here; watch it). */
  voiceDir: string;
  /** Run a command through the server command registry. Throws if unknown. */
  runCommand(name: string, args: Record<string, unknown> | undefined, origin: { clientId?: string }): Promise<unknown>;
  /** Hand a request to Claude: records an 'agent.ask' event (the MCP bridge pushes it into Claude Code). */
  agentAsk(text: string, context: Record<string, unknown>): void;
  /** Show a message in the XR agent panel. */
  say(text: string, kind: 'reply' | 'info' | 'error' | 'heard'): void;
  setAgentStatus(state: AgentState, detail?: string): void;
  /** Send to one client / all xr clients. */
  send(clientId: string, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  event(type: ServerEventType, data: Record<string, unknown>): void;
  /** Words to bias STT toward (widget ids, entity names, ...). */
  vocabulary(): string[];
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface VoiceService {
  onBegin(clientId: string, msg: VoiceBegin): void;
  onAudio(clientId: string, utteranceId: string, pcm: Int16Array): void;
  onEnd(clientId: string, msg: VoiceEnd): void;
  /** Route text as if it had been spoken (POST /api/voice/simulate). */
  simulate(text: string, context?: Record<string, unknown>): Promise<{ route: 'fastpath' | 'agent' | 'none'; command?: string }>;
  commands(): import('@evolspace/protocol').VoiceCommand[];
  close(): Promise<void>;
}
