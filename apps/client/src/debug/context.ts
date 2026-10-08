// Builds the DebugContext every panel and overlay receives: client handles
// (typed, via the EvolClient port), the HTTP API, the signal store + actions,
// the layout and the overlay host.

import * as THREE from 'three';
import { createApi } from './api.ts';
import { DebugCamera } from './camera.ts';
import { LayoutStore, safeLocalStorage, type StorageLike } from './layout.ts';
import { OverlayRunner } from './overlays.ts';
import { overlayDefs, panelDefs } from './registry.ts';
import { createDebugStore } from './store.ts';
import type { DebugClientPort, DebugContext, ToastKind } from './types.ts';

export interface DebugContextHandle {
  ctx: DebugContext;
  camera: DebugCamera;
  overlays: OverlayRunner;
  dispose(): void;
}

export function createDebugContext(client: DebugClientPort, opts: { storage?: StorageLike } = {}): DebugContextHandle {
  const net = client.net;
  const base = (net.httpBase && net.httpBase !== '/' ? net.httpBase : location.origin).replace(/\/$/, '');
  const api = createApi(base);
  const toast = (text: string, kind: ToastKind = 'info') => {
    if (client.page) client.page.toast(text, kind, kind === 'error' ? 7000 : 4000);
    else (kind === 'error' ? console.error : console.info)(`[debug] ${text}`);
  };
  const camera = new DebugCamera(client);
  const { store, actions } = createDebugStore({
    runtime: client.runtime,
    net,
    api,
    camera,
    toast,
    command: (name, args) => { client.command(name, args, 'start'); },
  });
  const layout = new LayoutStore(panelDefs, opts.storage ?? safeLocalStorage());
  const overlays = new OverlayRunner(overlayDefs, layout);
  const ctx: DebugContext = {
    client,
    runtime: client.runtime,
    engine: client.engine,
    net,
    THREE,
    scene: client.scene,
    camera: client.camera,
    renderer: client.renderer,
    api,
    store,
    actions,
    layout,
    overlays,
    toast,
  };
  return {
    ctx,
    camera,
    overlays,
    dispose: () => {
      overlays.dispose();
      store.dispose();
      layout.dispose();
      camera.dispose();
    },
  };
}
