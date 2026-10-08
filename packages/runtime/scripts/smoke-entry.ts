// Browser smoke scene for @evolspace/runtime (bundled by browser-smoke.mjs).
// Renders panels/text/widgets/system UI with real troika + WebGL, no server.

import * as THREE from 'three';
import type { ClientMessage, WidgetDefinition, WidgetManifest } from '@evolspace/protocol';
import { SpaceRuntime, createHandVisual, type NetPort } from '../src/index.ts';

const sent: ClientMessage[] = [];
const net: NetPort = {
  connected: true,
  clientId: 'smoke',
  send: (m) => { sent.push(m); },
  sendBinary: () => {},
  subscribe: () => () => {},
  on: () => () => {},
  onTensor: () => () => {},
  onStatus: () => () => {},
};

const card: WidgetDefinition = {
  description: 'card',
  props: { title: { type: 'string', default: 'Card' }, value: { type: 'number', default: 0.5 } },
  create(ctx) {
    const { THREE: T, ui, theme } = ctx;
    const panel = ui.panel(0.42, 0.26);
    ctx.root.add(panel);
    const title = ui.text(String(ctx.props.title), { size: 0.024, anchorX: 'left', anchorY: 'top' });
    title.position.set(-0.19, 0.11, 0.002);
    ctx.root.add(title);
    const mono = ui.text('resid[12] = 0.4231', { size: 0.016, font: 'mono', anchorX: 'left', color: theme.textDim });
    mono.position.set(-0.19, 0.05, 0.002);
    ctx.root.add(mono);
    for (let i = 0; i < 10; i++) {
      const h = 0.02 + 0.1 * Math.abs(Math.sin(i * 1.3));
      const bar = new T.Mesh(new T.PlaneGeometry(0.028, h), ui.material('#' + ui.color('palette', i).getHexString()));
      bar.position.set(-0.17 + i * 0.037, -0.11 + h / 2, 0.002);
      ctx.root.add(bar);
    }
    const knob = new T.Mesh(new T.SphereGeometry(0.015, 16, 12), ui.material(theme.accent));
    knob.position.set(0.17, 0.1, 0.01);
    knob.name = 'knob';
    ctx.root.add(knob);
    ctx.interactive(knob);
    return { update: (dt) => { knob.rotation.y += dt; }, onProps: (p) => title.set(String(p.title)) };
  },
};

const ramp: WidgetDefinition = {
  description: 'ramp',
  create(ctx) {
    const { THREE: T, ui } = ctx;
    for (let i = 0; i < 24; i++) {
      const c = ui.color(i < 12 ? 'sequential' : 'diverging', i < 12 ? i / 11 : ((i - 12) / 11) * 2 - 1);
      const m = new T.Mesh(new T.BoxGeometry(0.03, 0.03, 0.03), ui.material('#' + c.getHexString()));
      m.position.set((i % 12) * 0.035 - 0.19, i < 12 ? 0.02 : -0.02, 0);
      ctx.root.add(m);
    }
    return {};
  },
};

const broken: WidgetDefinition = { description: 'broken', create() { throw new Error('demo failure in create()'); } };

const defs: Record<string, WidgetDefinition> = { card, ramp, broken };
const man = (id: string): WidgetManifest => ({ id, description: id, props: defs[id].props ?? {}, inputs: {}, outputs: {}, interactions: [], hash: '1', url: `/widgets/${id}.js?h=1`, hasThumbnail: false, size: [0.3, 0.2, 0.05] });

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(1280, 800);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2b3140');
// The runtime draws its own floor grid + origin marker (setEnvironment({ grid })).
const camera = new THREE.PerspectiveCamera(70, 1280 / 800, 0.01, 50);
camera.position.set(0, 1.55, 0);
camera.lookAt(0, 1.45, -1);

const rt = new SpaceRuntime({
  scene, net, role: 'desktop', camera, renderer,
  loadModule: async (url) => {
    const id = /\/widgets\/([^/.?]+)\.js/.exec(url)![1];
    return { default: defs[id] };
  },
});
rt.widgets.setCatalog(Object.keys(defs).map(man));
const T = (x: number, y: number, z: number, ry = 0) => ({ position: [x, y, z] as [number, number, number], rotation: [0, Math.sin(ry / 2), 0, Math.cos(ry / 2)] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
rt.applyPatch([
  { op: 'add', entity: { id: 'c1', widget: 'card', props: { title: 'Residual stream · layer 12' }, transform: T(-0.25, 1.45, -0.85, 0.25) } },
  { op: 'add', entity: { id: 'r1', widget: 'ramp', transform: T(0.0, 1.13, -0.8) } },
  { op: 'add', entity: { id: 'b1', widget: 'broken', transform: T(0.32, 1.45, -0.95, -0.3) } },
  { op: 'add', entity: { id: 'm1', widget: 'missing-widget', transform: T(0.55, 1.2, -1.1, -0.5) } },
]);
rt.system.setAgentStatus({ state: 'working', detail: 'Editing library/widgets/resid-flow/widget.ts', since: Date.now() });
rt.system.addMessage({ id: 'h', text: 'make the residual panel show layer twelve', kind: 'heard', ts: Date.now() - 1000 });
// Emoji are outside the bundled fonts: the UiKit must map them (troika would otherwise fetch fallback fonts from a CDN).
rt.system.addMessage({ id: 'r', text: 'Done ✅ — the panel now shows layer 12 🚀. I also added a token selector under it.', kind: 'reply', ts: Date.now() });
rt.system.toast('Saved workspace "interp"', 'success');
rt.select('c1');

const hand = createHandVisual(rt.theme);
rt.root.add(hand.object);

let t = 0;
let frames = 0;
async function run() {
  await rt.whenIdle();
  const host = rt.interactionHost();
  // Point the right ray at the card's knob.
  rt.update(1 / 60, 0);
  const kw = new THREE.Vector3();
  rt.entityObject('c1')!.getObjectByName('knob')!.getWorldPosition(kw);
  const origin: [number, number, number] = [0.15, 1.3, -0.3];
  const dir = kw.clone().sub(new THREE.Vector3(...origin)).normalize();
  const hit = host.raycast(origin, [dir.x, dir.y, dir.z]);
  rt.setPointerRays({ right: { origin, direction: [dir.x, dir.y, dir.z], hit } });

  const loop = () => {
    t += 1 / 60;
    frames++;
    rt.update(1 / 60, t);
    renderer.render(scene, camera);
    if (frames < 240) requestAnimationFrame(loop);
    else finish(hit);
  };
  requestAnimationFrame(loop);
}

function finish(hit: unknown) {
  const texts: Array<{ text: string; synced: boolean; visible: boolean }> = [];
  scene.traverse((o) => {
    const x = o as unknown as { text?: string; textRenderInfo?: unknown; isMesh?: boolean };
    if (x.isMesh && typeof x.text === 'string' && x.text) texts.push({ text: x.text.slice(0, 40), synced: !!x.textRenderInfo, visible: o.visible });
  });
  (window as unknown as { __smoke: unknown }).__smoke = {
    done: true,
    errors,
    hit,
    texts,
    unsynced: texts.filter((x) => !x.synced).map((x) => x.text),
    statuses: ['c1', 'r1', 'b1', 'm1'].map((id) => rt.widgets.record(id)?.status),
    sentTypes: [...new Set(sent.map((m) => m.type))],
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}

run().catch((e) => errors.push(String(e?.stack ?? e)));
