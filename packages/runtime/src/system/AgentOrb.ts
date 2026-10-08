// Agent status orb: a small calm "presence" that makes Claude's state obvious
// at a glance, with a status line and an elapsed timer so the user can tell a
// long-running task from a frozen session.
//
// States (distinct motion + color, all slow and low-contrast except error):
//   idle          gray core, slow breathing (4 s)
//   listening     blue, halo pulses with the mic level
//   transcribing  teal, three dots orbiting
//   thinking      violet, one arc sweeping slowly + faster breathing
//   working       amber, arc sweeping quickly + orbiting dots; the timer runs
//   error         red, static halo, gentle blink
//   offline       dim gray, "reconnecting…" (server connection lost)

import * as THREE from 'three';
import type { AgentState, AgentStatus } from '@evolspace/protocol';
import { SYSTEM_STYLE } from '../theme.ts';
import type { RuntimeText, RuntimeUiKit } from '../ui/UiKit.ts';
import { unitSphereGeometry } from '../ui/geometry.ts';
import { formatElapsed, truncate } from './util.ts';

export type OrbState = AgentState | 'offline';

const LABELS: Record<OrbState, string> = {
  idle: 'Claude · idle',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Claude is thinking',
  working: 'Claude is working',
  error: 'Claude · error',
  offline: 'Server offline',
};

const CORE_R = 0.016;

export class AgentOrb {
  readonly group = new THREE.Group();
  private core: THREE.Mesh;
  private coreMat: THREE.MeshBasicMaterial;
  private halo: THREE.Mesh;
  private haloMat: THREE.MeshBasicMaterial;
  private arc: THREE.Mesh;
  private arcMat: THREE.MeshBasicMaterial;
  private dots: THREE.Mesh[] = [];
  private dotMat: THREE.MeshBasicMaterial;
  private badge: THREE.Mesh;
  private label: RuntimeText;
  private detail: RuntimeText;
  private state: OrbState = 'idle';
  private detailText = '';
  private stateStart = 0;
  private since: number | undefined = undefined;
  private lastElapsedShown = -1;
  private level = 0;
  private color = new THREE.Color();
  private targetColor = new THREE.Color();
  private clock = 0;

  constructor(private ui: RuntimeUiKit) {
    this.group.name = 'agent-orb';
    this.coreMat = new THREE.MeshBasicMaterial({ color: SYSTEM_STYLE.agent.idle, transparent: true, opacity: 0.95 });
    this.core = new THREE.Mesh(unitSphereGeometry(2), this.coreMat);
    this.core.scale.setScalar(CORE_R);

    this.haloMat = new THREE.MeshBasicMaterial({ color: SYSTEM_STYLE.agent.idle, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
    this.halo = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 48), this.haloMat);
    this.halo.scale.setScalar(CORE_R * 1.5);

    this.arcMat = new THREE.MeshBasicMaterial({ color: SYSTEM_STYLE.agent.idle, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    this.arc = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.6, 40, 1, 0, Math.PI * 0.9), this.arcMat);
    this.arc.scale.setScalar(CORE_R);
    this.arc.visible = false;

    this.dotMat = new THREE.MeshBasicMaterial({ color: SYSTEM_STYLE.agent.idle, transparent: true, opacity: 0.9, depthWrite: false });
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(unitSphereGeometry(1), this.dotMat);
      d.scale.setScalar(CORE_R * 0.22);
      d.visible = false;
      this.dots.push(d);
    }

    this.badge = new THREE.Mesh(unitSphereGeometry(1), ui.material(SYSTEM_STYLE.agent.listening));
    this.badge.scale.setScalar(CORE_R * 0.28);
    this.badge.position.set(CORE_R * 0.9, CORE_R * 0.9, CORE_R * 0.5);
    this.badge.visible = false;

    this.label = ui.textEx(LABELS.idle, { size: 0.0125, color: ui.theme.text, anchorX: 'left', anchorY: 'bottom', weight: 'semibold', outline: { width: 0.0008 } });
    this.label.position.set(CORE_R * 2.2, 0.0005, 0);
    this.detail = ui.textEx('', { size: 0.0105, color: ui.theme.textDim, anchorX: 'left', anchorY: 'top', maxWidth: 0.34, outline: { width: 0.0007 } });
    this.detail.position.set(CORE_R * 2.2, -0.002, 0);

    this.group.add(this.halo, this.arc, this.core, ...this.dots, this.badge, this.label, this.detail);
    for (const o of this.group.children) o.raycast = () => {};
    this.color.set(SYSTEM_STYLE.agent.idle);
    this.applyLabel();
  }

  get current(): OrbState {
    return this.state;
  }

  /** The status line under the label (state detail · elapsed time). */
  get detailLine(): string {
    return this.detail.text;
  }

  setStatus(s: AgentStatus): void {
    this.set(s.state, s.detail ?? '', s.since);
  }

  /**
   * @param sinceMs when the state began (epoch ms, AgentStatus.since). Lets the
   *   timer show the true duration after a reconnect / page reload instead of
   *   restarting at 0. Ignored when implausible (clock skew).
   */
  set(state: OrbState, detail = '', sinceMs?: number): void {
    if (state !== this.state || (sinceMs !== undefined && sinceMs !== this.since)) {
      this.state = state;
      this.since = sinceMs;
      let elapsed = 0;
      if (typeof sinceMs === 'number' && Number.isFinite(sinceMs)) {
        const e = (Date.now() - sinceMs) / 1000;
        if (e > 0 && e < 86_400) elapsed = e;
      }
      this.stateStart = this.clock - elapsed;
      this.lastElapsedShown = -1;
    }
    this.detailText = detail;
    this.targetColor.set(SYSTEM_STYLE.agent[state]);
    this.applyLabel();
  }

  /** Mic level 0..1 while listening (drives the halo). */
  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
  }

  setUnread(on: boolean): void {
    this.badge.visible = on;
  }

  private showsTimer(): boolean {
    return this.state === 'working' || this.state === 'thinking' || this.state === 'transcribing' || this.state === 'offline';
  }

  private applyLabel(): void {
    this.label.set(LABELS[this.state]);
    let d = truncate(this.detailText, 90);
    if (this.showsTimer()) {
      const el = formatElapsed(this.clock - this.stateStart);
      d = d ? `${d} · ${el}` : el;
    }
    this.detail.set(d);
  }

  update(dt: number): void {
    this.clock += dt;
    const t = this.clock;
    // Color eases between states (no hard flashes).
    this.color.lerp(this.targetColor, Math.min(1, dt * 6));
    this.coreMat.color.copy(this.color);
    this.haloMat.color.copy(this.color);
    this.arcMat.color.copy(this.color);
    this.dotMat.color.copy(this.color);

    const s = this.state;
    let breathe = 1;
    let haloScale = 1.5;
    let haloOpacity = 0.18;
    let arcSpeed = 0;
    let dotSpeed = 0;
    switch (s) {
      case 'idle':
        breathe = 1 + 0.05 * Math.sin((t * Math.PI * 2) / 4);
        break;
      case 'listening':
        breathe = 1 + 0.15 * this.level;
        haloScale = 1.6 + this.level * 1.4 + 0.1 * Math.sin(t * 6);
        haloOpacity = 0.35 + this.level * 0.45;
        break;
      case 'transcribing':
        breathe = 1 + 0.04 * Math.sin(t * 5);
        dotSpeed = Math.PI * 2;
        break;
      case 'thinking':
        breathe = 1 + 0.07 * Math.sin((t * Math.PI * 2) / 1.6);
        arcSpeed = Math.PI; // 0.5 rev/s
        haloOpacity = 0.25;
        break;
      case 'working':
        breathe = 1 + 0.05 * Math.sin(t * 4);
        arcSpeed = Math.PI * 2.4;
        dotSpeed = Math.PI * 0.8;
        haloOpacity = 0.3;
        break;
      case 'error':
        haloOpacity = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(t * 2));
        haloScale = 1.7;
        break;
      case 'offline':
        breathe = 0.85;
        haloOpacity = 0.08;
        this.coreMat.opacity = 0.5 + 0.2 * Math.sin(t * 1.5);
        break;
    }
    if (s !== 'offline') this.coreMat.opacity = 0.95;
    this.core.scale.setScalar(CORE_R * breathe);
    this.halo.scale.setScalar(CORE_R * haloScale);
    this.haloMat.opacity = haloOpacity;
    this.arc.visible = arcSpeed > 0;
    if (arcSpeed) this.arc.rotation.z = -t * arcSpeed;
    const showDots = dotSpeed > 0;
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i];
      d.visible = showDots;
      if (!showDots) continue;
      const a = t * dotSpeed + (i * Math.PI * 2) / 3;
      d.position.set(Math.cos(a) * CORE_R * 2.0, Math.sin(a) * CORE_R * 2.0, 0);
    }
    // Refresh the timer once per second.
    if (this.showsTimer()) {
      const sec = Math.floor(t - this.stateStart);
      if (sec !== this.lastElapsedShown) {
        this.lastElapsedShown = sec;
        this.applyLabel();
      }
    }
  }

  dispose(): void {
    this.coreMat.dispose();
    this.haloMat.dispose();
    this.arcMat.dispose();
    this.dotMat.dispose();
    this.halo.geometry.dispose();
    this.arc.geometry.dispose();
    this.label.dispose();
    this.detail.dispose();
  }
}
