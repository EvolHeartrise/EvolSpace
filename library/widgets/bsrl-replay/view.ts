// The replay diorama: platform + lanes, the FK body, sabers with swept trails, notes/bombs/chains,
// walls, cut debris, miss/bad markers, flying scores and the in-game HUD — everything in BeatSaberRL
// world units inside one scaled group. World (x right, y up, notes from +z) maps to the group's
// scene coords as (x, y, -z), like the original viewer; the group puts the player's feet at the
// widget origin (shifted down by `floorOffset`).
//
// Allocation-free per frame: instanced meshes with preallocated matrices/colors, a pooled set of
// popup texts with stable note→slot assignment, HUD strings rebuilt only when the tick changes.

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { sharedGeometry, shadedGeometry, ownMaterial, hitMaterial } from '../../shared/resources.ts';
import { SegmentMath } from '../../shared/segments.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { BodyFK, F, poseAt } from './fk.ts';
import { C, H, KIND, OUTCOME, REASONS, lowerBound, gradeOf, formatScore, type Replay } from './data.ts';

type Three = typeof THREE;

export interface ViewOptions {
  scale: number;
  trackLength: number;
  showTrails: boolean;
  trailSeconds: number;
  showHud: boolean;
}

const NOTE_COLORS = ['#c81414', '#288ed2'];
const SABER_COLORS = ['#ff4646', '#40aaff'];
const HANDLE_COLORS = ['#7c3b41', '#33586f'];
const BODY = { trunk: '#f4f6fa', legs: '#d9dee8', armL: '#eca7ac', armR: '#a0cff5', visor: '#1b2030' };
const MARK = { bad: '#f0a35e', miss: '#e06c75', bomb: '#ff4a4a' };
const NOTE_SIZE = 0.45;
const AFTER = 0.7; // s: aftermath window (markers, popups)
const DEBRIS = 0.35; // s: lifetime of cut halves
const TRAIL_K = 14; // samples per saber trail
const POPUPS = 10;
const PLAYER_Z = -0.65;

const noRaycast = () => {};

export class ReplayView {
  readonly group: THREE.Group;
  private readonly T: Three;
  private rep: Replay | null = null;
  private readonly fk = new BodyFK();
  private readonly pose = new Float64Array(36);
  private readonly seg: SegmentMath;
  private readonly m4: THREE.Matrix4;
  private readonly v3: THREE.Vector3;
  private readonly v3b: THREE.Vector3;
  private readonly s3: THREE.Vector3;
  private readonly q4: THREE.Quaternion;
  private readonly zAxis: THREE.Vector3;
  private readonly tmpA = new Float64Array(3);
  private readonly tmpB = new Float64Array(3);
  private readonly tmpC = new Float64Array(3);
  private readonly col: Record<string, THREE.Color> = {};

  private cyl!: THREE.InstancedMesh;
  private sph!: THREE.InstancedMesh;
  private boxes!: THREE.InstancedMesh;
  private sabers!: THREE.InstancedMesh;
  private trails: THREE.Mesh[] = [];
  private notes!: THREE.InstancedMesh;
  private arrows!: THREE.InstancedMesh;
  private dots!: THREE.InstancedMesh;
  private bombs!: THREE.InstancedMesh;
  private walls!: THREE.InstancedMesh;
  private debris!: THREE.InstancedMesh;
  private marks!: THREE.InstancedMesh;
  private popups: Text[] = [];
  private popupNote = new Int32Array(POPUPS).fill(-1);
  private popupSeen = new Uint8Array(POPUPS);

  // HUD
  private hud!: THREE.Group;
  private hudTitle!: Text;
  private hudCombo!: Text;
  private hudScore!: Text;
  private hudAcc!: Text;
  private hudMult!: Text;
  private hudMisses!: Text;
  private ring!: THREE.Mesh;
  private energyFill!: THREE.Mesh;
  private energyMat!: THREE.MeshBasicMaterial;
  private lastHudTick = -2;
  private lastLow = false;

  constructor(private readonly ctx: WidgetContext, private readonly o: ViewOptions) {
    const T = (this.T = ctx.THREE);
    this.seg = new SegmentMath(T);
    this.m4 = new T.Matrix4();
    this.v3 = new T.Vector3();
    this.v3b = new T.Vector3();
    this.s3 = new T.Vector3();
    this.q4 = new T.Quaternion();
    this.zAxis = new T.Vector3(0, 0, 1);
    for (const [k, hex] of Object.entries({
      ...BODY, n0: NOTE_COLORS[0], n1: NOTE_COLORS[1], s0: SABER_COLORS[0], s1: SABER_COLORS[1],
      h0: HANDLE_COLORS[0], h1: HANDLE_COLORS[1], ...MARK, bombc: '#3c3c48', white: '#ffffff',
    })) this.col[k] = new T.Color(hex);

    const s = o.scale;
    const g = (this.group = new T.Group());
    g.name = 'diorama';
    g.scale.setScalar(s);
    g.position.set(0, -1.2 * s, PLAYER_Z * s);
    this.build();
  }

  /** Scene-space bounds of everything the diorama draws. */
  private bounds(): THREE.Box3 {
    const L = this.o.trackLength;
    return new this.T.Box3(new this.T.Vector3(-3.2, -0.1, -L - 0.5), new this.T.Vector3(3.2, 3.2, 2.2));
  }

  private inst(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, colored: boolean): THREE.InstancedMesh {
    const T = this.T;
    const m = new T.InstancedMesh(geo, mat, cap);
    if (colored) m.setColorAt(0, this.col.white);
    m.count = 0;
    m.frustumCulled = false;
    m.raycast = noRaycast;
    const box = this.bounds();
    m.boundingBox = box;
    m.boundingSphere = box.getBoundingSphere(new T.Sphere());
    this.group.add(m);
    return m;
  }

  private build(): void {
    const T = this.T, g = this.group, theme = this.ctx.theme, L = this.o.trackLength;

    // platform with cyan edge strips (the original's), lanes on the floor, the hit line
    const plat = new T.Mesh(shadedGeometry(T, 'box'), ownMaterial(T, '#1a2130', { shaded: true }));
    plat.scale.set(3, 0.05, 2);
    plat.position.set(0, -0.025, -PLAYER_Z);
    plat.raycast = noRaycast;
    g.add(plat);
    for (const z of [-PLAYER_Z - 1, -PLAYER_Z + 1]) {
      const strip = new T.Mesh(sharedGeometry(T, 'box'), ownMaterial(T, '#45d4ff'));
      strip.scale.set(3, 0.014, 0.025);
      strip.position.set(0, 0.008, z);
      strip.raycast = noRaycast;
      g.add(strip);
    }
    const lane: number[] = [];
    for (const x of [-1.2, -0.6, 0, 0.6, 1.2]) lane.push(x, 0.003, 0, x, 0.003, -L);
    lane.push(-1.2, 0.003, 0, 1.2, 0.003, 0);
    const laneGeo = new T.BufferGeometry();
    laneGeo.setAttribute('position', new T.Float32BufferAttribute(lane, 3));
    const lanes = new T.LineSegments(laneGeo, new T.LineBasicMaterial({ color: theme.border, transparent: true, opacity: 0.7 }));
    lanes.raycast = noRaycast;
    g.add(lanes);

    // an invisible grab volume over the platform + body (the diorama itself is not hit-tested)
    const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
    hit.scale.set(3.2, 2.4, 2.4);
    hit.position.set(0, 1.2, -PLAYER_Z + 0.2);
    hit.name = 'diorama';
    g.add(hit);

    const shadedWhite = () => ownMaterial(T, '#ffffff', { shaded: true });
    this.cyl = this.inst(shadedGeometry(T, 'cylinder'), shadedWhite(), 16, true);
    this.sph = this.inst(shadedGeometry(T, 'sphere'), shadedWhite(), 24, true);
    this.boxes = this.inst(shadedGeometry(T, 'box'), shadedWhite(), 4, true);
    this.sabers = this.inst(sharedGeometry(T, 'cylinder'), ownMaterial(T, '#ffffff'), 4, true);

    // swept saber trails: a quad strip between blade base and tip over the last trailSeconds,
    // additive so it fades to nothing without sorting
    const idx: number[] = [];
    for (let j = 0; j < TRAIL_K - 1; j++) idx.push(2 * j, 2 * j + 1, 2 * j + 2, 2 * j + 1, 2 * j + 3, 2 * j + 2);
    for (let h = 0; h < 2; h++) {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(TRAIL_K * 6), 3));
      geo.setAttribute('color', new T.BufferAttribute(new Float32Array(TRAIL_K * 6), 3));
      geo.setIndex(idx);
      geo.boundingSphere = this.bounds().getBoundingSphere(new T.Sphere());
      const mat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
      const mesh = new T.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.raycast = noRaycast;
      g.add(mesh);
      this.trails.push(mesh);
    }

    this.notes = this.inst(shadedGeometry(T, 'box'), shadedWhite(), 256, true);
    this.arrows = this.inst(arrowGeometry(T), ownMaterial(T, '#ffffff'), 256, false);
    this.dots = this.inst(sharedGeometry(T, 'disc'), ownMaterial(T, '#ffffff'), 256, false);
    this.bombs = this.inst(shadedGeometry(T, 'ico'), ownMaterial(T, '#5a5a6a', { shaded: true }), 128, false);
    this.walls = this.inst(sharedGeometry(T, 'box'), ownMaterial(T, '#ff2f2f', { opacity: 0.34 }), 64, false);
    this.debris = this.inst(shadedGeometry(T, 'box'), shadedWhite(), 64, true);
    this.marks = this.inst(sharedGeometry(T, 'ring'), ownMaterial(T, '#ffffff', { doubleSide: true }), 32, true);

    for (let i = 0; i < POPUPS; i++) {
      const t = makeText(this.ctx, '', { size: 0.16, anchorX: 'center', anchorY: 'middle', font: 'sans', weight: 'semibold' });
      t.visible = false;
      g.add(t);
      this.popups.push(t);
    }

    this.buildHud();
  }

  private buildHud(): void {
    const T = this.T, theme = this.ctx.theme;
    const hud = (this.hud = new T.Group());
    hud.position.set(0, 0, -4); // world z = +4, down the track, facing the player (and the viewer)
    const text = (s: string, size: number, x: number, y: number, ax: 'left' | 'center' | 'right', color = theme.text, mono = false) => {
      const t = makeText(this.ctx, s, { size, anchorX: ax, anchorY: 'middle', color, font: mono ? 'mono' : 'sans', weight: 'semibold' });
      t.position.set(x, y, 0);
      hud.add(t);
      return t;
    };
    this.hudTitle = text('', 0.17, 0, 2.55, 'center', theme.textDim);
    text('COMBO', 0.13, -2.3, 2.0, 'center', theme.textDim);
    this.hudCombo = text('0', 0.34, -2.3, 1.72, 'center');
    this.hudScore = text('0', 0.22, -2.3, 1.3, 'center', theme.text, true);
    this.hudAcc = text('', 0.16, -2.3, 1.02, 'center', theme.textDim, true);
    this.hudMult = text('×1', 0.2, 2.3, 1.72, 'center');
    text('MISSES', 0.11, 2.3, 1.25, 'center', theme.textDim);
    this.hudMisses = text('0', 0.2, 2.3, 1.02, 'center', theme.text, true);

    const ringBg = new T.Mesh(new T.RingGeometry(0.24, 0.28, 48), ownMaterial(T, theme.border, { doubleSide: true }));
    ringBg.position.set(2.3, 1.72, -0.01);
    // filled clockwise from the top: segments are indexed by angle, a draw range shows a partial ring
    this.ring = new T.Mesh(new T.RingGeometry(0.24, 0.28, 48, 1, Math.PI / 2, -Math.PI * 2), ownMaterial(T, theme.accent, { doubleSide: true }));
    this.ring.position.set(2.3, 1.72, 0);
    const barBg = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
    barBg.scale.set(2.6, 0.07, 1);
    barBg.position.set(0, 0.12, -0.01);
    this.energyMat = ownMaterial(T, '#f4f6fa');
    this.energyFill = new T.Mesh(sharedGeometry(T, 'plane'), this.energyMat);
    this.energyFill.position.set(0, 0.12, 0);
    for (const m of [ringBg, this.ring, barBg, this.energyFill]) { m.raycast = noRaycast; hud.add(m); }
    hud.visible = this.o.showHud;
    this.group.add(hud);
  }

  setReplay(rep: Replay | null): void {
    this.rep = rep;
    this.lastHudTick = -2;
    this.popupNote.fill(-1);
    for (const p of this.popups) p.visible = false;
    if (rep) {
      const m = rep.meta;
      const pp = m.pp > 0 ? ` · ${Math.round(m.pp)} pp` : '';
      this.hudTitle.set(`${m.song} · ${m.difficulty}${m.model ? ` · ${m.model}` : ''}${pp}`);
    } else this.hudTitle.set('');
    for (const im of [this.cyl, this.sph, this.boxes, this.sabers, this.notes, this.arrows, this.dots, this.bombs, this.walls, this.debris, this.marks]) im.count = 0;
    for (const t of this.trails) t.visible = false;
  }

  /** Draw the replay at `time` seconds. */
  render(time: number): void {
    const rep = this.rep;
    if (!rep) return;
    poseAt(rep.q, rep.T, rep.hz, time, this.pose);
    this.fk.compute(this.pose);
    this.renderBody();
    this.renderSabers(rep, time);
    const zOff = rep.meta.trackAnchor === 'head' ? this.fk.p[F.HEAD * 3 + 2] - PLAYER_Z : 0;
    this.renderNotes(rep, time, zOff);
    this.renderWalls(rep, time, zOff);
    if (this.o.showHud) this.renderHud(rep, time);
  }

  // ---- body ------------------------------------------------------------------------------------

  private ci = 0;
  private si = 0;
  private cylAt(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, r: number, color: THREE.Color): void {
    this.seg.rod(this.m4, a[ao], a[ao + 1], -a[ao + 2], b[bo], b[bo + 1], -b[bo + 2], r);
    this.cyl.setMatrixAt(this.ci, this.m4);
    this.cyl.setColorAt(this.ci++, color);
  }
  private sphAt(a: ArrayLike<number>, ao: number, r: number, color: THREE.Color): void {
    this.m4.makeScale(2 * r, 2 * r, 2 * r);
    this.m4.setPosition(a[ao], a[ao + 1], -a[ao + 2]);
    this.sph.setMatrixAt(this.si, this.m4);
    this.sph.setColorAt(this.si++, color);
  }
  /** Box of size (sx, sy, sz) at frame-local offset, oriented by frame f (world→scene conjugated). */
  private boxAt(i: number, f: number, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: THREE.Color): void {
    const fk = this.fk, r = fk.r, o = f * 9, c = this.tmpC;
    fk.point(f, lx, ly, lz, c);
    // R' = D R D with D = diag(1, 1, -1)
    this.m4.set(
      r[o] * sx, r[o + 1] * sy, -r[o + 2] * sz, c[0],
      r[o + 3] * sx, r[o + 4] * sy, -r[o + 5] * sz, c[1],
      -r[o + 6] * sx, -r[o + 7] * sy, r[o + 8] * sz, -c[2],
      0, 0, 0, 1,
    );
    this.boxes.setMatrixAt(i, this.m4);
    this.boxes.setColorAt(i, color);
  }

  private renderBody(): void {
    const fk = this.fk, p = fk.p, c = this.col, a = this.tmpA, b = this.tmpB;
    this.ci = 0;
    this.si = 0;
    // trunk: chest capsule up 0.43 from the chest frame, pelvis capsule across the hips, neck
    fk.point(F.CHEST, 0, 0.43, 0, b);
    this.cylAt(p, F.CHEST * 3, b, 0, 0.15, c.trunk);
    this.sphAt(p, F.CHEST * 3, 0.15, c.trunk);
    this.sphAt(b, 0, 0.15, c.trunk);
    this.cylAt(b, 0, p, F.HEAD * 3, 0.05, c.trunk);
    const p0 = fk.p0, r0 = fk.r0;
    a[0] = p0[0] - 0.1 * r0[0]; a[1] = p0[1] - 0.1 * r0[3]; a[2] = p0[2] - 0.1 * r0[6];
    b[0] = p0[0] + 0.1 * r0[0]; b[1] = p0[1] + 0.1 * r0[3]; b[2] = p0[2] + 0.1 * r0[6];
    this.cylAt(a, 0, b, 0, 0.1, c.trunk);
    this.sphAt(a, 0, 0.1, c.trunk);
    this.sphAt(b, 0, 0.1, c.trunk);
    this.sphAt(p, F.HEAD * 3, 0.1, c.trunk);
    // arms
    for (const [sh, el, wr, hand, col] of [
      [F.L_SHOULDER, F.L_ELBOW, F.L_WRIST, F.L_HAND, c.armL],
      [F.R_SHOULDER, F.R_ELBOW, F.R_WRIST, F.R_HAND, c.armR],
    ] as const) {
      this.cylAt(p, sh * 3, p, el * 3, 0.045, col);
      this.cylAt(p, el * 3, p, wr * 3, 0.04, col);
      this.sphAt(p, sh * 3, 0.055, col);
      this.sphAt(p, el * 3, 0.042, col);
      fk.point(hand, 0, 0, 0.06, a);
      this.sphAt(a, 0, 0.05, col);
    }
    // legs
    for (const [th, sk, an] of [[F.L_THIGH, F.L_SHANK, F.L_ANKLE], [F.R_THIGH, F.R_SHANK, F.R_ANKLE]] as const) {
      this.cylAt(p, th * 3, p, sk * 3, 0.06, c.legs);
      this.cylAt(p, sk * 3, p, an * 3, 0.045, c.legs);
      this.sphAt(p, th * 3, 0.06, c.legs);
      this.sphAt(p, sk * 3, 0.05, c.legs);
      this.sphAt(p, an * 3, 0.045, c.legs);
    }
    this.boxAt(0, F.L_FOOT, 0, -0.035, 0.05, 0.09, 0.07, 0.25, c.legs);
    this.boxAt(1, F.R_FOOT, 0, -0.035, 0.05, 0.09, 0.07, 0.25, c.legs);
    // a visor on the head's gaze side (+z of the head frame) shows where it looks
    this.boxAt(2, F.HEAD, 0, 0.015, 0.085, 0.13, 0.045, 0.04, c.visor);
    commit(this.cyl, this.ci);
    commit(this.sph, this.si);
    commit(this.boxes, 3);
  }

  // ---- sabers + trails -------------------------------------------------------------------------

  private renderSabers(rep: Replay, time: number): void {
    const fk = this.fk, c = this.col, base = this.tmpA, tip = this.tmpB, grip = this.tmpC;
    const hl = rep.meta.handleLen;
    for (let h = 0 as 0 | 1; h < 2; h = (h + 1) as 0 | 1) {
      fk.saber(h, hl, base, tip, grip);
      this.seg.rod(this.m4, grip[0], grip[1], -grip[2], base[0], base[1], -base[2], 0.022);
      this.sabers.setMatrixAt(h * 2, this.m4);
      this.sabers.setColorAt(h * 2, h ? c.h1 : c.h0);
      this.seg.rod(this.m4, base[0], base[1], -base[2], tip[0], tip[1], -tip[2], 0.018);
      this.sabers.setMatrixAt(h * 2 + 1, this.m4);
      this.sabers.setColorAt(h * 2 + 1, h ? c.s1 : c.s0);
    }
    commit(this.sabers, 4);

    const show = this.o.showTrails && this.o.trailSeconds > 0;
    for (const t of this.trails) t.visible = show;
    if (!show) return;
    // sample the pose backwards in time (deterministic, so scrubbing and pausing look right)
    const step = this.o.trailSeconds / (TRAIL_K - 1);
    const pos = [this.trails[0].geometry.getAttribute('position'), this.trails[1].geometry.getAttribute('position')];
    const colA = [this.trails[0].geometry.getAttribute('color'), this.trails[1].geometry.getAttribute('color')];
    for (let j = 0; j < TRAIL_K; j++) {
      if (j > 0) {
        poseAt(rep.q, rep.T, rep.hz, time - j * step, this.pose);
        fk.compute(this.pose);
      }
      const fade = Math.pow(1 - j / (TRAIL_K - 1), 1.6) * 0.45;
      for (let h = 0 as 0 | 1; h < 2; h = (h + 1) as 0 | 1) {
        fk.saber(h, hl, base, tip, grip);
        const P = pos[h].array as Float32Array, Cc = colA[h].array as Float32Array, sc = h ? c.s1 : c.s0;
        const o = j * 6;
        P[o] = base[0]; P[o + 1] = base[1]; P[o + 2] = -base[2];
        P[o + 3] = tip[0]; P[o + 4] = tip[1]; P[o + 5] = -tip[2];
        // the base edge stays dim, the tip edge carries the glow
        Cc[o] = sc.r * fade * 0.25; Cc[o + 1] = sc.g * fade * 0.25; Cc[o + 2] = sc.b * fade * 0.25;
        Cc[o + 3] = sc.r * fade; Cc[o + 4] = sc.g * fade; Cc[o + 5] = sc.b * fade;
      }
    }
    for (let h = 0; h < 2; h++) { pos[h].needsUpdate = true; colA[h].needsUpdate = true; }
    // restore the current pose's FK for anything drawn after
    poseAt(rep.q, rep.T, rep.hz, time, this.pose);
    fk.compute(this.pose);
  }

  // ---- notes, bombs, effects -------------------------------------------------------------------

  private placeNote(x: number, y: number, z: number, roll: number, sx: number, sy: number, sz: number): void {
    this.v3.set(x, y, -z);
    this.q4.setFromAxisAngle(this.zAxis, roll);
    this.s3.set(sx, sy, sz);
    this.m4.compose(this.v3, this.q4, this.s3);
  }

  private renderNotes(rep: Replay, time: number, zOff: number): void {
    const L = this.o.trackLength, cd = rep.chart, c = this.col, hz = rep.hz;
    let ni = 0, ai = 0, di = 0, bi = 0, dbi = 0, mi = 0;
    const capN = this.notes.instanceMatrix.count, capB = this.bombs.instanceMatrix.count;
    const capD = this.debris.instanceMatrix.count, capM = this.marks.instanceMatrix.count;
    this.popupSeen.fill(0);
    const j0 = lowerBound(rep.times, time - 1.2);
    const tMax = time + (L + 1) / rep.minSpeed;
    for (let j = j0; j < rep.N && rep.times[j] <= tMax; j++) {
      const i = rep.order[j], o = i * C.N;
      const t = cd[o], x = cd[o + C.X], y = cd[o + C.Y], color = cd[o + C.COLOR] ? 1 : 0;
      const speed = cd[o + C.SPEED] || 18, kind = cd[o + C.KIND], any = cd[o + C.ANY] > 0;
      const rt = cd[o + C.RTICK], outcome = cd[o + C.OUTCOME];
      const roll = any || kind === KIND.BOMB ? 0 : cd[o + C.ANGLE] - 1.5 * Math.PI;
      const resolved = rt >= 0 && time >= (rt + 1) / hz;

      if (!resolved) {
        const zBase = (t - time) * speed;
        if (zBase > L || zBase < -0.65 - 1.5) continue;
        const z = zBase + zOff;
        const grow = Math.min(1, Math.max(0.05, (L - zBase) / 2));
        if (kind === KIND.BOMB) {
          if (bi >= capB) continue;
          const r = 0.4 * grow;
          this.placeNote(x, y, z, 0, r, r, r);
          this.bombs.setMatrixAt(bi++, this.m4);
          continue;
        }
        if (ni >= capN) continue;
        const link = kind === KIND.CHAIN_LINK;
        const s = NOTE_SIZE * grow;
        this.placeNote(x, y, z, roll, s, link ? s * 0.28 : s, s);
        this.notes.setMatrixAt(ni, this.m4);
        this.notes.setColorAt(ni++, color ? c.n1 : c.n0);
        // arrow (or dot) on the face toward the player
        this.v3b.set(0, link ? 0 : 0.05 * grow, s / 2 + 0.004).applyQuaternion(this.q4);
        this.v3.add(this.v3b);
        if (any || link) {
          const d = (link ? 0.09 : 0.14) * grow;
          this.s3.set(d, d, d);
          this.m4.compose(this.v3, this.q4, this.s3);
          this.dots.setMatrixAt(di++, this.m4);
        } else {
          this.s3.set(0.3 * grow, 0.3 * grow, 1);
          this.m4.compose(this.v3, this.q4, this.s3);
          this.arrows.setMatrixAt(ai++, this.m4);
        }
        continue;
      }

      // aftermath of a resolved object, at its position at the resolving tick
      const age = time - rt / hz;
      if (age < 0 || age >= AFTER) continue;
      const zr = (t - rt / hz) * speed + zOff;
      if (outcome === OUTCOME.GOOD && kind !== KIND.BOMB) {
        if (age < DEBRIS && dbi + 2 <= capD) {
          // two halves separate across the swing direction, spin a little and fall
          const life = 1 - age / DEBRIS, sep = 0.1 + 2.8 * age * 0.5;
          const nx = -Math.sin(roll + 1.5 * Math.PI), ny = Math.cos(roll + 1.5 * Math.PI);
          const fall = 0.5 * 9.81 * age * age;
          const link = kind === KIND.CHAIN_LINK;
          const s = NOTE_SIZE * life;
          for (const sgn of [-1, 1]) {
            this.placeNote(x + sgn * nx * sep, y + sgn * ny * sep - fall, zr, roll + 1.5 * Math.PI + sgn * 1.8 * age, s, (link ? 0.28 : 0.5) * s, s);
            this.debris.setMatrixAt(dbi, this.m4);
            this.debris.setColorAt(dbi++, color ? c.n1 : c.n0);
          }
        }
      } else if (mi < capM) {
        const grow = 0.55 + 0.5 * Math.min(1, age / 0.25);
        const s = (kind === KIND.BOMB ? 0.7 : 0.62) * grow;
        this.placeNote(x, y, zr, 0, s, s, s);
        this.marks.setMatrixAt(mi, this.m4);
        this.marks.setColorAt(mi++, outcome === OUTCOME.BAD ? c.bad : outcome === OUTCOME.BOMB ? c.bomb : c.miss);
      }
      if (kind !== KIND.BOMB || outcome === OUTCOME.BOMB) this.popup(i, outcome, cd[o + C.POINTS], cd[o + C.REASON], x, y, zr, age);
    }
    commit(this.notes, ni);
    commit(this.arrows, ai);
    commit(this.dots, di);
    commit(this.bombs, bi);
    commit(this.debris, dbi);
    commit(this.marks, mi);
    for (let k = 0; k < POPUPS; k++) {
      if (!this.popupSeen[k] && this.popupNote[k] >= 0) {
        this.popupNote[k] = -1;
        this.popups[k].visible = false;
      }
    }
  }

  /** Flying score for note i: eases away down the track (good) or up and away (bad/miss). */
  private popup(i: number, outcome: number, points: number, reason: number, x: number, y: number, z: number, age: number): void {
    let k = this.popupNote.indexOf(i);
    if (k < 0) {
      k = this.popupNote.indexOf(-1);
      if (k < 0) return;
      this.popupNote[k] = i;
      const t = this.popups[k];
      const good = outcome === OUTCOME.GOOD;
      t.set(good ? String(Math.round(points)) : outcome === OUTCOME.BAD ? `X ${REASONS[reason] ?? ''}` : outcome === OUTCOME.BOMB ? 'BOMB' : 'MISS');
      (t as unknown as { color: number }).color = good ? 0xffffff : 0xff3030;
    }
    this.popupSeen[k] = 1;
    const t = this.popups[k];
    const u = age / AFTER, e = 1 - Math.pow(1 - u, 4);
    const jitter = ((i * 2654435761) % 1000) / 1000 * 0.3 - 0.15;
    const good = outcome === OUTCOME.GOOD;
    const tx = x + jitter, ty = good ? y + 0.35 : 1.8, tz = good ? 6 : 7;
    t.position.set(x + (tx - x) * e, y + (ty - y) * e, -(z - 0.3 + (tz - z + 0.3) * e));
    const sc = u < 0.12 ? u / 0.12 : u > 0.65 ? Math.max(0, (1 - u) / 0.35) : 1;
    t.scale.setScalar(Math.max(0.001, sc));
    t.visible = true;
  }

  // ---- walls -----------------------------------------------------------------------------------

  private renderWalls(rep: Replay, time: number, zOff: number): void {
    const L = this.o.trackLength, w = rep.walls, cap = this.walls.instanceMatrix.count;
    let n = 0;
    for (let i = 0; i < rep.W && n < cap; i++) {
      const o = i * 7;
      const t = w[o], cx = w[o + 1], cy = w[o + 2], ww = w[o + 3], hh = w[o + 4], len = w[o + 5], speed = w[o + 6] || 18;
      const zf = (t - time) * speed - 0.25 + zOff;
      const z0 = Math.max(zf, -2.2), z1 = Math.min(zf + len, L);
      if (z1 <= z0) continue;
      this.v3.set(cx, cy, -(z0 + z1) / 2);
      this.q4.identity();
      this.s3.set(ww, hh, z1 - z0);
      this.m4.compose(this.v3, this.q4, this.s3);
      this.walls.setMatrixAt(n++, this.m4);
    }
    commit(this.walls, n);
  }

  // ---- HUD -------------------------------------------------------------------------------------

  private renderHud(rep: Replay, time: number): void {
    const k = Math.min(rep.T - 1, Math.floor(time * rep.hz));
    if (k === this.lastHudTick) return;
    this.lastHudTick = k;
    const h = rep.hud, o = k * H.N;
    const score = h[o + H.SCORE], max = h[o + H.MAX];
    const pct = max > 0 ? (100 * score) / max : 100;
    this.hudCombo.set(String(Math.round(h[o + H.COMBO])));
    this.hudScore.set(formatScore(score));
    this.hudAcc.set(`${pct.toFixed(2)}%  ${gradeOf(pct)}`);
    const mult = Math.round(h[o + H.MULT]);
    this.hudMult.set(`×${mult}`);
    this.hudMisses.set(String(Math.round(h[o + H.MISSES])));
    const need = mult === 1 ? 2 : mult === 2 ? 4 : mult === 4 ? 8 : 0;
    const fill = need ? h[o + H.PROGRESS] / need : 1;
    this.ring.geometry.setDrawRange(0, Math.round(fill * 48) * 6);
    const e = Math.min(1, Math.max(0, h[o + H.ENERGY]));
    this.energyFill.scale.set(Math.max(0.001, 2.6 * e), 0.07, 1);
    this.energyFill.position.x = -1.3 + 1.3 * e;
    const low = e < 0.3;
    if (low !== this.lastLow) {
      this.lastLow = low;
      this.energyMat.color.set(low ? '#ff4a4a' : '#f4f6fa');
    }
  }
}

function commit(m: THREE.InstancedMesh, n: number): void {
  m.count = n;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
}

/** A flat chevron (apex toward -y) in the XY plane facing +Z, within the unit box. */
function arrowGeometry(T: Three): THREE.BufferGeometry {
  const g = new T.BufferGeometry();
  const v = [-0.5, 0.25, 0, 0, -0.25, 0, 0.5, 0.25, 0]; // counter-clockwise seen from +Z
  g.setAttribute('position', new T.Float32BufferAttribute(v, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
