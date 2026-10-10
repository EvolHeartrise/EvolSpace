// fb-orbit — "Files · Orbit": the current folder as a small solar system (file-browser variation).
//
// The folder is the sun; its children orbit it in 3-D:
//   - folders are smooth planets (radius ∝ log size) with their own children as moons (tree depth 2),
//     files are faceted asteroids colored by type;
//   - distance from the sun = recency (faint guide rings at 1d / 1w / 1mo / 1y): recent stuff is close;
//   - orbital plane = type group (folders in the main plane; code, docs, data, media, other tilted).
// Bodies drift slowly (Kepler-ish, paused while you interact). Hover a body → it brightens and a
// tooltip billboards toward you (name, size, age). Pinch a planet → it flies to the center and grows
// into the new sun while the old system shrinks into a dim "outer star" behind it; pinch a moon → jump
// two levels; pinch a file → a preview screen unfolds from it (syntax-highlighted text or an image).
// The outer star (+ a short trail of older ancestors) goes back up. Pinch-drag the sun / halo / any body
// to rotate the system. Tap the sun to rescan.
//
// Data: the `files` source (tree depth 2 + preview), replies on files.fb-orbit.<entity>.{tree,preview}.
// Several clients share those channels, so replies are matched by path, never only by nonce.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, MeasureWatch, setColorRanges, textSize, type Text } from '../../shared/text.ts';
import { colorRanges, highlight, languageFor, SYNTAX_COLORS, type Span, type TokenKind } from '../../shared/syntax.ts';
import { hexToInt, mixHex } from '../../shared/color.ts';
import { makeIcon } from '../../shared/icons.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { isTensor } from '../../shared/tensor.ts';
import { STYLE } from '../../shared/style.ts';
import { FittedInstances } from '../../shared/instanced.ts';
import { Billboard } from '../../shared/billboard.ts';
import {
  ageShort, ancestorsOf, folderName, GUIDES, layoutSystem, orbitRadius, PLANES, SUN_R, typeOf,
  type BodySpec, type TNode,
} from './layout.ts';

export { layoutSystem, orbitRadius, typeOf, ancestorsOf } from './layout.ts';

interface Props extends Record<string, unknown> {
  path: string;
  showHidden: boolean;
  radius: number;
  maxBodies: number;
  labels: number;
  drift: boolean;
  guides: boolean;
  prefix: string;
}

interface TreeReply { kind: 'tree'; path: string; display: string; root: TNode | null; partial?: boolean; error?: string }
interface Preview { kind: 'preview'; path: string; name: string; size?: number; mtime?: number; type: string; text?: string; lines?: number; truncated?: boolean; src?: string; error?: string }

interface Body extends BodySpec {
  hit: THREE.Mesh;
  mesh: 0 | 1;
  slot: number;
  pos: THREE.Vector3;
  rot: THREE.Quaternion;
  q: THREE.Quaternion | null;
  base: THREE.Color;
}

interface Sys {
  gen: number;
  reply: TreeReply;
  sig: string;
  group: THREE.Group;
  bodies: Body[];
  nTop: number;
  sph: FittedInstances;
  rock: FittedInstances;
  nSph: number;
  nRock: number;
  sun: THREE.Mesh;
  halo: THREE.Mesh;
  hi: THREE.Line;
  u: number;
  hidden: number;
}

interface Label { pivot: THREE.Group; plate: THREE.Mesh; text: Text; body: number }

const D = Math.PI / 180;
const SUN_COLOR = '#ffb547';
const HALO_R = 0.1;
const OUTER = [-0.27, 0.25, -0.4] as const;   // parent star (root coords, × u)
const STEP = [-0.1, 0.075, -0.1] as const;    // trail of older ancestors
const ANC_R = [0.026, 0.012, 0.0105, 0.009];
const PW = 0.46, PH = 0.34;                   // preview screen
const LINE_H = 0.0105 * 1.25;
const TAP_SLOP = 0.018;                       // m of hand travel before a press becomes a rotation
const ROT_K = 5;                              // rad per m of hand travel
const DUR = 0.8;                              // navigation transition (s)
const DEFAULT_PITCH = 0.42;
const FRESH = 120;                            // s a cached tree is shown without waiting

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const expLerp = (a: number, b: number, e: number) => Math.exp(Math.log(Math.max(1e-4, a)) * (1 - e) + Math.log(Math.max(1e-4, b)) * e);
const noRaycast = () => {};

/** Bytes with GB support. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Tooltip second line for a body. */
export function bodyMeta(b: Pick<BodySpec, 'node' | 'kind' | 'type' | 'mtime'>, now = Date.now()): string {
  const age = ageShort(b.mtime, now);
  const ago = age ? (age === 'now' ? 'just now' : `${age} ago`) : '';
  if (b.node.type === 'dir') {
    const files = b.node.files != null ? `${b.node.files.toLocaleString('en-US')} file${b.node.files === 1 ? '' : 's'}` : '';
    return ['folder', b.node.skipped ? 'not scanned' : fmtBytes(b.node.size), files, ago].filter(Boolean).join(' · ');
  }
  const ext = b.node.ext ? `.${b.node.ext}` : '';
  return [`${b.type.label}${ext ? ` ${ext}` : ''}`, fmtBytes(b.node.size), ago].filter(Boolean).join(' · ');
}

const definition: WidgetDefinition<Props> = {
  description:
    "3-D file browser (via the 'files' source): the current folder is a sun, its children orbit it — folders as planets (size ∝ log bytes) " +
    'with their children as moons, files as asteroids colored by type; distance = recency (guide rings 1d/1w/1mo/1y), orbital plane = type. ' +
    'Hover for name/size/age; pinch a planet to fly into it, a moon to jump two levels, a file to unfold a preview; pinch the dim outer ' +
    'star (or the trail behind it) to go up; pinch-drag the sun/halo/bodies to rotate; tap the sun to rescan. Props: path, radius, maxBodies, labels, drift.',
  version: '1.0.0',
  props: {
    path: { type: 'string', default: '~', description: 'Current folder ("~" = home); updated as you navigate.' },
    showHidden: { type: 'boolean', default: false, description: 'Show dot files (secrets stay hidden regardless).' },
    radius: { type: 'number', default: 0.45, min: 0.25, max: 1, step: 0.01, description: 'Outermost orbit (m).' },
    maxBodies: { type: 'integer', default: 36, min: 6, max: 80, description: 'Most children shown as bodies (biggest + most recent).' },
    labels: { type: 'integer', default: 8, min: 0, max: 16, description: 'Persistent labels (biggest / nearest bodies); the hovered body always gets one.' },
    drift: { type: 'boolean', default: true, description: 'Bodies orbit slowly (paused while you interact).' },
    guides: { type: 'boolean', default: true, description: 'Faint recency guide rings (1d, 1w, 1mo, 1y).' },
    prefix: { type: 'string', default: 'files', description: "Channel prefix of the 'files' source." },
  },
  inputs: {
    path: { type: 'string', description: 'Open this folder.' },
    preview: { type: 'string', description: 'Preview this file (absolute or ~/ path).' },
  },
  outputs: {
    path: { type: 'string', description: 'Absolute path of the folder shown (on change).' },
    selected: { type: 'string', description: 'Absolute path of the file last previewed.' },
  },
  interactions: [dragBinding('fb-orbit-drag', 'drag')],
  size: [1, 0.8, 1],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    const prefix = () => String(ctx.props.prefix || 'files');
    const treeCh = () => `${prefix()}.fb-orbit.${ctx.entityId}.tree`;
    const previewCh = () => `${prefix()}.fb-orbit.${ctx.entityId}.preview`;
    const U = () => Math.max(0.2, ctx.props.radius / 0.45);

    // scratch (no per-frame allocation)
    const v1 = new T.Vector3(), v2 = new T.Vector3(), s3 = new T.Vector3();
    const m4 = new T.Matrix4(), qInv = new T.Quaternion(), white = new T.Color('#ffffff'), col = new T.Color();
    const ORIGIN = new T.Vector3();
    const planeQ = PLANES.map(([i, n]) => new T.Quaternion().setFromEuler(new T.Euler(i * D, n * D, 0, 'YXZ')));

    const stage = new T.Group();
    stage.name = 'stage';
    ctx.root.add(stage);
    let yaw = 0, pitch = DEFAULT_PITCH, vYaw = 0, vPitch = 0, lastYaw = 0, lastPitch = 0;
    const applyRotation = () => stage.rotation.set(pitch, yaw, 0, 'YXZ');
    applyRotation();

    // ---- state ------------------------------------------------------------------------------
    let clock = 0;
    let simT = 0;
    let driftAcc = 0;
    let lastInteract = -10;
    let genSeq = 0;
    let cur: Sys | null = null;
    let tr: { old: Sys; t: number; nfP: THREE.Vector3; nfS: number; ofP: THREE.Vector3; ofS: number; otP: THREE.Vector3; otS: number } | null = null;
    let want: string | null = String(ctx.props.path || '~');
    let wantFrom: { gen: number; idx: number } | null = null;
    let wantAt = 0;
    let message = '';
    let home: string | null = null;
    let nonce = 0;
    let lastPathOut = '';
    const cache = new Map<string, { r: TreeReply; at: number }>();
    const inFlight = new Map<string, number>();
    const hoverParts: Record<'left' | 'right', string | null> = { left: null, right: null };
    let hovered = -1;          // body index in cur
    let hoveredAnc = -1;
    let hoverSince = 0;
    let press: { hand: string; part: string; x0: number; y0: number; z0: number; yaw0: number; pitch0: number; scroll0: number; mode: 'tap' | 'rotate' | 'scroll' | 'none' } | null = null;
    const offs: Array<() => void> = [];

    // ---- paths --------------------------------------------------------------------------------
    const norm = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
    const absOf = (p: string) => (home && (p === '~' || p.startsWith('~/')) ? home + p.slice(1) : p);
    const matches = (r: TreeReply, p: string) => { const n = norm(p); return r.path === n || r.display === n || r.path === absOf(n); };
    const isUnder = (child: string, parent: string) => child !== parent && (parent === '/' ? child.startsWith('/') : child.startsWith(parent + '/'));
    function learnHome(r: TreeReply): void {
      if (home || typeof r.display !== 'string') return;
      if (r.display === '~') home = r.path;
      else if (r.display.startsWith('~/')) home = r.path.slice(0, r.path.length - (r.display.length - 1));
    }

    function request(cmd: 'tree' | 'preview', p: string): void {
      const msg: Record<string, unknown> = { cmd, path: p, reply: cmd === 'tree' ? treeCh() : previewCh(), nonce: ++nonce };
      if (cmd === 'tree') { msg.depth = 2; msg.hidden = !!ctx.props.showHidden; inFlight.set(norm(p), clock); }
      ctx.channels.publish(`${prefix()}.request`, msg as never);
    }

    const sigOf = (r: TreeReply) => {
      const root = r.root;
      if (!root) return '';
      let s = `${root.size}|${root.files}|`;
      for (const c of root.children ?? []) s += `${c.name}:${c.size}:${c.mtime}:${c.children?.length ?? 0};`;
      return s;
    };

    // ---- shared materials ---------------------------------------------------------------------
    const syntaxInts = Object.fromEntries(Object.entries(SYNTAX_COLORS).map(([k, v]) => [k, hexToInt(v)])) as Record<TokenKind, number>;

    function makePlate(): THREE.Mesh {
      const m = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.background, { opacity: 0.74 }));
      m.raycast = noRaycast;
      return m;
    }

    // ---- guides (in the stage: rotate with the system) ----------------------------------------
    let guides: THREE.Group | null = null;
    function buildGuides(): void {
      if (guides) disposeTree(guides);
      guides = null;
      if (!ctx.props.guides) return;
      const g = (guides = new T.Group());
      g.name = 'guides';
      const u = U(), rMin = 0.12 * u, rMax = ctx.props.radius;
      const now = Date.now();
      const rings = GUIDES.slice(1);
      const SEG = 96;
      const pos = new Float32Array(rings.length * (SEG / 2) * 6);
      let o = 0;
      rings.forEach(([h, label]) => {
        const r = orbitRadius(now - h * 3.6e6, now, rMin, rMax);
        for (let k = 0; k < SEG; k += 2) {
          const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
          pos[o++] = Math.cos(a0) * r; pos[o++] = 0; pos[o++] = -Math.sin(a0) * r;
          pos[o++] = Math.cos(a1) * r; pos[o++] = 0; pos[o++] = -Math.sin(a1) * r;
        }
        const pv = new T.Group();
        const a = -0.3 * Math.PI;
        pv.position.set(Math.cos(a) * r, 0.008, -Math.sin(a) * r);
        const t = makeText(ctx, label, { size: 0.011, color: theme.textDim, anchorX: 'center', anchorY: 'bottom' });
        pv.add(t);
        new Billboard(T, pv, 'full').attach();
        g.add(pv);
      });
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const lines = new T.LineSegments(geo, new T.LineBasicMaterial({ color: theme.textDim, transparent: true, opacity: 0.22, depthWrite: false }));
      lines.raycast = noRaycast;
      g.add(lines);
      stage.add(g);
    }

    // ---- systems ------------------------------------------------------------------------------
    function buildSys(r: TreeReply): Sys {
      const gen = ++genSeq;
      const L = layoutSystem(r.root!, { radius: ctx.props.radius, maxBodies: ctx.props.maxBodies, maxMoons: 60, now: Date.now() });
      const u = L.scale;
      const g = new T.Group();
      g.name = `sys:${gen}`;
      const sun = new T.Mesh(shadedGeometry(T, 'sphere'), ownMaterial(T, SUN_COLOR, { shaded: true }));
      sun.scale.setScalar(2 * SUN_R * u);
      sun.name = `s:${gen}`;
      ctx.interactive(sun);
      const haloPivot = new T.Group();
      const halo = new T.Mesh(sharedGeometry(T, 'ring'), ownMaterial(T, SUN_COLOR, { opacity: 0.13, doubleSide: true }));
      halo.scale.setScalar(2 * HALO_R * u);
      halo.name = `h:${gen}`;
      ctx.interactive(halo);
      haloPivot.add(halo);
      new Billboard(T, haloPivot, 'full').attach();
      g.add(sun, haloPivot);

      let nSph = 0, nRock = 0;
      for (const b of L.bodies) if (b.kind === 'planet') nSph++; else nRock++;
      const sph = new FittedInstances(T, shadedGeometry(T, 'sphere'), ownMaterial(T, '#ffffff', { shaded: true }), Math.max(1, nSph));
      const rock = new FittedInstances(T, shadedGeometry(T, 'ico'), ownMaterial(T, '#ffffff', { shaded: true }), Math.max(1, nRock));
      const ext = ctx.props.radius + 0.12 * u;
      for (const f of [sph, rock]) { f.mesh.raycast = noRaycast; f.fit(-ext, -ext, -ext, ext, ext, ext); g.add(f.mesh); }
      const bodies: Body[] = [];
      let si = 0, ri = 0;
      L.bodies.forEach((b, i) => {
        const hit = new T.Mesh(sharedGeometry(T, 'ico'), hitMaterial(T));
        hit.scale.setScalar(2 * b.hitR);
        hit.name = `b:${gen}:${i}`;
        ctx.interactive(hit);
        g.add(hit);
        const h = b.node.name;
        const rot = new T.Quaternion().setFromEuler(new T.Euler(h.length * 0.7, h.charCodeAt(0) * 0.13, 0));
        let color = b.type.color;
        if (b.kind === 'planet') color = mixHex(color, '#ff9f43', ((h.charCodeAt(0) * 37 + h.length * 11) % 100) / 220);
        if (b.node.skipped) color = mixHex(color, theme.border, 0.65);
        const q = b.kind === 'moon' ? new T.Quaternion().setFromEuler(new T.Euler(b.tilt[0], b.tilt[1], 0, 'YXZ')) : null;
        bodies.push({ ...b, hit, mesh: b.kind === 'planet' ? 0 : 1, slot: b.kind === 'planet' ? si++ : ri++, pos: new T.Vector3(), rot, q, base: new T.Color(color) });
      });
      const nTop = bodies.filter((b) => b.parent < 0).length;
      // orbit lines: one merged LineSegments (built once per system)
      const SEG = 64;
      const pos = new Float32Array(nTop * SEG * 6), cols = new Float32Array(nTop * SEG * 6);
      let o = 0;
      for (let i = 0; i < nTop; i++) {
        const b = bodies[i], q = planeQ[b.type.plane];
        for (let k = 0; k < SEG; k++) {
          for (const kk of [k, k + 1]) {
            const a = (kk / SEG) * Math.PI * 2;
            v1.set(Math.cos(a) * b.orbit, 0, -Math.sin(a) * b.orbit).applyQuaternion(q);
            pos[o] = v1.x; pos[o + 1] = v1.y; pos[o + 2] = v1.z;
            cols[o] = b.base.r; cols[o + 1] = b.base.g; cols[o + 2] = b.base.b;
            o += 3;
          }
        }
      }
      const lg = new T.BufferGeometry();
      lg.setAttribute('position', new T.BufferAttribute(pos, 3));
      lg.setAttribute('color', new T.BufferAttribute(cols, 3));
      const lines = new T.LineSegments(lg, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false }));
      lines.raycast = noRaycast;
      g.add(lines);
      const hg = new T.BufferGeometry();
      hg.setAttribute('position', new T.BufferAttribute(new Float32Array(65 * 3), 3));
      const hi = new T.Line(hg, new T.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }));
      hi.raycast = noRaycast;
      hi.visible = false;
      hi.frustumCulled = false;
      g.add(hi);
      const sys: Sys = { gen, reply: r, sig: sigOf(r), group: g, bodies, nTop, sph, rock, nSph, nRock, sun, halo, hi, u, hidden: L.hidden };
      for (let i = 0; i < bodies.length; i++) colorBody(sys, i);
      writeBodies(sys, 1);
      stage.add(g);
      return sys;
    }

    function colorBody(sys: Sys, i: number): void {
      const b = sys.bodies[i];
      col.copy(b.base);
      if (sys === cur && i === hovered) col.lerp(white, 0.45);
      else if (sys === cur && preview && b.node.path === preview.path) col.lerp(white, 0.3);
      (b.mesh === 0 ? sys.sph : sys.rock).setColorAt(b.slot, col);
    }
    function recolor(sys: Sys): void {
      for (let i = 0; i < sys.bodies.length; i++) colorBody(sys, i);
      for (const f of [sys.sph, sys.rock]) if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    }

    /** Positions at the drift clock → instance matrices + hit spheres. `pulse` scales the pending body. */
    function writeBodies(sys: Sys, pulse: number): void {
      const pend = wantFrom && wantFrom.gen === sys.gen ? wantFrom.idx : -1;
      for (let i = 0; i < sys.bodies.length; i++) {
        const b = sys.bodies[i];
        const a = b.phase + b.omega * simT;
        v1.set(Math.cos(a) * b.orbit, 0, -Math.sin(a) * b.orbit);
        if (b.parent < 0) b.pos.copy(v1.applyQuaternion(planeQ[b.type.plane]));
        else b.pos.copy(sys.bodies[b.parent].pos).add(v1.applyQuaternion(b.q!));
        b.hit.position.copy(b.pos);
        let s = 2 * b.r;
        if (sys === cur && i === hovered) s *= 1.3;
        if (i === pend) s *= pulse;
        m4.compose(b.pos, b.rot, s3.setScalar(s));
        (b.mesh === 0 ? sys.sph : sys.rock).setMatrixAt(b.slot, m4);
      }
      sys.sph.commit(sys.nSph);
      sys.rock.commit(sys.nRock);
    }

    /** Stage-local position of a system-local point. */
    const toStage = (sys: Sys, p: THREE.Vector3, out: THREE.Vector3) => out.copy(p).multiplyScalar(sys.group.scale.x).add(sys.group.position);
    /** ctx.root position of a system-local point. */
    const toRoot = (sys: Sys, p: THREE.Vector3, out: THREE.Vector3) => toStage(sys, p, out).applyQuaternion(stage.quaternion);
    /** A root-space point in stage coordinates. */
    const rootToStage = (p: THREE.Vector3, out: THREE.Vector3) => out.copy(p).applyQuaternion(qInv.copy(stage.quaternion).invert());
    const ancPos = (k: number, out: THREE.Vector3) => { const u = U(); return out.set((OUTER[0] + STEP[0] * k) * u, (OUTER[1] + STEP[1] * k) * u, (OUTER[2] + STEP[2] * k) * u); };

    function disposeSys(s: Sys): void {
      disposeTree(s.group);
    }

    function show(r: TreeReply): void {
      const old = cur;
      if (tr) { disposeSys(tr.old); tr = null; if (cur) { cur.group.position.set(0, 0, 0); cur.group.scale.setScalar(1); } }
      setHovered(-1);
      const pendingFrom = wantFrom;
      wantFrom = null;
      cur = buildSys(r);
      message = r.root && !(r.root.children?.length) ? 'Empty folder' : '';
      learnHome(r);
      if (!ctx.isMirror && r.display && r.display !== ctx.props.path) ctx.setProps({ path: r.display });
      if (r.path !== lastPathOut) { lastPathOut = r.path; ctx.emit('path', r.path); }
      if (!old) { finishShow(); return; }
      if (old.reply.path === r.path) { disposeSys(old); finishShow(); return; }
      const sunR = SUN_R * cur.u;
      const nfP = new T.Vector3(), ofP = old.group.position.clone(), otP = new T.Vector3();
      let nfS = 0.02, otS = 0.02;
      const ofS = old.group.scale.x;
      if (isUnder(r.path, old.reply.path)) {
        // down: the pinched planet / moon becomes the new sun; the old sun becomes the outer star
        let b: Body | undefined = pendingFrom && pendingFrom.gen === old.gen ? old.bodies[pendingFrom.idx] : undefined;
        if (!b || (b.node.path !== r.path && !isUnder(r.path, b.node.path))) b = old.bodies.find((x) => x.node.path === r.path) ?? old.bodies.find((x) => isUnder(r.path, x.node.path));
        if (b) { toStage(old, b.pos, nfP); nfS = (b.r * ofS) / sunR; }
        rootToStage(ancPos(0, v2), otP);
        otS = ANC_R[0] / SUN_R;
      } else if (isUnder(old.reply.path, r.path)) {
        // up: the new system comes from the outer star / trail; the old one shrinks into its body
        const depth = old.reply.path.split('/').filter(Boolean).length - r.path.split('/').filter(Boolean).length;
        const k = Math.max(0, Math.min(3, depth - 1));
        rootToStage(ancPos(k, v2), nfP);
        nfS = ANC_R[k] / SUN_R;
        const b = cur.bodies.find((x) => x.node.path === old.reply.path) ?? cur.bodies.find((x) => isUnder(old.reply.path, x.node.path));
        if (b) { otP.copy(b.pos); otS = b.r / sunR; }
      }
      cur.group.position.copy(nfP);
      cur.group.scale.setScalar(nfS);
      tr = { old, t: 0, nfP, nfS, ofP, ofS, otP, otS };
      ancGroup.visible = false;
      hideLabels();
    }

    function finishShow(): void {
      buildAncestors();
      relabel();
      updateSunLabel();
      findPreviewBody();
      dirty = true;
    }

    // ---- labels (pooled, root space) ----------------------------------------------------------
    const labelGroup = new T.Group();
    labelGroup.name = 'labels';
    ctx.root.add(labelGroup);
    let labels: Label[] = [];
    const watch = new MeasureWatch([]);
    function buildLabelPool(): void {
      for (const l of labels) disposeTree(l.pivot);
      labels = [];
      for (let i = 0; i < ctx.props.labels; i++) {
        const pivot = new T.Group();
        const plate = makePlate();
        const text = makeText(ctx, '', { size: 0.014, color: theme.text, anchorX: 'center', anchorY: 'middle', whiteSpace: 'nowrap' });
        text.position.z = 0.001;
        pivot.add(plate, text);
        new Billboard(T, pivot, 'full').attach();
        pivot.visible = false;
        labelGroup.add(pivot);
        labels.push({ pivot, plate, text, body: -1 });
      }
      resetWatch();
    }
    const fitPlate = (plate: THREE.Mesh, text: Text, s: string, size: number, padX: number, h: number) => {
      const w = s ? textSize(text, { text: s, size }).width : 0;
      plate.scale.set(Math.max(0.02, w + 2 * padX), h, 1);
    };
    function hideLabels(): void {
      for (const l of labels) { l.pivot.visible = false; l.body = -1; }
      tipPivot.visible = false;
      sunPivot.visible = false;
      msgPivot.visible = false;
    }
    let relabelAt = 0;
    function relabel(): void {
      relabelAt = clock;
      if (!cur || tr) return;
      const sys = cur;
      // biggest + nearest (toward the viewer side, +Z) top-level bodies; the hovered one has its tooltip
      const scores: Array<[number, number]> = [];
      for (let i = 0; i < sys.nTop; i++) {
        if (i === hovered) continue;
        const b = sys.bodies[i];
        toRoot(sys, b.pos, v1);
        const near = (v1.z / ctx.props.radius + 1) / 2;
        const big = Math.min(1, Math.max(0, (Math.log10(b.node.size + 1) - 2) / 8));
        const keep = labels.some((l) => l.body === i) ? 0.12 : 0;
        scores.push([i, big + 0.7 * near + (b.kind === 'planet' ? 0.25 : 0) + keep]);
      }
      scores.sort((a, b) => b[1] - a[1]);
      const chosen = scores.slice(0, labels.length).map((s) => s[0]);
      // keep labels on the same bodies where possible (no text churn)
      const free = labels.filter((l) => !chosen.includes(l.body));
      for (const l of labels) if (!chosen.includes(l.body)) { l.body = -1; l.pivot.visible = false; }
      for (const i of chosen) {
        if (labels.some((l) => l.body === i)) continue;
        const l = free.shift();
        if (!l) break;
        l.body = i;
        const s = truncate(sys.bodies[i].node.name, 24);
        l.text.set(s);
        fitPlate(l.plate, l.text, s, 0.014, 0.006, 0.022);
        l.pivot.visible = true;
      }
    }
    function positionLabels(): void {
      if (!cur || tr) return;
      const sys = cur;
      for (const l of labels) {
        if (l.body < 0) continue;
        const b = sys.bodies[l.body];
        if (!b) { l.pivot.visible = false; continue; }
        toRoot(sys, b.pos, v1);
        l.pivot.position.set(v1.x, v1.y + b.r * sys.group.scale.x + 0.017, v1.z);
      }
      if (hovered >= 0 && sys.bodies[hovered]) {
        const b = sys.bodies[hovered];
        toRoot(sys, b.pos, v1);
        tipPivot.position.set(v1.x, v1.y + b.r * 1.3 + 0.03, v1.z);
      }
    }

    // tooltip
    const tipPivot = new T.Group();
    const tipPlate = makePlate();
    const tipName = makeText(ctx, '', { size: 0.017, color: theme.text, anchorX: 'center', anchorY: 'middle', weight: 'semibold', whiteSpace: 'nowrap' });
    const tipMeta = makeText(ctx, '', { size: 0.0115, color: theme.textDim, anchorX: 'center', anchorY: 'middle', whiteSpace: 'nowrap' });
    tipName.position.set(0, 0.008, 0.001);
    tipMeta.position.set(0, -0.0105, 0.001);
    tipPivot.add(tipPlate, tipName, tipMeta);
    tipPlate.renderOrder = 7; tipName.renderOrder = tipMeta.renderOrder = 8;
    new Billboard(T, tipPivot, 'full').attach();
    tipPivot.visible = false;
    ctx.root.add(tipPivot);
    let tipStrings: [string, string] = ['', ''];
    function fitTip(): void {
      const a = textSize(tipName, { text: tipStrings[0], size: 0.017 }).width, b = textSize(tipMeta, { text: tipStrings[1], size: 0.0115 }).width;
      tipPlate.scale.set(Math.max(a, b) + 0.02, 0.045, 1);
    }

    // sun label + message
    const sunPivot = new T.Group();
    const sunPlate = makePlate();
    const sunName = makeText(ctx, '', { size: 0.024, color: theme.text, anchorX: 'center', anchorY: 'middle', weight: 'semibold', whiteSpace: 'nowrap' });
    const sunMeta = makeText(ctx, '', { size: 0.012, color: theme.textDim, anchorX: 'center', anchorY: 'middle', whiteSpace: 'nowrap' });
    sunName.position.set(0, 0.011, 0.001);
    sunMeta.position.set(0, -0.013, 0.001);
    sunPivot.add(sunPlate, sunName, sunMeta);
    sunPlate.renderOrder = 5; sunName.renderOrder = sunMeta.renderOrder = 6; // over body labels behind it
    new Billboard(T, sunPivot, 'yaw').attach();
    sunPivot.visible = false;
    ctx.root.add(sunPivot);
    let sunStrings: [string, string] = ['', ''];
    function fitSun(): void {
      const a = textSize(sunName, { text: sunStrings[0], size: 0.024 }).width, b = textSize(sunMeta, { text: sunStrings[1], size: 0.012 }).width;
      sunPlate.scale.set(Math.max(a, b) + 0.026, 0.056, 1);
    }
    const msgPivot = new T.Group();
    const msgText = makeText(ctx, '', { size: 0.014, color: theme.textDim, anchorX: 'center', anchorY: 'top', maxWidth: 0.4, textAlign: 'center' });
    msgPivot.add(msgText);
    new Billboard(T, msgPivot, 'yaw').attach();
    ctx.root.add(msgPivot);
    msgPivot.visible = false;

    function updateSunLabel(): void {
      const u = U();
      sunPivot.position.set(0, (HALO_R + 0.03) * u + 0.04, 0);
      msgPivot.position.set(0, -(HALO_R * u + 0.02), 0);
      if (cur && !tr) {
        const r = cur.reply, root = r.root!;
        const name = folderName(r.path, home) || r.display;
        const items = root.children?.length ?? 0;
        const meta = [`${r.partial ? '≥ ' : ''}${fmtBytes(root.size)}`, `${(root.files ?? 0).toLocaleString('en-US')} files`,
          `${items}${items >= 200 ? '+' : ''} items${cur.hidden ? ` (${cur.hidden} not shown)` : ''}`].join(' · ');
        sunStrings = [truncate(name, 30), meta];
        sunName.set(sunStrings[0]);
        sunMeta.set(sunStrings[1]);
        fitSun();
        sunPivot.visible = true;
      } else sunPivot.visible = false;
      let msg = message;
      if (!msg && want && clock - wantAt > 5) msg = "Waiting for the 'files' source…";
      if (!msg && !cur && want) msg = 'Scanning…';
      msgText.set(msg);
      msgPivot.visible = !!msg && !tr;
      if (!cur) msgPivot.position.set(0, 0, 0);
    }
    function resetWatch(): void {
      watch.reset([sunName, sunMeta, tipName, tipMeta, ...labels.map((l) => l.text)]);
    }

    // ---- ancestors: outer star + trail (root space) -------------------------------------------
    const ancGroup = new T.Group();
    ancGroup.name = 'ancestors';
    ctx.root.add(ancGroup);
    const ancStarMat = ownMaterial(T, mixHex(SUN_COLOR, theme.background, 0.45), { shaded: true });
    const ancDotMat = ownMaterial(T, mixHex(SUN_COLOR, theme.background, 0.62), { shaded: true });
    let ancPaths: string[] = [];
    const anc: Array<{ g: THREE.Group; mesh: THREE.Mesh; hit: THREE.Mesh; label: Text; pivot: THREE.Group }> = [];
    const trailGeo = new T.BufferGeometry();
    trailGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(4 * 6), 3));
    const trail = new T.LineSegments(trailGeo, new T.LineBasicMaterial({ color: SUN_COLOR, transparent: true, opacity: 0.25, depthWrite: false }));
    trail.raycast = noRaycast;
    trail.frustumCulled = false;
    ancGroup.add(trail);
    for (let k = 0; k < 4; k++) {
      const g = new T.Group();
      const mesh = new T.Mesh(shadedGeometry(T, 'sphere'), k === 0 ? ancStarMat : ancDotMat);
      mesh.raycast = noRaycast;
      const hit = new T.Mesh(sharedGeometry(T, 'ico'), hitMaterial(T));
      hit.name = `a:${k}`;
      ctx.interactive(hit);
      const pivot = new T.Group();
      const label = makeText(ctx, '', { size: k === 0 ? 0.017 : 0.013, color: theme.textDim, anchorX: 'center', anchorY: 'top', whiteSpace: 'nowrap' });
      pivot.add(label);
      new Billboard(T, pivot, 'full').attach();
      g.add(mesh, hit, pivot);
      ancGroup.add(g);
      anc.push({ g, mesh, hit, label, pivot });
    }
    function buildAncestors(): void {
      ancPaths = cur ? ancestorsOf(cur.reply.path).slice(0, 4) : [];
      const pos = trailGeo.getAttribute('position') as THREE.BufferAttribute;
      let prevX = 0, prevY = 0, prevZ = 0;
      for (let k = 0; k < 4; k++) {
        const a = anc[k], p = ancPaths[k];
        a.g.visible = !!p;
        if (!p) continue;
        ancPos(k, v1);
        a.g.position.copy(v1);
        const r = ANC_R[k] * U();
        a.mesh.scale.setScalar(2 * r);
        a.hit.scale.setScalar(2 * Math.max(0.0125, r * 1.5));
        a.pivot.position.set(0, -r - 0.006, 0);
        a.label.set(truncate(folderName(p, home), 22));
        pos.setXYZ(k * 2, prevX, prevY, prevZ);
        pos.setXYZ(k * 2 + 1, v1.x, v1.y, v1.z);
        prevX = v1.x; prevY = v1.y; prevZ = v1.z;
      }
      pos.needsUpdate = true;
      trailGeo.setDrawRange(0, ancPaths.length * 2);
      ancGroup.visible = !!cur && !tr;
      colorAnc();
    }
    function colorAnc(): void {
      for (let k = 0; k < 4; k++) (anc[k].label as unknown as { color: string }).color = k === hoveredAnc ? theme.text : theme.textDim;
      for (let k = 0; k < 4; k++) {
        const r = ANC_R[k] * U() * (k === hoveredAnc ? 1.3 : 1);
        anc[k].mesh.scale.setScalar(2 * r);
      }
    }

    // ---- hover --------------------------------------------------------------------------------
    function setHovered(i: number): void {
      if (i === hovered) return;
      const prev = hovered;
      hovered = i;
      hoverSince = clock;
      if (!cur) return;
      if (prev >= 0 && prev < cur.bodies.length) colorBody(cur, prev);
      if (i >= 0 && i < cur.bodies.length) colorBody(cur, i);
      for (const f of [cur.sph, cur.rock]) if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
      // highlight the orbit (a moon highlights its planet's)
      const hiB = i >= 0 ? cur.bodies[i] : null;
      const top = hiB ? (hiB.parent >= 0 ? cur.bodies[hiB.parent] : hiB) : null;
      cur.hi.visible = !!top;
      if (top) {
        const pos = cur.hi.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let k = 0; k <= 64; k++) {
          const a = (k / 64) * Math.PI * 2;
          v1.set(Math.cos(a) * top.orbit, 0, -Math.sin(a) * top.orbit).applyQuaternion(planeQ[top.type.plane]);
          pos.setXYZ(k, v1.x, v1.y, v1.z);
        }
        pos.needsUpdate = true;
        (cur.hi.material as THREE.LineBasicMaterial).color.copy(top.base);
      }
      // tooltip
      if (hiB) {
        tipStrings = [truncate(hiB.node.name, 34), bodyMeta(hiB) + (hiB.kind === 'moon' ? `  ·  in ${truncate(cur.bodies[hiB.parent].node.name, 16)}` : '')];
        tipName.set(tipStrings[0]);
        tipMeta.set(tipStrings[1]);
        fitTip();
        for (const l of labels) if (l.body === i) { l.body = -1; l.pivot.visible = false; }
      }
      tipPivot.visible = !!hiB && !tr;
      writeBodies(cur, 1);
      positionLabels();
    }
    function refreshHover(): void {
      const part = hoverParts.right ?? hoverParts.left ?? '';
      let bi = -1, ai = -1;
      if (part.startsWith('b:') && cur) {
        const [, g, i] = part.split(':');
        if (Number(g) === cur.gen) bi = Number(i);
      } else if (part.startsWith('a:')) ai = Number(part.slice(2));
      setHovered(bi);
      if (ai !== hoveredAnc) { hoveredAnc = ai; colorAnc(); }
    }

    // ---- preview screen -----------------------------------------------------------------------
    let preview: Preview | null = null;
    let pendingPreview = '';
    let pv: THREE.Group | null = null;
    let pvBody: Text | null = null, pvNums: Text | null = null;
    let pvAnim = 1;
    const pvFrom = new T.Vector3();
    let pvBodyIdx = -1;
    let imageTex: THREE.Texture | null = null;
    let textScroll = 0;
    let hlLines: string[] = [], hlSpans: Span[][] = [], hlLang = '';
    let pvDirty = false;
    const leaderGeo = new T.BufferGeometry();
    leaderGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(6), 3));
    const leader = new T.Line(leaderGeo, new T.LineBasicMaterial({ color: theme.textDim, transparent: true, opacity: 0.55, depthWrite: false }));
    leader.raycast = noRaycast;
    leader.frustumCulled = false;
    leader.visible = false;
    ctx.root.add(leader);
    const pvFinal = () => v2.set(ctx.props.radius + 0.07 + PW / 2, 0.04, 0.08);
    const previewLines = () => Math.floor((PH - 2 * 0.016 - 0.06) / LINE_H);

    function openPreview(path: string, fromIdx: number): void {
      pendingPreview = path;
      if (cur && fromIdx >= 0 && cur.bodies[fromIdx]) toRoot(cur, cur.bodies[fromIdx].pos, pvFrom);
      else pvFrom.set(0, 0, 0);
      request('preview', path);
    }
    function closePreview(): void {
      preview = null;
      pendingPreview = '';
      if (pv) disposeTree(pv);
      pv = null;
      pvBody = pvNums = null;
      imageTex?.dispose();
      imageTex = null;
      leader.visible = false;
      pvBodyIdx = -1;
      if (cur) recolor(cur);
    }
    function findPreviewBody(): void {
      pvBodyIdx = preview && cur ? cur.bodies.findIndex((b) => b.node.path === preview!.path) : -1;
      if (cur) recolor(cur);
    }
    function buildPreview(p: Preview): void {
      if (pv) disposeTree(pv);
      imageTex?.dispose();
      imageTex = null;
      pvBody = pvNums = null;
      const g = (pv = new T.Group());
      g.name = 'preview';
      const w = PW, h = PH, PAD = 0.016;
      g.add(ctx.ui.panel(w, h));
      const x0 = -w / 2 + PAD, x1 = w / 2 - PAD, top = h / 2 - PAD;
      const t = typeOf({ type: 'file', ext: p.name.includes('.') ? p.name.split('.').pop()!.toLowerCase() : '', name: p.name });
      const ic = makeIcon(ctx, t.icon, { size: 0.02, color: t.color });
      ic.position.set(x0 + 0.01, top - 0.013, STYLE.zText);
      const title = makeText(ctx, truncate(p.name, 34), { size: 0.0145, anchorX: 'left', anchorY: 'middle', color: theme.text, weight: 'semibold', whiteSpace: 'nowrap' });
      title.position.set(x0 + 0.027, top - 0.013, STYLE.zText);
      const age = ageShort(p.mtime ?? null);
      const meta = makeText(ctx, [fmtBytes(p.size), age ? `modified ${age === 'now' ? 'just now' : `${age} ago`}` : '', p.type === 'text' ? `${p.lines} lines${p.truncated ? ' (first 64 KB)' : ''}` : ''].filter(Boolean).join(' · '),
        { size: 0.0105, anchorX: 'left', anchorY: 'middle', color: theme.textDim, whiteSpace: 'nowrap' });
      meta.position.set(x0 + 0.027, top - 0.033, STYLE.zText);
      g.add(ic, title, meta);
      const btn = (id: string, icon: string, x: number) => {
        const d = 0.03;
        const b = ctx.ui.panel(d, d, { color: theme.surface, radius: d / 2 });
        b.position.set(x, top - 0.015, STYLE.zContent);
        b.name = `pv:${id}`;
        ctx.interactive(b);
        const bi = makeIcon(ctx, icon, { size: d * 0.55, color: theme.text });
        bi.position.z = STYLE.zText;
        b.add(bi);
        g.add(b);
      };
      btn('close', 'x', x1 - 0.015);
      btn('ask', 'message-square', x1 - 0.053);
      const bodyTop = top - 0.055, bodyH = h - 2 * PAD - 0.055;
      if (p.type === 'text') {
        pvNums = makeText(ctx, '', { size: 0.0105, anchorX: 'right', anchorY: 'top', color: theme.textDim, font: 'mono', lineHeight: 1.25 });
        pvNums.position.set(x0 + 0.026, bodyTop, STYLE.zText);
        pvBody = makeText(ctx, '', { size: 0.0105, anchorX: 'left', anchorY: 'top', color: theme.text, font: 'mono', whiteSpace: 'nowrap', lineHeight: 1.25 });
        pvBody.position.set(x0 + 0.034, bodyTop, STYLE.zText);
        const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
        hit.scale.set(w - PAD, bodyH, 0.01);
        hit.position.set(0, bodyTop - bodyH / 2, 0.004);
        hit.name = 'pv:text';
        ctx.interactive(hit);
        g.add(pvNums, pvBody, hit);
        const lang = languageFor(p.name);
        hlLines = (p.text ?? '').replace(/\t/g, '  ').split('\n');
        hlSpans = highlight(hlLines.join('\n'), lang);
        hlLang = lang?.id ?? '';
      } else if (p.type === 'image' && p.src && typeof document !== 'undefined') {
        const mat = new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
        const img = new T.Mesh(sharedGeometry(T, 'plane'), mat);
        img.raycast = noRaycast;
        img.visible = false;
        img.position.set(0, bodyTop - bodyH / 2, STYLE.zContent);
        g.add(img);
        imageTex = new T.TextureLoader().load(p.src, (tex) => {
          if (imageTex !== tex) return;
          tex.colorSpace = T.SRGBColorSpace;
          const im = tex.image as { width: number; height: number };
          const a = im.width / im.height, bw = w - 2 * PAD, bh = bodyH;
          img.scale.set(a > bw / bh ? bw : bh * a, a > bw / bh ? bw / a : bh, 1);
          mat.map = tex;
          mat.needsUpdate = true;
          img.visible = true;
        }, undefined, () => ctx.error(`fb-orbit: could not load ${p.src}`));
      } else {
        const msg = p.type === 'binary' ? 'Binary file: no preview' : p.type === 'denied' ? (p.error ?? 'Private file') : p.type === 'image' ? 'Image preview appears in the headset / browser' : (p.error ?? 'No preview');
        const tx = makeText(ctx, msg, { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: w - 0.06, textAlign: 'center' });
        tx.position.set(0, bodyTop - bodyH / 2, STYLE.zText);
        g.add(tx);
      }
      if (p.type !== 'text') { hlLines = []; hlSpans = []; hlLang = ''; }
      new Billboard(T, g, 'yaw').attach();
      g.position.copy(pvFrom);
      g.scale.setScalar(0.05);
      pvAnim = 0;
      ctx.root.add(g);
      textScroll = 0;
      pvDirty = true;
    }
    function renderPreviewText(): void {
      if (!pvBody || !pvNums) return;
      const visible = previewLines();
      const from = Math.min(Math.max(0, Math.round(textScroll)), Math.max(0, hlLines.length - visible));
      textScroll = Math.min(textScroll, Math.max(0, hlLines.length - visible));
      const lines = hlLines.slice(from, from + visible);
      const cols = Math.floor((PW - 0.07) / (0.0105 * 0.6));
      const shown = lines.map((l) => (l.length > cols ? l.slice(0, cols - 1) + '…' : l));
      pvBody.set(shown.join('\n'));
      const clips = shown.map((l, i) => (l.length < lines[i].length ? l.length - 1 : l.length));
      setColorRanges(pvBody, hlLang ? colorRanges(hlSpans.slice(from, from + visible), shown.map((l) => l.length), syntaxInts, hexToInt(theme.text), clips) : null);
      pvNums.set(lines.map((_, i) => String(from + i + 1)).join('\n'));
    }

    // ---- navigation ---------------------------------------------------------------------------
    function cached(p: string): { r: TreeReply; at: number } | null {
      for (const c of cache.values()) if (matches(c.r, p)) return c;
      return null;
    }
    function navigate(p: string, fromIdx: number): void {
      want = p;
      wantFrom = cur && fromIdx >= 0 ? { gen: cur.gen, idx: fromIdx } : null;
      wantAt = clock;
      message = '';
      const c = cached(p);
      if (c && clock - c.at < FRESH) {
        want = null;
        show(c.r);
        if (clock - c.at > 15) request('tree', c.r.path);
      } else request('tree', p);
      dirty = true;
    }
    function onTree(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as TreeReply).kind !== 'tree' || typeof (v as TreeReply).path !== 'string') return;
      const r = v as TreeReply;
      learnHome(r);
      const ok = !!r.root && !r.error && typeof r.root === 'object';
      if (ok) {
        cache.delete(r.path);
        cache.set(r.path, { r, at: clock });
        while (cache.size > 16) cache.delete(cache.keys().next().value as string);
      }
      inFlight.delete(r.path);
      if (r.display) inFlight.delete(r.display);
      if (want && matches(r, want)) {
        want = null;
        if (!ok) { wantFrom = null; message = r.error ?? 'Cannot read this folder'; updateSunLabel(); dirty = true; return; }
        show(r);
        return;
      }
      // a fresher scan of what we're showing (other clients ask too): rebuild in place only if it changed
      if (ok && cur && !tr && !want && r.path === cur.reply.path && sigOf(r) !== cur.sig) show(r);
    }
    function onPreview(v: ChannelValue): void {
      if (!v || typeof v !== 'object' || isTensor(v) || (v as Preview).kind !== 'preview') return;
      const got = (v as Preview).path;
      if (!pendingPreview || (got !== pendingPreview && got !== absOf(pendingPreview))) return; // stale / someone else's
      if (preview && preview.path === got && pv && preview.text?.length === (v as Preview).text?.length && preview.src === (v as Preview).src) return; // duplicate (other client)
      preview = v as Preview;
      ctx.emit('selected', got);
      buildPreview(preview);
      findPreviewBody();
    }
    function subscribe(): void {
      for (const o of offs.splice(0)) o();
      offs.push(ctx.channels.subscribe(treeCh(), onTree));
      offs.push(ctx.channels.subscribe(previewCh(), onPreview));
    }

    function activate(i: number): void {
      if (!cur) return;
      const b = cur.bodies[i];
      if (!b) return;
      if (b.node.type === 'dir') { closePreview(); navigate(b.node.path, i); return; }
      if (b.kind === 'moon') {
        // a file moon: fly into its planet, preview the file there
        const p = cur.bodies[b.parent];
        closePreview();
        openPreview(b.node.path, i);
        navigate(p.node.path, b.parent);
        return;
      }
      if (preview && preview.path === b.node.path) { closePreview(); return; } // tap again = close
      openPreview(b.node.path, i);
    }
    function tap(part: string): void {
      const [kind, a, b] = part.split(':');
      if (kind === 'b') { if (cur && Number(a) === cur.gen) activate(Number(b)); return; }
      if (kind === 's') { if (cur) { wantAt = clock; want = cur.reply.path; wantFrom = null; request('tree', cur.reply.path); } return; }
      if (kind === 'a') { const p = ancPaths[Number(a)]; if (p) { closePreview(); navigate(p, -1); } return; }
      if (part === 'pv:close') { closePreview(); return; }
      if (part === 'pv:ask' && preview) ctx.askAgent(`Take a look at this file and tell me about it: ${preview.path}`);
    }

    // ---- build --------------------------------------------------------------------------------
    let dirty = true;
    buildGuides();
    buildLabelPool();
    updateSunLabel();
    subscribe();                      // a reply already on the channel may restore the view instantly
    const shownNow = (): Sys | null => cur;
    if (want) { wantAt = clock; request('tree', want); }
    else { const c = shownNow(); if (c) request('tree', c.reply.path); } // refresh what the channel held

    return {
      onProps(p, prev) {
        if (p.prefix !== prev.prefix) { subscribe(); navigate(String(p.path || '~'), -1); return; }
        if (p.labels !== prev.labels) { buildLabelPool(); relabel(); }
        if (p.radius !== prev.radius || p.guides !== prev.guides) buildGuides();
        if (p.radius !== prev.radius || p.maxBodies !== prev.maxBodies) { if (cur && !tr) { const r = cur.reply; const old = cur; cur = null; disposeSys(old); show(r); } }
        if (p.showHidden !== prev.showHidden) { cache.clear(); navigate(cur?.reply.path ?? String(p.path || '~'), -1); }
        else if (p.path !== prev.path && (!cur || !matches(cur.reply, String(p.path || '~'))) && want !== p.path) navigate(String(p.path || '~'), -1);
        dirty = true;
      },
      onInput(port, v) {
        if (typeof v !== 'string' || !v.trim()) { ctx.error(`fb-orbit: '${port}' expects a path string`); return; }
        if (port === 'path') { closePreview(); navigate(v.trim(), -1); }
        if (port === 'preview') openPreview(v.trim(), cur ? cur.bodies.findIndex((b) => b.node.path === v.trim()) : -1);
      },
      onInteraction(e: InteractionEvent) {
        const part = e.objectName ?? '';
        if (e.handler === 'hover') {
          hoverParts[e.hand === 'left' ? 'left' : 'right'] = e.phase === 'end' || e.phase === 'cancel' ? null : part;
          lastInteract = clock;
          refreshHover();
          return;
        }
        if (e.handler !== 'drag' && e.handler !== 'press') return;
        lastInteract = clock;
        const lp = e.localPoint;
        if (e.phase === 'start') {
          if (press) return;
          press = { hand: e.hand, part, x0: lp[0], y0: lp[1], z0: lp[2], yaw0: yaw, pitch0: pitch, scroll0: textScroll, mode: 'tap' };
          vYaw = vPitch = 0;
          return;
        }
        if (!press || e.hand !== press.hand) return;
        if (e.phase === 'move') {
          const dx = lp[0] - press.x0, dy = lp[1] - press.y0, dz = lp[2] - press.z0;
          if (press.mode === 'tap' && dx * dx + dy * dy + dz * dz > TAP_SLOP * TAP_SLOP) {
            press.mode = press.part === 'pv:text' ? 'scroll' : press.part.startsWith('pv:') ? 'none' : 'rotate';
            // re-anchor so the rotation doesn't jump by the slop
            press.x0 = lp[0]; press.y0 = lp[1]; press.z0 = lp[2];
          }
          if (press.mode === 'rotate') {
            yaw = press.yaw0 + (lp[0] - press.x0) * ROT_K;
            pitch = Math.max(-1.2, Math.min(1.4, press.pitch0 - (lp[1] - press.y0) * ROT_K));
            applyRotation();
          } else if (press.mode === 'scroll') {
            textScroll = Math.max(0, press.scroll0 + (lp[1] - press.y0) / LINE_H);
            pvDirty = true;
          }
          return;
        }
        const p = press;
        press = null;
        if (e.phase !== 'end') { vYaw = vPitch = 0; return; } // cancelled: never act
        if (p.mode === 'tap') tap(p.part);
      },
      update(dt) {
        const step = Math.min(0.1, Math.max(0, dt || 0));
        clock += step;
        // rotation inertia
        if (press?.mode === 'rotate' && step > 0) {
          vYaw = vYaw * 0.5 + ((yaw - lastYaw) / step) * 0.5;
          vPitch = vPitch * 0.5 + ((pitch - lastPitch) / step) * 0.5;
        } else if (!press && (Math.abs(vYaw) > 0.01 || Math.abs(vPitch) > 0.01)) {
          yaw += vYaw * step;
          pitch = Math.max(-1.2, Math.min(1.4, pitch + vPitch * step));
          const k = Math.exp(-4 * step);
          vYaw *= k; vPitch *= k;
          applyRotation();
        }
        const rotated = yaw !== lastYaw || pitch !== lastPitch;
        lastYaw = yaw; lastPitch = pitch;

        // navigation transition
        if (tr && cur) {
          tr.t += step;
          const k = Math.min(1, tr.t / DUR), e = ease(k);
          cur.group.position.lerpVectors(tr.nfP, ORIGIN, e);
          cur.group.scale.setScalar(expLerp(tr.nfS, 1, e));
          tr.old.group.position.lerpVectors(tr.ofP, tr.otP, e);
          tr.old.group.scale.setScalar(expLerp(tr.ofS, tr.otS, e));
          if (k >= 1) {
            disposeSys(tr.old);
            tr = null;
            cur.group.position.set(0, 0, 0);
            cur.group.scale.setScalar(1);
            finishShow();
          }
        }

        // drift (≤ 30 Hz; paused while interacting, transitioning or loading-pulsing)
        const interacting = !!press || !!hoverParts.left || !!hoverParts.right || clock - lastInteract < 1.2;
        const loading = !!want && clock - wantAt > 0.12;
        let moved = rotated || !!tr;
        if (cur && ctx.props.drift && !interacting && !tr) {
          simT += step;
          driftAcc += step;
          if (driftAcc >= 1 / 30) { driftAcc = 0; writeBodies(cur, 1); moved = true; }
        }
        if (cur && loading) {
          const pulse = 1 + 0.18 * Math.sin(clock * 9);
          writeBodies(cur, pulse);
          cur.halo.scale.setScalar(2 * HALO_R * cur.u * (1 + 0.08 * Math.sin(clock * 6)));
          moved = true;
        } else if (cur && cur.halo.scale.x !== 2 * HALO_R * cur.u) cur.halo.scale.setScalar(2 * HALO_R * cur.u);

        // hover prefetch: dwell on a folder → scan it so the pinch is instant
        if (cur && hovered >= 0 && clock - hoverSince > 0.35) {
          const b = cur.bodies[hovered];
          if (b && b.node.type === 'dir' && !b.node.skipped) {
            const c = cached(b.node.path);
            if ((!c || clock - c.at > FRESH) && !inFlight.has(b.node.path)) request('tree', b.node.path);
          }
        }

        if (moved || dirty) positionLabels();
        if (clock - relabelAt > 0.6 && !tr) relabel();
        if (watch.changed()) {
          fitSun(); fitTip();
          for (const l of labels) if (l.body >= 0) fitPlate(l.plate, l.text, (l.text as unknown as { text: string }).text ?? '', 0.014, 0.006, 0.022);
        }
        if (dirty || loading || (want && clock - wantAt > 5 && clock - wantAt < 5.2)) updateSunLabel();
        dirty = false;

        // preview: unfold + leader line + text
        if (pv) {
          if (pvAnim < 1) {
            pvAnim = Math.min(1, pvAnim + step / 0.35);
            const e = ease(pvAnim);
            pv.position.lerpVectors(pvFrom, pvFinal(), e);
            pv.scale.setScalar(0.05 + 0.95 * e);
          }
          if (pvDirty) { pvDirty = false; renderPreviewText(); }
          if (cur && !tr && pvBodyIdx >= 0 && cur.bodies[pvBodyIdx]) {
            const pos = leaderGeo.getAttribute('position') as THREE.BufferAttribute;
            toRoot(cur, cur.bodies[pvBodyIdx].pos, v1);
            v2.set(-PW / 2 * pv.scale.x, 0, 0).applyQuaternion(pv.quaternion).add(pv.position);
            pos.setXYZ(0, v1.x, v1.y, v1.z);
            pos.setXYZ(1, v2.x, v2.y, v2.z);
            pos.needsUpdate = true;
            leader.visible = true;
          } else leader.visible = false;
        }
      },
      dispose() {
        for (const o of offs.splice(0)) o();
        imageTex?.dispose();
        if (tr) disposeSys(tr.old);
        if (cur) disposeSys(cur);
        if (pv) disposeTree(pv);
        disposeTree(stage);
      },
    };
  },
};

export default definition;
