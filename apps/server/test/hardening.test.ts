// Regression tests for the hardening pass: origin policy, TLS cert stability,
// workspace safety, store normalization/undo robustness, prefab link ids,
// pose-recording reconnects, stale event cursors, Windows source spawning and
// orphan reaping, malformed user.pose, widget ETags, voice/mirror wiring.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import type { SceneOp, Prefab } from '@evolspace/protocol';
import { createOriginPolicy } from '../src/http/origin.ts';
import { classify, lanInterfaces } from '../src/net/lan.ts';
import { headsetIpsFrom, regenerateReason, sansFor } from '../src/net/tls.ts';
import { SceneStore } from '../src/scene/store.ts';
import { planPrefab } from '../src/scene/prefabs.ts';
import { sanitizeScene } from '../src/scene/sanitize.ts';
import { PoseRecorder } from '../src/gestures/recorder.ts';
import { EventLog } from '../src/events.ts';
import { SourceSupervisor } from '../src/sources/supervisor.ts';
import { quoteWinArg, withWindowsShell } from '../src/sources/process.ts';
import { debounce } from '../src/util/timing.ts';
import { ScreenshotRequestError } from '../src/mirror/index.ts';
import type { VoiceDeps } from '../src/voice/index.ts';
import { silentLogger } from '../src/log.ts';
import { startTestServer, TestClient, api, makeLibrary, staticCatalog, tempDir, rmDir, until, writeFiles, type TestServer } from './helpers.ts';

const fakeReq = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Raw request (fetch can't set Origin). */
function rawRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('origin policy', () => {
  const policy = createOriginPolicy({ extraOrigins: ['https://allowed.example'] });
  it('allows non-browser clients, same origin, loopback and configured origins', () => {
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787' }))).toBe(true);
    const lan = lanInterfaces()[0]?.address ?? '127.0.0.1'; // headset → this machine's LAN address
    expect(policy.allowed(fakeReq({ host: `${lan}:8443`, origin: `https://${lan}:8443` }))).toBe(true);
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'http://localhost:5173' }))).toBe(true);
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }))).toBe(true);
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'https://allowed.example' }))).toBe(true);
    expect(policy.corsOrigin(fakeReq({ host: '127.0.0.1:8787', origin: 'http://localhost:5173' }))).toBe('http://localhost:5173');
  });
  it('refuses foreign, null and non-http origins', () => {
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'https://evil.example' }))).toBe(false);
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'null' }))).toBe(false);
    expect(policy.allowed(fakeReq({ host: '127.0.0.1:8787', origin: 'chrome-extension://abc' }))).toBe(false);
    // DNS rebinding: attacker domain resolving to 127.0.0.1 still carries its own origin.
    expect(policy.allowed(fakeReq({ host: 'rebind.evil.example:8787', origin: 'http://rebind.evil.example:8787' }))).toBe(false);
    expect(policy.allowed(fakeReq({ host: 'rebind.evil.example:8787' }))).toBe(false); // no Origin on simple GETs
    expect(policy.allowed(fakeReq({ host: `${os.hostname()}.local:8443`, origin: `https://${os.hostname()}.local:8443` }))).toBe(true);
    expect(createOriginPolicy({ extraOrigins: ['*'] }).allowed(fakeReq({ host: 'anything', origin: 'https://evil.example' }))).toBe(true);
    expect(policy.corsOrigin(fakeReq({ host: '127.0.0.1:8787', origin: 'https://evil.example' }))).toBeNull();
  });
});

describe('LAN classification and TLS cert reuse', () => {
  const wifi = classify('192.168.1.69', 'Wi-Fi');
  const wsl = classify('172.26.16.1', 'vEthernet (WSL)');
  const linkLocal = classify('169.254.134.148', 'Ethernet 4');
  const meta = { ips: ['127.0.0.1', '192.168.1.69', '169.254.134.148'], hostnames: ['localhost', 'pc'] };

  it('classifies physical private addresses as primary only', () => {
    expect(wifi.primary).toBe(true);
    expect(wsl.primary).toBe(false);
    expect(linkLocal.primary).toBe(false);
    const sorted = lanInterfaces({
      'Ethernet 4': [{ address: '169.254.134.148', family: 'IPv4', internal: false } as never],
      'vEthernet (WSL)': [{ address: '172.26.16.1', family: 'IPv4', internal: false } as never],
      'Wi-Fi': [{ address: '192.168.1.69', family: 'IPv4', internal: false } as never],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    }).map((a) => a.address);
    expect(sorted).toEqual(['192.168.1.69', '172.26.16.1', '169.254.134.148']);
  });

  it('does not regenerate when only virtual/link-local adapters changed', () => {
    expect(regenerateReason(meta, [wifi, wsl, classify('169.254.9.9', 'Ethernet 4')], ['localhost', 'pc'], 300)).toBe('');
  });
  it('regenerates for a new primary address, hostname change or expiry', () => {
    expect(regenerateReason(meta, [classify('10.0.0.5', 'Wi-Fi')], ['localhost', 'pc'], 300)).toMatch(/10\.0\.0\.5/);
    expect(regenerateReason(meta, [wifi], ['localhost', 'other'], 300)).toMatch(/hostname/);
    expect(regenerateReason(meta, [wifi], ['localhost', 'pc'], 3)).toMatch(/expires/);
  });
  it('keeps earlier addresses in new certs and shows primary headset URLs', () => {
    expect(sansFor([classify('10.0.0.5', 'Wi-Fi')], meta.ips)).toEqual(['127.0.0.1', '10.0.0.5', '192.168.1.69', '169.254.134.148']);
    expect(headsetIpsFrom([wifi, wsl, linkLocal])).toEqual(['192.168.1.69']);
    expect(headsetIpsFrom([wsl, linkLocal])).toEqual(['172.26.16.1']);
  });
});

describe('debounce maxWait', () => {
  it('fires during a continuous burst', async () => {
    let n = 0;
    const d = debounce(() => { n++; }, 40, 100);
    const end = Date.now() + 260;
    while (Date.now() < end) { d(); await new Promise((r) => setTimeout(r, 10)); }
    expect(n).toBeGreaterThanOrEqual(2);
    d.cancel();
  });
});

describe('scene store normalization and undo robustness', () => {
  const catalog = staticCatalog([{ id: 'box', inputs: { value: { type: 'number' } }, outputs: { changed: { type: 'number' } } }]);
  const make = () => {
    const patches: SceneOp[][] = [];
    const store = new SceneStore({ catalog, onPatch: (_v, ops) => patches.push(ops) });
    return { store, patches };
  };

  it('broadcasts the normalized quaternion of an update', () => {
    const { store, patches } = make();
    const [id] = store.apply([{ op: 'add', entity: { widget: 'box' } }], { source: 'agent' }).ids;
    store.apply([{ op: 'update', id, patch: { transform: { rotation: [0, 0, 0, 2] } } }], { source: 'agent' });
    const op = patches.at(-1)![0] as Extract<SceneOp, { op: 'update' }>;
    expect(op.patch.transform!.rotation).toEqual([0, 0, 0, 1]);
    expect(store.entity(id)!.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it('normalizes link.update patches and refuses channel→channel', () => {
    const { store, patches } = make();
    const [a] = store.apply([{ op: 'add', entity: { widget: 'box' } }], { source: 'agent' }).ids;
    const [l] = store.apply([{ op: 'link.add', link: { from: { kind: 'port', entity: a, port: 'changed' }, to: { kind: 'channel', channel: 'x.y' }, transform: 'x * 2' } }], { source: 'agent' }).ids;
    store.apply([{ op: 'link.update', id: l, patch: { transform: '', to: { kind: 'channel', channel: 'x.z', extra: 1 } as never } }], { source: 'agent' });
    const op = patches.at(-1)![0] as Extract<SceneOp, { op: 'link.update' }>;
    expect(op.patch).toEqual({ transform: null, to: { kind: 'channel', channel: 'x.z' } });
    expect(store.scene.links[l].transform).toBeUndefined();
    expect(() => store.apply([{ op: 'link.update', id: l, patch: { from: { kind: 'channel', channel: 'q' } } }], { source: 'agent' })).toThrow(/channel→channel/);
  });

  it('a failing inverse reports an error and clears history instead of throwing', () => {
    const { store } = make();
    const [id] = store.apply([{ op: 'add', entity: { widget: 'box' } }], { source: 'agent' }).ids;
    store.apply([{ op: 'remove', id }], { source: 'agent', record: false }); // unrecorded change desyncs history
    const v = store.version;
    const r = store.undo();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/undo failed/);
    expect(store.version).toBe(v);
    expect(store.canUndo || store.canRedo).toBe(false);
  });
});

describe('prefabs', () => {
  it('ignores link ids in prefab files (no collision on the second instance)', () => {
    const catalog = staticCatalog([{ id: 'box', inputs: { value: { type: 'number' } }, outputs: { changed: { type: 'number' } } }]);
    const store = new SceneStore({ catalog });
    const prefab = {
      description: 'pair',
      entities: [{ id: 'a', widget: 'box' }, { id: 'b', widget: 'box' }],
      links: [{ id: 'fixed', from: { kind: 'port', entity: 'a', port: 'changed' }, to: { kind: 'port', entity: 'b', port: 'value' } }],
    } as unknown as Prefab;
    for (let i = 0; i < 2; i++) store.apply(planPrefab(prefab, {}, (x) => x in store.scene.entities).ops, { source: 'agent' });
    expect(Object.keys(store.scene.links)).toHaveLength(2);
  });
});

describe('sanitizeScene', () => {
  it('repairs hand-edited workspace content', () => {
    const r = sanitizeScene({
      ok: { widget: 'box', parent: null, props: { a: 1 }, transform: { position: [1, 2, 3] }, visible: true },
      nowidget: { props: {} },
      orphan: { widget: 'box', parent: 'gone' },
      c1: { widget: 'box', parent: 'c2' },
      c2: { widget: 'box', parent: 'c1' },
      badtf: { widget: 'box', transform: { position: 'nope' } },
    }, {
      l1: { from: { kind: 'port', entity: 'ok', port: 'x' }, to: { kind: 'channel', channel: 'a.b' } },
      l2: { from: { kind: 'port', entity: 'nowidget', port: 'x' }, to: { kind: 'channel', channel: 'a.b' } },
    });
    expect(Object.keys(r.entities).sort()).toEqual(['badtf', 'c1', 'c2', 'ok', 'orphan']);
    expect(r.entities.ok.transform).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(r.entities.orphan.parent).toBeNull();
    expect([r.entities.c1.parent, r.entities.c2.parent]).toContain(null);
    expect(r.entities.badtf.transform.position).toEqual([0, 0, 0]);
    expect(Object.keys(r.links)).toEqual(['l1']);
    expect(r.links.l1.enabled).toBe(true);
    expect(r.problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe('pose recorder reconnects', () => {
  const derive = async () => ({ derivePose: (_s: unknown[], o: { id: string; hand: 'left' | 'right' | 'either' }) => ({ id: o.id, description: '', hand: o.hand, conditions: [{ feature: 'curl.index', min: 0 }], source: 'recorded' as const }) });
  let dir: string;
  beforeAll(() => { dir = tempDir('evol-rec-'); });
  afterAll(() => rmDir(dir));

  it('accepts the recording from the reconnected headset (new client id)', async () => {
    const sent: Array<{ id: string; requestId: string }> = [];
    const rec = new PoseRecorder({ posesDir: dir, primaryClient: () => 'c-1', send: (id, m) => { if (m.type === 'pose.record') sent.push({ id, requestId: m.requestId }); }, loadInput: derive, reconnectGraceMs: 2000 });
    const p = rec.record({ name: 'wave', hand: 'right', seconds: 0.5, countdown: 0 });
    await until(() => sent.length > 0);
    // Another client can't answer while the requester is connected…
    expect(rec.onRecording('c-x', { requestId: sent[0].requestId, hand: 'right', frames: [{ 'curl.index': 1 }] })).toBe(false);
    rec.onDisconnect('c-1');
    expect(rec.onRecording('c-2', { requestId: sent[0].requestId, hand: 'right', frames: [{ 'curl.index': 1 }] })).toBe(true);
    expect((await p).id).toBe('wave');
    expect(existsSync(path.join(dir, 'wave.json'))).toBe(true);
  });

  it('fails after the grace period if the headset never returns', async () => {
    const rec = new PoseRecorder({ posesDir: dir, primaryClient: () => 'c-1', send: () => {}, loadInput: derive, reconnectGraceMs: 50 });
    const p = rec.record({ name: 'gone', hand: 'left', seconds: 0.5, countdown: 0 });
    await new Promise((r) => setTimeout(r, 20));
    rec.onDisconnect('c-1');
    await expect(p).rejects.toThrow(/did not come back/);
  });

  it('derives and saves from pre-sampled frames without a headset', async () => {
    const rec = new PoseRecorder({ posesDir: dir, primaryClient: () => null, send: () => { throw new Error('no round trip expected'); }, loadInput: derive });
    const pose = await rec.record({ name: 'desk-fist', hand: 'right', frames: [{ 'curl.index': 0.9 }, { 'curl.index': 0.95 }] });
    expect(pose).toMatchObject({ id: 'desk-fist', hand: 'right', source: 'recorded' });
    expect(existsSync(path.join(dir, 'desk-fist.json'))).toBe(true);
    await expect(rec.record({ name: 'bad', hand: 'right', frames: [] })).rejects.toThrow(/non-empty array/);
    await expect(rec.record({ name: 'bad', hand: 'right', frames: [{ 'curl.index': 'x' }] as never })).rejects.toThrow(/feature objects/);
  });
});

describe('event cursors from a previous server run', () => {
  it('rebases a cursor beyond the head so callers see the reset at once', async () => {
    const log = new EventLog();
    log.emit('client.log', { n: 1 });
    log.emit('agent.ask', { text: 'hi' });
    const page = log.query({ since: 5000 });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.next).toBe(2);
    const t0 = Date.now();
    const waited = await log.wait({ since: 5000, types: ['agent.ask'] }, 2000);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(waited.events).toHaveLength(1);
  });
});

describe('Windows shell handling for sources', () => {
  it('wraps .cmd/.bat and npm shims in a quoted command line', () => {
    const base = { cwd: 'C:\\x', env: {} };
    expect(withWindowsShell({ ...base, command: 'npx', args: ['tsx', 'a b.ts'] }, 'win32')).toMatchObject({ command: 'npx tsx "a b.ts"', args: [], shell: true });
    expect(withWindowsShell({ ...base, command: 'C:\\tools\\run.cmd', args: ['x"y'] }, 'win32')).toMatchObject({ command: 'C:\\tools\\run.cmd "x""y"', shell: true });
    expect(withWindowsShell({ ...base, command: 'C:\\py\\python.exe', args: ['-m', 'x'] }, 'win32').shell).toBeUndefined();
    expect(withWindowsShell({ ...base, command: 'npx', args: [] }, 'linux').shell).toBeUndefined();
    expect(quoteWinArg('')).toBe('""');
    expect(quoteWinArg('plain')).toBe('plain');
  });

  it.runIf(process.platform === 'win32')('runs a .cmd source with arguments', async () => {
    const dir = tempDir('evol-cmd-');
    writeFiles(dir, {
      'sources/batch/source.json': JSON.stringify({ description: 'batch', command: './hello.cmd', args: ['a b'], restart: false }),
      'sources/batch/hello.cmd': '@echo hello %~1\r\n',
    });
    const sup = new SourceSupervisor({ sourcesDir: path.join(dir, 'sources'), repoRoot: dir, baseUrl: () => 'http://127.0.0.1:1', log: silentLogger, watch: false });
    await sup.init(false);
    sup.start('batch');
    await until(() => (sup.get('batch')?.logTail ?? []).some((l) => l.includes('hello a b')));
    await sup.close();
    rmDir(dir);
  });
});

describe('orphaned sources from a hard-killed server', () => {
  it('are killed on the next boot (pid file + image check)', async () => {
    const dir = tempDir('evol-orphan-');
    const pidFile = path.join(dir, 'data', 'sources.pids.json');
    writeFiles(dir, {
      'sources/sleeper/source.json': JSON.stringify({ description: 'sleeps', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], restart: false }),
    });
    const opts = { sourcesDir: path.join(dir, 'sources'), repoRoot: dir, baseUrl: () => 'http://127.0.0.1:1', log: silentLogger, watch: false, pidFile };
    const first = new SourceSupervisor(opts);
    await first.init(false);
    const pid = first.start('sleeper').pid!;
    expect(alive(pid)).toBe(true);
    expect(JSON.parse(readFileSync(pidFile, 'utf8')).sleeper.pid).toBe(pid);
    // "Hard kill" of the first server: it never runs close(). A new one boots with the same pid file.
    const second = new SourceSupervisor(opts);
    await second.init(false);
    await until(() => !alive(pid), 10_000);
    expect(JSON.parse(readFileSync(pidFile, 'utf8'))).toEqual({});
    await first.close();
    await second.close();
    rmDir(dir);
  });

  it('leaves a reused pid alone when the image differs', async () => {
    const dir = tempDir('evol-orphan2-');
    const pidFile = path.join(dir, 'sources.pids.json');
    mkdirSync(path.join(dir, 'sources'), { recursive: true });
    // Our own test process stands in for "some unrelated process that reused the pid".
    const other = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(pidFile, JSON.stringify({ ghost: { pid: other.pid, image: 'python.exe', startedAt: 1 } }));
    const sup = new SourceSupervisor({ sourcesDir: path.join(dir, 'sources'), repoRoot: dir, baseUrl: () => 'x', log: silentLogger, watch: false, pidFile });
    await sup.init(false);
    expect(alive(other.pid!)).toBe(true);
    other.kill();
    await sup.close();
    rmDir(dir);
  });
});

describe('server integration (hardening)', () => {
  let srv: TestServer;
  let voiceDeps: VoiceDeps | null = null;
  let mirrorError: Error | null = null;

  beforeAll(async () => {
    const lib = makeLibrary();
    writeFiles(lib, {
      'prefabs/pair.json': JSON.stringify({ description: 'pair', entities: [{ id: 'a', widget: 'box' }, { id: 'b', widget: 'box' }], links: [{ id: 'l-fixed', from: { kind: 'port', entity: 'a', port: 'changed' }, to: { kind: 'port', entity: 'b', port: 'value' } }] }),
    });
    srv = await startTestServer({
      lib,
      overrides: {
        createVoice: (deps) => {
          voiceDeps = deps;
          return { onBegin() {}, onAudio() {}, onEnd() {}, simulate: async () => ({ route: 'none' as const }), commands: () => [], close: async () => {} };
        },
        startMirror: async () => ({
          screenshot: async () => { if (mirrorError) throw mirrorError; return Buffer.from('89504e470d0a1a0a', 'hex'); },
          thumbnail: async () => { if (mirrorError) throw mirrorError; return Buffer.from('89504e470d0a1a0a', 'hex'); },
          close: async () => {},
        }),
      },
    });
  });
  afterAll(async () => { await srv?.close(); });

  it('refuses browser requests and WebSocket upgrades from foreign origins', async () => {
    const evil = await rawRequest(`${srv.url}/api/command`, 'POST', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, JSON.stringify({ name: 'agent.ask', args: { text: 'rm -rf' } }));
    expect(evil.status).toBe(403);
    const asks = (await api(srv.url, 'GET', '/api/events?types=agent.ask')).body.events;
    expect(asks).toHaveLength(0);
    const local = await rawRequest(`${srv.url}/api/health`, 'GET', { Origin: 'http://localhost:5173' });
    expect(local.status).toBe(200);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const plain = await rawRequest(`${srv.url}/api/health`, 'GET', {});
    expect(plain.status).toBe(200);
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();

    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(srv.wsUrl, { origin: 'https://evil.example' });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
      ws.on('error', () => resolve('error'));
    });
    expect(refused).toMatch(/403|error/);
    const ok = new WebSocket(srv.wsUrl, { origin: `http://127.0.0.1:${srv.app.httpPort}` });
    await new Promise((r, j) => { ok.once('open', r); ok.once('error', j); });
    ok.close();
  });

  it('workspace new refuses to overwrite an existing workspace', async () => {
    expect((await api(srv.url, 'POST', '/api/workspaces/keep/new')).status).toBe(200);
    await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { id: 'kept', widget: 'box' } }] });
    expect((await api(srv.url, 'POST', '/api/workspaces/keep/save')).status).toBe(200);
    expect((await api(srv.url, 'POST', '/api/workspaces/other/new')).status).toBe(200);
    const again = await api(srv.url, 'POST', '/api/workspaces/keep/new');
    expect(again.status).toBe(409);
    expect((await api(srv.url, 'POST', '/api/workspaces/keep/load')).status).toBe(200);
    expect(srv.app.services.store.entity('kept')).toBeDefined();
  });

  it('instantiates a prefab with link ids twice', async () => {
    expect((await api(srv.url, 'POST', '/api/prefabs/pair/instantiate', {})).status).toBe(200);
    const second = await api(srv.url, 'POST', '/api/prefabs/pair/instantiate', {});
    expect(second.status).toBe(200);
  });

  it('ignores malformed user.pose instead of breaking /api/user', async () => {
    const xr = await TestClient.connect(srv.wsUrl, { role: 'xr' });
    xr.send({ type: 'user.pose', pose: { t: 1, mode: 'vr', hands: {} } }); // no head
    await until(async () => (await api(srv.url, 'GET', '/api/events?types=client.log')).body.events.some((e: { data: { message: string } }) => /user\.pose ignored/.test(e.data.message)));
    const u = await api(srv.url, 'GET', '/api/user');
    expect(u.status).toBe(200);
    expect(u.body).toBeNull();
    xr.send({ type: 'user.pose', pose: { t: 2, mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, hands: {} } });
    await until(async () => (await api(srv.url, 'GET', '/api/user')).body !== null);
    await xr.close();
  });

  it('serves widget bundles with ETag revalidation', async () => {
    const m = srv.app.services.widgets.manifest('box')!;
    const first = await fetch(`${srv.url}${m.url}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${srv.url}${m.url}`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
  });

  it('gives voice readable entity descriptions', async () => {
    await api(srv.url, 'POST', '/api/scene/ops', { ops: [{ op: 'add', entity: { id: 'named', name: 'Seattle weather', widget: 'box' } }] });
    expect(voiceDeps!.describeEntity!('named')).toEqual({ name: 'Seattle weather', widget: 'box' });
    expect(voiceDeps!.describeEntity!('nope')).toBeUndefined();
  });

  it('maps invalid screenshot requests to 400 and renderer failures to 502', async () => {
    mirrorError = new ScreenshotRequestError('invalid screenshot request: width must be 16..4096');
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'camera', position: [0, 1, 1] }, width: 9 })).status).toBe(400);
    mirrorError = new Error('browser crashed');
    expect((await api(srv.url, 'POST', '/api/screenshot', { view: { kind: 'camera', position: [0, 1, 1] } })).status).toBe(502);
    mirrorError = null;
  });

  it('reports undo results', async () => {
    const r = await api(srv.url, 'POST', '/api/scene/undo');
    expect(r.status).toBe(200);
    expect(typeof r.body.ok).toBe('boolean');
  });
});

describe('workspace files on boot', () => {
  it('moves an unreadable workspace aside instead of overwriting it', async () => {
    const data = tempDir('evol-data-');
    writeFiles(data, { 'state.json': JSON.stringify({ lastWorkspace: 'main' }), 'workspaces/main.json': '{ broken json' });
    const srv = await startTestServer({ data });
    try {
      expect(srv.app.services.store.workspace).toBe('main');
      expect(Object.keys(srv.app.services.store.scene.entities)).toHaveLength(0);
      const files = readdirSync(path.join(data, 'workspaces'));
      const backup = files.find((f) => f.startsWith('main.json.corrupt-'));
      expect(backup).toBeDefined();
      expect(readFileSync(path.join(data, 'workspaces', backup!), 'utf8')).toBe('{ broken json');
    } finally {
      await srv.close();
      rmDir(data);
    }
  });

  it('repairs hand-edited entities when loading', async () => {
    const data = tempDir('evol-data-');
    writeFiles(data, {
      'state.json': JSON.stringify({ lastWorkspace: 'hand' }),
      'workspaces/hand.json': JSON.stringify({ format: 1, workspace: 'hand', entities: { b1: { widget: 'box', parent: 'ghost' } }, links: { l1: { from: { kind: 'port', entity: 'ghost', port: 'x' }, to: { kind: 'channel', channel: 'a' } } } }),
    });
    const srv = await startTestServer({ data });
    try {
      const e = srv.app.services.store.entity('b1')!;
      expect(e.parent).toBeNull();
      expect(e.transform.scale).toEqual([1, 1, 1]);
      expect(e.visible).toBe(true);
      expect(srv.app.services.store.scene.links).toEqual({});
    } finally {
      await srv.close();
      rmDir(data);
    }
  });
});
