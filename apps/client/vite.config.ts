// Vite config for the EvolSpace client.
//
// Two ways this runs:
//  1. Embedded: apps/server creates Vite in middleware mode with this config
//     (root = this folder) and serves it on :8787 / :8443 — the server owns TLS,
//     /ws, /api and /widgets, so the proxy below is unused.
//  2. Standalone: `npm run dev -w @evolspace/client` → http://localhost:5173,
//     proxying /ws, /api and /widgets to the server (EVOL_SERVER, default
//     http://127.0.0.1:8787). Handy for UI work; the headset should use the
//     server's HTTPS port.

import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const server = process.env.EVOL_SERVER ?? 'http://127.0.0.1:8787';

/**
 * Proxy /ws, /api, /widgets to the server — standalone only. In middleware mode
 * the server itself owns those routes (a proxy there would loop back to itself).
 */
function standaloneProxy(): Plugin {
  return {
    name: 'evol-standalone-proxy',
    config(c) {
      if (c.server?.middlewareMode) return;
      return {
        server: {
          proxy: {
            '/ws': { target: server, ws: true, changeOrigin: true },
            '/api': { target: server, changeOrigin: true },
            '/widgets': { target: server, changeOrigin: true },
          },
        },
      };
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  publicDir: 'public',
  plugins: [standaloneProxy()],
  server: {
    port: Number(process.env.EVOL_CLIENT_PORT ?? 5173),
    // Workspace packages are symlinked TS sources (packages/*/src): let Vite read them.
    fs: { allow: [repoRoot] },
  },
  optimizeDeps: {
    // Pre-bundle up front so first loads (and Playwright runs) don't trigger a
    // mid-session "new dependencies optimized → reload".
    include: ['three', 'troika-three-text', 'iwer', '@iwer/devui', '@iwer/sem'],
  },
  build: {
    // Quest Browser is current Chromium.
    target: 'chrome120',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
});
