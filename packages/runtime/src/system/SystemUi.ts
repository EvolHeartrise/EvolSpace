// System UI: agent orb + status line, agent message panel, voice HUD, toasts
// and the pose-recording countdown. Everything hangs off two lazy head-follow
// frames under the space root:
//   HUD frame   — orb (lower-left of view), voice meter, toasts (top), countdown (center)
//   panel frame — the agent message panel (right of view)
// The SystemUi is pure presentation; SpaceRuntime routes net messages into it.

import * as THREE from 'three';
import type { AgentMessage, AgentStatus, ServerMessage } from '@evolspace/protocol';
import type { RuntimeUiKit } from '../ui/UiKit.ts';
import { LazyFollower } from '../scene/anchors.ts';
import { AgentOrb } from './AgentOrb.ts';
import { AgentPanel } from './AgentPanel.ts';
import { RecordingUi } from './RecordingUi.ts';
import { Toasts, type ToastKind } from './Toasts.ts';
import { VoiceHud } from './VoiceHud.ts';
import { faceOrigin } from './util.ts';

export interface SystemUiOptions {
  /** Hide everything (mirror screenshots). Default true = shown. */
  enabled?: boolean;
  /** Open the panel automatically when Claude replies. Default true. */
  autoOpenPanel?: boolean;
}

/** Messages older than this (by their server timestamp) never auto-open the panel. */
const FRESH_MS = 60_000;

const ORB_POS = new THREE.Vector3(-0.17, -0.21, -0.65);
const VOICE_POS = new THREE.Vector3(-0.1, -0.14, -0.65);
const TOAST_POS = new THREE.Vector3(0, 0.2, -0.72);
const RECORD_POS = new THREE.Vector3(0, 0.02, -0.6);
const PANEL_POS = new THREE.Vector3(0.3, -0.05, -0.72);

export class SystemUi {
  readonly group = new THREE.Group();
  readonly orb: AgentOrb;
  readonly panel: AgentPanel;
  readonly voice: VoiceHud;
  readonly toasts: Toasts;
  readonly recording: RecordingUi;
  autoOpenPanel: boolean;

  private hud = new LazyFollower({ angleDeg: 38, maxDrift: 0.3 });
  private panelFollow = new LazyFollower({ angleDeg: 40, maxDrift: 0.4 });
  private serverStatus: AgentStatus = { state: 'idle', since: Date.now() };
  private connected = true;
  private enabled: boolean;

  constructor(ui: RuntimeUiKit, opts: SystemUiOptions = {}) {
    this.group.name = 'system-ui';
    this.enabled = opts.enabled !== false;
    this.autoOpenPanel = opts.autoOpenPanel !== false;

    this.orb = new AgentOrb(ui);
    this.voice = new VoiceHud(ui);
    this.toasts = new Toasts(ui);
    this.recording = new RecordingUi(ui);
    this.panel = new AgentPanel(ui);

    place(this.orb.group, ORB_POS);
    place(this.voice.group, VOICE_POS);
    place(this.toasts.group, TOAST_POS);
    place(this.recording.group, RECORD_POS);
    place(this.panel.group, PANEL_POS);

    this.hud.frame.name = 'system-hud';
    this.panelFollow.frame.name = 'system-panel';
    this.hud.frame.add(this.orb.group, this.voice.group, this.toasts.group, this.recording.group);
    this.panelFollow.frame.add(this.panel.group);
    this.group.add(this.hud.frame, this.panelFollow.frame);
    this.group.visible = this.enabled;
  }

  // ------------------------------------------------------------------ agent

  setAgentStatus(s: AgentStatus): void {
    this.serverStatus = s;
    this.refreshOrb();
  }

  get agentStatus(): AgentStatus {
    return this.serverStatus;
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.refreshOrb();
  }

  private refreshOrb(): void {
    if (!this.connected) this.orb.set('offline', 'Reconnecting to the EvolSpace server…');
    else if (this.voice.active) this.orb.set('listening', 'Release to send');
    else this.orb.setStatus(this.serverStatus);
  }

  addMessage(m: AgentMessage): void {
    const isNew = this.panel.add(m);
    // Only fresh replies demand attention: on (re)connect the server replays
    // recent history, which must not pop the panel open again.
    const fresh = isNew && (typeof m.ts !== 'number' || Date.now() - m.ts < FRESH_MS);
    if (fresh && (m.kind === 'reply' || m.kind === 'error')) {
      if (this.autoOpenPanel && !this.panel.visible) this.openPanel();
      else if (!this.panel.visible) this.orb.setUnread(true);
    }
  }

  openPanel(): void {
    if (!this.panel.visible) this.panelFollow.snap();
    this.panel.setVisible(true);
    this.orb.setUnread(false);
  }

  togglePanel(): boolean {
    return this.setPanelVisible(!this.panel.visible);
  }

  /** Show or hide the agent panel (idempotent). Returns the new visibility. */
  setPanelVisible(v: boolean): boolean {
    if (v) this.openPanel();
    else this.panel.setVisible(false);
    return v;
  }

  // ------------------------------------------------------------------ voice

  /** Push-to-talk pressed (client calls this when it starts streaming audio). */
  voiceBegin(): void {
    this.voice.begin();
    this.refreshOrb();
  }

  voiceLevel(v: number): void {
    this.voice.setLevel(v);
    this.orb.setLevel(v);
  }

  voiceEnd(cancelled = false): void {
    this.voice.end(cancelled);
    this.orb.setLevel(0);
    this.refreshOrb();
  }

  voiceResult(r: Extract<ServerMessage, { type: 'voice.result' }>): void {
    this.voice.onResult(r);
  }

  // ------------------------------------------------------------------ toasts

  toast(message: string, kind: ToastKind = 'info', seconds?: number): void {
    this.toasts.show(message, kind, seconds);
  }

  // ------------------------------------------------------------------ frame

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  /** Per frame; head pose in space coords. */
  update(dt: number, headPos: THREE.Vector3, headQuat: THREE.Quaternion): void {
    this.orb.update(dt);
    this.voice.update(dt);
    this.toasts.update(dt);
    this.recording.update(dt);
    this.panel.update();
    if (!this.enabled) return;
    this.hud.update(headPos, headQuat, ORB_POS, dt);
    if (this.panel.visible) this.panelFollow.update(headPos, headQuat, PANEL_POS, dt);
  }

  dispose(): void {
    this.orb.dispose();
    this.voice.dispose();
    this.toasts.dispose();
    this.recording.dispose();
    this.panel.dispose();
    this.group.removeFromParent();
  }
}

function place(o: THREE.Object3D, p: THREE.Vector3): void {
  o.position.copy(p);
  faceOrigin(o);
}
