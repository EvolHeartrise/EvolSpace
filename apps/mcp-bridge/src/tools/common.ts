// Helpers shared by tool modules: scene/catalog access, transforms, placement.
import type {
  AnchorRef, Entity, Quat, SceneOp, SceneState, Transform, UserPose, Vec3, WidgetManifest,
} from '@evolspace/protocol';
import type { EvolApi } from '../api.ts';
import { rotate, toQuat, yawQuat } from '../format.ts';
import { ToolError } from '../tool.ts';

export type AnchorName = 'space' | 'head' | 'head-lazy' | 'left-hand' | 'right-hand';

export function toAnchor(a: AnchorName): AnchorRef {
  switch (a) {
    case 'space': return { kind: 'space' };
    case 'head': return { kind: 'head' };
    case 'head-lazy': return { kind: 'head', lazy: true };
    case 'left-hand': return { kind: 'hand', hand: 'left' };
    case 'right-hand': return { kind: 'hand', hand: 'right' };
  }
}

export function anchorLabel(a: AnchorRef | undefined): string | undefined {
  if (!a || a.kind === 'space') return undefined;
  if (a.kind === 'head') return a.lazy ? 'head-lazy' : 'head';
  return `${a.hand}-hand${a.joint ? `:${a.joint}` : ''}`;
}

export function toScale(s: number | number[]): Vec3 {
  return typeof s === 'number' ? [s, s, s] : [s[0]!, s[1]!, s[2]!];
}

/** Partial transform from tool args (only the provided fields). */
export function partialTransform(args: { position?: number[]; rotation?: number[]; scale?: number | number[] }): Partial<Transform> {
  const t: Partial<Transform> = {};
  if (args.position) t.position = [args.position[0]!, args.position[1]!, args.position[2]!];
  if (args.rotation) t.rotation = toQuat(args.rotation);
  if (args.scale !== undefined) t.scale = toScale(args.scale);
  return t;
}

export interface OpsResult {
  version: number;
  ids: string[];
  /** Non-fatal validation notes from the server (unknown props, ignored fields, …). */
  warnings: string[];
}

export async function applyOps(api: EvolApi, ops: SceneOp[]): Promise<OpsResult> {
  const r = await api.post<{ version?: number; ids?: string[]; warnings?: unknown }>('/api/scene/ops', { ops, source: 'agent' });
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
  return { version: r.version ?? -1, ids: r.ids ?? [], warnings };
}

/** "\nwarning: …" lines for server op warnings (empty string when none). */
export function warningLines(warnings: string[]): string {
  return warnings.map((w) => `\nwarning: ${w}`).join('');
}

/**
 * Where new root content goes when no headset pose is available: eye height,
 * 1 m in front of the space origin (where the user stands at session start,
 * facing -Z), instead of the floor at the origin.
 */
export const FALLBACK_POSITION: Vec3 = [0, 1.3, -1];

export function getScene(api: EvolApi): Promise<SceneState> {
  return api.get<SceneState>('/api/scene');
}

export function requireEntity(scene: SceneState, id: string): Entity {
  const e = scene.entities[id];
  if (e) return e;
  const byName = Object.values(scene.entities).filter((x) => x.name === id);
  const hint = byName.length ? ` (an entity is NAMED "${id}": ${byName.map((x) => x.id).join(', ')} — use the id)` : '';
  throw new ToolError(`No entity "${id}" in the scene${hint}. Use the scene tool to list ids.`);
}

/** Widget catalog with a short cache (spawn/link validation calls this often). */
export class Catalog {
  private cache?: { at: number; list: WidgetManifest[] };
  constructor(private readonly api: EvolApi, private readonly ttlMs = 3000) {}

  async list(force = false): Promise<WidgetManifest[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.list;
    const list = await this.api.get<WidgetManifest[]>('/api/widgets');
    this.cache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    return this.cache.list;
  }

  async get(id: string): Promise<WidgetManifest | undefined> {
    return (await this.list()).find((w) => w.id === id) ?? (await this.list(true)).find((w) => w.id === id);
  }
}

/** Closest ids by a simple edit distance — for "did you mean" hints. */
export function suggest(name: string, candidates: string[], max = 3): string[] {
  const d = (a: string, b: string) => {
    const m = a.length, n = b.length;
    const row = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[n]!;
  };
  return candidates
    .map((c) => ({ c, s: c.includes(name) || name.includes(c) ? 0 : d(name, c) }))
    .filter((x) => x.s <= Math.max(2, Math.floor(name.length / 2)))
    .sort((a, b) => a.s - b.s)
    .slice(0, max)
    .map((x) => x.c);
}

/**
 * Default placement for new root content: `distance` m in front of the user's
 * head (horizontal forward), at head height minus a little, rotated to face
 * the user. Falls back to null if no XR client reports a pose.
 */
export async function placeInFrontOfUser(api: EvolApi, distance = 0.8): Promise<{ position: Vec3; rotation: Quat } | null> {
  let user: UserPose | null = null;
  try {
    user = await api.get<UserPose | null>('/api/user', { timeoutMs: 3000 });
  } catch {
    return null;
  }
  if (!user?.head?.position || !user.head.rotation) return null;
  const fwd = rotate(user.head.rotation, [0, 0, -1]);
  let fx = fwd[0], fz = fwd[2];
  const len = Math.hypot(fx, fz);
  if (len < 1e-3) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
  const [hx, hy, hz] = user.head.position;
  const position: Vec3 = [hx + fx * distance, Math.max(0.3, hy - 0.15), hz + fz * distance];
  // Widgets face +Z: yaw so +Z points back toward the user.
  const yaw = Math.atan2(-fx, -fz);
  return { position, rotation: yawQuat(yaw) };
}
