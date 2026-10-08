// Desktop debug dashboard e2e: a real server (isolated: random port, temp data,
// library copy — see harness.ts), Playwright Chromium on /debug.
//   - /debug redirects to ?role=desktop&debug=1; the tab is never primary
//   - the scene tree lists the entities; clicking a row selects (runtime + inspector)
//   - Ctrl+click in the 3D view selects (mouse → ray uses the resized canvas rect)
//   - editing a prop in the inspector lands on the server (/api/scene); Ctrl+Z undoes it
//   - Delete removes the selection; Ctrl+Z restores it
//   - layout persistence across a reload
// Opt-in:  EVOL_E2E=1 npx vitest run tests/e2e/debug.test.ts
// Screenshot: data/debug-samples/debug-e2e.png (1600×1000).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import type { SceneState } from '@evolspace/protocol';
import type {} from '../../apps/client/src/hooks.ts'; // window.__evol typing
import { E2E_ENABLED, ROOT, api, startServer, until, type TestServer } from './harness.ts';

const SAMPLES = path.join(ROOT, 'data', 'debug-samples');

describe.skipIf(!E2E_ENABLED)('debug dashboard (e2e)', { timeout: 60_000 }, () => {
  let srv: TestServer;
  let http: ReturnType<typeof api>;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];
  const scene = () => http.get<SceneState>('/api/scene');

  beforeAll(async () => {
    srv = await startServer();
    http = api(srv.url);
    await http.post('/api/scene/ops', {
      source: 'agent',
      ops: [
        { op: 'add', entity: { id: 'dbg-box', widget: 'box', name: 'debug box', transform: { position: [0, 1.4, -0.9] }, props: { size: 0.3, color: 'positive' } } },
        { op: 'add', entity: { id: 'dbg-group', widget: 'group', name: 'controls', transform: { position: [0.6, 1.3, -1.2] } } },
        { op: 'add', entity: { id: 'dbg-slider', parent: 'dbg-group', widget: 'slider', name: 'gain', props: { min: 0, max: 1, value: 0.25 } } },
        { op: 'add', entity: { id: 'dbg-num', parent: 'dbg-group', widget: 'number', name: 'readout', transform: { position: [0.3, 0, 0] } } },
        { op: 'link.add', link: { from: { kind: 'port', entity: 'dbg-slider', port: 'value' }, to: { kind: 'port', entity: 'dbg-num', port: 'value' } } },
      ],
    });
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  }, 180_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await srv?.stop();
  }, 60_000);

  const openDebug = async () => {
    await page.goto(`${srv.url}/debug`);
    await page.waitForFunction(() => !!window.__evol?.debug && !!(window.__evol.state() as { ready?: boolean }).ready, undefined, { timeout: 60_000 });
    await page.waitForFunction(() => !!window.__evol?.runtime.entityObject('dbg-box'), undefined, { timeout: 30_000 });
  };

  it('opens /debug as a desktop client that never takes primary', async () => {
    await openDebug();
    const u = new URL(page.url());
    expect(u.searchParams.get('role')).toBe('desktop');
    expect(u.searchParams.get('debug')).toBe('1');
    const st = await page.evaluate(() => window.__evol!.state() as { role: string; primary: boolean });
    expect(st.role).toBe('desktop');
    expect(st.primary).toBe(false);
    const health = await http.get<{ clients: Array<{ role: string; primary: boolean }> }>('/api/health');
    expect(health.clients.filter((c) => c.role === 'desktop').every((c) => !c.primary)).toBe(true);
    expect(await http.get('/api/user')).toBeNull(); // no user.pose streamed by the debug tab
    // The landing panel is replaced by the dashboard; the canvas lives in the viewport cell.
    expect(await page.locator('#evol-landing').isVisible()).toBe(false);
    const canvasBox = await page.locator('.dbg-canvas-host canvas').boundingBox();
    expect(canvasBox!.width).toBeLessThan(1600);
    expect(canvasBox!.height).toBeLessThan(1000);
    const aspect = await page.evaluate(() => window.__evol!.client.camera.aspect);
    expect(aspect).toBeCloseTo(canvasBox!.width / canvasBox!.height, 2);
  });

  it('receives the headset pose from the server (user-pose capability) and shows the headset indicator', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`${srv.url.replace(/^http/, 'ws')}/ws`);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const hello = new Promise<void>((res) => ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'hello') res(); }));
    ws.send(JSON.stringify({ type: 'hello', role: 'xr', wantPrimary: true, userAgent: 'fake-quest' }));
    await hello;
    ws.send(JSON.stringify({ type: 'user.pose', pose: { t: Date.now(), mode: 'vr', head: { position: [0.123, 1.6, 0.4], rotation: [0, 0, 0, 1] }, hands: {} } }));
    await page.waitForFunction(() => window.__evol!.debug!.store.userPose.value?.head.position[0] === 0.123, undefined, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('.dbg-headset')?.classList.contains('on'), undefined, { timeout: 10_000 });
    // The debug tab is still not primary; the fake headset is.
    expect(await page.evaluate(() => (window.__evol!.state() as { primary: boolean }).primary)).toBe(false);
    ws.close();
    await page.waitForFunction(() => window.__evol!.debug!.store.userPose.value === null, undefined, { timeout: 10_000 });
  });

  it('shows the scene tree and selects by clicking a row', async () => {
    const row = page.locator('.dbg-trow[data-id="dbg-box"]');
    await row.waitFor();
    for (const id of ['dbg-group', 'dbg-slider', 'dbg-num']) await page.locator(`.dbg-trow[data-id="${id}"]`).waitFor();
    await row.click();
    await page.waitForFunction(() => window.__evol!.runtime.selected === 'dbg-box');
    await expect.poll(() => page.locator('.dbg-insp-head .nm input').inputValue()).toBe('debug box');
    // Esc clears the selection (focus is not in a text field).
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__evol!.runtime.selected === null);
  });

  it('Ctrl+click in the 3D view selects the entity under the cursor', async () => {
    const pt = await page.evaluate(() => {
      const { runtime, client } = window.__evol!;
      const box = runtime.frameEntity('dbg-box')!;
      const c = box.getCenter(box.min.clone());
      c.project(client.camera);
      const r = client.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((c.x + 1) / 2) * r.width, y: r.top + ((1 - c.y) / 2) * r.height };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.waitForFunction(() => window.__evol!.runtime.selected === 'dbg-box', undefined, { timeout: 5000 });
    expect(await page.locator('.dbg-trow[data-id="dbg-box"]').getAttribute('class')).toContain('sel');
  });

  it('edits a prop in the inspector (server-side) and undoes it', async () => {
    const input = page.locator('.dbg-row[title^="size:"] .dbg-num input');
    await input.waitFor();
    expect(await input.inputValue()).toBe('0.3');
    await input.click(); // a click without drag focuses for typing
    await input.fill('0.45');
    await input.press('Enter');
    await until(async () => (await scene()).entities['dbg-box']?.props.size === 0.45, 'size=0.45 on the server', 10_000);
    await expect.poll(() => input.inputValue()).toBe('0.45');
    // Typing in a field must not trigger shortcuts: 'f'/'Delete' inside the name field.
    const name = page.locator('.dbg-insp-head .nm input');
    await name.click();
    await name.press('End');
    await name.type(' f');
    await name.press('Delete');
    await name.press('Escape');
    expect((await scene()).entities['dbg-box']).toBeTruthy();
    // Undo (Ctrl+Z, focus outside inputs).
    await page.locator('.dbg-trow[data-id="dbg-box"]').click();
    await page.keyboard.press('Control+z');
    await until(async () => (await scene()).entities['dbg-box']?.props.size === 0.3, 'undo restores size=0.3', 10_000);
    await expect.poll(() => input.inputValue()).toBe('0.3');
  });

  it('Delete removes the selection, Ctrl+Z brings it back', async () => {
    await page.locator('.dbg-trow[data-id="dbg-num"]').click();
    await page.keyboard.press('Delete');
    await until(async () => !(await scene()).entities['dbg-num'], 'dbg-num removed', 10_000);
    await page.locator('.dbg-trow[data-id="dbg-num"]').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+z');
    await until(async () => !!(await scene()).entities['dbg-num'], 'dbg-num restored', 10_000);
    await page.locator('.dbg-trow[data-id="dbg-num"]').waitFor();
  });

  it('takes a screenshot of the dashboard', async () => {
    await page.locator('.dbg-trow[data-id="dbg-slider"]').click();
    await page.evaluate(() => window.__evol!.debug!.actions.frame('dbg-group'));
    await page.waitForTimeout(900);
    mkdirSync(SAMPLES, { recursive: true });
    await page.screenshot({ path: path.join(SAMPLES, 'debug-e2e.png') });
  });

  it('persists the layout (collapsed dock, active tab) across reloads', async () => {
    await page.locator('.dbg-dock.bottom .dbg-tab', { hasText: 'Events' }).click();
    await page.evaluate(() => window.__evol!.debug!.layout.setCollapsed('left', true));
    await page.evaluate(() => window.__evol!.debug!.layout.flush());
    await openDebug();
    const st = await page.evaluate(() => window.__evol!.debug!.layout.value);
    expect(st.docks.left.collapsed).toBe(true);
    expect(st.docks.bottom.active).toBe('events');
    await page.evaluate(() => window.__evol!.debug!.layout.reset());
  });

  it('had no page errors', () => {
    expect(pageErrors.filter((e) => !/GL Driver|WebGL|favicon/i.test(e))).toEqual([]);
  });
});
