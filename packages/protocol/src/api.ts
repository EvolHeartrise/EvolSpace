// HTTP API served by apps/server on BOTH http://127.0.0.1:8787 (local tools,
// no TLS hassle) and https://0.0.0.0:8443 (the headset). JSON in/out unless
// noted. Every language on the machine drives EvolSpace through this API; the
// MCP bridge is a thin proxy over it.
//
// Scene
//   GET    /api/health                         -> { ok, version, clients: {role,primary}[] }
//   GET    /api/scene                          -> SceneState
//   GET    /api/scene/summary                  -> SceneSummary (compact tree for the agent)
//   POST   /api/scene/ops    {ops, source?}    -> { version, ids: string[] }  (ids of added entities/links, in op order)
//   POST   /api/scene/undo | /api/scene/redo   -> { version }
//   POST   /api/prefabs/:id/instantiate {transform?, parent?, props?: Record<prefabLocalId, props>} -> { ids: Record<prefabLocalId, newId> }
//   GET    /api/workspaces                     -> { current, list: string[] }
//   POST   /api/workspaces/:name/save | /load | /new
//
// Widgets (source of truth = files in library/widgets; server watches + rebuilds)
//   GET    /api/widgets                        -> WidgetManifest[]
//   GET    /api/widgets/:id                    -> WidgetManifest & { source: string }
//   POST   /api/widgets/:id/build              -> { ok, error?, manifest? }   (force rebuild, returns errors)
//   POST   /api/widgets/:id/thumbnail          -> image/png (renders + saves library/widgets/:id/thumbnail.png)
//   GET    /widgets/:id.js                     -> compiled ESM bundle
//
// Data channels
//   GET    /api/channels                       -> ChannelInfo[]
//   GET    /api/channels/:name                 -> JSON value, or application/x-evol-tensor binary
//   PUT    /api/channels/:name                 body JSON, or binary tensor with Content-Type application/x-evol-tensor
//                                              (or raw bytes with headers X-Dtype + X-Shape: "2,3,4")
//   GET    /api/channels/:name/events          -> text/event-stream of JSON values (tensors as {$tensor, dtype, shape, b64})
//
// Sources (long-running drivers in library/sources/<id>/source.json)
//   GET    /api/sources                        -> SourceStatus[]
//   POST   /api/sources/:id/start | /stop | /restart
//
// User & view
//   GET    /api/user                           -> UserPose | null (latest from primary xr client; hands summarized to features)
//   POST   /api/screenshot  ScreenshotRequest  -> image/png (or JSON {error})
//
// Agent I/O
//   POST   /api/agent/status {state, detail?}  -> {}   (Claude Code hooks call this)
//   POST   /api/agent/say    {text, kind?}     -> { id }
//   GET    /api/events?since=<seq>&wait=<ms>&types=a,b -> { events: ServerEvent[], next: number }  (long-poll)
//
// Gestures & voice (source of truth = files in library/poses, library/interactions, library/voice)
//   GET    /api/gestures                       -> { poses: PoseDef[], interactions: Record<string, InteractionSet> }
//   POST   /api/gestures/record {name, hand, seconds?, countdown?, description?} -> PoseDef (saved to library/poses/<name>.json)
//   GET    /api/voice/commands                 -> VoiceCommand[]
//   POST   /api/voice/simulate {text, context?} -> { route, command? }   (test fast-path routing without audio)
//
// Commands
//   POST   /api/command {name, args?}          -> { ok, result? }   (same command registry clients use)

import type { Vec3, Quat, Transform } from './scene.ts';

export type ScreenshotView =
  /** What the user sees: the primary xr client's head pose, its FOV. */
  | { kind: 'user' }
  /** Explicit camera in space coordinates. */
  | { kind: 'camera'; position: Vec3; lookAt?: Vec3; rotation?: Quat; fov?: number }
  /** Auto-framed view of one entity (and its children), from a direction. */
  | { kind: 'entity'; entity: string; direction?: Vec3; padding?: number }
  /** A widget rendered alone in a neutral studio scene (thumbnails, testing). */
  | { kind: 'widget'; widget: string; props?: Record<string, unknown>; direction?: Vec3 };

export interface ScreenshotRequest {
  view: ScreenshotView;
  width?: number;   // default 1024
  height?: number;  // default 768
  /** Draw ghost hands at the user's tracked hand poses. Default true for 'user'. */
  hands?: boolean;
  /** Overlay entity ids/names as labels (debugging). Default false. */
  labels?: boolean;
  /** Background: 'scene' (space background), 'transparent', or a CSS color. MR passthrough is never included. */
  background?: string;
}

export interface SceneSummaryNode {
  id: string;
  name?: string;
  widget: string;
  position: Vec3;
  /** Props with large values elided. */
  props: Record<string, unknown>;
  children?: SceneSummaryNode[];
}

export interface SceneSummary {
  version: number;
  workspace: string;
  roots: SceneSummaryNode[];
  links: Array<{ id: string; from: string; to: string; transform?: string }>;
}

export type ServerEventType =
  | 'agent.ask'        // a request for Claude (voice that missed the fast path, widget askAgent, etc.)
  | 'voice.utterance'  // every transcribed utterance + its route
  | 'widget.event'
  | 'pose.event'
  | 'client.error'
  | 'client.log'
  | 'widget.build'     // build success/failure
  | 'source.exit'
  | 'scene.changed'    // coarse notice (version, source) — not the ops
  | 'client.connect'
  | 'client.disconnect';

export interface ServerEvent {
  seq: number;
  ts: number;
  type: ServerEventType;
  data: Record<string, unknown>;
}

/** library/voice/commands.json is VoiceCommand[]. */
export interface VoiceCommand {
  id: string;
  description?: string;
  /**
   * Case-insensitive regexes matched against the normalized transcript (lowercase,
   * punctuation stripped, whitespace collapsed). Must match the WHOLE utterance.
   * Named groups become args, e.g. "^set layer (?<value>\\d+)$".
   */
  patterns: string[];
  /** Command name to run (server command registry), with args. "$name" strings are replaced by named groups; "$target" by the voice context's focused entity id. */
  command: string;
  args?: Record<string, unknown>;
}

export type { Transform };
