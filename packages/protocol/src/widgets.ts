// Widget module contract. A widget lives in library/widgets/<id>/widget.ts and
// default-exports a WidgetDefinition. The server bundles it with esbuild into
// one ESM file. Widgets MUST NOT import 'three' or any npm package at runtime:
// they receive three.js and helpers through the WidgetContext. They may import
// relative files (their own folder or library/shared/**), which get bundled.
// `import type` from '@evolspace/protocol' is fine (erased at build).
//
// Top-level module code must be side-effect free (the server evaluates the
// bundle in Node to read the static fields of the definition).

import type * as THREE_NS from 'three';
import type { Vec3, Quat, Transform, Entity, AnchorRef } from './scene.ts';
import type { InteractionBinding, InteractionEvent } from './gestures.ts';
import type { ChannelValue } from './data.ts';

export type PortType =
  | 'number' | 'boolean' | 'string' | 'vec3' | 'color'
  | 'json'    // any JSON value
  | 'tensor'  // TensorValue
  | 'event'   // momentary trigger; value is optional payload
  | 'any';

export interface PortSpec {
  type: PortType;
  description?: string;
  /** For inputs: value before anything is linked. */
  default?: unknown;
}

export interface PropSpec {
  type: 'number' | 'integer' | 'boolean' | 'string' | 'color' | 'vec3' | 'enum' | 'json' | 'channel';
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // for 'enum'
}

export interface WidgetDefinition<P extends Record<string, unknown> = Record<string, any>> {
  /** One or two sentences; shown to the agent in the catalog. */
  description: string;
  /** Semver-ish string the agent bumps on meaningful changes. */
  version?: string;
  props?: Record<string, PropSpec>;
  inputs?: Record<string, PortSpec>;
  outputs?: Record<string, PortSpec>;
  /** Default interaction bindings for instances of this widget (scope between entity and global). */
  interactions?: InteractionBinding[];
  /** Approximate size in meters at scale 1, used for placement/framing before first render. */
  size?: Vec3;
  create(ctx: WidgetContext<P>): WidgetInstance | Promise<WidgetInstance>;
}

export interface WidgetInstance {
  /** Called every frame while visible. dt/t in seconds. */
  update?(dt: number, t: number): void;
  /** Props changed. If not implemented, the host disposes and re-creates the instance. */
  onProps?(props: Record<string, unknown>, prev: Record<string, unknown>): void;
  /** A linked input port received a value. */
  onInput?(port: string, value: unknown): void;
  /** Interaction events for this entity (from 'widget' bindings, plus 'press'/'hover' handlers). */
  onInteraction?(e: InteractionEvent): void;
  dispose?(): void;
}

export interface TextOptions {
  size?: number;          // em height in meters, default 0.03
  color?: string;
  maxWidth?: number;      // meters; wraps
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  font?: 'sans' | 'mono';
}

/** Clean/diagrammatic look; widgets should use these instead of hard-coded colors. */
export interface Theme {
  background: string;     // panel fill
  surface: string;        // raised elements
  border: string;
  text: string;
  textDim: string;
  accent: string;
  accent2: string;
  positive: string;
  negative: string;
  /** Categorical palette (8+ colors) for series/tokens/layers. */
  palette: string[];
  /** Diverging ramp endpoints for signed values. */
  diverging: [string, string, string];
  /** Sequential ramp for magnitudes. */
  sequential: string[];
}

export interface UiKit {
  /** SDF text mesh (troika). Call .set(text) to update; .sync() is handled by the host. */
  text(content: string, opts?: TextOptions): THREE_NS.Mesh & { set(text: string): void };
  /** Rounded flat panel (width × height meters) with theme styling. */
  panel(width: number, height: number, opts?: { color?: string; radius?: number; opacity?: number }): THREE_NS.Mesh;
  /** Unlit material in a theme color (cheap on Quest). */
  material(color: string, opts?: { opacity?: number; doubleSide?: boolean }): THREE_NS.Material;
  /** Map a value to a color on a theme ramp. */
  color(ramp: 'sequential' | 'diverging' | 'palette', t: number): THREE_NS.Color;
}

export interface ChannelApi {
  get(name: string): ChannelValue | undefined;
  /** Subscribe to a server data channel. Returns an unsubscribe fn. Fires immediately if a value exists. */
  subscribe(name: string, cb: (value: ChannelValue) => void): () => void;
  publish(name: string, value: ChannelValue): void;
}

export interface ChildHandle {
  readonly entityId: string;
  setProps(patch: Record<string, unknown>): void;
  setTransform(t: Partial<Transform>): void;
  remove(): void;
}

export interface WidgetContext<P extends Record<string, unknown> = Record<string, any>> {
  THREE: typeof THREE_NS;
  /** Attach your objects here. Its transform is controlled by the entity; don't move it. */
  root: THREE_NS.Group;
  entityId: string;
  /** Current props, defaults applied. Updated in place before onProps is called. */
  props: P;
  theme: Theme;
  ui: UiKit;
  channels: ChannelApi;
  /** Emit a value on an output port (flows over links, locally). */
  emit(port: string, value: unknown): void;
  /** Latest value received on an input port (or its default). */
  input(port: string): unknown;
  /** Persist prop changes to the server scene (e.g. a slider's value), so they survive reloads. Throttled by host. */
  setProps(patch: Record<string, unknown>): void;
  /**
   * Mark an object as hit-testable for interactions (ray/touch). Hits resolve to this entity;
   * the object's name is passed back as InteractionEvent.objectName.
   */
  interactive(obj: THREE_NS.Object3D): void;
  /** Spawn a child entity (any widget) parented to this entity. Persisted in the scene. */
  spawnChild(widget: string, props?: Record<string, unknown>, transform?: Partial<Transform>, name?: string): ChildHandle;
  /** Log a notable event to the server event log (visible to the agent). */
  event(name: string, data?: unknown): void;
  /** Send a request to Claude, as if the user had spoken it, with this entity as context. */
  askAgent(text: string): void;
  log(...args: unknown[]): void;
  /** Reports to the server's error log (agent-visible) without throwing. */
  error(message: string, detail?: unknown): void;
  /** True when rendering in the headless mirror (for screenshots); avoid expensive effects. */
  readonly isMirror: boolean;
  /**
   * The client running this instance: its server-assigned id (null until connected; stable for the
   * connection) — e.g. to pick ONE client to play a widget's audio when the scene is open in several.
   */
  readonly client: { readonly id: string | null };
  /** Read-only view of the user (head + hands) in space coordinates. */
  readonly user: UserView;
}

export interface UserView {
  head: { position: Vec3; rotation: Quat };
  hands: Partial<Record<'left' | 'right', { position: Vec3; rotation: Quat; tracked: boolean }>>;
}

/** Catalog entry the server derives for each widget (GET /api/widgets). */
export interface WidgetManifest {
  id: string;
  description: string;
  version?: string;
  props: Record<string, PropSpec>;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  interactions: InteractionBinding[];
  size?: Vec3;
  /** Content hash of the bundle; clients re-import when it changes. */
  hash: string;
  /** URL of the compiled ESM bundle, e.g. /widgets/slider.js?h=<hash> */
  url: string;
  hasThumbnail: boolean;
  /** Build error, if the latest source failed to compile/evaluate. The last good bundle stays served. */
  error?: string;
}

export type { Entity, AnchorRef };
