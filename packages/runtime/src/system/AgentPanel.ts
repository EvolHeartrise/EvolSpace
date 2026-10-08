// Agent message panel: recent messages from Claude (and transcripts of what
// the user said), newest at the bottom, scrollable. Lazy head-follow is done
// by the SystemUi frame it lives in.
//
// Styling by kind:
//   reply  → primary text
//   heard  → dim, smaller, prefixed "you ›" (clearly the user's words, not Claude's)
//   info   → dim
//   error  → negative color

import * as THREE from 'three';
import type { AgentMessage } from '@evolspace/protocol';
import type { RuntimeText, RuntimeUiKit } from '../ui/UiKit.ts';
import { estimateTextBlock } from '../ui/stubText.ts';
import { truncate } from './util.ts';

const W = 0.46;
const H = 0.34;
const PAD = 0.018;
const HEADER = 0.034;
const GAP = 0.009;
const SLOTS = 10;
const MAX_MESSAGES = 80;
const TEXT_W = W - PAD * 2;

interface Slot {
  text: RuntimeText;
  bar: THREE.Mesh;
  msgId: string | null;
  clip: [number, number, number, number];
}

export class AgentPanel {
  readonly group = new THREE.Group();
  private messages: AgentMessage[] = [];
  private slots: Slot[] = [];
  private scrollOffset = 0;
  private dirty = true;
  private footer: RuntimeText;
  private barMats: Record<AgentMessage['kind'], THREE.Material>;

  constructor(private ui: RuntimeUiKit) {
    this.group.name = 'agent-panel';
    this.group.visible = false;
    const th = ui.theme;
    const bg = ui.panel(W, H);
    this.group.add(bg);
    const title = ui.textEx('Claude', { size: 0.016, weight: 'semibold', anchorX: 'left', anchorY: 'middle', color: th.text });
    title.position.set(-W / 2 + PAD, H / 2 - HEADER / 2 - 0.004, 0.001);
    this.group.add(title);
    this.footer = ui.textEx('', { size: 0.0095, anchorX: 'right', anchorY: 'middle', color: th.textDim });
    this.footer.position.set(W / 2 - PAD, H / 2 - HEADER / 2 - 0.004, 0.001);
    this.group.add(this.footer);
    const rule = new THREE.Mesh(new THREE.PlaneGeometry(W - PAD * 2, 0.0008), ui.material(th.border));
    rule.position.set(0, H / 2 - HEADER, 0.001);
    this.group.add(rule);

    this.barMats = {
      reply: ui.material(th.accent),
      heard: ui.material(th.accent2, { opacity: 0.7 }),
      info: ui.material(th.textDim, { opacity: 0.6 }),
      error: ui.material(th.negative),
    };
    const barGeom = new THREE.PlaneGeometry(0.0022, 1);
    for (let i = 0; i < SLOTS; i++) {
      const text = ui.textEx('', { size: 0.0135, maxWidth: TEXT_W - 0.01, anchorX: 'left', anchorY: 'bottom', lineHeight: 1.3, color: th.text });
      text.visible = false;
      const bar = new THREE.Mesh(barGeom, this.barMats.reply);
      bar.visible = false;
      this.group.add(text, bar);
      this.slots.push({ text, bar, msgId: null, clip: [0, 0, 0, 0] });
    }
    for (const o of this.group.children) o.raycast = () => {};
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    if (v) this.dirty = true;
  }

  toggle(): boolean {
    this.setVisible(!this.group.visible);
    return this.group.visible;
  }

  /** Add or update a message. Returns true if it was not known yet (the server replays recent ones on reconnect). */
  add(m: AgentMessage): boolean {
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      this.messages[i] = m; // edits/updates of the same message
      this.dirty = true;
      return false;
    }
    // Keep chronological order even when a replay delivers older messages late.
    let at = this.messages.length;
    while (at > 0 && typeof m.ts === 'number' && this.messages[at - 1].ts > m.ts) at--;
    // Keep the user's scroll position anchored to the same message: the
    // offset counts from the newest, so it grows only when the new message
    // lands below (newer than) the one at the bottom of the view.
    const viewed = this.messages.length - 1 - this.scrollOffset;
    if (this.scrollOffset > 0 && at > viewed) this.scrollOffset++;
    this.messages.splice(at, 0, m);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    this.dirty = true;
    return true;
  }

  clear(): void {
    this.messages = [];
    this.scrollOffset = 0;
    this.dirty = true;
  }

  get count(): number {
    return this.messages.length;
  }

  /** Scroll by whole messages (positive = older). */
  scroll(delta: number): void {
    const max = Math.max(0, this.messages.length - 1);
    const next = Math.max(0, Math.min(max, this.scrollOffset + Math.round(delta)));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.dirty = true;
    }
  }

  get scrollPosition(): number {
    return this.scrollOffset;
  }

  update(): void {
    if (!this.group.visible) return;
    // Re-layout every frame while visible: heights become exact once troika
    // finishes typesetting (async), and positioning ≤10 meshes is trivial.
    this.layout();
  }

  private layout(): void {
    const th = this.ui.theme;
    const bottom = -H / 2 + PAD;
    const top = H / 2 - HEADER - 0.006;
    let y = bottom;
    let slot = 0;
    const end = this.messages.length - this.scrollOffset;
    for (let i = end - 1; i >= 0 && slot < SLOTS && y < top; i--, slot++) {
      const m = this.messages[i];
      const s = this.slots[slot];
      if (s.msgId !== m.id || this.dirty) {
        s.msgId = m.id;
        const isHeard = m.kind === 'heard';
        s.text.set(isHeard ? `you › ${truncate(m.text, 400)}` : truncate(m.text, 1200));
        s.text.color = m.kind === 'error' ? th.negative : m.kind === 'reply' ? th.text : th.textDim;
        const size = isHeard || m.kind === 'info' ? 0.012 : 0.0135;
        if (s.text.fontSize !== size) s.text.fontSize = size;
        this.ui.markDirty(s.text);
        s.bar.material = this.barMats[m.kind] ?? this.barMats.info;
      }
      const h = measure(s.text);
      s.text.position.set(-W / 2 + PAD + 0.008, y, 0.002);
      s.text.visible = true;
      // Clip to the content area (clipRect is in the text's local frame).
      s.clip[0] = -1;
      s.clip[1] = bottom - y;
      s.clip[2] = TEXT_W;
      s.clip[3] = top - y;
      s.text.clipRect = s.clip;
      const barTop = Math.min(top, y + h);
      const barH = Math.max(0, barTop - y);
      s.bar.visible = barH > 0.002;
      s.bar.scale.y = barH;
      s.bar.position.set(-W / 2 + PAD, y + barH / 2, 0.002);
      y += h + GAP;
    }
    for (; slot < SLOTS; slot++) {
      const s = this.slots[slot];
      s.text.visible = false;
      s.bar.visible = false;
      s.msgId = null;
    }
    if (this.dirty) {
      this.footer.set(this.scrollOffset > 0 ? `↓ ${this.scrollOffset} newer` : this.messages.length ? '' : 'No messages yet');
    }
    this.dirty = false;
  }

  dispose(): void {
    for (const s of this.slots) s.text.dispose();
  }
}

function measure(t: RuntimeText): number {
  const info = t.textRenderInfo;
  if (info) return Math.max(0.001, info.blockBounds[3] - info.blockBounds[1]);
  return estimateTextBlock(t.text, t.fontSize, t.maxWidth, t.lineHeight).height;
}
