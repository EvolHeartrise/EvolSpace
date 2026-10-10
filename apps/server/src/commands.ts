// Server command registry. One namespace shared by HTTP (POST /api/command),
// WS ({type:'command'}), voice fast-path and interaction bindings. Clients run
// their local commands first (select, voice.ptt, ...) and forward unknown names here.
//
// Other server modules add commands with `registry.register(...)`, or at import
// time with the global `registerCommand(...)` (picked up by every registry).
import type { Entity, Quat, SceneOp, Vec3, WidgetManifest } from '@evolspace/protocol';
import type { SceneStore } from './scene/store.ts';
import { rotateVec } from './scene/math.ts';

export interface CommandContext {
  /** WS client that issued the command, if any. */
  clientId?: string;
  /** Where it came from: 'http' | 'ws' | 'voice' | 'internal' | ... */
  origin: string;
}

export interface CommandDef {
  description: string;
  /** Human-readable args doc, e.g. "{entity: string}". */
  args?: string;
  run(args: Record<string, unknown>, ctx: CommandContext): unknown | Promise<unknown>;
}

export class CommandError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'CommandError'; }
}

/**
 * The command does not apply to these args (e.g. `spawn` of a name that is no widget). Over HTTP/WS it is
 * a 404 like any error; the voice fast path hands the utterance to Claude instead of reporting a failure.
 */
export class CommandDeclined extends CommandError {
  readonly passToAgent = true;
  constructor(message: string) { super(message, 404); this.name = 'CommandDeclined'; }
}

const globalCommands = new Map<string, CommandDef>();

/** Register a command for every registry (module-level extension point). Returns an unregister fn. */
export function registerCommand(name: string, def: CommandDef): () => void {
  globalCommands.set(name, def);
  return () => { if (globalCommands.get(name) === def) globalCommands.delete(name); };
}

export class CommandRegistry {
  private local = new Map<string, CommandDef>();

  register(name: string, def: CommandDef): () => void {
    this.local.set(name, def);
    return () => { if (this.local.get(name) === def) this.local.delete(name); };
  }

  get(name: string): CommandDef | undefined { return this.local.get(name) ?? globalCommands.get(name); }
  has(name: string): boolean { return this.get(name) !== undefined; }

  list(): Array<{ name: string; description: string; args?: string }> {
    const names = new Set([...globalCommands.keys(), ...this.local.keys()]);
    return [...names].sort().map((name) => {
      const d = this.get(name)!;
      return { name, description: d.description, ...(d.args ? { args: d.args } : {}) };
    });
  }

  async run(name: string, args: Record<string, unknown> | undefined, ctx: CommandContext): Promise<unknown> {
    const def = this.get(name);
    if (!def) throw new CommandError(`unknown command '${name}' (available: ${this.list().map((c) => c.name).join(', ')})`, 404);
    return def.run(args ?? {}, ctx);
  }
}

// ---------------------------------------------------------------- built-ins

export interface BuiltinDeps {
  store: SceneStore;
  undo(): unknown;
  redo(): unknown;
  applyOps(ops: SceneOp[], source: string): { ids: string[] };
  saveWorkspace(name?: string): Promise<string>;
  loadWorkspace(name: string): Promise<void>;
  newWorkspace(name: string): Promise<void>;
  /** Take a screenshot of the user's view and record it for the agent; returns the saved path. */
  screenshot(): Promise<{ path: string }>;
  /** Send a command message to all xr clients. */
  broadcastToXr(name: string, args?: Record<string, unknown>): number;
  agentAsk(text: string, context: Record<string, unknown>): void;
  say(text: string, kind?: 'reply' | 'info' | 'error' | 'heard'): void;
  restartSource(id: string): Promise<unknown>;
  rebuildWidget(id: string): Promise<unknown>;
  /** Publish a value on the data bus; returns the new seq. Throws (status 400) on a bad name/value. */
  publish(channel: string, value: unknown, opts: { producer: string; origin?: string }): { seq: number };
  /** The widget catalog. */
  widgets(): WidgetManifest[];
  /** The user's head pose from the primary xr client, if one is connected. */
  head(): { position: Vec3; rotation: Quat } | null;
}

function entityArg(args: Record<string, unknown>, store: SceneStore): string {
  const id = args.entity ?? args.id ?? args.target;
  if (typeof id !== 'string' || !id) throw new CommandError(`missing {entity: "<id>"}`);
  if (!store.entity(id)) throw new CommandError(`entity '${id}' does not exist`, 404);
  return id;
}

/**
 * Op source for scene edits made by a command: voice → 'voice', a WS client
 * (the headset's bindings/UI) → 'user', HTTP (Claude via the MCP bridge,
 * scripts) → 'agent'. Matters for undo grouping: user/voice edits within a
 * short window merge into one step, agent edits never do.
 */
export function opSourceFor(origin: string): 'voice' | 'user' | 'agent' {
  return origin === 'voice' ? 'voice' : origin === 'ws' ? 'user' : 'agent';
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new CommandError(`missing {${key}: string}`);
  return v;
}

/** Ops that copy an entity subtree (fresh ids) plus links touching it, offset slightly to the side. */
export function planDuplicate(store: SceneStore, rootId: string, offset: [number, number, number] = [0.15, 0, 0]): { ops: SceneOp[]; rootId: string } {
  const ids = store.subtree(rootId);
  const map = new Map<string, string>();
  const scene = store.scene;
  const taken = (x: string) => x in scene.entities || [...map.values()].includes(x);
  for (const id of ids) {
    let n = 2;
    // Readable: e-7f3a → e-7f3a-2 (then -3, ...). Falls back to suffixing if taken.
    while (taken(`${id}-${n}`) || `${id}-${n}`.length > 64) n++;
    map.set(id, `${id}-${n}`.length <= 64 ? `${id}-${n}` : `d-${n}-${Math.random().toString(16).slice(2, 6)}`);
  }
  const ops: SceneOp[] = ids.map((id) => {
    const e = structuredClone(scene.entities[id]);
    e.id = map.get(id)!;
    if (id === rootId) {
      const p = e.transform.position;
      e.transform.position = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
      if (e.name) e.name = `${e.name} copy`;
    } else {
      e.parent = map.get(e.parent!)!;
    }
    return { op: 'add', entity: e };
  });
  for (const l of Object.values(scene.links)) {
    const inFrom = l.from.kind === 'port' && map.has(l.from.entity);
    const inTo = l.to.kind === 'port' && map.has(l.to.entity);
    if (!inFrom && !inTo) continue;
    const from = l.from.kind === 'port' && inFrom ? { ...l.from, entity: map.get(l.from.entity)! } : { ...l.from };
    const to = l.to.kind === 'port' && inTo ? { ...l.to, entity: map.get(l.to.entity)! } : { ...l.to };
    ops.push({ op: 'link.add', link: { from, to, enabled: l.enabled, ...(l.transform ? { transform: l.transform } : {}) } });
  }
  return { ops, rootId: map.get(rootId)! };
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Levenshtein distance, early-out above `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...next) > max) return false;
    row = next;
  }
  return row[b.length]! <= max;
}

/**
 * A spoken widget name → widget id: "line plot" / "Line-Plot" / "a line plot widget" → `line-plot`.
 * Exact after dropping articles, a trailing "widget/panel" and all non-alphanumerics; otherwise a
 * unique near miss (one edit, names of 5+ chars) for STT slips. undefined = no (unique) widget.
 */
export function resolveWidgetName(spoken: string, ids: readonly string[]): string | undefined {
  const words = spoken.toLowerCase().trim().split(/[\s_-]+/).filter(Boolean);
  while (words.length > 1 && /^(a|an|the|another|new|one)$/.test(words[0]!)) words.shift();
  while (words.length > 1 && /^(widget|widgets|panel|one|please|here)$/.test(words[words.length - 1]!)) words.pop();
  const key = compact(words.join(''));
  if (!key) return undefined;
  const exact = ids.find((id) => compact(id) === key);
  if (exact) return exact;
  if (key.length < 5) return undefined;
  const near = ids.filter((id) => within(compact(id), key, 1) || (key.endsWith('s') && compact(id) === key.slice(0, -1)));
  return near.length === 1 ? near[0] : undefined;
}

/** "line-plot" → "Line Plot". */
const titleCase = (id: string) => id.split(/[-_]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

const finite = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

/** A {position, rotation} head pose, or null. */
export function headPose(v: unknown): { position: Vec3; rotation: Quat } | null {
  const h = v as { position?: unknown; rotation?: unknown } | null;
  return h && typeof h === 'object' && finite(h.position, 3) && finite(h.rotation, 4) ? { position: h.position as Vec3, rotation: h.rotation as Quat } : null;
}

/**
 * Root transform for new content straight in front of the user: at arm's length (a little further for
 * big widgets, at most 1.6 m), a little below eye height, turned to face them. No pose: in front of the origin.
 */
export function placeInFront(head: { position: Vec3; rotation: Quat } | null, size?: Vec3): { position: Vec3; rotation: Quat } {
  const dist = Math.min(1.6, Math.max(0.7, 0.4 + 0.6 * (size ? Math.max(...size) : 0.3)));
  if (!head) return { position: [0, 1.3, -dist], rotation: [0, 0, 0, 1] };
  const f = rotateVec(head.rotation, [0, 0, -1]);
  let fx = f[0], fz = f[2];
  const len = Math.hypot(fx, fz);
  if (len < 1e-3) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
  const [hx, hy, hz] = head.position;
  const yaw = Math.atan2(-fx, -fz); // widgets face +Z: point it back at the user
  return { position: [hx + fx * dist, Math.max(0.3, hy - 0.15), hz + fz * dist], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
}

export function registerBuiltinCommands(reg: CommandRegistry, d: BuiltinDeps): void {
  reg.register('undo', { description: 'Undo the last scene change (or gesture).', run: () => d.undo() });
  reg.register('redo', { description: 'Redo the last undone scene change.', run: () => d.redo() });
  reg.register('delete', {
    description: 'Remove an entity (with its children and links).',
    args: '{entity: string}',
    run: (args, ctx) => { const id = entityArg(args, d.store); d.applyOps([{ op: 'remove', id }], opSourceFor(ctx.origin)); return { removed: id }; },
  });
  reg.register('duplicate', {
    description: 'Copy an entity subtree (and links touching it) next to the original.',
    args: '{entity: string}',
    run: (args, ctx) => {
      const id = entityArg(args, d.store);
      const plan = planDuplicate(d.store, id);
      d.applyOps(plan.ops, opSourceFor(ctx.origin));
      return { entity: plan.rootId };
    },
  });
  reg.register('spawn', {
    description: 'Add a widget straight in front of the user (of `head`, else the headset). `widget` may be a spoken name ("line plot" → line-plot); declines (voice: goes to Claude) when it names no widget.',
    args: '{widget: string, name?: string, props?: object, head?: {position, rotation}}',
    run: (args, ctx) => {
      const spoken = stringArg(args, 'widget');
      const catalog = d.widgets();
      const id = resolveWidgetName(spoken, catalog.map((m) => m.id));
      if (!id) throw new CommandDeclined(`no widget named '${spoken}'`);
      const w = catalog.find((m) => m.id === id);
      const entity: Partial<Entity> & { widget: string } = {
        widget: id,
        name: typeof args.name === 'string' && args.name ? args.name : titleCase(id),
        props: args.props && typeof args.props === 'object' ? (args.props as Record<string, unknown>) : {},
        transform: { ...placeInFront(headPose(args.head) ?? d.head(), w?.size), scale: [1, 1, 1] },
      };
      const { ids } = d.applyOps([{ op: 'add', entity: entity as Entity }], opSourceFor(ctx.origin));
      return { entity: ids[0], widget: id };
    },
  });
  reg.register('workspace.save', {
    description: 'Save the scene (optionally under a new name).',
    args: '{name?: string}',
    run: async (args) => ({ workspace: await d.saveWorkspace(typeof args.name === 'string' && args.name ? args.name : undefined) }),
  });
  reg.register('workspace.load', {
    description: 'Load a saved workspace.',
    args: '{name: string}',
    run: async (args) => { const name = stringArg(args, 'name'); await d.loadWorkspace(name); return { workspace: name }; },
  });
  reg.register('workspace.new', {
    description: 'Start a new empty workspace (the current one is saved).',
    args: '{name: string}',
    run: async (args) => { const name = stringArg(args, 'name'); await d.newWorkspace(name); return { workspace: name }; },
  });
  reg.register('screenshot', { description: "Capture the user's view and log it for the agent.", run: () => d.screenshot() });
  reg.register('broadcast', {
    description: 'Forward a command to all xr clients.',
    args: '{name: string, args?: object}',
    run: (args) => {
      const name = stringArg(args, 'name');
      const a = args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : undefined;
      return { clients: d.broadcastToXr(name, a) };
    },
  });
  reg.register('agent.ask', {
    description: 'Send a free-text request to Claude.',
    args: '{text: string, context?: object}',
    run: (args, ctx) => {
      const text = stringArg(args, 'text');
      const context = args.context && typeof args.context === 'object' ? (args.context as Record<string, unknown>) : {};
      d.agentAsk(text, { ...context, ...(ctx.clientId ? { clientId: ctx.clientId } : {}), origin: ctx.origin });
      return { queued: true };
    },
  });
  reg.register('say', {
    description: 'Show a message in the XR agent panel.',
    args: "{text: string, kind?: 'reply'|'info'|'error'}",
    run: (args) => { d.say(stringArg(args, 'text'), (args.kind as 'reply' | 'info' | 'error') ?? 'info'); return {}; },
  });
  reg.register('source.restart', {
    description: 'Restart a supervised source process.',
    args: '{id: string}',
    run: (args) => d.restartSource(stringArg(args, 'id')),
  });
  reg.register('widget.rebuild', {
    description: 'Force a rebuild of a widget bundle.',
    args: '{id: string}',
    run: (args) => d.rebuildWidget(stringArg(args, 'id')),
  });
  reg.register('channel.publish', {
    description: "Publish a value on a data channel (e.g. voice 'layer five' → {channel:'interp.ctl.layer', value:5}).",
    args: '{channel: string, value: any}',
    run: (args, ctx) => {
      const channel = stringArg(args, 'channel');
      if (!('value' in args) || args.value === undefined) throw new CommandError('missing {value}');
      try {
        // No `origin`: the requesting client has NOT delivered this value locally (unlike its own
        // channel.publish), so a 'no-echo' client must still receive it — e.g. the voice fast path
        // run for the headset that spoke.
        const { seq } = d.publish(channel, args.value, { producer: `command:${ctx.origin}` });
        return { channel, seq };
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        throw new CommandError((e as Error).message, typeof status === 'number' ? status : 400);
      }
    },
  });
  reg.register('ping', {
    description: 'No-op liveness probe (over WebSocket the server also replies {type:"command", name:"pong"}).',
    run: () => ({ ok: true }),
  });
  reg.register('commands.list', { description: 'List server commands.', run: () => reg.list() });
}
