// Debug dashboard state: signals mirrored from the runtime (scene, selection,
// widget statuses), the WebSocket (connection, agent, headset pose) and the
// HTTP API (health, events long-poll, channels, sources, workspaces), plus the
// actions panels use to drive the space. Polling that only some panels need
// is reference-counted: `need('channels')` starts it, the returned fn releases.
//
// The scene is NOT duplicated: `scene` re-reads the runtime's SceneMirror state
// (shallow copy, so signal identity changes) after every applied diff.

import { batch, computed, signal, type ReadonlySignal } from '@preact/signals';
import type {
  AgentMessage, AgentStatus, ChannelInfo, Entity, EntityPatch, HandFrame, SceneOp, SceneState, ServerEvent,
  SourceStatus, Transform, UserPose, WidgetManifest,
} from '@evolspace/protocol';
import type { NetClient } from '../integration.ts';
import type { DebugApi, HealthInfo, OpsResult, UserSummary, WorkspaceList } from './api.ts';
import type { ToastKind } from './types.ts';

// ------------------------------------------------------------------ deps (narrow, fakeable)

export interface StoreRuntime {
  readonly sceneState: SceneState;
  onSceneChange(cb: () => void): () => void;
  readonly selected: string | null;
  select(id: string | null): void;
  onSelectionChange(cb: (id: string | null) => void): () => void;
  readonly widgets: {
    readonly catalog: WidgetManifest[];
    allRecords(): Iterable<{ readonly entityId: string; status: string; error: string | null }>;
  };
}

export type StoreNet = Pick<NetClient, 'on' | 'onStatus' | 'connected' | 'clientId' | 'primary' | 'status' | 'httpBase'>;

export interface StoreCamera {
  /** Fly the desktop camera to frame an entity. False if it has no bounds. */
  frame(id: string): boolean;
  /** Frame several entities (default: all roots). */
  frameAll?(ids?: string[]): boolean;
  /** A transform (space coords) ~`distance` m in front of the camera, facing it. */
  spawnTransform(distance?: number): Transform;
}

export interface StoreDeps {
  runtime: StoreRuntime;
  net: StoreNet;
  api: DebugApi;
  camera?: StoreCamera;
  toast?(text: string, kind?: ToastKind): void;
  /** Run a command through the client router (local first, else server). */
  command?(name: string, args?: Record<string, unknown>): void;
  /** Poll intervals (ms); tests shorten them. */
  intervals?: Partial<Record<'health' | 'channels' | 'sources' | 'widgetStatus' | 'userPose', number>>;
  /** Long-poll wait (ms). 0 disables the event loop (tests drive it with pollEventsOnce). */
  eventsWaitMs?: number;
  /** Ring buffer size of the event log (default 2000). */
  maxEvents?: number;
}

// ------------------------------------------------------------------ state types

export interface ConnInfo {
  connected: boolean;
  ready: boolean;
  attempt: number;
  clientId: string | null;
  primary: boolean;
  /** HTTP origin of the server. */
  url: string;
}

export interface HeadsetInfo {
  /** A primary xr client is connected (its pose is "the user"). */
  connected: boolean;
  primaryId: string | null;
  userAgent?: string;
  /** All xr clients. */
  xrClients: number;
}

export interface TreeNode {
  id: string;
  entity: Entity;
  depth: number;
  children: TreeNode[];
}

export interface WidgetRuntimeStatus {
  status: string;
  error: string | null;
}

export interface EntityError {
  message: string;
  /** runtime = this tab's widget host; event = client.error from any client; build = widget bundle failed to build. */
  source: 'runtime' | 'event' | 'build';
  ts?: number;
}

export type NeedKind = 'channels' | 'sources' | 'userPose';

export interface DebugStore {
  readonly conn: ReadonlySignal<ConnInfo>;
  readonly health: ReadonlySignal<HealthInfo | null>;
  readonly headset: ReadonlySignal<HeadsetInfo>;
  /** Shallow copy of the runtime's scene, replaced after every applied change. */
  readonly scene: ReadonlySignal<SceneState>;
  /** Entity hierarchy (roots first, children in scene order; orphans become roots). */
  readonly tree: ReadonlySignal<TreeNode[]>;
  readonly catalog: ReadonlySignal<Record<string, WidgetManifest>>;
  readonly widgetStatus: ReadonlySignal<Record<string, WidgetRuntimeStatus>>;
  readonly entityErrors: ReadonlySignal<Record<string, EntityError>>;
  /** Selected entity id — mirrors runtime.selected (Ctrl+click in the view, voice, the tree…). */
  readonly selection: ReadonlySignal<string | null>;
  readonly selectedEntity: ReadonlySignal<Entity | null>;
  readonly agentStatus: ReadonlySignal<AgentStatus | null>;
  readonly agentMessages: ReadonlySignal<AgentMessage[]>;
  /** Server event log (ring buffer, oldest first). */
  readonly events: ReadonlySignal<ServerEvent[]>;
  /** Needs 'channels'. */
  readonly channels: ReadonlySignal<ChannelInfo[]>;
  /** Needs 'sources'. */
  readonly sources: ReadonlySignal<SourceStatus[]>;
  /** The headset user's pose (pushed by the server ≤15 Hz; HTTP fallback while 'userPose' is needed). */
  readonly userPose: ReadonlySignal<UserPose | null>;
  readonly workspaces: ReadonlySignal<WorkspaceList | null>;
  /** Start ref-counted polling; call the returned fn to release. */
  need(kind: NeedKind): () => void;
  refresh(what: 'health' | 'channels' | 'sources' | 'workspaces' | 'agent' | 'widgetStatus'): Promise<void>;
  /** Forget client.error badges collected from events. */
  clearErrors(): void;
  dispose(): void;
}

export interface EditOptions {
  /** Ops sharing a group are one undo step (e.g. one scrub drag). Default: a fresh group per call. */
  group?: string;
  /** Don't toast on failure. */
  quiet?: boolean;
}

export interface DebugActions {
  select(id: string | null): void;
  /** Fly the camera to frame `id` (default: the selection). */
  frame(id?: string | null): void;
  /** Fly the camera to frame the whole scene (or `ids`). */
  frameAll(ids?: string[]): void;
  ops(ops: SceneOp[], opts?: EditOptions): Promise<OpsResult | null>;
  update(id: string, patch: EntityPatch, opts?: EditOptions): Promise<OpsResult | null>;
  setProps(id: string, patch: Record<string, unknown>, opts?: EditOptions): Promise<OpsResult | null>;
  remove(id: string): Promise<OpsResult | null>;
  /** Copies the subtree + links (server `duplicate`); selects and returns the copy's id. */
  duplicate(id: string): Promise<string | null>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** Add a widget ~1.2 m in front of the desktop camera, facing it; selects and returns the new id. */
  spawn(widget: string, props?: Record<string, unknown>, opts?: { name?: string; parent?: string | null; distance?: number; transform?: Partial<Transform> }): Promise<string | null>;
  /** Run a command through the client router (runtime local commands first, else the server). */
  command(name: string, args?: Record<string, unknown>): void;
  /** POST /api/command (server registry); toasts on failure. */
  serverCommand<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T | null>;
  toast(text: string, kind?: ToastKind): void;
  /** A fresh undo-group id. */
  newGroup(): string;
}

// ------------------------------------------------------------------ pure helpers (tested)

/** Hierarchy from an entity table: roots (parent null or missing) in table order, children in table order. */
export function buildTree(entities: Record<string, Entity>): TreeNode[] {
  const kids = new Map<string | null, Entity[]>();
  for (const e of Object.values(entities)) {
    const p = e.parent && entities[e.parent] && e.parent !== e.id ? e.parent : null;
    let l = kids.get(p);
    if (!l) kids.set(p, (l = []));
    l.push(e);
  }
  const seen = new Set<string>();
  const make = (e: Entity, depth: number): TreeNode => {
    seen.add(e.id);
    const children: TreeNode[] = [];
    for (const c of kids.get(e.id) ?? []) if (!seen.has(c.id)) children.push(make(c, depth + 1));
    return { id: e.id, entity: e, depth, children };
  };
  const roots = (kids.get(null) ?? []).map((e) => make(e, 0));
  // Cycles (malformed data): anything unreached becomes a root.
  for (const e of Object.values(entities)) if (!seen.has(e.id)) roots.push(make(e, 0));
  return roots;
}

/** Convert GET /api/user?raw=1 into a UserPose (HTTP fallback when the server doesn't push poses). */
export function userPoseFromSummary(s: UserSummary | null): UserPose | null {
  if (!s) return null;
  const hands: UserPose['hands'] = {};
  for (const h of ['left', 'right'] as const) {
    const j = s.hands?.[h]?.joints;
    if (s.hands?.[h]?.tracked && Array.isArray(j) && j.length >= 175) hands[h] = { hand: h, joints: j, radii: new Array(25).fill(0.008) } as HandFrame;
  }
  return {
    t: s.t,
    mode: s.mode,
    head: { position: s.head.position as UserPose['head']['position'], rotation: s.head.rotation as UserPose['head']['rotation'] },
    ...(s.fov !== undefined ? { fov: s.fov } : {}),
    ...(s.aspect !== undefined ? { aspect: s.aspect } : {}),
    hands,
    focus: (s.focus ?? {}) as UserPose['focus'],
    gaze: s.gaze ?? null,
    selected: s.selected ?? null,
  };
}

let groupSeq = 0;
export function newGroupId(): string {
  return `dbg-${Date.now().toString(36)}-${(++groupSeq).toString(36)}`;
}

const shallowScene = (s: SceneState): SceneState => ({ version: s.version, workspace: s.workspace, entities: { ...s.entities }, links: { ...s.links } });

// ------------------------------------------------------------------ store

export function createDebugStore(deps: StoreDeps): { store: DebugStore; actions: DebugActions } {
  const { runtime, net, api } = deps;
  const iv = { health: 2000, channels: 1000, sources: 2000, widgetStatus: 1000, userPose: 100, ...deps.intervals };
  const maxEvents = deps.maxEvents ?? 2000;
  const offs: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  let disposed = false;
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    timers.add(t);
    return () => { clearInterval(t); timers.delete(t); };
  };
  const toast = (text: string, kind: ToastKind = 'info') => {
    if (deps.toast) deps.toast(text, kind);
    else (kind === 'error' ? console.error : console.info)(`[debug] ${text}`);
  };

  // ---------------------------------------------------------------- connection
  const connOf = (): ConnInfo => ({
    connected: net.connected, ready: net.status.ready, attempt: net.status.attempt,
    clientId: net.clientId, primary: net.primary, url: (net.httpBase ?? '').replace(/\/$/, ''),
  });
  const conn = signal<ConnInfo>(connOf());
  offs.push(net.onStatus(() => { conn.value = connOf(); }));
  offs.push(net.on('hello', () => { queueMicrotask(() => { conn.value = connOf(); }); }));

  const health = signal<HealthInfo | null>(null);
  const headset = computed<HeadsetInfo>(() => {
    const clients = health.value?.clients ?? [];
    const xr = clients.filter((c) => c.role === 'xr');
    const p = xr.find((c) => c.primary);
    return { connected: !!p, primaryId: p?.id ?? null, ...(p?.userAgent ? { userAgent: p.userAgent } : {}), xrClients: xr.length };
  });

  // ---------------------------------------------------------------- scene (from the runtime)
  const scene = signal<SceneState>(shallowScene(runtime.sceneState));
  let scenePending = false;
  offs.push(runtime.onSceneChange(() => {
    if (scenePending) return;
    scenePending = true;
    queueMicrotask(() => {
      scenePending = false;
      if (!disposed) scene.value = shallowScene(runtime.sceneState);
    });
  }));
  const tree = computed(() => buildTree(scene.value.entities));

  const workspaces = signal<WorkspaceList | null>(null);
  let lastWorkspace = scene.value.workspace;

  // ---------------------------------------------------------------- catalog + widget statuses
  const catalogOf = (list: WidgetManifest[]) => Object.fromEntries(list.map((m) => [m.id, m]));
  const catalog = signal<Record<string, WidgetManifest>>(catalogOf(runtime.widgets.catalog));
  offs.push(net.on('widgets.catalog', (m) => { catalog.value = catalogOf(m.widgets); }));
  offs.push(net.on('widgets.updated', (m) => { catalog.value = { ...catalog.value, [m.widget.id]: m.widget }; }));

  const widgetStatus = signal<Record<string, WidgetRuntimeStatus>>({});
  let statusKey = '';
  const readStatuses = () => {
    const out: Record<string, WidgetRuntimeStatus> = {};
    for (const r of runtime.widgets.allRecords()) out[r.entityId] = { status: r.status, error: r.error };
    const key = JSON.stringify(out);
    if (key !== statusKey) { statusKey = key; widgetStatus.value = out; }
  };
  readStatuses();
  offs.push(every(iv.widgetStatus, readStatuses));

  // ---------------------------------------------------------------- selection (two-way with the runtime)
  const selection = signal<string | null>(runtime.selected);
  offs.push(runtime.onSelectionChange((id) => { selection.value = id; }));
  const selectedEntity = computed(() => {
    const id = selection.value;
    return id ? scene.value.entities[id] ?? null : null;
  });

  // ---------------------------------------------------------------- agent
  const agentStatus = signal<AgentStatus | null>(null);
  const agentMessages = signal<AgentMessage[]>([]);
  const addMessages = (list: AgentMessage[]) => {
    const have = new Set(agentMessages.value.map((m) => m.id));
    const fresh = list.filter((m) => m && !have.has(m.id));
    if (!fresh.length) return;
    agentMessages.value = [...agentMessages.value, ...fresh].sort((a, b) => a.ts - b.ts).slice(-200);
  };
  offs.push(net.on('agent.status', (m) => { agentStatus.value = m.status; }));
  offs.push(net.on('agent.message', (m) => addMessages([m.message])));

  // ---------------------------------------------------------------- events (long-poll, ring buffer)
  const events = signal<ServerEvent[]>([]);
  const eventErrors = signal<Record<string, EntityError>>({});
  let errorsClearedAt = 0;
  let cursor: number | undefined;
  const ingest = (list: ServerEvent[]) => {
    if (!list.length) return;
    const merged = events.value.concat(list);
    events.value = merged.length > maxEvents ? merged.slice(merged.length - maxEvents) : merged;
    let errs: Record<string, EntityError> | null = null;
    for (const e of list) {
      if (e.type !== 'client.error' || e.ts < errorsClearedAt) continue;
      const ent = e.data.entity;
      if (typeof ent !== 'string' || !ent) continue;
      errs ??= { ...eventErrors.value };
      errs[ent] = { message: String(e.data.message ?? 'error'), source: 'event', ts: e.ts };
    }
    if (errs) eventErrors.value = errs;
  };
  const pollEventsOnce = async (wait: number, signalOpt?: AbortSignal): Promise<void> => {
    const page = cursor === undefined
      ? await api.events({ limit: 500 }, signalOpt)
      : await api.events({ since: cursor, wait }, signalOpt);
    // A server restart resets seq: `next` drops below our cursor; just continue from it.
    cursor = page.next;
    ingest(page.events);
  };
  const eventsAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const waitMs = deps.eventsWaitMs ?? 25_000;
  if (waitMs > 0) {
    void (async () => {
      let backoff = 500;
      while (!disposed) {
        try {
          await pollEventsOnce(waitMs, eventsAbort?.signal);
          backoff = 500;
        } catch {
          if (disposed) return;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    })();
  }

  const entityErrors = computed<Record<string, EntityError>>(() => {
    const out: Record<string, EntityError> = { ...eventErrors.value };
    const cat = catalog.value;
    for (const e of Object.values(scene.value.entities)) {
      const err = cat[e.widget]?.error;
      if (err && !out[e.id]) out[e.id] = { message: `widget '${e.widget}' build failed: ${err}`, source: 'build' };
    }
    for (const [id, st] of Object.entries(widgetStatus.value)) {
      if ((st.status === 'error' || st.status === 'missing') && st.error) out[id] = { message: st.error, source: 'runtime' };
    }
    return out;
  });

  // ---------------------------------------------------------------- polled data
  const channels = signal<ChannelInfo[]>([]);
  const sources = signal<SourceStatus[]>([]);
  const userPose = signal<UserPose | null>(null);
  let lastPushAt = 0;
  offs.push(net.on('user.pose', (m) => { lastPushAt = Date.now(); userPose.value = m.pose; }));

  const refreshers = {
    health: async () => {
      health.value = await api.health();
      const ws = health.value.workspace;
      if (ws && ws !== workspaces.value?.current) void refreshers.workspaces().catch(() => {});
    },
    channels: async () => { channels.value = await api.channels(); },
    sources: async () => { sources.value = await api.sources(); },
    workspaces: async () => { workspaces.value = await api.workspaces(); },
    agent: async () => {
      const r = await api.agentStatus();
      agentStatus.value = r.status;
      addMessages(r.messages);
    },
    widgetStatus: async () => readStatuses(),
    userPose: async () => {
      // HTTP fallback only when the server isn't pushing poses (older server).
      if (Date.now() - lastPushAt < 1500) return;
      userPose.value = userPoseFromSummary(await api.user(true));
    },
  };
  const safe = (fn: () => Promise<void>) => () => { void fn().catch(() => { /* offline: keep last value */ }); };

  void safe(refreshers.health)();
  void safe(refreshers.agent)();
  void safe(refreshers.workspaces)();
  offs.push(every(iv.health, safe(refreshers.health)));
  offs.push(net.onStatus((s) => { if (s.connected) { safe(refreshers.health)(); safe(refreshers.agent)(); } }));

  // The workspace name lives in the scene: refresh the list when it changes (load/save-as/new).
  offs.push(runtime.onSceneChange(() => {
    const ws = runtime.sceneState.workspace;
    if (ws !== lastWorkspace) { lastWorkspace = ws; safe(refreshers.workspaces)(); }
  }));

  const needCount = new Map<NeedKind, number>();
  const needStop = new Map<NeedKind, () => void>();
  const startNeed = (kind: NeedKind): (() => void) => {
    const fn = safe(refreshers[kind]);
    fn();
    return every(iv[kind], fn);
  };
  const need = (kind: NeedKind) => {
    const n = (needCount.get(kind) ?? 0) + 1;
    needCount.set(kind, n);
    if (n === 1 && !disposed) needStop.set(kind, startNeed(kind));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (needCount.get(kind) ?? 1) - 1;
      needCount.set(kind, m);
      if (m === 0) { needStop.get(kind)?.(); needStop.delete(kind); }
    };
  };

  const store: DebugStore = {
    conn, health, headset, scene, tree, catalog, widgetStatus, entityErrors, selection, selectedEntity,
    agentStatus, agentMessages, events, channels, sources, userPose, workspaces,
    need,
    refresh: (what) => refreshers[what](),
    clearErrors: () => { errorsClearedAt = Date.now(); eventErrors.value = {}; },
    dispose: () => {
      disposed = true;
      eventsAbort?.abort();
      for (const off of offs) off();
      for (const t of timers) clearInterval(t);
      timers.clear();
    },
  };
  (store as DebugStore & { pollEventsOnce: typeof pollEventsOnce }).pollEventsOnce = pollEventsOnce;

  // ---------------------------------------------------------------- actions
  const edit = async (ops: SceneOp[], opts: EditOptions = {}): Promise<OpsResult | null> => {
    try {
      const r = await api.ops(ops, { source: 'user', group: opts.group ?? newGroupId() });
      if (r.warnings?.length && !opts.quiet) toast(r.warnings.join('\n'), 'warn');
      return r;
    } catch (e) {
      if (!opts.quiet) toast((e as Error).message, 'error');
      return null;
    }
  };

  const actions: DebugActions = {
    select: (id) => {
      runtime.select(id);
      // The runtime refuses unknown ids; keep the signal truthful either way.
      selection.value = runtime.selected;
    },
    frame: (id) => {
      const target = id ?? selection.value;
      if (!target) return;
      if (!deps.camera?.frame(target)) toast(`Nothing to frame for ${target} (no bounds yet)`, 'warn');
    },
    frameAll: (ids) => {
      if (!deps.camera?.frameAll?.(ids)) toast('Nothing to frame', 'warn');
    },
    ops: edit,
    update: (id, patch, opts) => edit([{ op: 'update', id, patch }], opts),
    setProps: (id, patch, opts) => edit([{ op: 'update', id, patch: { props: patch } }], opts),
    remove: async (id) => {
      const r = await edit([{ op: 'remove', id }]);
      if (r && selection.value === id) actions.select(null);
      return r;
    },
    duplicate: async (id) => {
      const r = await actions.serverCommand<{ entity: string }>('duplicate', { entity: id });
      const copy = r?.entity ?? null;
      if (copy) await selectWhenPresent(copy);
      return copy;
    },
    undo: async () => history('undo'),
    redo: async () => history('redo'),
    spawn: async (widget, props, opts = {}) => {
      const base = deps.camera?.spawnTransform(opts.distance ?? 1.2);
      const transform = { ...(base ?? {}), ...(opts.transform ?? {}) };
      const entity: SceneOp & { op: 'add' } = {
        op: 'add',
        entity: {
          widget,
          ...(props ? { props } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.parent ? { parent: opts.parent } : {}),
          ...(Object.keys(transform).length ? { transform: transform as Transform } : {}),
        },
      };
      const r = await edit([entity]);
      const id = r?.ids[0] ?? null;
      if (id) await selectWhenPresent(id);
      return id;
    },
    command: (name, args) => {
      if (deps.command) deps.command(name, args);
      else void actions.serverCommand(name, args);
    },
    serverCommand: async <T,>(name: string, args?: Record<string, unknown>) => {
      try {
        const r = await api.command<T>(name, args);
        return (r.result ?? null) as T | null;
      } catch (e) {
        toast((e as Error).message, 'error');
        return null;
      }
    },
    toast,
    newGroup: newGroupId,
  };

  async function history(kind: 'undo' | 'redo'): Promise<boolean> {
    try {
      const r = kind === 'undo' ? await api.undo() : await api.redo();
      if (r.error) toast(r.error, 'error');
      else if (!r.ok) toast(`Nothing to ${kind}`, 'info');
      return r.ok;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  }

  /** Select an id that the server just created (the patch may still be in flight). */
  async function selectWhenPresent(id: string, timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!runtime.sceneState.entities[id] && Date.now() < end && !disposed) await new Promise((r) => setTimeout(r, 30));
    batch(() => actions.select(id));
  }

  return { store, actions };
}
