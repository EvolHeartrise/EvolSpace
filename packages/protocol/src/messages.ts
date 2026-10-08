// WebSocket protocol. One endpoint: wss://<host>:8443/ws (or ws://127.0.0.1:8787/ws).
// Text frames carry JSON messages below; binary frames carry either tensor
// channel values (see data.ts) or microphone audio (see AudioFrame).

import type { SceneState, SceneOp, Transform, Vec3, Quat, Handedness } from './scene.ts';
import type { HandFrame, PoseDef, InteractionSet, PoseEvent, HandFeatures } from './gestures.ts';
import type { WidgetManifest } from './widgets.ts';
import type { ChannelValue } from './data.ts';

/**
 * Roles:
 * - xr:      the headset (or a desktop browser emulating one). Exactly one is "primary";
 *            its user.pose is what screenshots use for the user's view.
 * - desktop: a non-XR viewer (monitor spectator / dev).
 * - mirror:  the server's headless renderer (screenshots, thumbnails).
 * - tool:    scripts/bridges that want events and channels but not rendering.
 */
export type ClientRole = 'xr' | 'desktop' | 'mirror' | 'tool';

export type AgentState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'working' | 'error';

export interface AgentStatus {
  state: AgentState;
  /** Short line, e.g. "Editing resid-flow widget", "Running Bash". */
  detail?: string;
  since: number;
}

export interface AgentMessage {
  id: string;
  text: string;
  /** reply = Claude talking to the user; info = system notice; error = failures; heard = transcript echo. */
  kind: 'reply' | 'info' | 'error' | 'heard';
  ts: number;
}

/** The user's state, streamed by the primary xr client at ~30 Hz. */
export interface UserPose {
  t: number;
  mode: 'vr' | 'ar' | 'inline';
  head: { position: Vec3; rotation: Quat };
  /** Vertical FOV (degrees) and aspect of the XR view, for mirror camera matching. */
  fov?: number;
  aspect?: number;
  hands: Partial<Record<Handedness, HandFrame>>;
  /** What each hand's ray currently hits (entity id + point), if anything. */
  focus?: Partial<Record<Handedness, { entity: string; point: Vec3 } | null>>;
  /** What the head's forward ray hits. */
  gaze?: { entity: string; point: Vec3 } | null;
  /** Currently selected entity (via 'select' command), if any. */
  selected?: string | null;
}

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | { type: 'hello'; clientId: string; serverVersion: string; primary: boolean }
  | { type: 'scene.snapshot'; scene: SceneState }
  | { type: 'scene.patch'; version: number; ops: SceneOp[]; source: string }
  | { type: 'widgets.catalog'; widgets: WidgetManifest[] }
  /** A single widget was rebuilt; clients re-import manifest.url and re-create its instances. */
  | { type: 'widgets.updated'; widget: WidgetManifest }
  | { type: 'gestures.defs'; poses: PoseDef[]; interactions: Record<string, InteractionSet> }
  /** JSON channel value (tensor values arrive as binary frames). */
  | { type: 'channel.value'; channel: string; value: ChannelValue; seq: number }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'agent.message'; message: AgentMessage }
  /** Ask the xr client to record a pose: show a countdown, sample features for `seconds`, reply with pose.recording. */
  | { type: 'pose.record'; requestId: string; name: string; hand: Handedness | 'either'; seconds: number; countdown: number }
  /** Generic command for clients, e.g. { name: 'session.mode', args: { mode: 'ar' } }, 'reload', 'select'. */
  | { type: 'command'; name: string; args?: Record<string, unknown> }
  /** Fast-path voice command result / routing notice (shown briefly in the HUD). */
  | { type: 'voice.result'; utteranceId: string; text: string; route: 'fastpath' | 'agent' | 'none'; command?: string }
  /**
   * The primary xr client's latest user.pose, forwarded (≤15 Hz, latest wins) only to clients whose hello
   * carried the `user-pose` capability (the desktop debug dashboard). `null` = the primary went away.
   * Also sent right after hello when a pose is known.
   */
  | { type: 'user.pose'; pose: UserPose | null };

// ---------------------------------------------------------------- client → server

export type ClientMessage =
  /**
   * capabilities (free-form strings) the server understands: 'no-echo' (don't send this client its own channel
   * publishes back), 'user-pose' (forward the primary's user.pose to this client, see ServerMessage 'user.pose').
   */
  | { type: 'hello'; role: ClientRole; userAgent?: string; capabilities?: string[]; wantPrimary?: boolean }
  | { type: 'scene.ops'; ops: SceneOp[]; source: 'user' | 'widget'; /** ops in one gesture share a group for undo */ group?: string }
  | { type: 'scene.undo' }
  | { type: 'scene.redo' }
  | { type: 'user.pose'; pose: UserPose }
  | { type: 'channel.subscribe'; channels: string[] }
  | { type: 'channel.unsubscribe'; channels: string[] }
  | { type: 'channel.publish'; channel: string; value: ChannelValue }
  | { type: 'widget.event'; entity: string; widget: string; name: string; data?: unknown }
  | { type: 'client.error'; message: string; stack?: string; entity?: string; widget?: string }
  | { type: 'client.log'; level: 'info' | 'warn' | 'error'; message: string; entity?: string }
  | { type: 'pose.event'; event: PoseEvent }
  | { type: 'pose.recording'; requestId: string; name: string; hand: Handedness; frames: HandFeatures[] }
  /** Free-text request to the agent (from a widget's askAgent or a UI). */
  | { type: 'agent.ask'; text: string; context?: Record<string, unknown> }
  /** Push-to-talk lifecycle. Audio itself flows as binary AudioFrames between begin and end. */
  | { type: 'voice.begin'; utteranceId: string; sampleRate: number; context: VoiceContext }
  | { type: 'voice.end'; utteranceId: string; cancelled?: boolean }
  /** Run a named command on the server (undo, redo, screenshot, etc.) — used by fast-path & bindings. */
  | { type: 'command'; name: string; args?: Record<string, unknown> };

/** Snapshot of deictic context captured at push-to-talk start ("make *this* bigger"). */
export interface VoiceContext {
  focus?: UserPose['focus'];
  gaze?: UserPose['gaze'];
  selected?: string | null;
  head?: UserPose['head'];
}

/**
 * Binary audio frame (client → server):
 *   bytes 0..3 : ASCII "AUD0"
 *   bytes 4..39: utteranceId, ASCII, NUL-padded to 36 bytes
 *   remaining  : PCM s16le mono at the sampleRate given in voice.begin (16000 recommended)
 * Tensor frames never start with "AUD0" because their first 4 bytes are a small u32 length.
 */
export const AUDIO_FRAME_MAGIC = 'AUD0';

export type { Transform };
