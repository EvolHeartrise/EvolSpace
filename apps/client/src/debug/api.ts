// Typed wrapper over the HTTP API (packages/protocol/src/api.ts — every
// endpoint). JSON in/out; errors throw ApiError {status, message, body}.
// The base defaults to the server the WebSocket talks to (NetClient.httpBase).

import {
  decodeTensorFrame, encodeTensorFrame, isTensor, tensorFromJson,
  type AgentMessage, type AgentState, type AgentStatus, type ChannelInfo, type ChannelValue, type InteractionSet,
  type OpSource, type PoseDef, type SceneOp, type SceneState, type SceneSummary, type ScreenshotRequest,
  type ServerEvent, type ServerEventType, type SourceStatus, type TensorValue, type Transform, type UserPose,
  type VoiceCommand, type WidgetManifest,
} from '@evolspace/protocol';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientSummary {
  id: string;
  role: 'xr' | 'desktop' | 'mirror' | 'tool';
  primary: boolean;
  userAgent?: string;
  address: string;
  connectedAt: number;
  subscriptions: number;
  pending: number;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  clients: ClientSummary[];
  workspace?: string;
  sceneVersion?: number;
  uptimeSec?: number;
  mirror?: Record<string, unknown> | null;
}

export interface OpsResult { version: number; ids: string[]; warnings?: string[] }
export interface HistoryResult { version: number; ok: boolean; error?: string }
export interface WorkspaceList { current: string; list: string[] }
export interface PrefabInfo { id: string; description: string }
export interface EventPage { events: ServerEvent[]; next: number }
export interface EventQuery { since?: number; wait?: number; types?: ServerEventType[] | string[]; limit?: number }
export interface GesturesInfo {
  poses: PoseDef[];
  interactions: Record<string, InteractionSet>;
  errors?: Record<string, string>;
  warnings?: Record<string, string[]>;
}
export interface CommandInfo { name: string; description: string; args?: string }

/** GET /api/user: the primary's pose summarized for the agent (hands → features; joints with raw). */
export interface UserSummary {
  t: number;
  ageMs: number;
  mode: UserPose['mode'];
  head: { position: number[]; rotation: number[] };
  fov?: number;
  aspect?: number;
  focus: UserPose['focus'] | Record<string, never>;
  gaze: UserPose['gaze'];
  selected: string | null;
  hands: Partial<Record<'left' | 'right', {
    tracked: boolean;
    wrist?: { position: number[]; rotation: number[] };
    features?: Record<string, number>;
    poses: string[];
    joints?: number[];
  }>>;
  featuresError?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TENSOR_MIME = 'application/x-evol-tensor';
const enc = encodeURIComponent;

export function createApi(base: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
  const root = base.replace(/\/+$/, '');

  async function raw(method: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const r = await fetchImpl(root + path, { method, ...init, signal: signal ?? init.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const msg = (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string')
        ? (body as { error: string }).error : text || r.statusText;
      throw new ApiError(r.status, `${method} ${path} → ${r.status}: ${msg}`, body);
    }
    return r;
  }

  async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const r = await raw(method, path, body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    base: root,

    // ------------------------------------------------------------ scene
    health: () => json<HealthInfo>('GET', '/api/health'),
    scene: () => json<SceneState>('GET', '/api/scene'),
    sceneSummary: () => json<SceneSummary>('GET', '/api/scene/summary'),
    ops: (ops: SceneOp[], opts: { source?: OpSource; group?: string } = {}) =>
      json<OpsResult>('POST', '/api/scene/ops', { ops, source: opts.source ?? 'user', ...(opts.group ? { group: opts.group } : {}) }),
    undo: () => json<HistoryResult>('POST', '/api/scene/undo'),
    redo: () => json<HistoryResult>('POST', '/api/scene/redo'),
    prefabs: () => json<PrefabInfo[]>('GET', '/api/prefabs'),
    instantiatePrefab: (id: string, body: { transform?: Partial<Transform>; parent?: string | null; props?: Record<string, Record<string, unknown>>; source?: OpSource } = {}) =>
      json<{ ids: Record<string, string>; version: number }>('POST', `/api/prefabs/${enc(id)}/instantiate`, body),
    workspaces: () => json<WorkspaceList>('GET', '/api/workspaces'),
    saveWorkspace: (name: string) => json<{ current: string }>('POST', `/api/workspaces/${enc(name)}/save`),
    loadWorkspace: (name: string) => json<{ current: string; version: number }>('POST', `/api/workspaces/${enc(name)}/load`),
    newWorkspace: (name: string) => json<{ current: string; version: number }>('POST', `/api/workspaces/${enc(name)}/new`),

    // ------------------------------------------------------------ widgets
    widgets: () => json<WidgetManifest[]>('GET', '/api/widgets'),
    widget: (id: string) => json<WidgetManifest & { source: string }>('GET', `/api/widgets/${enc(id)}`),
    buildWidget: (id: string) => json<{ ok: boolean; error?: string; manifest?: WidgetManifest }>('POST', `/api/widgets/${enc(id)}/build`),
    /** Renders + saves library/widgets/:id/thumbnail.png; returns the PNG. */
    widgetThumbnail: async (id: string, props?: Record<string, unknown>) =>
      (await raw('POST', `/api/widgets/${enc(id)}/thumbnail`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(props ? { props } : {}) })).blob(),
    widgetBundleUrl: (id: string) => `${root}/widgets/${enc(id)}.js`,
    widgetThumbnailUrl: (id: string) => `${root}/widgets/${enc(id)}/thumbnail.png`,

    // ------------------------------------------------------------ channels
    channels: () => json<ChannelInfo[]>('GET', '/api/channels'),
    /** Latest value: JSON, or a TensorValue for tensor channels. 404 → ApiError. */
    channel: async (name: string): Promise<ChannelValue> => {
      const r = await raw('GET', `/api/channels/${enc(name)}`, { headers: { Accept: `${TENSOR_MIME}, application/json` } });
      if ((r.headers.get('content-type') ?? '').startsWith(TENSOR_MIME)) return decodeTensorFrame(new Uint8Array(await r.arrayBuffer())).tensor;
      const v = (await r.json()) as unknown;
      return isTensorJson(v) ? tensorFromJson(v) : v;
    },
    /** Publish JSON or a TensorValue. Returns the channel info. */
    publish: async (name: string, value: ChannelValue, opts: { producer?: string; description?: string } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.producer) headers['X-Producer'] = opts.producer;
      if (opts.description) headers['X-Description'] = opts.description;
      let body: BodyInit;
      if (isTensor(value)) {
        headers['Content-Type'] = TENSOR_MIME;
        body = encodeTensorFrame({ channel: name }, value as TensorValue) as unknown as BodyInit;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(value);
      }
      return (await (await raw('PUT', `/api/channels/${enc(name)}`, { headers, body })).json()) as ChannelInfo;
    },
    deleteChannel: (name: string) => json<{ ok: boolean }>('DELETE', `/api/channels/${enc(name)}`),
    /** Server-sent events of a channel's values (tensors as {$tensor, dtype, shape, b64} → decoded). */
    channelEvents: (name: string, cb: (value: ChannelValue) => void, onError?: (e: Event) => void): (() => void) => {
      const es = new EventSource(`${root}/api/channels/${enc(name)}/events`);
      es.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data as string) as unknown;
          cb(isTensorJson(v) ? tensorFromJson(v) : v);
        } catch { /* malformed frame */ }
      };
      if (onError) es.onerror = onError;
      return () => es.close();
    },

    // ------------------------------------------------------------ sources
    sources: () => json<SourceStatus[]>('GET', '/api/sources'),
    source: (id: string) => json<SourceStatus>('GET', `/api/sources/${enc(id)}`),
    startSource: (id: string) => json<SourceStatus>('POST', `/api/sources/${enc(id)}/start`),
    stopSource: (id: string) => json<SourceStatus>('POST', `/api/sources/${enc(id)}/stop`),
    restartSource: (id: string) => json<SourceStatus>('POST', `/api/sources/${enc(id)}/restart`),

    // ------------------------------------------------------------ user & view
    user: (rawJoints = false) => json<UserSummary | null>('GET', `/api/user${rawJoints ? '?raw=1' : ''}`),
    /** PNG of a mirror render (see ScreenshotRequest). */
    screenshot: async (req: ScreenshotRequest) =>
      (await raw('POST', '/api/screenshot', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })).blob(),

    // ------------------------------------------------------------ agent I/O
    agentStatus: () => json<{ status: AgentStatus; messages: AgentMessage[] }>('GET', '/api/agent/status'),
    setAgentStatus: (state: AgentState, detail?: string) => json<Record<string, never>>('POST', '/api/agent/status', { state, ...(detail ? { detail } : {}) }),
    say: (text: string, kind?: AgentMessage['kind']) => json<{ id: string }>('POST', '/api/agent/say', { text, ...(kind ? { kind } : {}) }),
    /** Long-poll: resolves as soon as events exist (or after `wait` ms with an empty page). */
    events: (q: EventQuery = {}, signal?: AbortSignal) => {
      const p = new URLSearchParams();
      if (q.since !== undefined) p.set('since', String(q.since));
      if (q.wait) p.set('wait', String(q.wait));
      if (q.types?.length) p.set('types', q.types.join(','));
      if (q.limit) p.set('limit', String(q.limit));
      const s = p.toString();
      return json<EventPage>('GET', `/api/events${s ? `?${s}` : ''}`, undefined, signal);
    },

    // ------------------------------------------------------------ gestures & voice
    gestures: () => json<GesturesInfo>('GET', '/api/gestures'),
    recordGesture: (body: { name: string; hand: 'left' | 'right' | 'either'; seconds?: number; countdown?: number; description?: string }) =>
      json<PoseDef>('POST', '/api/gestures/record', body),
    voiceCommands: () => json<VoiceCommand[]>('GET', '/api/voice/commands'),
    simulateVoice: (text: string, context?: Record<string, unknown>) =>
      json<{ route: 'fastpath' | 'agent' | 'none'; command?: string; [k: string]: unknown }>('POST', '/api/voice/simulate', { text, ...(context ? { context } : {}) }),

    // ------------------------------------------------------------ commands
    command: <T = unknown>(name: string, args?: Record<string, unknown>) =>
      json<{ ok: boolean; result?: T }>('POST', '/api/command', { name, ...(args ? { args } : {}) }),
    commands: () => json<CommandInfo[]>('GET', '/api/commands'),
    routes: () => json<{ routes: string[]; docs: string }>('GET', '/api'),
  };
}

export type DebugApi = ReturnType<typeof createApi>;

function isTensorJson(v: unknown): v is { $tensor: true; dtype: TensorValue['dtype']; shape: number[]; b64: string } {
  return !!v && typeof v === 'object' && (v as { $tensor?: unknown }).$tensor === true && typeof (v as { b64?: unknown }).b64 === 'string';
}
