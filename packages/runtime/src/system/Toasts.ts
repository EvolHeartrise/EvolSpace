// Transient notifications (client/widget errors, voice results, notices).
// A small pool of slots stacked top-center of the HUD; repeated messages are
// coalesced ("×3") instead of stacking.

import * as THREE from 'three';
import type { RuntimeText, RuntimeUiKit } from '../ui/UiKit.ts';
import { roundedRectGeometry } from '../ui/geometry.ts';
import { estimateTextBlock } from '../ui/stubText.ts';
import { truncate } from './util.ts';

export type ToastKind = 'info' | 'success' | 'error' | 'voice';

const SLOTS = 4;
const W = 0.36;
const FONT = 0.0115;
const FADE = 0.35;

interface Slot {
  group: THREE.Group;
  bg: THREE.Mesh;
  bgMat: THREE.MeshBasicMaterial;
  accent: THREE.Mesh;
  accentMat: THREE.MeshBasicMaterial;
  text: RuntimeText;
  key: string | null;
  base: string;
  count: number;
  life: number;
  age: number;
  height: number;
}

export class Toasts {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];

  constructor(private ui: RuntimeUiKit) {
    this.group.name = 'toasts';
    const th = ui.theme;
    for (let i = 0; i < SLOTS; i++) {
      const g = new THREE.Group();
      const bgMat = new THREE.MeshBasicMaterial({ color: th.background, transparent: true, opacity: 0.9, depthWrite: false });
      const bg = new THREE.Mesh(roundedRectGeometry(W, 0.03, 0.008), bgMat);
      bg.renderOrder = -1;
      const accentMat = new THREE.MeshBasicMaterial({ color: th.accent, transparent: true, opacity: 1, depthWrite: false });
      const accent = new THREE.Mesh(new THREE.PlaneGeometry(0.003, 1), accentMat);
      const text = ui.textEx('', { size: FONT, maxWidth: W - 0.03, anchorX: 'left', anchorY: 'middle', color: th.text, lineHeight: 1.25 });
      text.position.set(-W / 2 + 0.016, 0, 0.001);
      accent.position.set(-W / 2 + 0.007, 0, 0.001);
      g.add(bg, accent, text);
      g.visible = false;
      for (const o of g.children) o.raycast = () => {};
      this.group.add(g);
      this.slots.push({ group: g, bg, bgMat, accent, accentMat, text, key: null, base: '', count: 0, life: 0, age: 0, height: 0.03 });
    }
  }

  show(message: string, kind: ToastKind = 'info', seconds?: number): void {
    const th = this.ui.theme;
    const life = seconds ?? (kind === 'error' ? 7 : 4);
    const text = truncate(message.replace(/\s+/g, ' ').trim(), 220);
    const key = `${kind}|${text}`;
    let s = this.slots.find((x) => x.key === key && x.age < x.life);
    if (s) {
      s.count++;
      s.age = 0;
      s.life = life;
      s.text.set(`${s.base}  ×${s.count}`);
      return;
    }
    // Reuse a free slot, else the oldest one.
    s = this.slots.find((x) => x.key === null) ?? this.slots.reduce((a, b) => (b.age / b.life > a.age / a.life ? b : a));
    s.key = key;
    s.base = text;
    s.count = 1;
    s.age = 0;
    s.life = life;
    s.text.set(text);
    s.accentMat.color.set(kind === 'error' ? th.negative : kind === 'success' ? th.positive : kind === 'voice' ? th.accent2 : th.accent);
    s.text.color = kind === 'error' ? th.text : th.text;
    const h = estimateTextBlock(text, FONT, W - 0.03, 1.25).height + 0.014;
    s.height = Math.max(0.028, h);
    s.bg.geometry = roundedRectGeometry(W, s.height, 0.008);
    s.accent.scale.y = s.height - 0.01;
    s.group.visible = true;
    // Newest first: move this slot to the front of the stack order.
    this.slots.splice(this.slots.indexOf(s), 1);
    this.slots.unshift(s);
  }

  /** Number of toasts on screen. */
  get active(): number {
    return this.slots.filter((s) => s.key !== null).length;
  }

  /** Text of visible toasts (newest first) — for tests and the mirror. */
  messages(): string[] {
    return this.slots.filter((s) => s.key !== null).map((s) => s.text.text);
  }

  update(dt: number): void {
    let y = 0;
    for (const s of this.slots) {
      if (s.key === null) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.key = null;
        s.group.visible = false;
        continue;
      }
      const fadeIn = Math.min(1, s.age / 0.15);
      const fadeOut = Math.min(1, (s.life - s.age) / FADE);
      const a = Math.min(fadeIn, fadeOut);
      s.bgMat.opacity = 0.9 * a;
      s.accentMat.opacity = a;
      s.text.fillOpacity = a;
      // Ease toward the stacked position.
      const target = y - s.height / 2;
      s.group.position.y += (target - s.group.position.y) * Math.min(1, dt * 12);
      y -= s.height + 0.006;
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.bgMat.dispose();
      s.accentMat.dispose();
      s.accent.geometry.dispose();
      s.text.dispose();
    }
  }
}
