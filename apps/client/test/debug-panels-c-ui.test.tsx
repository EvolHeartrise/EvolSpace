// @vitest-environment happy-dom
// Hands + View panels mount against a fake context: enabling a simulated hand
// solves its preset, the hold button applies only while pressed, overlay
// switches drive ctx.overlays, and the binding explanation is rendered.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { computed, signal } from '@preact/signals';
import * as THREE from 'three';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InteractionSet, PoseDef, UserPose } from '@evolspace/protocol';
import { DEFAULT_THEME } from '@evolspace/runtime';
import handsPanel from '../src/debug/panels/hands.tsx';
import viewPanel from '../src/debug/panels/view.tsx';
import { gestureDefs } from '../src/debug/panels/hands/live.ts';
import { patchSim, simHeld, simState } from '../src/debug/panels/hands/driver.ts';
import { OVERLAYS } from '../src/debug/overlays-impl/index.ts';
import type { DebugContext } from '../src/debug/types.ts';

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../library');
const POSES: PoseDef[] = readdirSync(path.join(LIB, 'poses')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(LIB, 'poses', f), 'utf8')) as PoseDef);
const SETS: Record<string, InteractionSet> = Object.fromEntries(readdirSync(path.join(LIB, 'interactions')).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(LIB, 'interactions', f), 'utf8')) as InteractionSet]));

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => {
  render(null, host); host.remove();
  for (const h of ['left', 'right'] as const) { patchSim(h, { enabled: false, latched: false, solve: null, preset: 'pinch' }); simHeld[h].value = false; }
});

function fakeCtx() {
  const enabled = signal<ReadonlySet<string>>(new Set(['avatar']));
  const defs = signal(OVERLAYS);
  const toasts: string[] = [];
  const commands: Array<[string, unknown]> = [];
  const camera = new THREE.PerspectiveCamera(70, 1.5, 0.02, 300);
  const pose: UserPose = { t: Date.now(), mode: 'vr', head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] }, fov: 96, aspect: 1, hands: {} };
  const ctx = {
    THREE, camera,
    renderer: { domElement: document.createElement('canvas'), info: { render: { calls: 3, triangles: 100, lines: 0, points: 0 }, memory: { geometries: 4, textures: 1 }, programs: [] } },
    runtime: {
      theme: DEFAULT_THEME, root: new THREE.Group(), environment: { grid: true },
      gestures: { poses: POSES, interactions: SETS }, entity: () => undefined, sceneState: { entities: {}, links: {} },
      onGestures: (cb: (g: unknown) => void) => { cb({ poses: POSES, interactions: SETS }); return () => {}; },
    },
    engine: {
      activeSessions: () => [{ hand: 'left', pose: 'pinch-middle', binding: 'push-to-talk', action: 'command', scope: 'global' }],
      rays: () => ({}), activePoses: (h: string) => (h === 'left' ? ['pinch-middle'] : []),
      matcher: { features: (h: string) => (h === 'left' ? { 'pinch.middle': 0.01, 'pinch.index': 0.06, 'curl.index': 0.12 } : undefined) },
    },
    client: {
      hands: { left: { hand: 'left', joints: new Array(175).fill(0), radii: new Array(25).fill(0.01) } },
      sim: { active: false, get: () => null, setHands: () => ({}), clearHands: () => {} },
      desktop: null, head: { position: [0, 1.6, 0], rotation: [0, 0, 0, 1] },
      host: { touch: () => null, widgetBindings: () => [] },
      onFrame: () => () => {},
    },
    store: {
      selection: signal<string | null>(null), scene: signal({ version: 1, workspace: 'w', entities: {}, links: {} }),
      headset: signal({ connected: true, primaryId: 'x', xrClients: 1 }), userPose: signal<UserPose | null>(pose),
      need: () => () => {},
    },
    overlays: {
      defs, enabled: computed(() => enabled.value),
      isEnabled: (id: string) => enabled.value.has(id),
      setEnabled: (id: string, on: boolean) => { const n = new Set(enabled.value); if (on) n.add(id); else n.delete(id); enabled.value = n; },
      toggle: () => {},
    },
    actions: { command: (n: string, a: unknown) => commands.push([n, a]), frame: () => {}, frameAll: () => {}, select: () => {} },
    api: { gestures: async () => ({ poses: POSES, interactions: SETS }) },
    toast: (t: string) => toasts.push(t),
  } as unknown as DebugContext;
  return { ctx, enabled, toasts, commands };
}

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('hands panel', () => {
  it('enables a simulated hand, solves its preset, hold applies only while pressed; shows bindings', async () => {
    const f = fakeCtx();
    gestureDefs.value = { poses: POSES, interactions: SETS };
    const Hands = handsPanel.component;
    await act(() => { render(<Hands ctx={f.ctx} />, host); });
    const card = () => host.querySelector('.hx-card[data-hand="left"]')!;
    await act(() => { (card().querySelector('.dbg-switch input') as HTMLInputElement).click(); });
    expect(simState.left.value.enabled).toBe(true);
    await act(() => {
      const sel = card().querySelector('select.dbg-select') as HTMLSelectElement;
      sel.value = 'pinch-middle';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(simState.left.value.preset).toBe('pinch-middle');
    expect(simState.left.value.solve?.ok).toBe(true);
    expect(card().textContent).toContain('classifies');
    const hold = card().querySelector('.hx-hold') as HTMLButtonElement;
    expect(hold.textContent).toContain('Hold pinch-middle');
    await act(() => { hold.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 1 })); });
    expect(simHeld.left.value).toBe(true);
    await act(() => { hold.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true, pointerId: 1 })); });
    expect(simHeld.left.value).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); }); // live poll
    // The left pinch-middle → global push-to-talk (firing session).
    expect(host.querySelectorAll('.hx-ex')[1].textContent).toContain('push-to-talk');
    expect(host.querySelectorAll('.hx-ex')[0].textContent).toContain('select'); // right pinch-middle → global select
    expect(host.querySelector('.hx-feat')!.textContent).toContain('pinch.middle');
    await tick();
  });
});

describe('view panel', () => {
  it('lists the overlays (+ floor grid) and toggles them through ctx.overlays', async () => {
    const f = fakeCtx();
    const View = viewPanel.component;
    await act(() => { render(<View ctx={f.ctx} />, host); });
    const rows = [...host.querySelectorAll<HTMLElement>('.vw-ov')].map((r) => r.dataset.overlay);
    expect(rows).toEqual([...OVERLAYS.map((o) => o.id), 'grid']);
    await act(() => { (host.querySelector('.vw-ov[data-overlay="bounds"] .dbg-switch input') as HTMLInputElement).click(); });
    expect(f.enabled.value.has('bounds')).toBe(true);
    await act(() => { (host.querySelector('.vw-ov[data-overlay="grid"] .dbg-switch input') as HTMLInputElement).click(); });
    expect(f.commands).toContainEqual(['grid.toggle', { visible: false }]);
    expect(host.textContent).toContain('Follow headset');
    expect(host.textContent).toContain('96°');
  });
});
