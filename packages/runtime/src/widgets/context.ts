// WidgetContext implementation: what a widget's create(ctx) receives.
// Every capability is scoped to one instance (InstanceState) so that when the
// instance is disposed — hot reload, prop-driven re-create, entity removal —
// its channel subscriptions are released and late async calls become no-ops.

import * as THREE from 'three';
import type {
  ChannelApi,
  ChannelValue,
  ChildHandle,
  Theme,
  Transform,
  UserView,
  WidgetContext,
  WidgetManifest,
} from '@evolspace/protocol';
import type { ChannelHub } from '../data/ChannelHub.ts';
import type { LinkEngine } from '../links/LinkEngine.ts';
import type { NetPort } from '../net/types.ts';
import type { SceneWriter } from '../scene/SceneWriter.ts';
import type { RuntimeUiKit } from '../ui/UiKit.ts';
import { randomId } from '../util/ids.ts';
import { TokenBucket } from '../util/rate.ts';

/** Per-instance bookkeeping owned by the widget host. */
export class InstanceState {
  alive = true;
  readonly cleanups: Array<() => void> = [];
  readonly interactives = new Set<THREE.Object3D>();
  readonly logBucket = new TokenBucket(5, 20);

  constructor(public props: Record<string, unknown>) {}

  release(): void {
    this.alive = false;
    for (const c of this.cleanups.splice(0)) {
      try { c(); } catch { /* ignore */ }
    }
    for (const o of this.interactives) delete o.userData.evolInteractive;
    this.interactives.clear();
  }
}

export interface ContextEnv {
  theme: Theme;
  ui: RuntimeUiKit;
  net: NetPort;
  channels: ChannelHub;
  links: LinkEngine;
  writer: SceneWriter;
  user: UserView;
  isMirror: boolean;
  /** Latest value on an input port (received or default). */
  input(entity: string, port: string): unknown;
  reportError(entity: string, widget: string, message: string, detail?: unknown, fromWidget?: boolean): void;
}

export function createWidgetContext(
  env: ContextEnv,
  entityId: string,
  manifest: WidgetManifest,
  root: THREE.Group,
  state: InstanceState,
): WidgetContext {
  const widget = manifest.id;

  const channels: ChannelApi = {
    get: (name) => env.channels.get(name),
    subscribe(name, cb) {
      if (!state.alive) return () => {};
      const off = env.channels.subscribe(name, (v: ChannelValue) => {
        if (state.alive) cb(v);
      });
      state.cleanups.push(off);
      return off;
    },
    publish(name, value) {
      if (state.alive) env.channels.publish(name, value);
    },
  };

  const ctx: WidgetContext = {
    THREE,
    root,
    entityId,
    props: state.props,
    theme: env.theme,
    ui: env.ui,
    channels,
    emit(port, value) {
      if (state.alive) env.links.emit(entityId, port, value);
    },
    input: (port) => env.input(entityId, port),
    setProps(patch) {
      if (!state.alive || !patch || typeof patch !== 'object') return;
      // Update ctx.props in place first so the optimistic local echo does not
      // trigger onProps for values the widget itself just set.
      Object.assign(state.props, patch);
      env.writer.update(entityId, { props: patch }, 'widget');
    },
    interactive(obj) {
      if (!state.alive || !obj) return;
      obj.userData.evolInteractive = entityId;
      state.interactives.add(obj);
    },
    spawnChild(childWidget, props, transform, name) {
      // Server ids are 1-64 chars of [A-Za-z0-9_.:-]; randomId() adds ≤ 20.
      const id = `${String(childWidget).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 32)}-${randomId()}`;
      if (state.alive) {
        env.writer.add({
          id,
          parent: entityId,
          widget: childWidget,
          props: props ?? {},
          transform: {
            position: transform?.position ?? [0, 0, 0],
            rotation: transform?.rotation ?? [0, 0, 0, 1],
            scale: transform?.scale ?? [1, 1, 1],
          },
          visible: true,
          ...(name ? { name } : {}),
        });
      }
      return childHandle(env, id);
    },
    event(name, data) {
      if (state.alive) env.net.send({ type: 'widget.event', entity: entityId, widget, name, data });
    },
    askAgent(text) {
      if (state.alive) env.net.send({ type: 'agent.ask', text, context: { entity: entityId, widget } });
    },
    log(...args) {
      console.log(`[${widget}:${entityId}]`, ...args);
      if (state.alive && state.logBucket.take()) {
        env.net.send({ type: 'client.log', level: 'info', message: formatArgs(args), entity: entityId });
      }
    },
    error(message, detail) {
      console.warn(`[${widget}:${entityId}] ${message}`, detail ?? '');
      if (state.alive) env.reportError(entityId, widget, String(message), detail, true);
    },
    isMirror: env.isMirror,
    user: env.user,
  };
  return ctx;
}

function childHandle(env: ContextEnv, id: string): ChildHandle {
  return {
    entityId: id,
    setProps(patch) {
      env.writer.update(id, { props: patch }, 'widget');
    },
    setTransform(t: Partial<Transform>) {
      env.writer.update(id, { transform: t }, 'widget');
    },
    remove() {
      env.writer.remove(id, 'widget');
    },
  };
}

export function formatArgs(args: unknown[], max = 2000): string {
  const s = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}
