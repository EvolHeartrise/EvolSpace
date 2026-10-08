// The service container shared by HTTP routes and WS handlers (built in app.ts).
import type { OpSource, SceneOp, ServerEventType } from '@evolspace/protocol';
import type { ServerConfig } from './config.ts';
import type { Logger } from './log.ts';
import type { EventLog } from './events.ts';
import type { SceneStore, ApplyResult } from './scene/store.ts';
import type { Workspaces } from './scene/workspaces.ts';
import type { InstantiateOptions } from './scene/prefabs.ts';
import type { WidgetLibrary } from './widgets/library.ts';
import type { DataBus } from './data/bus.ts';
import type { WsHub } from './ws/hub.ts';
import type { AgentHub } from './agent.ts';
import type { CommandRegistry } from './commands.ts';
import type { GestureLibrary } from './gestures/library.ts';
import type { PoseRecorder } from './gestures/recorder.ts';
import type { UserState } from './user.ts';
import type { SourceSupervisor } from './sources/supervisor.ts';
import type { VoiceService } from './voice/index.ts';
import type { Mirror } from './mirror/index.ts';
import type { UserPoseFeed } from './ws/user-pose-feed.ts';

export interface Services {
  config: ServerConfig;
  log: Logger;
  events: EventLog;
  store: SceneStore;
  workspaces: Workspaces;
  widgets: WidgetLibrary;
  bus: DataBus;
  hub: WsHub;
  agent: AgentHub;
  commands: CommandRegistry;
  gestures: GestureLibrary;
  recorder: PoseRecorder;
  user: UserState;
  /** Forwards the primary's user.pose to `user-pose` subscribers (debug dashboards). */
  userPoseFeed: UserPoseFeed;
  sources: SourceSupervisor;
  voice: VoiceService;
  /** Lazily started headless renderer. */
  mirror(): Promise<Mirror>;
  /** Mirror diagnostics if it has been started (never starts it). */
  mirrorStatus(): object | null;
  /** Apply + broadcast an op batch (throws SceneError on invalid ops). */
  applyOps(ops: SceneOp[], source: OpSource | string, group?: string): ApplyResult;
  instantiatePrefab(id: string, opts: InstantiateOptions, source?: OpSource): Promise<{ ids: Record<string, string>; version: number }>;
  /** Record an agent.ask event (the MCP bridge forwards it into Claude Code). */
  agentAsk(text: string, context: Record<string, unknown>): void;
  event(type: ServerEventType, data: Record<string, unknown>): void;
  /** http://127.0.0.1:<port> of the running server. */
  baseUrl(): string;
  /** Words to bias STT toward. */
  vocabulary(): string[];
  /** Absolute paths of library sub-folders. */
  paths: { widgets: string; shared: string; prefabs: string; poses: string; interactions: string; voice: string; sources: string };
}
