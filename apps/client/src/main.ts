// Entry point. Routes by ?role=:
//   xr (default) — headset client (falls back to desktop controls without WebXR)
//   desktop      — spectator / dev client with fly camera + mouse hand
//   mirror       — the server's headless renderer (owned by the mirror component)

import { parseConfig } from './config.ts';

async function boot(): Promise<void> {
  const cfg = parseConfig();
  const container = document.getElementById('app') ?? document.body;

  if (cfg.role === 'mirror') {
    // Owned by the mirror component; resolved lazily so it never ships on the headset path.
    const mods = import.meta.glob<{ default?: unknown; start?: unknown; startMirror?: unknown; boot?: unknown }>('./mirror/index.ts');
    const load = mods['./mirror/index.ts'];
    if (!load) throw new Error('mirror mode is not available in this build (src/mirror/index.ts missing)');
    const m = await load();
    const entry = [m.default, m.start, m.startMirror, m.boot].find((f) => typeof f === 'function') as
      | ((opts: { container: HTMLElement; wsUrl: string }) => unknown)
      | undefined;
    // Modules that bootstrap on import need no explicit entry call.
    if (entry) await entry({ container, wsUrl: cfg.wsUrl });
    return;
  }

  const [{ EvolClient }, { installHooks }] = await Promise.all([import('./app.ts'), import('./hooks.ts')]);
  const client = new EvolClient(cfg);
  installHooks(client); // before start() so tests can observe the boot
  await client.start(container);
}

boot().catch((e) => {
  console.error('[evol] boot failed', e);
  const el = document.createElement('pre');
  el.id = 'evol-boot-error';
  el.textContent = `EvolSpace failed to start:\n${(e as Error)?.stack ?? String(e)}`;
  el.style.cssText = 'position:fixed;inset:12px;color:#ff5d6c;background:#0e131b;padding:16px;white-space:pre-wrap;font:12px monospace;z-index:99';
  document.body.appendChild(el);
});
