// Contract between the server core and the voice component.
import type { ClientMessage, ServerMessage, ServerEventType, AgentState, AgentStatus } from '@evolspace/protocol';

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
  /**
   * Optional (added by the voice component, backward compatible): name + widget
   * of an entity, so requests routed to Claude carry readable deictic context
   * ("this" = entity e-7f3a "Seattle weather", widget line-chart).
   */
  describeEntity?(id: string): { name?: string; widget?: string } | undefined;
  /**
   * Optional (added by the voice component, backward compatible): the current
   * agent status. Lets voice restore Claude's 'thinking'/'working' indicator
   * after an utterance instead of resetting it to 'idle'.
   */
  agentStatus?(): AgentStatus;
  /** Optional STT base URL (default: env EVOL_STT_URL, else http://127.0.0.1:8790). */
  sttUrl?: string;
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
