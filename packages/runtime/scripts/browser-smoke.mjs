#!/usr/bin/env node
// Browser smoke test for @evolspace/runtime: bundles scripts/smoke-entry.ts
// with esbuild, serves it plus the client fonts on a random local port, runs
// it in headless Chromium (Playwright), and checks: no page errors, every
// troika text typeset with the bundled fonts, expected widget statuses, and a
// ray hit on an interactive object, and that nothing is requested from any
// other origin (troika's CDN font fallback must never trigger). Writes a screenshot.
//
//   node packages/runtime/scripts/browser-smoke.mjs [screenshot.png]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const fontsDir = join(repo, 'apps/client/public/fonts');
const shot = process.argv[2] ?? join(tmpdir(), 'evolspace-runtime-smoke.png');

const bundle = await esbuild.build({
  entryPoints: [join(here, 'smoke-entry.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  logLevel: 'error',
});
const js = bundle.outputFiles[0].text;
const html = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}</style><script type="module" src="/app.js"></script>';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url.pathname === '/app.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    if (url.pathname.startsWith('/fonts/')) {
      const file = join(fontsDir, url.pathname.slice('/fonts/'.length).replace(/[^\w.-]/g, ''));
      return void res.writeHead(200, { 'content-type': 'font/ttf' }).end(await readFile(file));
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  const fontRequests = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  page.on('request', (r) => { if (r.url().includes('/fonts/')) fontRequests.push(new URL(r.url()).pathname); });
  // Anything leaving the local origin (e.g. a CDN font fallback) is recorded and blocked.
  const offOrigin = [];
  await page.route((u) => u.host !== `127.0.0.1:${port}` && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob'), (route) => {
    offOrigin.push(route.request().url());
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__smoke?.done, null, { timeout: 60_000 });
  const result = await page.evaluate(() => window.__smoke);
  await page.screenshot({ path: shot });

  // The broken/missing widgets log errors on purpose; ignore those.
  const unexpected = pageErrors.filter((e) => !/demo failure|unknown widget|\[widget\]/.test(e));
  const checks = {
    noUnexpectedErrors: unexpected.length === 0 && result.errors.length === 0,
    allTextsSynced: result.unsynced.length === 0 && result.texts.length > 5,
    fontsLoadedLocally: ['/fonts/Inter-Regular.ttf', '/fonts/JetBrainsMono-Regular.ttf'].every((f) => fontRequests.includes(f)),
    widgetStatuses: JSON.stringify(result.statuses) === JSON.stringify(['ready', 'ready', 'error', 'missing']),
    rayHitsKnob: result.hit?.entity === 'c1' && result.hit?.interactive === true,
    noOffOriginRequests: offOrigin.length === 0,
  };
  ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, checks, unexpected, offOrigin, fontRequests: [...new Set(fontRequests)], drawCalls: result.drawCalls, triangles: result.triangles, texts: result.texts.length, unsynced: result.unsynced, screenshot: shot }, null, 2));
} finally {
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);
