// End-to-end: real headless Chromium + the real mirror page (apps/client/src/mirror)
// + the real @evolspace/runtime, against a fake server (Vite + fake WS) that
// serves a small scene of fixture widgets. Saves sample PNGs to
// data/mirror-samples/ for visual inspection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { Entity, HandFrame, Handedness, SceneState, ScreenshotRequest, UserPose, Vec3 } from '@evolspace/protocol';
import { startMirror, type Mirror } from '../index.ts';
import { decodePng, imageStats } from '../png.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.resolve(here, '../../../../../data/mirror-samples');

function entity(id: string, widget: string, position: Vec3, extra: Partial<Entity> = {}): Entity {
  return { id, parent: null, widget, props: {}, transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, visible: true, ...extra };
}

const scene: SceneState = {
  version: 1,
  workspace: 'test',
  links: {},
  entities: {
    b1: entity('b1', 'box', [0, 1.4, -1.2], { name: 'main box', props: { label: 'hello' } }),
    b2: entity('b2', 'box', [0.55, 1.2, -1.4], { name: 'small box', props: { size: 0.15, label: 'small' }, transform: { position: [0.55, 1.2, -1.4], rotation: [0, 0.38268343, 0, 0.92387953], scale: [1, 1, 1] } }),
    s1: entity('s1', 'slow', [-0.55, 1.4, -1.3], { name: 'slow knot' }),
    // Side-effecting widget, behind the sample views (passivity test).
    c1: entity('c1', 'chatty', [0, 0.3, 3], { name: 'chatty' }),
  },
};

/** A plausible open hand: fingers fanned forward (-Z) from the wrist. */
function openHand(hand: Handedness, wrist: Vec3): HandFrame {
  const joints: number[] = [];
  const radii: number[] = [];
  const side = hand === 'left' ? -1 : 1;
  const push = (p: Vec3, r: number): void => { joints.push(p[0], p[1], p[2], 0, 0, 0, 1); radii.push(r); };
  push(wrist, 0.02);
  // thumb: 4 joints angled outward
  for (let j = 1; j <= 4; j++) push([wrist[0] - side * 0.025 * j, wrist[1] + 0.005 * j, wrist[2] - 0.022 * j], 0.011);
  // four fingers, 5 joints each
  for (let f = 0; f < 4; f++) {
    const x = wrist[0] + side * (f - 1) * 0.02 - side * 0.01;
    for (let j = 0; j < 5; j++) push([x, wrist[1], wrist[2] - 0.035 - 0.022 * j], j === 0 ? 0.012 : 0.009);
  }
  return { hand, joints, radii };
}

const pose: UserPose = {
  t: 0,
  mode: 'vr',
  head: { position: [0, 1.6, 0.2], rotation: [-0.0871557, 0, 0, 0.9961947] }, // pitched down 10°
  fov: 90,
  aspect: 1,
  hands: { left: openHand('left', [-0.18, 1.3, -0.25]), right: openHand('right', [0.18, 1.3, -0.25]) },
};

// The real runtime is used whenever it exists; EVOL_MIRROR_MOCK_RUNTIME=1 forces the mock
// (which has no scene patches, anchors or spawnChild: tests needing those are skipped).
const mockRuntime = process.env.EVOL_MIRROR_MOCK_RUNTIME === '1' || !existsSync(path.resolve(here, '../../../../../packages/runtime/src/index.ts'));

let server: FakeServer;
let mirror: Mirror;
let widgetsDir: string;
const logs: Array<[string, string]> = [];

async function save(name: string, png: Buffer): Promise<void> {
  await writeFile(path.join(samplesDir, name), png);
}

/** The mirror's Playwright page (private field; tests only). Waits for (re)start. */
async function mirrorPage(): Promise<Page> {
  for (let i = 0; i < 600; i++) {
    const page = (mirror as unknown as { page: Page | null }).page;
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mirror page not running');
}

/** RGB of one pixel. */
function pixel(png: Buffer, x: number, y: number): number[] {
  const img = decodePng(png);
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 3));
}

function setPose(p: UserPose | null): void {
  (globalThis as { __setPose?: (p: UserPose | null) => void }).__setPose!(p);
}

function expectRich(png: Buffer, what: string): ReturnType<typeof imageStats> {
  const s = imageStats(png);
  expect(png.length, `${what}: PNG bytes`).toBeGreaterThan(1000);
  expect(s.variance, `${what}: luminance variance`).toBeGreaterThan(50);
  expect(s.distinctColors, `${what}: distinct colors`).toBeGreaterThan(20);
  return s;
}

beforeAll(async () => {
  await mkdir(samplesDir, { recursive: true });
  widgetsDir = await mkdtemp(path.join(tmpdir(), 'evol-mirror-widgets-'));
  if (mockRuntime) console.warn('mirror test: using the MOCK runtime (fixtures/mock-runtime.ts)');
  server = await startFakeServer(scene, { mockRuntime });
  let currentPose: UserPose | null = pose;
  mirror = await startMirror({
    baseUrl: server.baseUrl,
    getUserPose: () => currentPose,
    widgetsDir,
    log: (level, message) => {
      logs.push([level, message]);
      if (process.env.EVOL_MIRROR_TEST_VERBOSE) console.log(`[${level}] ${message}`);
    },
  });
  // Exposed for the "no pose" test.
  (globalThis as { __setPose?: (p: UserPose | null) => void }).__setPose = (p) => { currentPose = p; };
}, 120_000);

afterAll(async () => {
  await mirror?.close();
  await writeFile(path.join(samplesDir, 'mirror-log.txt'), logs.map(([l, m]) => `[${l}] ${m}`).join('\n') + '\n').catch(() => {});
  await server?.close();
  if (widgetsDir) await rm(widgetsDir, { recursive: true, force: true });
}, 60_000);

describe('mirror (headless Chromium, end to end)', () => {
  it('captures a camera view of the scene', async () => {
    const png = await mirror.screenshot({ view: { kind: 'camera', position: [0.2, 1.7, 0.4], lookAt: [0, 1.35, -1.3] }, width: 800, height: 600 });
    await save('camera.png', png);
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([800, 600]);
    expectRich(png, 'camera');
    const status = mirror.status!();
    expect(status.running).toBe(true);
    expect(status.webglRenderer).toBeTruthy();
    expect(logs.some(([, m]) => m.includes('WebGL:'))).toBe(true);
  }, 90_000);

  it('captures a widget in the studio', async () => {
    const png = await mirror.screenshot({ view: { kind: 'widget', widget: 'box', props: { label: 'studio' } }, width: 640, height: 480 });
    await save('widget-box.png', png);
    expectRich(png, 'widget');
  }, 60_000);

  it('waits for slow widgets before capturing (thumbnail)', async () => {
    const png = await mirror.thumbnail('slow');
    await save('thumbnail-slow.png', png);
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([512, 512]);
    // The knot fills the middle: its center pixel must differ from the studio background corner.
    const px = (x: number, y: number): number[] => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    expect(px(256, 256)).not.toEqual(px(2, 2));
    expectRich(png, 'slow thumbnail');
    const onDisk = await readFile(path.join(widgetsDir, 'slow', 'thumbnail.png'));
    expect(onDisk.equals(png)).toBe(true);
  }, 60_000);

  it('frames widgets whose geometry contains NaN', async () => {
    const png = await mirror.screenshot({ view: { kind: 'widget', widget: 'nan' }, width: 320, height: 240 });
    await save('widget-nan.png', png);
    const s = imageStats(png);
    expect(s.variance, 'nan widget: variance').toBeGreaterThan(50);
    expect(s.distinctColors, 'nan widget: box + grid + background').toBeGreaterThan(3);
  }, 60_000);

  it("captures the user's view with ghost hands", async () => {
    const png = await mirror.screenshot({ view: { kind: 'user' }, width: 768 });
    await save('user.png', png);
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([768, 768]); // aspect 1 from the pose
    expectRich(png, 'user');
  }, 60_000);

  it('auto-frames an entity, with labels', async () => {
    const png = await mirror.screenshot({ view: { kind: 'entity', entity: 'b2' }, labels: true, width: 640, height: 480 });
    await save('entity-b2-labels.png', png);
    expectRich(png, 'entity');
  }, 60_000);

  it('supports transparent and CSS-color backgrounds', async () => {
    const t = await mirror.screenshot({ view: { kind: 'widget', widget: 'box' }, background: 'transparent', width: 256, height: 256 });
    await save('widget-box-transparent.png', t);
    expect(imageStats(t).transparentFraction).toBeGreaterThan(0.3);
    const c = await mirror.screenshot({ view: { kind: 'camera', position: [0, 1.5, 1], lookAt: [0, 1.4, -1.2] }, background: 'rebeccapurple', width: 256, height: 256 });
    const img = decodePng(c);
    expect(Array.from(img.data.subarray(0, 3))).toEqual([102, 51, 153]); // top-left corner = background
  }, 60_000);

  it('rejects bad requests with descriptive errors', async () => {
    await expect(mirror.screenshot({ view: { kind: 'widget', widget: 'nope' } })).rejects.toThrow(/unknown widget "nope"/);
    await expect(mirror.screenshot({ view: { kind: 'entity', entity: 'missing' } })).rejects.toThrow(/unknown entity "missing"/);
    await expect(mirror.screenshot({ view: { kind: 'camera', position: [0, 1, 0] }, background: 'not-a-color' })).rejects.toThrow(/invalid background/);
    await expect(mirror.thumbnail('broken')).rejects.toThrow(/broken/);
    (globalThis as { __setPose?: (p: UserPose | null) => void }).__setPose!(null);
    try {
      await expect(mirror.screenshot({ view: { kind: 'user' } })).rejects.toThrow(/no user pose/);
    } finally {
      (globalThis as { __setPose?: (p: UserPose | null) => void }).__setPose!(pose);
    }
    // ...and keeps working afterwards.
    expectRich(await mirror.screenshot({ view: { kind: 'widget', widget: 'box' }, width: 128, height: 128 }), 'after errors');
  }, 60_000);

  it('recovers when the browser dies', async () => {
    const before = mirror.status!().restarts;
    // Simulate a crash: kill the browser behind the mirror's back.
    await (mirror as unknown as { browser: { close(): Promise<void> } }).browser.close();
    const png = await mirror.screenshot({ view: { kind: 'widget', widget: 'box' }, width: 200, height: 150 });
    expectRich(png, 'after restart');
    expect(mirror.status!().restarts).toBeGreaterThan(before);
  }, 90_000);

  it('serializes concurrent captures', async () => {
    const reqs = [0, 1, 2].map((i) => mirror.screenshot({ view: { kind: 'camera', position: [i * 0.3, 1.6, 0.5], lookAt: [0, 1.4, -1.2] }, width: 320 + i * 16, height: 240 }));
    const pngs = await Promise.all(reqs);
    pngs.forEach((p, i) => expect(decodePng(p).width).toBe(320 + i * 16));
  }, 60_000);

  it.skipIf(mockRuntime)('is a passive observer: widget side effects never reach the server', async () => {
    // c1 (chatty) lives in the space; render it in the studio too, then let the
    // between-capture ticks run its update() a few times.
    expectRich(await mirror.screenshot({ view: { kind: 'widget', widget: 'chatty' }, width: 200, height: 200 }), 'chatty');
    expectRich(await mirror.screenshot({ view: { kind: 'entity', entity: 'c1' }, width: 200, height: 200 }), 'chatty entity');
    await new Promise((r) => setTimeout(r, 800));
    // The NetClient liveness ping is not a widget side effect (it fires when the socket is quiet, e.g. under load).
    const isPing = (m: { type: string; name?: unknown }) => m.type === 'command' && m.name === 'ping';
    const sideEffects = server.received.filter((m) => ['scene.ops', 'channel.publish', 'widget.event', 'agent.ask', 'command', 'scene.undo', 'scene.redo'].includes(m.type) && !isPing(m));
    expect(sideEffects.map((m) => m.type)).toEqual([]);
    // Observability still flows: the mirror did say hello and subscribe-style traffic is allowed.
    expect(server.received.some((m) => m.type === 'hello')).toBe(true);
  }, 60_000);

  it.skipIf(mockRuntime)('waits for scene changes that are still in flight', async () => {
    // The server has applied the op (its version moved on) but the WS patch arrives 500 ms later.
    server.patch([{ op: 'add', entity: entity('late', 'box', [0, 2.2, -1.5], { name: 'late box', props: { label: 'late' } }) }], 500);
    const t0 = Date.now();
    const png = await mirror.screenshot({ view: { kind: 'entity', entity: 'late' }, width: 320, height: 240 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    await save('entity-late.png', png);
    expectRich(png, 'late entity');
    server.patch([{ op: 'remove', id: 'late' }]);
  }, 60_000);

  it('renders the latest widget build even before widgets.updated arrives', async () => {
    const before = await mirror.thumbnail('rebuilt');
    const [r1, g1] = pixel(before, 256, 256);
    expect(g1).toBeGreaterThan(200);
    expect(r1).toBeLessThan(60);
    // Rebuilt on the server (new hash + bundle), broadcast not yet received.
    server.setManifest('rebuilt', { hash: 'h2', url: '/widgets/rebuilt-v2.js?h=h2', version: '2' });
    const after = await mirror.thumbnail('rebuilt');
    await save('thumbnail-rebuilt-v2.png', after);
    const [r2, g2] = pixel(after, 256, 256);
    expect(r2).toBeGreaterThan(200);
    expect(g2).toBeLessThan(60);
  }, 60_000);

  it.skipIf(mockRuntime)('keeps head-anchored entities with the user, not the screenshot camera', async () => {
    server.patch([{ op: 'add', entity: entity('hud', 'box', [0, 0, -0.6], { name: 'hud', props: { size: 0.05, label: '' }, anchor: { kind: 'head' } }) }]);
    const where = async (): Promise<number[]> => (await mirrorPage()).evaluate(() => {
      const m = (window as unknown as { __evolMirror: { space: { runtime: { entityObject(id: string): { updateWorldMatrix(a: boolean, b: boolean): void; matrixWorld: { elements: number[] } } | undefined } } } }).__evolMirror;
      const o = m.space.runtime.entityObject('hud')!;
      o.updateWorldMatrix(true, false);
      return [12, 13, 14].map((i) => o.matrixWorld.elements[i]);
    });
    const far: ScreenshotRequest = { view: { kind: 'camera', position: [3, 1.5, 3], lookAt: [0, 1.4, -1.2] }, width: 160, height: 120 };
    try {
      // No headset: the default standing user at the origin, looking down -Z.
      setPose(null);
      await mirror.screenshot(far);
      await new Promise((r) => setTimeout(r, 1200)); // past the runtime's 1 s pose expiry, with ticks running
      await mirror.screenshot(far);
      const p0 = await where();
      expect(p0[0]).toBeCloseTo(0, 3);
      expect(p0[1]).toBeCloseTo(1.6, 3);
      expect(p0[2]).toBeCloseTo(-0.6, 3);
      // With a headset: in front of its head (pose head at z=0.2, pitched down 10°).
      setPose(pose);
      await mirror.screenshot(far);
      const p1 = await where();
      expect(p1[0]).toBeCloseTo(0, 3);
      expect(p1[2]).toBeCloseTo(0.2 - 0.6 * Math.cos((10 * Math.PI) / 180), 2);
      expect(p1[1]).toBeCloseTo(1.6 - 0.6 * Math.sin((10 * Math.PI) / 180), 2);
    } finally {
      setPose(pose);
      server.patch([{ op: 'remove', id: 'hud' }]);
    }
  }, 60_000);

  it('recovers from a lost WebGL context', async () => {
    const before = mirror.status!().restarts;
    await (await mirrorPage()).evaluate(() => {
      const canvas = document.getElementById('evol-mirror-canvas') as HTMLCanvasElement;
      (canvas.getContext('webgl2') as WebGL2RenderingContext).getExtension('WEBGL_lose_context')!.loseContext();
    });
    const png = await mirror.screenshot({ view: { kind: 'widget', widget: 'box' }, width: 200, height: 150 });
    expectRich(png, 'after context loss');
    expect(mirror.status!().restarts).toBeGreaterThan(before);
    expect(logs.some(([, m]) => m.includes('WebGL context lost'))).toBe(true);
  }, 90_000);

  it('survives a page reload (Vite HMR) before or during a capture', async () => {
    const page = await mirrorPage();
    const restarts = mirror.status!().restarts;
    // Before: the API disappears and comes back; the capture waits for it.
    await page.evaluate(() => setTimeout(() => location.reload(), 0));
    expectRich(await mirror.screenshot({ view: { kind: 'camera', position: [0.2, 1.7, 0.4], lookAt: [0, 1.35, -1.3] }, width: 320, height: 240 }), 'after reload');
    // During: 'slow' takes 600 ms to create, the reload lands mid-capture and the capture is retried.
    await page.evaluate(() => setTimeout(() => location.reload(), 250));
    expectRich(await mirror.screenshot({ view: { kind: 'widget', widget: 'slow' }, width: 320, height: 240 }), 'reload mid-capture');
    expect(logs.some(([, m]) => m.includes('page reloaded during capture'))).toBe(true);
    expect(mirror.status!().restarts).toBe(restarts); // same browser, no relaunch
  }, 90_000);

  it('relaunches a page that never receives its initial state', async () => {
    const page = await mirrorPage();
    const restarts = mirror.status!().restarts;
    server.setSilent(true);
    // Reload while the server ignores hellos: the page comes up without a scene.
    await page.evaluate(() => setTimeout(() => location.reload(), 0));
    // The capture gives up waiting after 8 s and the server relaunches; only then
    // does the fake server answer again (event-driven, not timed: robust under load).
    const before = logs.length;
    const unmute = setInterval(() => {
      if (logs.slice(before).some(([, m]) => m.includes('page not ready'))) {
        clearInterval(unmute);
        server.setSilent(false);
      }
    }, 50);
    try {
      const png = await mirror.screenshot({ view: { kind: 'widget', widget: 'box' }, width: 160, height: 120 });
      expectRich(png, 'after relaunch');
    } finally {
      clearInterval(unmute);
      server.setSilent(false);
    }
    expect(mirror.status!().restarts).toBeGreaterThan(restarts);
    expect(logs.some(([, m]) => m.includes('page not ready'))).toBe(true);
  }, 90_000);
});
