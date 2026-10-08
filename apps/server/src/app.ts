// Composition root: builds every service, wires callbacks (scene → broadcast,
// library watchers → broadcast, bus → subscribers) and owns the HTTP/HTTPS
// servers. main.ts adds env config + signals; tests call createApp() directly
// with temp dirs and random ports.
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { OpSource, SceneOp, ServerEventType, ServerMessage } from '@evolspace/protocol';
import { libraryPaths, type ServerConfig } from './config.ts';
import { createLogger, type Logger } from './log.ts';
import { EventLog } from './events.ts';
import { SceneStore } from './scene/store.ts';
import { Workspaces } from './scene/workspaces.ts';
import { loadPrefab, planPrefab } from './scene/prefabs.ts';
import { WidgetLibrary } from './widgets/library.ts';
import { DataBus } from './data/bus.ts';
import { WsHub } from './ws/hub.ts';
import { createHandlers } from './ws/handlers.ts';
import { AgentHub } from './agent.ts';
import { CommandRegistry, registerBuiltinCommands } from './commands.ts';
import { GestureLibrary } from './gestures/library.ts';
import { PoseRecorder } from './gestures/recorder.ts';
import { loadInput } from './gestures/input.ts';
import { UserState } from './user.ts';
import { SourceSupervisor } from './sources/supervisor.ts';
import { Router, sendJson } from './http/router.ts';
import { createClientApp, type ClientApp } from './http/client-app.ts';
import { createOriginPolicy } from './http/origin.ts';
import { ensureCert, type TlsMaterial } from './net/tls.ts';
import { sceneRoutes } from './routes/scene.ts';
import { widgetRoutes } from './routes/widgets.ts';
import { channelRoutes } from './routes/channels.ts';
import { systemRoutes } from './routes/system.ts';
import { atomicWrite } from './util/fs.ts';
import { startMirror, type Mirror, type MirrorDeps } from './mirror/index.ts';
import { createVoice, type VoiceDeps, type VoiceService } from './voice/index.ts';
import type { Services } from './services.ts';

export interface AppOverrides {
  log?: Logger;
  /** Replace the mirror (tests). */
  startMirror?: (deps: MirrorDeps) => Promise<Mirror>;
  createVoice?: (deps: VoiceDeps) => VoiceService;
  /** Replace @evolspace/input (tests). */
  loadInput?: typeof loadInput;
  /** Pre-generated TLS material (tests) instead of certs/ caching. */
  tls?: Pick<TlsMaterial, 'key' | 'cert'>;
  workspaceDebounceMs?: number;
  sourceBackoffMs?: number;
}

export interface RunningApp {
  services: Services;
  httpPort: number;
  httpsPort: number | null;
  /** LAN URLs for the headset. */
  headsetUrls: string[];
  tls: TlsMaterial | null;
  stop(): Promise<void>;
}

/** Sources whose scene.changed events are throttled (high-frequency interactive edits). */
const THROTTLED_SOURCES = new Set(['user', 'widget']);

export async function startApp(config: ServerConfig, ov: AppOverrides = {}): Promise<RunningApp> {
  const log = ov.log ?? createLogger();
  const paths = libraryPaths(config.libraryDir);
  mkdirSync(config.dataDir, { recursive: true });

  const events = new EventLog();
  const event = (type: ServerEventType, data: Record<string, unknown>) => { events.emit(type, data); };

  // ---------------------------------------------------------------- hub (transport only; handlers attached below)
  let handlers: ReturnType<typeof createHandlers> | null = null;
  let services!: Services;
  const hub = new WsHub({
    highWaterMark: config.wsHighWaterMark,
    serverVersion: config.serverVersion,
    log: log.child('ws'),
    onHello: (c) => {
      c.send({ type: 'scene.snapshot', scene: store.scene });
      c.send({ type: 'widgets.catalog', widgets: widgets.list() });
      const g = gestures.current;
      c.send({ type: 'gestures.defs', poses: g.poses, interactions: g.interactions });
      c.send({ type: 'agent.status', status: agent.status });
      for (const message of agent.recent().slice(-20)) c.send({ type: 'agent.message', message });
      event('client.connect', { clientId: c.id, role: c.role, primary: c.primary, ...(c.userAgent ? { userAgent: c.userAgent } : {}) });
    },
    onText: (c, m) => handlers?.onText(c, m),
    onBinary: (c, b) => handlers?.onBinary(c, b),
    onClose: (c) => {
      recorder.onDisconnect(c.id);
      try { voice.onDisconnect?.(c.id); } catch (e) { log.warn(`voice.onDisconnect failed: ${(e as Error).message}`); }
      if (c.helloed) event('client.disconnect', { clientId: c.id, role: c.role });
    },
    onPrimaryChange: (now, prev) => {
      if (prev && prev !== now) user.clear();
      log.info(`primary xr client: ${now ? now.id : 'none'}`);
    },
  });
  const broadcast = (m: ServerMessage) => { hub.broadcast(m); };

  // ---------------------------------------------------------------- scene changed (coarse) events
  const lastChanged = new Map<string, { at: number; timer: NodeJS.Timeout | null }>();
  const sceneChanged = (version: number, source: string, count: number) => {
    if (!THROTTLED_SOURCES.has(source)) { event('scene.changed', { version, source, ops: count }); return; }
    const st = lastChanged.get(source) ?? { at: 0, timer: null };
    lastChanged.set(source, st);
    const now = Date.now();
    if (now - st.at >= 1000 && !st.timer) { st.at = now; event('scene.changed', { version, source, ops: count }); return; }
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null; st.at = Date.now();
        event('scene.changed', { version: store.version, source, ops: count });
      }, Math.max(0, 1000 - (now - st.at)));
    }
  };

  // ---------------------------------------------------------------- widgets
  const widgets = new WidgetLibrary({
    libraryDir: config.libraryDir,
    log: log.child('widgets'),
    watch: config.watch,
    onUpdated: (widget) => broadcast({ type: 'widgets.updated', widget }),
    onCatalog: (all) => broadcast({ type: 'widgets.catalog', widgets: all }),
    onBuild: (e) => event('widget.build', { ...e }),
  });

  // ---------------------------------------------------------------- scene
  let workspaces!: Workspaces;
  const store = new SceneStore({
    catalog: widgets,
    onPatch: (version, ops, source) => {
      broadcast({ type: 'scene.patch', version, ops, source });
      sceneChanged(version, source, ops.length);
    },
    onReset: (scene) => broadcast({ type: 'scene.snapshot', scene }),
    // Undo deleting prop keys / save-as renaming the workspace: clients diff snapshots, so
    // re-sending the scene only touches what actually changed.
    onResync: (scene) => broadcast({ type: 'scene.snapshot', scene }),
    onChange: () => workspaces?.markDirty(),
  });
  workspaces = new Workspaces(config.dataDir, store, log.child('workspace'), ov.workspaceDebounceMs);

  // ---------------------------------------------------------------- data, agent, gestures, user
  const bus = new DataBus();
  bus.onPublish((ch, origin) => {
    for (const c of hub.clients.values()) {
      if (origin === c.id && c.capabilities.includes('no-echo')) continue;
      if (c.isSubscribed(ch.info.name)) c.sendChannel(ch);
    }
  });
  const agent = new AgentHub(broadcast);
  const gestures = new GestureLibrary({
    libraryDir: config.libraryDir,
    log: log.child('gestures'),
    watch: config.watch,
    onChange: (d) => broadcast({ type: 'gestures.defs', poses: d.poses, interactions: d.interactions }),
    // Like widget.build: every (re)load is recorded so Claude sees file problems/typos.
    onLoad: (d) => event('gestures.load', {
      ok: Object.keys(d.errors).length === 0 && Object.keys(d.warnings).length === 0,
      poses: d.poses.length,
      interactions: Object.keys(d.interactions).length,
      ...(Object.keys(d.errors).length ? { errors: d.errors } : {}),
      ...(Object.keys(d.warnings).length ? { warnings: d.warnings } : {}),
    }),
    validators: () => input().catch(() => null),
  });
  const input = ov.loadInput ?? loadInput;
  const user = new UserState(input);
  const recorder = new PoseRecorder({
    posesDir: paths.poses,
    primaryClient: () => hub.primary?.id ?? null,
    send: (id, m) => hub.send(id, m),
    loadInput: input,
  });

  // ---------------------------------------------------------------- servers
  let httpPort = config.httpPort;
  const baseUrl = () => `http://127.0.0.1:${httpPort}`;

  const sources = new SourceSupervisor({
    sourcesDir: paths.sources,
    repoRoot: config.repoRoot,
    baseUrl,
    log: log.child('sources'),
    watch: config.watch,
    onExit: (d) => event('source.exit', d),
    pidFile: path.join(config.dataDir, 'sources.pids.json'),
    ...(ov.sourceBackoffMs ? { backoffBaseMs: ov.sourceBackoffMs } : {}),
  });

  // ---------------------------------------------------------------- mirror (lazy)
  let mirrorP: Promise<Mirror> | null = null;
  let mirrorInstance: Mirror | null = null;
  const mirror = (): Promise<Mirror> => {
    if (!mirrorP) {
      const p = (ov.startMirror ?? startMirror)({
        baseUrl: baseUrl(),
        getUserPose: () => user.latest,
        widgetsDir: paths.widgets,
        log: (level, message) => log.child('mirror')[level](message),
      });
      mirrorP = p;
      p.then((m) => { mirrorInstance = m; }, () => { if (mirrorP === p) mirrorP = null; }); // allow retry after a failed start
    }
    return mirrorP;
  };

  const commands = new CommandRegistry();
  const agentAsk = (text: string, context: Record<string, unknown>) => {
    event('agent.ask', { text, context });
  };

  const applyOps = (ops: SceneOp[], source: OpSource | string, group?: string) => store.apply(ops, { source, group });

  // ---------------------------------------------------------------- voice
  const voiceDeps: VoiceDeps = {
    voiceDir: paths.voice,
    runCommand: (name, args, origin) => commands.run(name, args, { clientId: origin.clientId, origin: 'voice' }),
    agentAsk,
    say: (text, kind) => { agent.say(text, kind); },
    setAgentStatus: (state, detail) => { agent.setStatus(state, detail); },
    agentStatus: () => agent.status,
    send: (id, m) => hub.send(id, m),
    broadcast,
    event,
    vocabulary: () => vocabulary(),
    log: (level, message) => log.child('voice')[level](message),
    describeEntity: (id) => {
      const e = store.entity(id);
      return e ? { ...(e.name ? { name: e.name } : {}), widget: e.widget } : undefined;
    },
  };
  const vocabulary = (): string[] => {
    const words = new Set<string>();
    for (const id of widgets.ids()) { words.add(id); for (const part of id.split(/[-_]/)) if (part.length > 2) words.add(part); }
    for (const e of Object.values(store.scene.entities)) if (e.name) words.add(e.name);
    return [...words];
  };
  const voice = (ov.createVoice ?? createVoice)(voiceDeps);

  services = {
    config, log, events, store, workspaces, widgets, bus, hub, agent, commands, gestures, recorder, user, sources, voice,
    mirror, mirrorStatus: () => (mirrorInstance?.status ? mirrorInstance.status() : null), applyOps, agentAsk, event, baseUrl, vocabulary, paths,
    instantiatePrefab: async (id, opts, source = 'agent') => {
      const prefab = await loadPrefab(paths.prefabs, id);
      const plan = planPrefab(prefab, opts, (x) => x in store.scene.entities);
      const res = applyOps(plan.ops, source);
      return { ids: plan.ids, version: res.version };
    },
  };
  handlers = createHandlers(services);

  registerBuiltinCommands(commands, {
    store,
    undo: () => store.undo(),
    redo: () => store.redo(),
    applyOps: (ops, source) => applyOps(ops, source),
    saveWorkspace: (name) => workspaces.save(name),
    loadWorkspace: (name) => workspaces.load(name),
    newWorkspace: (name) => workspaces.create(name),
    screenshot: async () => {
      const png = await (await mirror()).screenshot({ view: { kind: 'user' } });
      const file = path.join(config.dataDir, 'screenshots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await atomicWrite(file, png);
      event('client.log', { level: 'info', kind: 'screenshot', message: `screenshot of the user's view saved to ${file}`, path: file });
      return { path: file };
    },
    broadcastToXr: (name, args) => hub.broadcast({ type: 'command', name, ...(args ? { args } : {}) }, (c) => c.role === 'xr'),
    agentAsk,
    say: (text, kind) => { agent.say(text, kind ?? 'info'); },
    restartSource: (id) => sources.restart(id),
    rebuildWidget: (id) => widgets.build(id),
    publish: (channel, value, o) => ({ seq: bus.publish(channel, value, o).seq }),
  });

  // ---------------------------------------------------------------- load library + scene
  await widgets.init();
  await gestures.init();
  await workspaces.init();

  // ---------------------------------------------------------------- HTTP plumbing
  const router = new Router();
  sceneRoutes(router, services);
  widgetRoutes(router, services);
  channelRoutes(router, services);
  systemRoutes(router, services);

  let client: ClientApp | null = null;
  // Browser requests from foreign origins are refused (see http/origin.ts): the API can
  // inject requests into Claude Code, so arbitrary web pages must not reach it.
  const origins = createOriginPolicy({ extraOrigins: config.allowedOrigins });
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!origins.allowed(req)) {
      log.warn(`refused ${req.method} ${(req.url ?? '').split('?')[0]} from foreign origin ${req.headers.origin}`);
      sendJson(res, 403, { error: `origin ${req.headers.origin} is not allowed (set EVOL_ALLOWED_ORIGINS to allow it)` });
      return;
    }
    const cors = origins.corsOrigin(req);
    if (cors) { res.setHeader('Access-Control-Allow-Origin', cors); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS' && (req.url ?? '').startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Dtype, X-Shape, X-Producer, X-Description',
        'Access-Control-Max-Age': '600',
      }).end();
      return;
    }
    router.handle(req, res).then((handled) => {
      if (handled) return;
      if ((req.url ?? '').startsWith('/api/')) { sendJson(res, 404, { error: `no route ${req.method} ${req.url?.split('?')[0]} — GET /api lists routes` }); return; }
      if (client) client.handle(req, res);
      else sendJson(res, 503, { error: 'starting' });
    }).catch((e) => {
      log.error(`request failed: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: String((e as Error).message ?? e) });
    });
  };

  const httpServer = http.createServer(onRequest);
  let tls: TlsMaterial | null = null;
  let httpsServer: https.Server | null = null;
  if (config.httpsPort !== null) {
    const material = ov.tls ?? (tls = await ensureCert(config.certsDir, log.child('tls')));
    httpsServer = https.createServer({ key: material.key, cert: material.cert }, onRequest);
  }

  const onUpgrade = (isPlain: boolean) => (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!origins.allowed(req)) {
      log.warn(`refused WebSocket upgrade from foreign origin ${req.headers.origin}`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/ws') { hub.handleUpgrade(req, socket, head); return; }
    if (client?.isHmrUpgrade(req)) {
      // Vite's HMR listener is attached to the HTTPS server (or to the HTTP one when HTTPS is off).
      if (isPlain && httpsServer) httpsServer.emit('upgrade', req, socket, head);
      return; // the Vite listener on this server handles it
    }
    socket.destroy();
  };
  httpServer.on('upgrade', onUpgrade(true));
  httpsServer?.on('upgrade', onUpgrade(false));

  client = await createClientApp({ mode: config.clientMode, clientDir: config.clientDir, hmrServer: httpsServer ?? httpServer, log: log.child('client') });

  const listen = (srv: http.Server | https.Server, port: number, host: string, label: string) =>
    new Promise<number>((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        reject(e.code === 'EADDRINUSE' ? new Error(`${label} port ${port} on ${host} is already in use — is another EvolSpace server running? (set EVOL_${label.toUpperCase()}_PORT to change it)`) : e);
      };
      srv.once('error', onErr);
      srv.listen(port, host, () => { srv.off('error', onErr); resolve((srv.address() as AddressInfo).port); });
    });

  httpPort = await listen(httpServer, config.httpPort, config.httpHost, 'http');
  let httpsPort: number | null = null;
  if (httpsServer) httpsPort = await listen(httpsServer, config.httpsPort!, config.httpsHost, 'https');

  // Sources last: they get EVOL_URL pointing at the live server.
  await sources.init(config.autostartSources);

  const headsetUrls = httpsPort === null || !tls ? [] : tls.headsetIps.map((ip) => `https://${ip}:${httpsPort}/`);

  let stopping: Promise<void> | null = null;
  const stop = () => (stopping ??= (async () => {
    log.info('shutting down…');
    for (const st of lastChanged.values()) if (st.timer) clearTimeout(st.timer);
    events.close();
    recorder.close();
    await Promise.allSettled([
      workspaces.flush().catch((e) => log.error(`final save failed: ${(e as Error).message}`)),
      sources.close(),
      widgets.close(),
      gestures.close(),
      voice.close(),
      mirrorP?.then((m) => m.close()).catch(() => {}),
    ]);
    await hub.close();
    await client?.close().catch(() => {});
    const closeSrv = (srv: http.Server | https.Server | null) => new Promise<void>((r) => {
      if (!srv) return r();
      srv.close(() => r());
      srv.closeAllConnections?.();
    });
    await Promise.all([closeSrv(httpServer), closeSrv(httpsServer)]);
  })());

  return { services, httpPort, httpsPort, headsetUrls, tls, stop };
}
