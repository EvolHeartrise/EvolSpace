// EvolSpace server entry point: `npm run dev -w @evolspace/server` (tsx watch)
// or `npx tsx apps/server/src/main.ts`. Config via env (see config.ts / README).
import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { startApp } from './app.ts';

const log = createLogger();

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await startApp(config, { log });

  const lines = [
    '',
    '  EvolSpace server ready',
    `  local API   http://127.0.0.1:${app.httpPort}/api/health`,
  ];
  if (app.httpsPort !== null) {
    lines.push(`  desktop     https://localhost:${app.httpsPort}/`);
    if (app.headsetUrls.length) {
      lines.push('  headset     open on the Quest browser (accept the self-signed certificate once):');
      for (const u of app.headsetUrls) lines.push(`                ${u}`);
    } else {
      lines.push('  headset     no LAN IPv4 address found — connect this PC to the same network as the Quest');
    }
    if (app.tls?.regenerated) lines.push('  (TLS certificate regenerated; the headset will ask to accept it again)');
  }
  lines.push(`  workspace   ${app.services.store.workspace} (${Object.keys(app.services.store.scene.entities).length} entities)`, '');
  console.log(lines.join('\n'));

  let exiting = false;
  const shutdown = (signal: string) => {
    if (exiting) { log.warn('forced exit'); process.exit(1); }
    exiting = true;
    log.info(`${signal} received`);
    const force = setTimeout(() => {
      log.error('shutdown timed out; saving synchronously and exiting');
      try { app.services.workspaces.flushSync(); } catch (e) { log.error(String(e)); }
      process.exit(1);
    }, 8000);
    force.unref();
    app.stop().then(() => process.exit(0), (e) => { log.error(`shutdown error: ${(e as Error).message}`); process.exit(1); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Ctrl+Break on Windows
  process.on('SIGHUP', () => shutdown('SIGHUP')); // terminal closed (Windows gives ~10 s before killing us)
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${(e as Error)?.stack ?? e}`));
  process.on('uncaughtException', (e) => {
    // State may be inconsistent: save what we have synchronously, then let the supervisor (tsx watch / user) restart us.
    log.error(`uncaught exception: ${e.stack ?? e}`);
    try { app.services.workspaces.flushSync(); } catch (err) { log.error(`final save failed: ${(err as Error).message}`); }
    process.exit(1);
  });
}

main().catch((e) => {
  log.error(`failed to start: ${(e as Error).message}`);
  process.exit(1);
});
