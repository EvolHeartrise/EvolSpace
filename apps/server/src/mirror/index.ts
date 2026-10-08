// Mirror: a headless Chromium running the client in mirror mode
// (<baseUrl>/?role=mirror), driven through window.__evolMirror to render
// screenshots and widget thumbnails for the agent.
//
// Lifecycle: the browser is launched once and kept alive. Captures run through
// a strict serial queue (one page, one renderer). Each capture has a timeout;
// on timeout, crash or disconnect the browser is torn down and relaunched on the
// next request (and a capture that died from a crash is retried once).
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { ScreenshotRequest, UserPose } from '@evolspace/protocol';
import type { Mirror, MirrorDeps, MirrorStatus } from './types.ts';
import { launchBestBrowser, launchCandidates, type GpuMode, type WebGlInfo } from './browser.ts';
import { SerialQueue, TimeoutError, withTimeout } from './queue.ts';
import { imageStats, pngFromDataUrl } from './png.ts';
import { assertWidgetId, normalizeRequest, THUMBNAIL_SIZE, type NormalizedRequest } from './request.ts';
import { atomicWrite } from '../util/fs.ts';

export type { Mirror, MirrorDeps, MirrorStatus };
export { imageStats, decodePng } from './png.ts';
export { ScreenshotRequestError } from './request.ts';

/** The page-side API (apps/client/src/mirror). Duplicated structurally to keep apps decoupled. */
interface PageMirrorApi {
  ready: Promise<void>;
  capture(req: ScreenshotRequest, userPose: UserPose | null, opts?: CaptureOptions): Promise<string>;
}
interface CaptureOptions {
  /** Reject instead of returning an image of the error placeholder (thumbnails). */
  failOnWidgetError?: boolean;
}
/** Page global accessor (no global augmentation: the client declares its own typed version). */
type MirrorWindow = { __evolMirror?: PageMirrorApi };

/** Captures allowed to wait in the queue (incl. the running one) before new ones are rejected. */
const MAX_QUEUED = 32;
/** Marker in the page's error when the WebGL context is gone (apps/client/src/mirror CONTEXT_LOST_ERROR). */
const CONTEXT_LOST = 'WebGL context lost';
/** Marker when the page never got its initial scene/catalog (apps/client/src/mirror NOT_READY_ERROR). */
const NOT_READY = 'mirror: not ready';

/** Playwright errors raised when the page navigates (reloads) while we evaluate in it. */
export function isNavigationError(message: string): boolean {
  return /execution context was destroyed|frame (was|got) detached|navigat(ed|ion)/i.test(message);
}

const envNum = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

export async function startMirror(deps: MirrorDeps): Promise<Mirror> {
  const mirror = new HeadlessMirror(deps);
  // Warm up in the background so the first screenshot is fast; failures are
  // logged here and retried by the first capture.
  mirror.warmUp();
  return mirror;
}

class HeadlessMirror implements Mirror {
  private readonly queue = new SerialQueue();
  private readonly captureTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly gpu: GpuMode;
  private readonly extraArgs: string[];
  private readonly pageUrl: string;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private webgl: WebGlInfo | null = null;
  private launchConfig: string | undefined;
  private closed = false;
  /** Bumped by every teardown; a start() that sees it change was cancelled (e.g. timed out). */
  private generation = 0;
  private counters = { captures: 0, failures: 0, restarts: 0, launches: 0 };
  private consoleBudget = { windowStart: 0, count: 0 };

  constructor(private readonly deps: MirrorDeps) {
    const o = deps.options ?? {};
    this.captureTimeoutMs = o.captureTimeoutMs ?? envNum('EVOL_MIRROR_TIMEOUT_MS') ?? 20_000;
    this.startupTimeoutMs = o.startupTimeoutMs ?? envNum('EVOL_MIRROR_STARTUP_TIMEOUT_MS') ?? 45_000;
    const envGpu = process.env.EVOL_MIRROR_GPU as GpuMode | undefined;
    this.gpu = o.gpu ?? (envGpu && ['auto', 'gpu', 'software'].includes(envGpu) ? envGpu : 'auto');
    this.extraArgs = o.extraArgs ?? (process.env.EVOL_MIRROR_ARGS?.split(/\s+/).filter(Boolean) ?? []);
    this.pageUrl = new URL(o.pagePath ?? '/?role=mirror', deps.baseUrl).toString();
  }

  warmUp(): void {
    void this.queue.run(() => this.ensurePage()).catch((e) => {
      this.deps.log('warn', `mirror: warm-up failed (will retry on first capture): ${errMsg(e)}`);
    });
  }

  status(): MirrorStatus {
    return {
      running: !!this.page && !this.page.isClosed(),
      webglRenderer: this.webgl?.renderer,
      software: this.webgl?.software,
      launchConfig: this.launchConfig,
      captures: this.counters.captures,
      failures: this.counters.failures,
      restarts: this.counters.restarts,
      queued: this.queue.pending,
    };
  }

  screenshot(req: ScreenshotRequest): Promise<Buffer> {
    return this.render(req, {});
  }

  private async render(req: ScreenshotRequest, opts: CaptureOptions): Promise<Buffer> {
    if (this.closed) throw new Error('mirror: closed');
    // Fail fast instead of piling up requests behind a slow/hung renderer.
    if (this.queue.pending >= MAX_QUEUED) {
      throw new Error(`mirror: busy (${this.queue.pending} captures queued); try again shortly`);
    }
    return this.queue.run(async () => {
      // Read the pose when the capture actually runs, not when it was queued.
      const pose = this.deps.getUserPose();
      const norm = normalizeRequest(req, pose);
      const t0 = Date.now();
      try {
        const png = await this.captureWithRetry(norm, pose, opts);
        this.counters.captures++;
        this.deps.log('info', `mirror: ${describeView(norm)} ${norm.width}x${norm.height} in ${Date.now() - t0} ms`);
        this.checkBlank(png, norm);
        return png;
      } catch (e) {
        this.counters.failures++;
        throw e;
      }
    });
  }

  async thumbnail(widgetId: string, props?: Record<string, unknown>): Promise<Buffer> {
    assertWidgetId(widgetId);
    const png = await this.render(
      { view: { kind: 'widget', widget: widgetId, props }, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE },
      { failOnWidgetError: true },
    );
    // Atomic (temp file + rename, Windows-safe retries): the server watches this
    // file and serves it, so it must never be observed half-written. The temp
    // name matches the widget watcher's ignore pattern (no spurious rebuilds).
    await atomicWrite(path.join(this.deps.widgetsDir, widgetId, 'thumbnail.png'), png);
    return png;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.teardown('closing');
  }

  // ------------------------------------------------------------------ capture

  private async captureWithRetry(req: NormalizedRequest, pose: UserPose | null, opts: CaptureOptions): Promise<Buffer> {
    try {
      return await this.captureOnce(req, pose, opts);
    } catch (e) {
      // Retry once when the failure is about the renderer, not the request:
      // - the browser/page died underneath us (crash, GPU process loss, external kill);
      // - the WebGL context was lost (GPU reset / driver TDR): renders would be blank forever;
      // - the page never received its initial state (its WS is stuck): relaunch;
      // - the page navigated mid-capture (Vite HMR full reload): just run it again.
      // Timeouts and page-side request errors are not retried: they would most
      // likely just happen again.
      if (e instanceof TimeoutError || this.closed) throw e;
      const msg = errMsg(e);
      if (isNavigationError(msg) && this.isAlive()) {
        this.deps.log('warn', `mirror: page reloaded during capture (${msg}); retrying once`);
        return this.captureOnce(req, pose, opts);
      }
      const contextLost = msg.includes(CONTEXT_LOST);
      const notReady = msg.includes(NOT_READY);
      if (!contextLost && !notReady && this.isAlive()) throw e;
      const why = contextLost ? 'WebGL context lost' : notReady ? `page not ready (${msg})` : `renderer died during capture (${msg})`;
      this.deps.log('warn', `mirror: ${why}; restarting and retrying once`);
      await this.teardown(contextLost ? 'context lost' : notReady ? 'page not ready' : 'crash');
      return this.captureOnce(req, pose, opts);
    }
  }

  private async captureOnce(req: NormalizedRequest, pose: UserPose | null, opts: CaptureOptions): Promise<Buffer> {
    const page = await this.ensurePage();
    const run = async (): Promise<Buffer> => {
      await page.setViewportSize({ width: req.width, height: req.height });
      // After a page reload (Vite HMR) the API is re-created a moment later.
      await page.waitForFunction(() => !!(window as unknown as MirrorWindow).__evolMirror, undefined, {
        polling: 50,
        timeout: this.captureTimeoutMs,
      });
      const dataUrl = await page.evaluate(
        async ([r, p, o]) => {
          const api = (window as unknown as MirrorWindow).__evolMirror;
          if (!api) throw new Error('mirror: page API missing (window.__evolMirror)');
          // capture() itself waits (bounded) for the page's initial scene + catalog.
          return api.capture(r, p, o);
        },
        [req, pose, opts] as [ScreenshotRequest, UserPose | null, CaptureOptions],
      );
      return pngFromDataUrl(dataUrl);
    };
    try {
      return await withTimeout(run(), this.captureTimeoutMs, `mirror: capture (${req.view.kind})`, () => {
        // A hung page (infinite loop in widget code, lost GPU) never recovers by
        // itself: kill the browser; the next request relaunches it.
        void this.teardown('capture timeout');
      });
    } catch (e) {
      throw cleanError(e);
    }
  }

  private checkBlank(png: Buffer, req: NormalizedRequest): void {
    try {
      const s = imageStats(png);
      if (s.distinctColors <= 1) {
        this.deps.log('warn', `mirror: ${req.view.kind} screenshot is a single flat color — the view may be empty or pointing at nothing`);
      }
    } catch { /* stats are advisory */ }
  }

  // ------------------------------------------------------------------ lifecycle

  private isAlive(): boolean {
    return !!this.browser?.isConnected() && !!this.page && !this.page.isClosed();
  }

  private ensurePage(): Promise<Page> {
    if (this.closed) return Promise.reject(new Error('mirror: closed'));
    if (this.isAlive()) return Promise.resolve(this.page!);
    if (!this.starting) {
      this.starting = withTimeout(this.start(), this.startupTimeoutMs, 'mirror: startup', () => {
        void this.teardown('startup timeout');
      }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  private async start(): Promise<Page> {
    if (this.counters.launches > 0) this.counters.restarts++;
    this.counters.launches++;
    await this.teardown('restart');
    const gen = this.generation;
    const cancelled = (): boolean => this.closed || gen !== this.generation;

    const launched = await launchBestBrowser(launchCandidates(this.gpu, process.platform, this.extraArgs), this.deps.log);
    if (cancelled()) {
      await launched.browser.close().catch(() => {});
      throw new Error(this.closed ? 'mirror: closed' : 'mirror: startup cancelled');
    }
    const browser = launched.browser;
    this.browser = browser;
    this.webgl = launched.webgl;
    this.launchConfig = launched.candidate.name;
    this.deps.log(
      launched.webgl.software ? 'warn' : 'info',
      `mirror: Chromium ${browser.version()} [${launched.candidate.name}] WebGL: ${launched.webgl.renderer} (${launched.webgl.software ? 'SOFTWARE' : 'hardware'})`,
    );
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        if (!this.closed) this.deps.log('warn', 'mirror: browser disconnected');
        this.browser = null;
        this.context = null;
        this.page = null;
      }
    });

    this.context = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
    const page = await this.context.newPage();
    this.attachPageLogging(page);
    await page.goto(this.pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as MirrorWindow).__evolMirror, undefined, { polling: 50 });
    await page.evaluate(() => (window as unknown as MirrorWindow).__evolMirror!.ready);
    if (cancelled()) throw new Error('mirror: startup cancelled');
    this.page = page;
    this.deps.log('info', `mirror: ready at ${this.pageUrl}`);
    return page;
  }

  private attachPageLogging(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type();
      // Errors always; warnings only from the mirror itself (e.g. "scene did not settle").
      if (type === 'error') this.forwardLog('error', `mirror page console: ${msg.text()}`);
      else if (type === 'warning' && msg.text().startsWith('mirror:')) this.forwardLog('warn', msg.text());
    });
    page.on('pageerror', (err) => this.forwardLog('error', `mirror page error: ${err.message}`));
    page.on('framenavigated', (frame) => {
      // Only interesting after startup: a Vite HMR full reload re-creates the page API.
      if (frame === page.mainFrame() && this.page === page) this.deps.log('warn', 'mirror: page reloaded (HMR?); the next capture waits for it to be ready');
    });
    page.on('crash', () => {
      this.deps.log('error', 'mirror: page crashed; it will be restarted on the next capture');
      if (this.page === page) this.page = null;
    });
  }

  /** Forward page errors to the server log, at most 30 per 10 s so a broken widget cannot flood it. */
  private forwardLog(level: 'warn' | 'error', message: string): void {
    const now = Date.now();
    if (now - this.consoleBudget.windowStart > 10_000) this.consoleBudget = { windowStart: now, count: 0 };
    if (++this.consoleBudget.count > 30) return;
    this.deps.log(level, message.length > 2000 ? `${message.slice(0, 2000)}…` : message);
  }

  private async teardown(reason: string): Promise<void> {
    this.generation++;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (!browser) return;
    if (reason !== 'restart' && reason !== 'closing') this.deps.log('warn', `mirror: tearing down browser (${reason})`);
    // close() can itself hang on a wedged browser; don't wait forever.
    await withTimeout(browser.close(), 5_000, 'mirror: browser close').catch(() => {});
  }
}

/** Strips Playwright prefixes/stack noise so the agent sees the page's actual message. */
function cleanError(e: unknown): Error {
  if (e instanceof TimeoutError) return e;
  const raw = errMsg(e);
  const firstLine = raw.split('\n')[0]
    .replace(/^page\.\w+:\s*/, '')
    .replace(/^Error:\s*/, '');
  const err = new Error(firstLine.startsWith('mirror') ? firstLine : `mirror: ${firstLine}`);
  return err;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeView(r: NormalizedRequest): string {
  const v = r.view;
  return v.kind === 'widget' ? `widget '${v.widget}'` : v.kind === 'entity' ? `entity '${v.entity}'` : `${v.kind} view`;
}
