// Push-to-talk HUD: a level meter while the mic is open, and a short-lived
// result line once the server routed the utterance (fast-path command, sent to
// Claude, or not understood). The client drives begin/level/end; results come
// from voice.result messages.

import * as THREE from 'three';
import type { ServerMessage } from '@evolspace/protocol';
import type { RuntimeText, RuntimeUiKit } from '../ui/UiKit.ts';
import { truncate } from './util.ts';

type VoiceResult = Extract<ServerMessage, { type: 'voice.result' }>;

const BARS = 9;
const BAR_W = 0.004;
const BAR_GAP = 0.003;
const BAR_H = 0.03;

export class VoiceHud {
  readonly group = new THREE.Group();
  private meter = new THREE.Group();
  private bars: THREE.Mesh[] = [];
  private history = new Float32Array(BARS);
  private level = 0;
  private smoothed = 0;
  private sampleClock = 0;
  private result: RuntimeText;
  private resultLife = 0;
  private resultAge = 0;
  private hint: RuntimeText;
  private _active = false;

  constructor(private ui: RuntimeUiKit) {
    this.group.name = 'voice-hud';
    const th = ui.theme;
    const mat = ui.material(th.accent);
    const geom = new THREE.PlaneGeometry(BAR_W, 1);
    const total = BARS * BAR_W + (BARS - 1) * BAR_GAP;
    for (let i = 0; i < BARS; i++) {
      const b = new THREE.Mesh(geom, mat);
      b.position.x = -total / 2 + i * (BAR_W + BAR_GAP) + BAR_W / 2;
      b.scale.y = 0.002;
      this.bars.push(b);
      this.meter.add(b);
    }
    this.hint = ui.textEx('Listening — release to send', { size: 0.0095, color: th.textDim, anchorX: 'center', anchorY: 'top', outline: { width: 0.0007 } });
    this.hint.position.set(0, -BAR_H / 2 - 0.006, 0);
    this.meter.add(this.hint);
    this.meter.visible = false;
    this.result = ui.textEx('', { size: 0.0115, color: th.text, anchorX: 'center', anchorY: 'middle', maxWidth: 0.4, textAlign: 'center', outline: { width: 0.0008 } });
    this.result.visible = false;
    this.result.position.set(0, -0.012, 0);
    this.group.add(this.meter, this.result);
    this.group.traverse((o) => { o.raycast = () => {}; });
  }

  get active(): boolean {
    return this._active;
  }

  begin(): void {
    this._active = true;
    this.history.fill(0);
    this.meter.visible = true;
    this.result.visible = false;
  }

  /** RMS level 0..1 (call as often as audio chunks arrive). */
  setLevel(v: number): void {
    this.level = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  get currentLevel(): number {
    return this.smoothed;
  }

  end(cancelled = false): void {
    this._active = false;
    this.meter.visible = false;
    this.level = 0;
    if (cancelled) this.showResult('Cancelled', this.ui.theme.textDim, 1.5);
    else this.showResult('Transcribing…', this.ui.theme.textDim, 6);
  }

  onResult(r: VoiceResult): void {
    const th = this.ui.theme;
    const said = `“${truncate(r.text, 80)}”`;
    if (r.route === 'fastpath') this.showResult(`${r.command ?? 'command'} · ${said}`, th.positive, 3);
    else if (r.route === 'agent') this.showResult(`→ Claude: ${said}`, th.accent, 3.5);
    else this.showResult(r.text ? `Not understood: ${said}` : 'Heard nothing', th.textDim, 3);
  }

  private showResult(text: string, color: string, seconds: number): void {
    this.result.set(text);
    this.result.color = color;
    this.ui.markDirty(this.result);
    this.result.visible = true;
    this.resultAge = 0;
    this.resultLife = seconds;
  }

  get resultText(): string | null {
    return this.result.visible ? this.result.text : null;
  }

  update(dt: number): void {
    if (this._active) {
      // Fast attack, slower release, so speech reads as a lively meter.
      const k = this.level > this.smoothed ? 0.6 : 0.15;
      this.smoothed += (this.level - this.smoothed) * k;
      this.sampleClock += dt;
      if (this.sampleClock >= 0.05) {
        this.sampleClock = 0;
        this.history.copyWithin(0, 1);
        this.history[BARS - 1] = this.smoothed;
      }
      for (let i = 0; i < BARS; i++) {
        // Symmetric envelope: center bars taller.
        const shape = 0.55 + 0.45 * Math.cos(((i - (BARS - 1) / 2) / BARS) * Math.PI);
        this.bars[i].scale.y = Math.max(0.002, BAR_H * shape * Math.sqrt(this.history[i]));
      }
    }
    if (this.result.visible) {
      this.resultAge += dt;
      const left = this.resultLife - this.resultAge;
      this.result.fillOpacity = Math.max(0, Math.min(1, left / 0.4));
      if (left <= 0) this.result.visible = false;
    }
  }

  dispose(): void {
    this.bars[0]?.geometry.dispose();
    this.result.dispose();
    this.hint.dispose();
  }
}
