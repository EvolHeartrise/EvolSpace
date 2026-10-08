// Lens readout panel: P.lens.readout ({title, items: {label, value}[]}) as a
// glass panel with a title and labeled bars. Rows are drawn with two column
// texts (labels, values) whose line height matches the bar pitch plus one
// instanced mesh for all bars, so the panel costs ~5 draw calls regardless of
// the number of items. The label column widens (up to LABEL_MAX_CHARS) for
// producers with descriptive labels ("entropy (nats, max 1.61)").

import type * as THREE_NS from 'three';
import type { Theme, UiKit } from '@evolspace/protocol';
import { displayToken, formatValue, type LensReadout } from './data.ts';

type ThreeLib = typeof THREE_NS;
type Text = THREE_NS.Mesh & { set(text: string): void };

export const READOUT_MAX_ROWS = 10;
/** Minimum panel width; long labels widen it. */
const W_MIN = 0.32;
const PAD = 0.014;
const TITLE_H = 0.05;
const PITCH = 0.024;
const LABEL_SIZE = 0.0145;
const VALUE_SIZE = 0.0125;
const VALUE_W = 0.05;
/** JetBrains Mono advance is 0.6 em (plus a little slack per glyph). */
const CHAR_W = 0.6 * LABEL_SIZE + 0.0006;
const LABEL_MIN_CHARS = 12;
export const LABEL_MAX_CHARS = 22;
const labelWidth = (chars: number): number => chars * CHAR_W + 0.002;
/** Bar span at the minimum width; kept constant when the label column grows. */
const BAR_SPAN = W_MIN - 2 * PAD - labelWidth(LABEL_MIN_CHARS) - VALUE_W;

const noRaycast = () => {};

/**
 * Row pitch for a column text. troika's `lineHeight` (not part of the widget
 * TextOptions contract) is a multiple of the font size; it is set before the
 * host's first sync, so it takes effect. Harmless on other text impls.
 */
function setLineHeight(t: Text, pitch: number, size: number): void {
  (t as unknown as { lineHeight: number }).lineHeight = pitch / size;
}

export class ReadoutPanel {
  readonly group: THREE_NS.Group;
  private panel: THREE_NS.Mesh | null = null;
  private rows = -1;
  private w = W_MIN;
  private labelW = labelWidth(LABEL_MIN_CHARS);
  private readonly title: Text;
  private readonly sub: Text;
  private readonly labels: Text;
  private readonly values: Text;
  private readonly bars: THREE_NS.InstancedMesh;
  private readonly barMat: THREE_NS.MeshBasicMaterial;
  private readonly barGeo: THREE_NS.PlaneGeometry;
  private readonly m4: THREE_NS.Matrix4;
  private readonly cPos: THREE_NS.Color;
  private readonly cNeg: THREE_NS.Color;
  private readonly cDim: THREE_NS.Color;
  private readonly cTmp: THREE_NS.Color;

  constructor(private THREE: ThreeLib, private ui: UiKit, private theme: Theme) {
    this.group = new THREE.Group();
    this.group.name = 'readout';
    this.title = ui.text('', { size: 0.017, color: theme.text, anchorX: 'left', anchorY: 'top', maxWidth: W_MIN - 2 * PAD });
    this.sub = ui.text('', { size: 0.011, color: theme.textDim, anchorX: 'left', anchorY: 'top', maxWidth: W_MIN - 2 * PAD });
    this.labels = ui.text('', { size: LABEL_SIZE, color: theme.text, anchorX: 'left', anchorY: 'top', font: 'mono' });
    this.values = ui.text('', { size: VALUE_SIZE, color: theme.textDim, anchorX: 'right', anchorY: 'top', font: 'mono' });
    setLineHeight(this.labels, PITCH, LABEL_SIZE);
    setLineHeight(this.values, PITCH, VALUE_SIZE);
    for (const t of [this.title, this.sub, this.labels, this.values]) {
      t.position.z = 0.002;
      this.group.add(t);
    }
    this.barGeo = new THREE.PlaneGeometry(1, 1);
    this.barGeo.translate(0.5, 0, 0); // grows rightwards from x = 0
    this.barMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.bars = new THREE.InstancedMesh(this.barGeo, this.barMat, READOUT_MAX_ROWS);
    this.bars.name = 'readout-bars';
    this.bars.count = 0;
    this.bars.raycast = noRaycast;
    this.bars.frustumCulled = false;
    this.bars.position.z = 0.0015;
    this.group.add(this.bars);
    this.m4 = new THREE.Matrix4();
    this.cPos = new THREE.Color(theme.accent);
    this.cNeg = new THREE.Color(theme.negative);
    this.cDim = new THREE.Color(theme.border);
    this.cTmp = new THREE.Color();
  }

  /** Total panel height for the current row count. */
  get height(): number {
    return TITLE_H + Math.max(1, this.rows) * PITCH + PAD * 1.5;
  }

  /** Current panel width (≥ 0.32 m; grows with the label column). */
  get width(): number {
    return this.w;
  }

  /** (Re)build the panel for a row count and label column (panel geometry is cached by the UiKit). */
  private ensurePanel(rows: number, labelChars: number): void {
    const labelW = labelWidth(labelChars);
    const w = Math.max(W_MIN, 2 * PAD + labelW + BAR_SPAN + VALUE_W);
    if (rows === this.rows && Math.abs(w - this.w) < 1e-6 && this.panel) return;
    this.rows = rows;
    this.w = w;
    this.labelW = labelW;
    if (this.panel) this.group.remove(this.panel);
    const h = this.height;
    this.panel = this.ui.panel(w, h, { opacity: 0.88 });
    this.panel.name = 'readout-panel';
    // Origin at the panel's left/middle so the group can be placed by its edge.
    this.panel.position.set(w / 2, 0, 0);
    this.group.add(this.panel);
    const top = h / 2;
    this.title.position.set(PAD, top - PAD * 0.8, 0.002);
    this.sub.position.set(PAD, top - PAD * 0.8 - 0.022, 0.002);
    this.labels.position.set(PAD, top - TITLE_H, 0.002);
    this.values.position.set(w - PAD, top - TITLE_H, 0.002);
  }

  /**
   * Show a readout. `stale` = the readout belongs to a different layer/token
   * than the current selection (the producer has not caught up yet).
   */
  set(r: LensReadout | null, stale: boolean, fallbackTitle: string, waitingNote: string): void {
    const items = r ? r.items.slice(0, READOUT_MAX_ROWS) : [];
    const labels = items.map((it) => displayToken(it.label, LABEL_MAX_CHARS));
    let chars = LABEL_MIN_CHARS;
    for (const l of labels) chars = Math.max(chars, l.length);
    this.ensurePanel(Math.max(1, items.length), Math.min(LABEL_MAX_CHARS, chars));
    this.title.set(r?.title || fallbackTitle);
    this.sub.set(!r ? waitingNote : stale ? 'updating…' : r.items.length > READOUT_MAX_ROWS ? `top ${READOUT_MAX_ROWS} of ${r.items.length}` : '');
    this.labels.set(labels.join('\n'));
    this.values.set(items.map((it) => formatValue(it.value)).join('\n'));

    let maxAbs = 0;
    for (const it of items) maxAbs = Math.max(maxAbs, Math.abs(it.value));
    const top = this.height / 2 - TITLE_H;
    const x0 = PAD + this.labelW;
    const span = this.w - 2 * PAD - this.labelW - VALUE_W;
    for (let i = 0; i < items.length; i++) {
      const v = items[i].value;
      const len = Math.max(0.002, maxAbs > 0 ? (Math.abs(v) / maxAbs) * span : 0.002);
      this.m4.makeScale(len, PITCH * 0.42, 1);
      this.m4.setPosition(x0, top - PITCH * (i + 0.5), 0);
      this.bars.setMatrixAt(i, this.m4);
      this.cTmp.copy(v < 0 ? this.cNeg : this.cPos);
      if (stale) this.cTmp.lerp(this.cDim, 0.6);
      this.bars.setColorAt(i, this.cTmp);
    }
    this.bars.count = items.length;
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    this.bars.boundingBox = null;
    this.bars.boundingSphere = null;
  }

  dispose(): void {
    this.barGeo.dispose();
    this.barMat.dispose();
    this.bars.dispose();
  }
}
