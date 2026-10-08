// Contracts of the desktop debug dashboard (?debug=1, /debug). Panels and 3D
// overlays plug in through these types; see README "Debug mode" and
// panels/index.ts. Everything here is type-only.

import type * as THREE_NS from 'three';
import type { ComponentChildren, VNode } from 'preact';
import type { EvolClient } from '../app.ts';
import type { DebugApi } from './api.ts';
import type { DebugActions, DebugStore } from './store.ts';
import type { LayoutStore } from './layout.ts';
import type { IconName } from './ui/icons.tsx';
import type { ReadonlySignal } from '@preact/signals';

export type { IconName };

/** The three docks around the 3D viewport (all tabbed). */
export type DockId = 'left' | 'right' | 'bottom';
export const DOCK_IDS: readonly DockId[] = ['left', 'right', 'bottom'];

/**
 * The slice of EvolClient the dashboard uses (typed, narrow). `runtime` is the
 * @evolspace/runtime SpaceRuntime, `engine` the @evolspace/input InteractionEngine,
 * `net` the runtime NetClient, `sim` the simulated-hands driver (same as __evol.sim).
 */
export type DebugClientPort = Pick<EvolClient,
  | 'cfg' | 'renderer' | 'scene' | 'camera' | 'runtime' | 'engine' | 'net' | 'host' | 'desktop' | 'sim' | 'page' | 'hud'
  | 'origin' | 'head' | 'hands' | 'command' | 'state' | 'buildPose'
  | 'attachViewport' | 'fitViewport' | 'viewportSize' | 'onFrame'>;

export interface PanelProps {
  ctx: DebugContext;
}

/**
 * A dashboard panel. Register it in panels/index.ts (each panel lives in its own
 * file under panels/; extra files go in panels/<id>/). Only the ACTIVE tab of a
 * dock is mounted: keep state that must survive tab switches in module-level
 * signals, and acquire polling via `ctx.store.need(...)` / `useNeed` while mounted.
 */
export interface PanelDef {
  /** Stable id (persisted in the layout). */
  id: string;
  title: string;
  /** Default dock; the user can move panels (tab context menu). */
  dock: DockId;
  /** Tab order within the default dock (lower = further left). */
  order: number;
  component: (props: PanelProps) => VNode | null;
  icon?: IconName;
  /**
   * Called once when the dashboard starts, whether or not the panel is open:
   * register overlays / toolbar actions here. May return a disposer.
   */
  init?(ctx: DebugContext): void | (() => void);
  /** Small tab badge (e.g. an error count). Read signals here: it re-renders reactively. */
  badge?(ctx: DebugContext): string | number | null;
}

/** A live 3D debug overlay instance (created while enabled). */
export interface OverlayInstance {
  /** Per frame, after runtime.update() and before render. dt in s, tMs = rAF time. */
  update?(dt: number, tMs: number): void;
  dispose(): void;
}

/**
 * A 3D debug overlay (bounds, rays, labels, axes, …). Add objects to
 * `ctx.scene` (world) or `ctx.runtime.root` (space coordinates); remove and
 * dispose them in dispose(). Never hit-tested unless you register them.
 */
export interface OverlayDef {
  id: string;
  title: string;
  description?: string;
  /** Enabled the first time the dashboard runs (then the user's choice is persisted). */
  defaultEnabled?: boolean;
  create(ctx: DebugContext): OverlayInstance;
}

export interface OverlayHost {
  readonly defs: ReadonlySignal<OverlayDef[]>;
  /** Ids of enabled overlays (persisted). */
  readonly enabled: ReadonlySignal<ReadonlySet<string>>;
  isEnabled(id: string): boolean;
  setEnabled(id: string, on: boolean): void;
  toggle(id: string): void;
}

/** A toolbar button. Re-registering an id replaces it (placeholders never replace real actions). */
export interface ToolbarAction {
  id: string;
  title: string;
  /** Short text next to the icon (optional). */
  label?: string;
  icon?: IconName;
  /** Lower = further left within the actions group. */
  order?: number;
  /** Built-in stand-in that a panel is expected to replace. */
  placeholder?: boolean;
  run(ctx: DebugContext): void | Promise<void>;
  /** Highlighted state (read signals here for reactivity). */
  active?(ctx: DebugContext): boolean;
}

export type ToastKind = 'info' | 'warn' | 'error';

/** Everything a panel / overlay gets. */
export interface DebugContext {
  readonly client: DebugClientPort;
  readonly runtime: DebugClientPort['runtime'];
  readonly engine: DebugClientPort['engine'];
  readonly net: DebugClientPort['net'];
  readonly THREE: typeof THREE_NS;
  /** three.js world scene (the space root is `runtime.root`). */
  readonly scene: THREE_NS.Scene;
  /** The desktop camera (world coordinates). */
  readonly camera: THREE_NS.PerspectiveCamera;
  readonly renderer: THREE_NS.WebGLRenderer;
  /** Typed HTTP API (packages/protocol/src/api.ts). */
  readonly api: DebugApi;
  /** Live signals. */
  readonly store: DebugStore;
  /** Scene edits (undoable), selection, camera framing, spawning. */
  readonly actions: DebugActions;
  readonly layout: LayoutStore;
  readonly overlays: OverlayHost;
  /** DOM toast in the viewport corner. */
  toast(text: string, kind?: ToastKind): void;
}

export type { ComponentChildren };
