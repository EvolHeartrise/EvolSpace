// End-to-end smoke tests: real server + real client in headless Chromium.
//
// Requires a running server (npm run dev) with at least one widget on EVOL_URL
// (default http://127.0.0.1:8787); skipped otherwise. Each test adds a fresh
// entity through the HTTP API, drives the client, and asserts the result on the
// server (GET /api/scene, /api/user):
//   1. ?role=desktop — simulated pinch-grab (window.__evol.sim) moves the entity
//   2. ?role=desktop — real mouse: LMB-hold pinch-drag moves the entity
//   3. ?emulate=quest3&autoenter=vr — IWER runs the real WebXR path: VR session,
//      anchored origin, hands, user.pose streaming, a simulated grab, and that
//      leaving XR mid-grab ends the grab and restores the desktop camera
//   4. ?role=desktop — hold V: push-to-talk with Chromium's fake microphone
//      (AudioWorklet → 16 kHz resampler → AUD0 frames) reaches the server's voice service
//
//   npx vitest run apps/client/test-e2e
//   EVOL_URL=http://127.0.0.1:18787 npx vitest run apps/client/test-e2e

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'playwright';
import type { SceneState, Vec3 } from '@evolspace/protocol';
import type {} from '../src/hooks.ts'; // window.__evol typing

const BASE = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** A grabbable widget from the catalog: 'box' if present, else the first one that built. */
async function pickWidget(): Promise<string | null> {
  try {
    const list = (await (await fetch(`${BASE}/api/widgets`)).json()) as Array<{ id: string; error?: string }>;
    const ok = list.filter((w) => !w.error);
    return ok.find((w) => w.id === 'box')?.id ?? ok[0]?.id ?? null;
  } catch {
    return null;
  }
}

const up = await serverUp();
if (!up) console.warn(`[e2e] server not reachable at ${BASE} — skipping client smoke tests`);
const widget = up ? await pickWidget() : null;
if (up && !widget) console.warn('[e2e] the widget library is empty — skipping client smoke tests');

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function entityPosition(id: string): Promise<Vec3 | undefined> {
  return (await api<SceneState>('/api/scene')).entities[id]?.transform.position;
}

/** Polls the server until the entity's x moved by more than `minDx`. */
async function waitMoved(id: string, startX: number, minDx: number): Promise<Vec3 | null> {
  for (let i = 0; i < 25; i++) {
    const pos = await entityPosition(id);
    if (pos && Math.abs(pos[0] - startX) > minDx) return pos;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function waitReady(page: Page, entityId: string): Promise<void> {
  await page.waitForFunction(() => {
    const s = window.__evol?.state() as { connected?: boolean; ready?: boolean } | undefined;
    return !!s?.connected && !!s.ready;
  }, undefined, { timeout: 30_000 });
  await page.waitForFunction((id) => !!window.__evol?.runtime.entityObject(id), entityId, { timeout: 20_000 });
}

/** Entity origin in SPACE coordinates (as the engine/sim hands use). */
async function entitySpacePosition(page: Page, id: string): Promise<Vec3> {
  return page.evaluate((id) => {
    const rt = window.__evol!.runtime;
    const obj = rt.entityObject(id)!;
    obj.updateWorldMatrix(true, false);
    const p = obj.getWorldPosition(obj.position.clone());
    rt.root.worldToLocal(p);
    return [p.x, p.y, p.z] as Vec3;
  }, id);
}

/** Open hand at `p` → pinch → drag +dx along x in 10 steps → release (all via __evol.sim). */
async function simGrabDrag(page: Page, p: Vec3, dx: number): Promise<void> {
  const at = (d: number): Vec3 => [p[0] + d, p[1], p[2]];
  await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, false), at(0));
  await page.waitForTimeout(250);
  await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, true), at(0));
  await page.waitForTimeout(300);
  for (let i = 1; i <= 10; i++) {
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, true), at((dx * i) / 10));
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(150);
  await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, false), at(dx));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__evol!.sim.clearHands());
}

describe.skipIf(!up || !widget)('client e2e', () => {
  let browser: Browser;
  let page: Page;
  let entityId = '';
  let errors: string[] = [];
  const START: Vec3 = [0, 1.3, -0.5];

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        // A synthetic microphone (beep) without a permission prompt, for push-to-talk.
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    errors = [];
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const res = await api<{ ids: string[] }>('/api/scene/ops', {
      source: 'agent',
      ops: [{ op: 'add', entity: { widget: widget!, name: 'e2e-grab-target', transform: { position: START, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, props: {} } }],
    });
    entityId = res.ids[0];
  });

  afterEach(async () => {
    await page?.close();
    if (entityId) await api('/api/scene/ops', { source: 'agent', ops: [{ op: 'remove', id: entityId }] }).catch(() => {});
  });

  const diag = async () => `client state: ${JSON.stringify(await page.evaluate(() => window.__evol!.state()))}; errors: ${errors.join(' | ')}`;

  it('desktop: a simulated pinch-grab moves the entity on the server', async () => {
    await page.goto(`${BASE}/?role=desktop`);
    await waitReady(page, entityId);
    await simGrabDrag(page, await entitySpacePosition(page, entityId), 0.3);
    const moved = await waitMoved(entityId, START[0], 0.15);
    expect(moved, `entity did not move; ${await diag()}`).not.toBeNull();
    expect(moved![0] - START[0]).toBeGreaterThan(0.2);
    expect(moved![0] - START[0]).toBeLessThan(0.4);
    expect(Math.abs(moved![1] - START[1])).toBeLessThan(0.05);
  }, 90_000);

  it('desktop: mouse LMB-hold pinch-drag moves the entity', async () => {
    await page.goto(`${BASE}/?role=desktop`);
    await waitReady(page, entityId);
    // Project the entity to the screen and press on it.
    const [sx, sy] = await page.evaluate((id) => {
      const c = window.__evol!.client;
      const obj = window.__evol!.runtime.entityObject(id)!;
      const p = obj.getWorldPosition(obj.position.clone()).project(c.camera);
      const r = c.renderer.domElement.getBoundingClientRect();
      return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
    }, entityId);
    await page.mouse.move(sx, sy);
    await page.waitForTimeout(300);
    const hover = await page.evaluate(() => window.__evol!.state().rays as { right?: { hit: { entity: string } | null } });
    expect(hover.right?.hit?.entity, await diag()).toBe(entityId);
    await page.mouse.down();
    await page.waitForTimeout(300);
    for (let i = 1; i <= 10; i++) { await page.mouse.move(sx + i * 15, sy); await page.waitForTimeout(40); }
    await page.waitForTimeout(150);
    await page.mouse.up();
    const moved = await waitMoved(entityId, START[0], 0.1);
    expect(moved, `entity did not move; ${await diag()}`).not.toBeNull();
    expect(moved![0]).toBeGreaterThan(START[0]);
  }, 90_000);

  it('emulated Quest 3 (IWER): VR session, anchored origin, user.pose streaming, simulated grab', async () => {
    await page.goto(`${BASE}/?emulate=quest3&autoenter=vr`);
    await waitReady(page, entityId);
    await page.waitForFunction(() => (window.__evol!.state() as { mode: string }).mode === 'vr', undefined, { timeout: 20_000 });
    const s = (await page.evaluate(() => window.__evol!.state())) as { origin: { status: string }; hands: Record<string, boolean> };
    expect(['anchored', 'anchoring', 'floor', 'restoring']).toContain(s.origin.status);
    expect(s.hands.right || s.hands.left).toBe(true); // IWER emulates tracked hands

    // If this client is primary (no real headset connected), its user.pose reaches the server.
    const primary = await page.evaluate(() => window.__evol!.state().primary as boolean);
    if (primary) {
      await page.waitForTimeout(300);
      const user = await api<{ mode?: string } | null>('/api/user');
      expect(user?.mode).toBe('vr');
    }

    await simGrabDrag(page, await entitySpacePosition(page, entityId), 0.3);
    const moved = await waitMoved(entityId, START[0], 0.15);
    expect(moved, `entity did not move in emulated VR; ${await diag()}`).not.toBeNull();

    // Leaving XR while still pinching must end the grab (no dangling session),
    // and the desktop camera gets its own FOV back.
    const p = await entitySpacePosition(page, entityId);
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, false), p);
    await page.waitForTimeout(250);
    await page.evaluate((q) => window.__evol!.sim.setPinchAt('right', q, true), p);
    await page.waitForFunction(() => (window.__evol!.state().sessions as unknown[]).length > 0, undefined, { timeout: 5000 });
    await page.evaluate(() => window.__evol!.client.xr.exit());
    await page.waitForFunction(() => window.__evol!.state().mode === 'inline', undefined, { timeout: 10_000 });
    const after = (await page.evaluate(() => ({ sessions: window.__evol!.state().sessions, fov: window.__evol!.client.camera.fov }))) as { sessions: unknown[]; fov: number };
    expect(after.sessions, await diag()).toEqual([]);
    expect(after.fov).toBe(70);
    await page.evaluate(() => window.__evol!.sim.clearHands());
  }, 90_000);

  it('desktop: holding V streams push-to-talk audio to the server (fake mic)', async () => {
    await page.context().grantPermissions(['microphone'], { origin: BASE });
    await page.goto(`${BASE}/?role=desktop`);
    await waitReady(page, entityId);
    await page.locator('#evol-canvas').focus();
    await page.keyboard.down('KeyV');
    // ~0.8 s of audio = 8 × 100 ms frames.
    await page.waitForFunction(() => ((window.__evol!.state().ptt as { framesSent: number }).framesSent >= 8), undefined, { timeout: 15_000 })
      .catch(async (e) => { throw new Error(`no audio frames: ${(e as Error).message}; ${await diag()}`); });
    const utterance = (await page.evaluate(() => (window.__evol!.state().ptt as { utterance: string }).utterance));
    expect(utterance).toMatch(/^[0-9a-f-]{36}$/);
    await page.keyboard.up('KeyV');
    await page.waitForFunction(() => !(window.__evol!.state().ptt as { active: boolean }).active);
    // The server's voice service received the utterance (STT itself may be absent:
    // any outcome except 'cancelled' proves begin → audio → end arrived intact).
    let ev: { data: Record<string, unknown> } | undefined;
    for (let i = 0; i < 40 && !ev; i++) {
      const r = await api<{ events: Array<{ data: Record<string, unknown> }> }>('/api/events?since=0&types=voice.utterance');
      ev = r.events.find((e) => e.data.utteranceId === utterance);
      if (!ev) await new Promise((r) => setTimeout(r, 250));
    }
    expect(ev, `no voice.utterance event for ${utterance}; ${await diag()}`).toBeDefined();
    expect(ev!.data.reason).not.toBe('cancelled');
    expect(ev!.data.durationMs as number).toBeGreaterThan(700);
  }, 90_000);
});
