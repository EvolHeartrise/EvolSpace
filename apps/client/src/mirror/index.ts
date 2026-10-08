// Entry point for the client's mirror role (/?role=mirror). The client's
// main.ts dynamically imports this module; importing it is enough (it starts
// itself when the page is in mirror role), and `startMirror()` is exported for
// explicit use. Exposes window.__evolMirror for the server's headless driver.
//
// Query parameters:
//   ws=<url>   WebSocket URL override (default: same host, /ws)
import { MirrorRenderer, type EvolMirrorApi } from './mirror.ts';

export type { EvolMirrorApi, MirrorInfo, CaptureOptions } from './mirror.ts';
export { MirrorRenderer } from './mirror.ts';

declare global {
  interface Window {
    __evolMirror?: EvolMirrorApi;
  }
}

let instance: MirrorRenderer | null = null;

export function defaultWsUrl(loc: Location = location): string {
  const override = new URLSearchParams(loc.search).get('ws');
  if (override) return override;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** Idempotent: creates the renderer once and publishes window.__evolMirror. */
export function startMirror(opts: { wsUrl?: string; container?: HTMLElement } = {}): EvolMirrorApi {
  if (instance) return instance;
  document.title = 'EvolSpace mirror';
  document.documentElement.style.background = '#000';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  instance = new MirrorRenderer({ wsUrl: opts.wsUrl ?? defaultWsUrl(), container: opts.container });
  window.__evolMirror = instance;
  instance.ready.then(
    () => console.info('[mirror] ready', instance?.info().gl.renderer),
    (e: Error) => console.error(`[mirror] ${e.message}`),
  );
  return instance;
}

export default startMirror;

// Self-start for plain imports. Deferred one task so a caller that imports and
// then calls startMirror({ wsUrl, container }) (the client's main.ts) wins.
if (typeof window !== 'undefined' && new URLSearchParams(location.search).get('role') === 'mirror') {
  setTimeout(() => { if (!instance) startMirror(); }, 0);
}
