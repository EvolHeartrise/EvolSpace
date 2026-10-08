// Lens readout panel: P.lens.readout ({title, items: {label, value}[]}) as a
// glass panel with a title and labeled bars. Rows are drawn with two column
// texts (labels, values) whose line height matches the bar pitch plus one
// instanced mesh for all bars, so the panel costs ~5 draw calls regardless of
// the number of items.
//
// Sizing: the label column widens for descriptive labels (up to
// LABEL_MAX_CHARS, longer ones are cut at a word boundary), the panel also
// widens (up to W_MAX) for a long title; title and subtitle are single lines
// cut to the panel width, so nothing wraps into the rows. Bars are scaled by
// the largest |value| of the readout (values may exceed 1); null / non-finite
// values show '—' and no bar.

import type * as THREE_NS from 'three';
import type { Theme, UiKit } from '@evolspace/protocol';
import { displayToken, fitText, formatValue, type LensReadout } from './data.ts';

type ThreeLib = typeof THREE_NS;
type Text = THREE_NS.Mesh & { set(text: string): void };

export const READOUT_MAX_ROWS = 10;
/** Panel width bounds (m). */
export const W_MIN = 0.32;
export const W_MAX = 0.52;
const PAD = 0.014;
const TITLE_SIZE = 0.016;
const SUB_SIZE = 0.011;
const TITLE_H = 0.05;
const PITCH = 0.024;
const LABEL_SIZE = 0.0145;
const VALUE_SIZE = 0.0125;
/** Value column: fits "-4.0e-14" (8 mono glyphs) plus slack. */
const VALUE_W = 8 * 0.6 * VALUE_SIZE + 0.006;
const GAP = 0.008;
const BAR_SPAN = 0.11;
/** JetBrains Mono advance is 0.6 em (plus a little slack per glyph). */
const CHAR_W = 0.6 * LABEL_SIZE + 0.0006;
/** Conservative Inter advance (wide glyphs, digits) for single-line fitting. */
const SANS_ADV = 0.6;
const LABEL_MIN_CHARS = 12;
export const LABEL_MAX_CHARS = 30;
const labelWidth = (chars: number): number => chars * CHAR_W + 0.002;
const widthFor = (labelChars: number): number => 2 * PAD + labelWidth(labelChars) + GAP + BAR_SPAN + GAP + VALUE_W;
const sansChars = (width: number, size: number): number => Math.max(4, Math.floor(width / (size * SANS_ADV)));

const noRaycast = () => {};

/**
 * Row pitch for a column text. troika's `lineHeight` (not part of the widget
 * TextOptions contract) is a multiple of the font size; it is set before the
 * host's first sync, so it takes effect. Harmless on other text impls.
 */
function setLineHeight(t: Text, pitch: number, size: number): void {
  (t as unknown as { lineHeight: number }).lineHeight = pitch / size;
}

/** Readout label for display: visible edge whitespace (tokens), cut at a word boundary. */
export function readoutLabel(label: string, max = LABEL_MAX_CHARS): string {
  const d = displayToken(label, 4096);
  return d.length > max ? fitText(d, max) : d;
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
    // No maxWidth: title/sub are fitted to one line (wrapping would run into the rows).
    this.title = ui.text('', { size: TITLE_SIZE, color: theme.text, anchorX: 'left', anchorY: 'top' });
    this.sub = ui.text('', { size: SUB_SIZE, color: theme.textDim, anchorX: 'left', anchorY: 'top' });
    this.labels = ui.text('', { size: LABEL_SIZE, color: theme.text, anchorX: 'left', anchorY: 'top', font: 'mono' });
    this.values = ui.text('', { size: VALUE_SIZE, color: theme.textDim, anchorX: 'right', anchorY: 'top', font: 'mono' });
    setLineHeight(this.labels, PITCH, LABEL_SIZE);
    setLineHeight(this.values, PITCH, VALUE_SIZE);
    for (const t of [this.title, this.sub, this.labels, this.values]) {
      t.position.z = 0.002;
      t.raycast = noRaycast;
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

  /** Current panel width (W_MIN..W_MAX; grows with the label column and the title). */
  get width(): number {
    return this.w;
  }

  /** (Re)build the panel for a row count and width (panel geometry is cached by the UiKit). */
  private ensurePanel(rows: number, labelChars: number, w: number): void {
    const labelW = labelWidth(labelChars);
    if (rows === this.rows && Math.abs(w - this.w) < 1e-6 && Math.abs(labelW - this.labelW) < 1e-9 && this.panel) return;
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
    const labels = items.map((it) => readoutLabel(it.label));
    let chars = LABEL_MIN_CHARS;
    for (const l of labels) chars = Math.max(chars, l.length);
    chars = Math.min(LABEL_MAX_CHARS, chars);
    const title = (r?.title || fallbackTitle).replace(/\s+/g, ' ').trim();
    const sub = !r ? waitingNote : stale ? 'updating…' : r.items.length > READOUT_MAX_ROWS ? `top ${READOUT_MAX_ROWS} of ${r.items.length}` : '';
    // Width: label column first; a long title may widen the panel up to W_MAX.
    const titleW = title.length * TITLE_SIZE * SANS_ADV + 2 * PAD;
    const w = Math.min(W_MAX, Math.max(W_MIN, widthFor(chars), Math.min(W_MAX, titleW)));
    this.ensurePanel(Math.max(1, items.length), chars, w);
    this.title.set(fitText(title, sansChars(w - 2 * PAD, TITLE_SIZE)));
    this.sub.set(fitText(sub, sansChars(w - 2 * PAD, SUB_SIZE)));
    this.labels.set(labels.join('\n'));
    this.values.set(items.map((it) => formatValue(it.value)).join('\n'));

    // Bars: |value| relative to the largest |value| in this readout (values may be > 1).
    let maxAbs = 0;
    for (const it of items) if (Number.isFinite(it.value)) maxAbs = Math.max(maxAbs, Math.abs(it.value));
    const top = this.height / 2 - TITLE_H;
    const x0 = PAD + this.labelW + GAP;
    const span = this.w - x0 - GAP - VALUE_W - PAD;
    for (let i = 0; i < items.length; i++) {
      const v = items[i].value;
      const ok = Number.isFinite(v);
      const len = !ok ? 1e-5 : Math.max(0.002, maxAbs > 0 ? (Math.abs(v) / maxAbs) * span : 0.002);
      this.m4.makeScale(len, ok ? PITCH * 0.42 : 1e-5, 1);
      this.m4.setPosition(x0, top - PITCH * (i + 0.5), 0);
      this.bars.setMatrixAt(i, this.m4);
      this.cTmp.copy(ok && v < 0 ? this.cNeg : this.cPos);
      if (stale) this.cTmp.lerp(this.cDim, 0.6);
      this.bars.setColorAt(i, this.cTmp);
    }
    this.bars.count = items.length;
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
    this.bars.boundingBox = null;
    this.bars.boundingSphere = null;
  }

  /** Bar geometry of row i in panel coordinates (tests/diagnostics). */
  barOf(i: number): { x: number; length: number; visible: boolean } {
    this.bars.getMatrixAt(i, this.m4);
    const e = this.m4.elements;
    return { x: e[12], length: e[0], visible: e[5] > 1e-4 };
  }

  dispose(): void {
    this.barGeo.dispose();
    this.barMat.dispose();
    this.bars.dispose();
  }
}
