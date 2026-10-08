// Scene model. The server owns the authoritative SceneState; clients render it
// and may submit ops (e.g. a grab moving an entity). Coordinates are meters in
// "space" coordinates: a right-handed, Y-up frame whose origin the client maps
// to the floor (local-floor in VR, a persistent spatial anchor in MR).

export type Vec3 = [number, number, number];
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export type Handedness = 'left' | 'right';

/**
 * What an entity's transform is relative to. Only meaningful on root entities
 * (parent === null); children are always relative to their parent.
 * - space: the shared space origin (default)
 * - head:  follows the head. `lazy` = smoothly re-centers in front of the user
 *          only when it drifts out of view (good for HUD-ish panels).
 * - hand:  attached to a hand joint (e.g. a wrist menu). Hidden while that hand is not tracked.
 */
export type AnchorRef =
  | { kind: 'space' }
  | { kind: 'head'; lazy?: boolean }
  | { kind: 'hand'; hand: Handedness; joint?: string };

export interface Entity {
  /** Stable id. Server assigns one if an 'add' op omits it. */
  id: string;
  /** Parent entity id, or null for a root entity. */
  parent: string | null;
  /** Human/agent-friendly name ("lens slider"). Not unique. */
  name?: string;
  /** Widget type id = folder name under library/widgets (e.g. "box", "slider", "resid-flow"). */
  widget: string;
  /** Widget props; validated/defaulted against the widget's prop specs. */
  props: Record<string, unknown>;
  transform: Transform;
  visible: boolean;
  anchor?: AnchorRef;
  tags?: string[];
  /** Object-scoped interaction bindings; override the widget's defaults and globals. */
  interactions?: InteractionBindingRef[];
  /** When true, standard grab/scale interactions are ignored for this entity. */
  locked?: boolean;
}

/** An interaction binding attached to an entity; see gestures.ts for the full type. */
export type InteractionBindingRef = import('./gestures.ts').InteractionBinding;

/**
 * A link moves values between ports/channels. Port→port links are evaluated
 * entirely on the client (no server round trip). Channel→port links deliver
 * server data to widget inputs. Port→channel links publish widget outputs to
 * the server data bus (where Python/Rust/anything can consume them).
 */
export interface Link {
  id: string;
  from: PortRef;
  to: PortRef;
  /**
   * Optional JS expression of `x` (the incoming value) evaluated client-side,
   * e.g. "Math.round(x * 10)" or "x > 0.5". Must be a pure expression.
   */
  transform?: string;
  enabled: boolean;
}

export type PortRef =
  | { kind: 'port'; entity: string; port: string }
  | { kind: 'channel'; channel: string };

export interface SceneState {
  /** Monotonic version; incremented once per applied op batch. */
  version: number;
  entities: Record<string, Entity>;
  links: Record<string, Link>;
  /** Name of the workspace this scene was loaded from / will save to. */
  workspace: string;
}

/** Partial entity update. `props` is shallow-merged; other fields replace. */
export type EntityPatch = Partial<Omit<Entity, 'id' | 'props' | 'transform'>> & {
  props?: Record<string, unknown>;
  transform?: Partial<Transform>;
};

export type SceneOp =
  | { op: 'add'; entity: Partial<Entity> & Pick<Entity, 'widget'> }
  | { op: 'update'; id: string; patch: EntityPatch }
  /** Removes the entity, its descendants, and any links touching them. */
  | { op: 'remove'; id: string }
  | { op: 'link.add'; link: Omit<Link, 'id' | 'enabled'> & Partial<Pick<Link, 'id' | 'enabled'>> }
  | { op: 'link.update'; id: string; patch: Partial<Omit<Link, 'id'>> }
  | { op: 'link.remove'; id: string }
  | { op: 'clear' };

/** Where an op batch originated; recorded in the op log and used for undo grouping. */
export type OpSource = 'agent' | 'user' | 'voice' | 'widget' | 'system';

/** A prefab: a reusable group of entities + links, stored in library/prefabs/<id>.json. */
export interface Prefab {
  description: string;
  /** Entities with prefab-local ids; remapped to fresh ids on instantiation. Root(s) have parent null. */
  entities: Array<Partial<Entity> & Pick<Entity, 'id' | 'widget'>>;
  links: Array<Omit<Link, 'id' | 'enabled'> & Partial<Pick<Link, 'enabled'>>>;
}

export const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};
