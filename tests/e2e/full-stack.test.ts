// Full-stack end-to-end suite: a REAL apps/server (child process, free test port,
// isolated data dir, temp copy of the real library), the REAL MCP bridge over
// stdio (spawned exactly like .mcp.json does), the REAL client in Playwright
// Chromium (desktop + IWER-emulated Quest 3), the mirror's headless renderer,
// the Claude Code status hook script and the Python interp source.
//
// Opt-in (~30 s, spawns processes):   EVOL_E2E=1 npx vitest run tests/e2e
// See tests/e2e/README.md. Screenshots are saved to data/e2e/.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import type { PoseDef, SceneState, Vec3 } from '@evolspace/protocol';
import { imageStats } from '../../apps/server/src/mirror/png.ts';
import type {} from '../../apps/client/src/hooks.ts'; // window.__evol typing
import { NetClient } from '../../packages/runtime/src/net/NetClient.ts';
import { E2E_ENABLED, ROOT, api, freePort, portInUse, saveShot, sleep, startServer, until, type TestServer } from './harness.ts';

const CHANNEL_METHOD = 'notifications/claude/channel';

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** A PNG that is not one flat color (and not nearly so). */
function expectNonUniform(png: Buffer, what: string): ReturnType<typeof imageStats> {
  const st = imageStats(png);
  expect(st.width, what).toBeGreaterThan(0);
  expect(st.variance, `${what}: luminance variance ${st.variance.toFixed(2)} (uniform image?)`).toBeGreaterThan(20);
  expect(st.distinctColors, `${what}: only ${st.distinctColors} distinct colors`).toBeGreaterThan(8);
  return st;
}

describe.skipIf(!E2E_ENABLED)('EvolSpace full stack (e2e)', () => {
  let srv: TestServer;
  let http: ReturnType<typeof api>;
  let mcp: Client;
  let bridgeStderr = '';
  const notifications: Notification[] = [];
  let browser: Browser | null = null;
  const pageErrors: string[] = [];
  let boxId = '';
  const BOX_AT: Vec3 = [0, 1.3, -0.5];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
    if (r.isError) throw new Error(`tool ${name} failed: ${textOf(r)}`);
    return r;
  };
  const scene = () => http.get<SceneState>('/api/scene');

  async function newPage(query: string, opts: { waitEntity?: string } = {}): Promise<Page> {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    }
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    page.on('pageerror', (e) => pageErrors.push(`[${query}] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`[${query}] ${m.text()}`); });
    await page.goto(`${srv.url}/${query}`);
    await page.waitForFunction(() => {
      const s = window.__evol?.state() as { connected?: boolean; ready?: boolean } | undefined;
      return !!s?.connected && !!s.ready;
    }, undefined, { timeout: 60_000 });
    if (opts.waitEntity) await page.waitForFunction((id) => !!window.__evol?.runtime.entityObject(id), opts.waitEntity, { timeout: 30_000 });
    return page;
  }

  /** Object origin (or a named descendant) in SPACE coordinates. */
  const spacePos = (page: Page, id: string, child?: string) => page.evaluate(([id, child]) => {
    const rt = window.__evol!.runtime;
    let obj = rt.entityObject(id!)!;
    if (child) obj = obj.getObjectByName(child)!;
    obj.updateWorldMatrix(true, false);
    const p = obj.getWorldPosition(obj.position.clone());
    rt.root.worldToLocal(p);
    return [p.x, p.y, p.z] as Vec3;
  }, [id, child] as const);

  /** Open hand at `p` → pinch → drag by `d` in 10 steps → release (window.__evol.sim). */
  async function simDrag(page: Page, p: Vec3, d: Vec3): Promise<void> {
    const at = (f: number): Vec3 => [p[0] + d[0] * f, p[1] + d[1] * f, p[2] + d[2] * f];
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, false), at(0));
    await sleep(250);
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, true), at(0));
    await sleep(300);
    for (let i = 1; i <= 10; i++) {
      await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, true), at(i / 10));
      await sleep(50);
    }
    await sleep(200);
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, false), at(1));
    await sleep(300);
    await page.evaluate(() => window.__evol!.sim.clearHands());
  }

  beforeAll(async () => {
    srv = await startServer();
    http = api(srv.url);
  }, 120_000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    try { await mcp?.close(); } catch { /* ignore */ }
    await srv?.stop();
    if (pageErrors.length) console.warn(`[e2e] page errors:\n${pageErrors.join('\n')}`);
  }, 60_000);

  // ------------------------------------------------------------------ 1. MCP bridge
  it('1. MCP bridge over stdio: tools, spawn, scene, screenshots', async () => {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, '.mcp.json'), 'utf8')).mcpServers.evolspace as { command: string; args: string[] };
    expect(cfg.command).toBe('node');
    const transport = new StdioClientTransport({
      command: process.execPath, // "node" from .mcp.json, resolved
      args: cfg.args,
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), EVOL_URL: srv.url, MCP_PROTOCOL_NEGOTIATION: 'legacy' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => { bridgeStderr += d; });
    mcp = new Client({ name: 'evol-e2e', version: '0' });
    mcp.fallbackNotificationHandler = async (n) => { notifications.push(n); };
    await mcp.connect(transport);
    expect(mcp.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({});

    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    for (const t of ['scene', 'spawn', 'link', 'screenshot', 'say', 'voice_simulate', 'pose_record']) expect(names).toContain(t);

    const spawned = textOf(await call('spawn', { widget: 'box', name: 'e2e box', position: BOX_AT, props: { color: '#3b82f6' } }));
    boxId = /spawned (\S+)/.exec(spawned)?.[1] ?? '';
    expect(boxId, spawned).toMatch(/^e-/);
    const sceneText = textOf(await call('scene'));
    expect(sceneText).toContain(boxId);
    expect(sceneText).toContain('box');
    expect((await scene()).entities[boxId]?.transform.position).toEqual(BOX_AT);

    const shots: Array<[string, Record<string, unknown>]> = [
      ['01-mcp-camera.png', { view: 'camera', position: [0.6, 1.7, 0.4], lookAt: BOX_AT, width: 640, height: 480 }],
      ['01-mcp-entity-box.png', { view: 'entity', entity: boxId, width: 640, height: 480 }],
    ];
    for (const [file, args] of shots) {
      const r = await call('screenshot', args);
      const img = r.content.find((c) => c.type === 'image');
      expect(img?.mimeType).toBe('image/png');
      const png = Buffer.from(img!.data!, 'base64');
      saveShot(file, png);
      expectNonUniform(png, file);
    }
  }, 180_000);

  // ------------------------------------------------------------------ 2. client grab + undo
  it('2a. desktop client (?role=desktop): sim pinch-grab moves the box, undo restores it', async () => {
    const page = await newPage('?role=desktop', { waitEntity: boxId });
    try {
      expect(await page.evaluate(() => window.__evol!.runtime.environment.grid)).toBe(true);
      const start = (await scene()).entities[boxId].transform.position;
      await simDrag(page, await spacePos(page, boxId), [0.3, 0, 0]);
      const moved = await until(async () => {
        const p = (await scene()).entities[boxId].transform.position;
        return Math.abs(p[0] - start[0]) > 0.15 ? p : null;
      }, 'the server to see the grab', 10_000);
      expect(moved[0] - start[0]).toBeGreaterThan(0.2);
      expect(Math.abs(moved[1] - start[1])).toBeLessThan(0.05);

      const u = await http.post<{ ok: boolean }>('/api/scene/undo');
      expect(u.ok).toBe(true);
      const back = (await scene()).entities[boxId].transform.position;
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(start[i], 4);
      // The client follows the undo too.
      await until(async () => Math.abs((await spacePos(page, boxId))[0] - start[0]) < 1e-3, 'the client to apply the undo', 5000);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('2b. emulated Quest 3 (IWER immersive-vr): primary xr client, grab + undo, grid on in VR / off in AR', async () => {
    const page = await newPage('?emulate=quest3&autoenter=vr', { waitEntity: boxId });
    try {
      await page.waitForFunction(() => window.__evol!.state().mode === 'vr', undefined, { timeout: 30_000 });
      const health = await http.get<{ clients: Array<{ role: string; primary: boolean }> }>('/api/health');
      expect(health.clients.some((c) => c.role === 'xr' && c.primary)).toBe(true);
      expect(await page.evaluate(() => window.__evol!.state().primary)).toBe(true);
      expect(await page.evaluate(() => window.__evol!.runtime.environment.grid)).toBe(true);
      await until(async () => (await http.get<{ mode?: string } | null>('/api/user'))?.mode === 'vr', 'user.pose streaming', 10_000);

      const start = (await scene()).entities[boxId].transform.position;
      await simDrag(page, await spacePos(page, boxId), [0, 0.15, 0.1]);
      const moved = await until(async () => {
        const p = (await scene()).entities[boxId].transform.position;
        return Math.abs(p[1] - start[1]) > 0.08 ? p : null;
      }, 'the server to see the VR grab', 10_000);
      expect(moved[2] - start[2]).toBeGreaterThan(0.05);
      expect((await http.post<{ ok: boolean }>('/api/scene/undo')).ok).toBe(true);
      const back = (await scene()).entities[boxId].transform.position;
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(start[i], 4);

      // Leave VR, enter AR (emulated passthrough): the floor grid hides, then comes back.
      await page.evaluate(() => window.__evol!.client.xr.exit());
      await page.waitForFunction(() => window.__evol!.state().mode === 'inline', undefined, { timeout: 10_000 });
      const arOk = await page.evaluate(() => window.__evol!.client.xr.supported.ar);
      if (arOk) {
        // requestSession needs user activation: a page click completes the parked switch.
        await page.evaluate(() => window.__evol!.sim.command('session.mode', { mode: 'ar' }));
        await page.mouse.click(500, 300);
        await page.waitForFunction(() => window.__evol!.state().mode === 'ar', undefined, { timeout: 15_000 });
        expect(await page.evaluate(() => window.__evol!.runtime.environment.grid)).toBe(false);
        await page.evaluate(() => window.__evol!.client.xr.exit());
        await page.waitForFunction(() => window.__evol!.state().mode === 'inline', undefined, { timeout: 10_000 });
        expect(await page.evaluate(() => window.__evol!.runtime.environment.grid)).toBe(true);
      } else {
        console.warn('[e2e] IWER reports no immersive-ar support: AR grid check skipped');
      }
    } finally {
      await page.close();
    }
  }, 120_000);

  it('2c. runtime heartbeat ↔ server: a silent connection is probed with ping and the pong is consumed', async () => {
    const ws = srv.url.replace(/^http/, 'ws') + '/ws';
    const nc = new NetClient(ws, 'desktop', { heartbeat: { probeMs: 400, timeoutMs: 30_000, stallMs: 30_000 } });
    const seen: string[] = [];
    nc.onMessage((m) => { if (m.type === 'command' || m.type === 'agent.message') seen.push(JSON.stringify(m)); });
    try {
      await until(() => nc.ready, 'NetClient hello', 10_000);
      await until(() => (nc as unknown as { pongSeen: boolean }).pongSeen, 'a pong for the heartbeat probe', 10_000);
      await sleep(1500); // a few more probe cycles
      expect(nc.connected).toBe(true);
      expect(seen, 'pong / ping errors must not reach listeners').toEqual([]);
    } finally {
      nc.close();
    }
  }, 30_000);

  // ------------------------------------------------------------------ 3. links
  let sliderId = '';
  let numberId = '';
  it('3. linking: slider.value → number.value (channel input and a sim drag on the knob)', async () => {
    sliderId = /spawned (\S+)/.exec(textOf(await call('spawn', { widget: 'slider', name: 'e2e slider', position: [0.45, 1.35, -0.55], props: { label: 'gain', min: 0, max: 1, value: 0.25 } })))![1];
    numberId = /spawned (\S+)/.exec(textOf(await call('spawn', { widget: 'number', name: 'e2e number', position: [0.45, 1.22, -0.55], props: { label: 'gain', precision: 2 } })))![1];
    const linked = textOf(await call('link', { from: `${sliderId}.value`, to: `${numberId}.value` }));
    expect(linked).toMatch(/link/i);
    // A channel drives the slider's `value` input (input → re-emitted on `value` → number).
    await call('link', { from: '#e2e.gain', to: `${sliderId}.value` });

    const page = await newPage('?role=desktop', { waitEntity: numberId });
    const shown = () => page.evaluate((id) => {
      const t = window.__evol!.runtime.entityObject(id)?.getObjectByName('value') as unknown as { text?: string } | undefined;
      return t?.text ?? '';
    }, numberId);
    try {
      await page.waitForFunction((id) => !!window.__evol!.runtime.entityObject(id)?.getObjectByName('knob'), sliderId, { timeout: 20_000 });
      await http.put('/api/channels/e2e.gain', 0.8);
      await until(async () => Number.parseFloat(await shown()) === 0.8, `number to show 0.80 (shows "${await shown()}")`, 10_000);

      // Drag the knob left by 0.1 m on a 0.28 m track → ~0.45.
      const knob = await spacePos(page, sliderId, 'knob');
      await simDrag(page, knob, [-0.1, 0, 0]);
      const v = await until(async () => {
        const n = Number.parseFloat(await shown());
        return Number.isFinite(n) && n < 0.75 ? n : null;
      }, `number to follow the slider drag (shows "${await shown()}")`, 10_000);
      expect(v).toBeGreaterThan(0.2);
      expect(v).toBeLessThan(0.7);
      // The slider persisted the dragged value on the server (throttled setProps).
      await until(async () => Math.abs(((await scene()).entities[sliderId].props.value as number) - v) < 0.02, 'slider value persisted', 10_000);

      const png = await http.png({ view: { kind: 'camera', position: [0.45, 1.3, -0.12], lookAt: [0.45, 1.29, -0.55] }, width: 800, height: 600 });
      saveShot('03-link-slider-number.png', png);
      expectNonUniform(png, 'link screenshot');
    } finally {
      await page.close();
    }
  }, 120_000);

  // ------------------------------------------------------------------ 4. voice routing → channel
  it('4. voice routing: "undo" is fast-path, "make the cube red" reaches Claude as a channel event', async () => {
    const before = await http.get<{ next: number }>('/api/events?since=0&types=voice.utterance');
    const undo = await http.post<{ route: string; command?: string }>('/api/voice/simulate', { text: 'undo' });
    expect(undo.route).toBe('fastpath');
    expect(undo.command).toBe('undo');
    const ev = await until(async () => (await http.get<{ events: Array<{ data: Record<string, unknown> }> }>(`/api/events?since=${before.next}&types=voice.utterance`))
      .events.find((e) => e.data.run === 'undo'), 'voice.utterance for undo', 5000);
    expect(ev.data.error).toBeUndefined();

    const ask = await http.post<{ route: string }>('/api/voice/simulate', { text: 'make the cube red', context: { focus: { right: { entity: boxId } } } });
    expect(ask.route).toBe('agent');
    const n = await until(() => notifications.find((x) => x.method === CHANNEL_METHOD && (x.params as { content?: string }).content === 'make the cube red'),
      'the bridge to push notifications/claude/channel', 30_000);
    const meta = (n.params as { meta: Record<string, string> }).meta;
    expect(meta.kind).toBe('voice');
    expect(meta.simulated).toBe('true');
    expect(meta.target).toBe(boxId);
    expect(meta.target_name).toBe('e2e box');
    for (const k of Object.keys(meta)) expect(k).toMatch(/^[A-Za-z0-9_]+$/);
  }, 60_000);

  // ------------------------------------------------------------------ 5. pose recording
  it('5. pose recording: sim hands hold a fist → a PoseDef file is written (temp library)', async () => {
    const page = await newPage(''); // default role xr → primary (no headset connected)
    const name = `e2e-fist-${Date.now().toString(36)}`;
    const file = path.join(srv.libraryDir, 'poses', `${name}.json`);
    try {
      await until(async () => (await page.evaluate(() => window.__evol!.state().primary)) === true, 'the page to become primary', 10_000);
      const fist = { hand: 'right', position: [0.18, 1.15, -0.35], curl: { index: 0.95, middle: 0.95, ring: 0.95, pinky: 0.9 }, thumb: 'wrap' };
      // Keep re-asserting the simulated hand while recording (nothing clears it, but be explicit).
      await page.evaluate((f) => window.__evol!.sim.setHands(f as never), fist);
      const pose = await http.post<PoseDef>('/api/gestures/record', { name, hand: 'right', seconds: 1, countdown: 0, description: 'e2e synthetic fist' });
      expect(pose.id).toBe(name);
      expect(pose.source).toBe('recorded');
      expect(existsSync(file)).toBe(true);
      const saved = JSON.parse(readFileSync(file, 'utf8')) as PoseDef;
      expect(saved.id).toBe(name);
      const curl = saved.conditions.find((c) => c.feature === 'curl.index');
      expect(curl?.min ?? 0, JSON.stringify(saved.conditions)).toBeGreaterThan(0.5);
      // The real library is untouched.
      expect(existsSync(path.join(ROOT, 'library', 'poses', `${name}.json`))).toBe(false);
      // The gesture watcher picks the new file up.
      await until(async () => (await http.get<{ poses: PoseDef[] }>('/api/gestures')).poses.some((p) => p.id === name), 'the new pose to load', 10_000);
    } finally {
      await page.evaluate(() => window.__evol!.sim.clearHands()).catch(() => {});
      await page.close();
      rmSync(file, { force: true });
    }
    expect(readdirSync(path.join(ROOT, 'library', 'poses')).filter((f) => f.startsWith('e2e-'))).toEqual([]);
  }, 60_000);

  // ------------------------------------------------------------------ 6. status hooks
  it('6. Claude Code status hooks drive /api/agent/status; fast exit when the server is down', async () => {
    const hook = path.join(ROOT, 'scripts', 'hooks', 'status.mjs');
    const run = (event: string, input: Record<string, unknown>, url: string) => new Promise<{ code: number | null; ms: number; out: string }>((resolve) => {
      const t0 = Date.now();
      const p = spawn(process.execPath, [hook, event], { cwd: ROOT, env: { ...process.env, EVOL_URL: url }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', (code) => resolve({ code, ms: Date.now() - t0, out }));
      p.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'e2e', cwd: ROOT, ...input }));
    });
    const status = async () => (await http.get<{ status: { state: string; detail?: string } }>('/api/agent/status')).status;

    let r = await run('UserPromptSubmit', { prompt: 'please tidy the e2e scene' }, srv.url);
    expect(r.code).toBe(0);
    expect(r.out).toBe(''); // stdout would be injected into Claude's context
    expect(await status()).toMatchObject({ state: 'thinking' });
    expect((await status()).detail).toContain('tidy the e2e scene');

    r = await run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, srv.url);
    expect(r.code).toBe(0);
    expect(await status()).toMatchObject({ state: 'working' });
    expect((await status()).detail).toContain('npm test');

    r = await run('Stop', {}, srv.url);
    expect(r.code).toBe(0);
    expect((await status()).state).toBe('idle');

    const dead = `http://127.0.0.1:${await freePort()}`;
    r = await run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, dead);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500); // 400 ms hard deadline + node start-up
  }, 60_000);

  // ------------------------------------------------------------------ 7. interp
  it('7. interp: interp-toy source → resid-lens prefab renders, lens layer control updates the readout', async () => {
    // A clean stage for the screenshots: the earlier steps' entities would stand in front of the rig.
    await call('remove', { id: [boxId, sliderId, numberId].filter(Boolean) });
    const start = await http.post<{ running: boolean }>('/api/sources/interp-toy/start');
    expect(start.running).toBe(true);
    try {
      type Meta = { model: string; short_name?: string; layers: string[]; tokens: unknown[]; sample: { total: number } };
      const meta = await until(async () => {
        const r = await fetch(`${srv.url}/api/channels/interp.meta`);
        return r.ok ? ((await r.json()) as Meta) : null;
      }, 'interp.meta (toy model start-up)', 120_000, 500);
      expect(meta.layers[0]).toBe('embed');
      expect(meta.model).not.toMatch(/[\\/]/); // a name, not a checkpoint path
      await until(async () => (await fetch(`${srv.url}/api/channels/interp.resid.proj`)).ok, 'interp.resid.proj', 30_000);

      const inst = await http.post<{ ids: Record<string, string> }>('/api/prefabs/resid-lens/instantiate', {});
      const residId = inst.ids.resid;
      expect(residId).toBeTruthy();
      // Loading the prefab must not overwrite the producer's controls.
      await sleep(1500);

      const png = await http.png({ view: { kind: 'entity', entity: residId }, width: 1200, height: 900 });
      saveShot('07-interp-resid-flow.png', png);
      expectNonUniform(png, 'resid-flow screenshot');

      type Readout = { layer: number | string; token: number; title: string; items: Array<{ label: string; value: unknown }> };
      const readout = () => fetch(`${srv.url}/api/channels/interp.lens.readout`).then((r) => (r.ok ? (r.json() as Promise<Readout>) : null));
      const first = await until(readout, 'interp.lens.readout', 30_000);
      const target = first.layer === 1 || first.layer === meta.layers[1] ? 2 : 1;
      await http.put('/api/channels/interp.ctl.layer', target);
      const next = await until(async () => {
        const r = await readout();
        return r && (r.layer === target || r.layer === meta.layers[target]) ? r : null;
      }, `the readout to switch to layer ${target}`, 30_000);
      expect(next.items.length).toBeGreaterThan(0);
      expect(next.title).toContain(meta.layers[target]);

      // The lens follows (layer slider + resid-flow follow interp.ctl.layer): shoot again.
      await sleep(800);
      const png2 = await http.png({ view: { kind: 'entity', entity: residId }, width: 1200, height: 900 });
      saveShot('07-interp-resid-flow-layer.png', png2);
      expectNonUniform(png2, 'resid-flow screenshot (layer changed)');
    } finally {
      await http.post('/api/sources/interp-toy/stop').catch(() => {});
    }
    const st = await http.get<{ running: boolean; pid?: number }>('/api/sources/interp-toy');
    expect(st.running).toBe(false);
  }, 240_000);

  it('cleanup: the test server releases its port', async () => {
    try { await browser?.close(); } finally { browser = null; }
    await mcp?.close();
    const port = srv.port;
    await srv.stop();
    expect(await portInUse(port)).toBe(false);
  }, 60_000);
});
