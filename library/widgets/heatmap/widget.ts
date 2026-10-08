// heatmap: a 2-D matrix as a colored grid (attention patterns, confusion
// matrices, activations × tokens). One DataTexture (nearest filtering) on one
// quad; values mapped through a theme or scientific colormap. Hovering a cell
// highlights it, shows its value and emits `cell`; pressing emits `select`.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { buildLut, COLORMAPS, isColormap, lutIndex, type ColormapName, type Lut } from '../../shared/colormap.ts';
import { formatNumber, truncate } from '../../shared/format.ts';
import { estimateTextWidth } from '../../shared/layout.ts';
import { disposeTree, sharedGeometry } from '../../shared/resources.ts';
import { buildCard, STYLE, type Rect } from '../../shared/style.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { asMatrix, extent, isTensor, type Matrix } from '../../shared/tensor.ts';
import { PressTracker } from '../../shared/handle.ts';

interface HeatmapProps extends Record<string, unknown> {
  title: string;
  width: number;
  height: number;
  colormap: ColormapName;
  autoscale: boolean;
  min: number;
  max: number;
  rowLabels: string[];
  colLabels: string[];
  showColorbar: boolean;
  interactive: boolean;
  channel: string;
}

const MAX_LABELS = 48;
const LABEL_SIZE = 0.01;

const definition: WidgetDefinition<HeatmapProps> = {
  description:
    'Heatmap of a 2-D matrix: tensor [R, C] (higher rank → first [R, C] slice) or number[][]. Row 0 is at the top. ' +
    'colormap sequential|diverging (centered on 0)|viridis|magma|gray; autoscale or min/max; optional row/col labels and colorbar. ' +
    'Hover a cell → `cell` {row, col, value} (null on leave); press → `select`.',
  version: '1.0.0',
  props: {
    title: { type: 'string', default: '' },
    width: { type: 'number', default: 0.32, min: 0.05, max: 4 },
    height: { type: 'number', default: 0.32, min: 0.05, max: 4 },
    colormap: { type: 'enum', options: COLORMAPS.filter((c) => c !== 'palette'), default: 'sequential' },
    autoscale: { type: 'boolean', default: true, description: 'Fit the color range to the data (diverging: symmetric around 0).' },
    min: { type: 'number', default: 0 },
    max: { type: 'number', default: 1 },
    rowLabels: { type: 'json', default: [], description: 'string[] row labels (shown when ≤ 48 rows).' },
    colLabels: { type: 'json', default: [], description: 'string[] column labels (shown vertically when ≤ 48 columns).' },
    showColorbar: { type: 'boolean', default: true },
    interactive: { type: 'boolean', default: true, description: 'Hover/press cells (grab the heatmap by its frame).' },
    channel: { type: 'channel', default: '', description: 'Optional data channel (alternative to linking into `data`).' },
  },
  inputs: {
    data: { type: 'any', description: '2-D tensor or number[][].' },
  },
  outputs: {
    cell: { type: 'json', description: 'Hovered cell {row, col, value}, or null when the hand leaves.' },
    select: { type: 'json', description: 'Pressed cell {row, col, value}.' },
  },
  size: [0.32, 0.32, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let quad: THREE.Mesh | null = null;
    let tex: THREE.DataTexture | null = null;
    let texBytes = new Uint8Array(0);
    let highlight: THREE.LineLoop | null = null;
    let readout: Text | null = null;
    let barMin: Text | null = null;
    let barMax: Text | null = null;
    let rowTexts: Text[] = [];
    let colTexts: Text[] = [];
    let plot: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
    let lut: Lut = buildLut(ctx.theme, 'sequential');
    let mat: Matrix | null = null;
    let lo = 0;
    let hi = 1;
    let hoverKey = -1;
    let dirty = true;
    const press = new PressTracker(['press']);
    const channel = new ChannelProp(ctx, (v) => setData(v));

    const colormap = (): ColormapName => (isColormap(ctx.props.colormap) && ctx.props.colormap !== 'palette' ? ctx.props.colormap : 'sequential');
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

    function build(): void {
      if (group) disposeTree(group);
      tex = null;
      const p = ctx.props;
      lut = buildLut(ctx.theme, colormap());
      const card = buildCard(ctx, { width: p.width, height: p.height, title: p.title || undefined });
      group = card.group;
      group.name = 'heatmap';
      const rl = strings(p.rowLabels);
      const cl = strings(p.colLabels);
      const left = rl.length && rl.length <= MAX_LABELS ? Math.min(0.08, Math.max(...rl.map((s) => estimateTextWidth(truncate(s, 14), LABEL_SIZE))) + 0.006) : 0;
      const bottom = cl.length && cl.length <= MAX_LABELS ? Math.min(0.08, Math.max(...cl.map((s) => estimateTextWidth(truncate(s, 14), LABEL_SIZE))) + 0.006) : 0;
      const right = p.showColorbar ? 0.045 : 0;
      const inner = card.inner;
      // Leave a line under the title area for the hover read-out.
      plot = { x0: inner.x0 + left, x1: inner.x1 - right, y0: inner.y0 + bottom, y1: inner.y1 - STYLE.labelSize * 1.4 };

      quad = new T.Mesh(sharedGeometry(T, 'plane'), new T.MeshBasicMaterial({ color: 0xffffff }));
      quad.name = 'cells';
      quad.scale.set(plot.x1 - plot.x0, plot.y1 - plot.y0, 1);
      quad.position.set((plot.x0 + plot.x1) / 2, (plot.y0 + plot.y1) / 2, STYLE.zContent);
      quad.visible = false;
      group.add(quad);
      if (p.interactive) ctx.interactive(quad);

      // Hover highlight: unit square outline, scaled to a cell.
      const hg = new T.BufferGeometry();
      hg.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
      highlight = new T.LineLoop(hg, new T.LineBasicMaterial({ color: ctx.theme.text }));
      highlight.visible = false;
      highlight.raycast = () => {};
      group.add(highlight);

      readout = makeText(ctx, '', { size: STYLE.labelSize, color: ctx.theme.text, anchorX: 'right', anchorY: 'bottom', font: 'mono', whiteSpace: 'nowrap' });
      readout.position.set(plot.x1, plot.y1 + 0.004, STYLE.zText);
      group.add(readout);

      barMin = barMax = null;
      if (p.showColorbar) {
        const strip = new Uint8Array(lut.bytes);
        const btex = new T.DataTexture(strip, 1, lut.size, T.RGBAFormat);
        btex.colorSpace = T.SRGBColorSpace;
        btex.magFilter = T.LinearFilter;
        btex.needsUpdate = true;
        const bar = new T.Mesh(sharedGeometry(T, 'plane'), new T.MeshBasicMaterial({ map: btex }));
        bar.scale.set(0.012, plot.y1 - plot.y0, 1);
        bar.position.set(plot.x1 + 0.014, (plot.y0 + plot.y1) / 2, STYLE.zContent);
        bar.raycast = () => {};
        group.add(bar);
        barMax = makeText(ctx, '', { size: LABEL_SIZE, color: ctx.theme.textDim, anchorX: 'left', anchorY: 'top', font: 'mono' });
        barMax.position.set(plot.x1 + 0.022, plot.y1, STYLE.zText);
        barMin = makeText(ctx, '', { size: LABEL_SIZE, color: ctx.theme.textDim, anchorX: 'left', anchorY: 'bottom', font: 'mono' });
        barMin.position.set(plot.x1 + 0.022, plot.y0, STYLE.zText);
        group.add(barMax, barMin);
      }
      rowTexts = [];
      colTexts = [];
      if (left) {
        for (const s of rl) {
          const t = makeText(ctx, truncate(s, 14), { size: LABEL_SIZE, color: ctx.theme.textDim, anchorX: 'right', anchorY: 'middle', whiteSpace: 'nowrap' });
          group.add(t);
          rowTexts.push(t);
        }
      }
      if (bottom) {
        for (const s of cl) {
          const t = makeText(ctx, truncate(s, 14), { size: LABEL_SIZE, color: ctx.theme.textDim, anchorX: 'right', anchorY: 'middle', whiteSpace: 'nowrap' });
          t.rotation.z = Math.PI / 2; // reads bottom-to-top, hanging below the plot
          group.add(t);
          colTexts.push(t);
        }
      }
      ctx.root.add(group);
      hoverKey = -1;
      dirty = true;
    }

    function setData(v: unknown): void {
      const m = asMatrix(v);
      if (!m || !m.rows || !m.cols) {
        if (v !== undefined && v !== null) ctx.error(`heatmap: expected a 2-D tensor or number[][] (got ${isTensor(v) ? `tensor ${v.dtype}[${v.shape}]` : typeof v})`);
        return;
      }
      mat = m;
      dirty = true;
    }

    function redraw(): void {
      dirty = false;
      if (!mat || !quad) return;
      const { rows, cols, data } = mat;
      const n = rows * cols;
      const p = ctx.props;
      const cm = colormap();
      if (p.autoscale) {
        const [a, b] = extent(data, n);
        if (cm === 'diverging') {
          const m = Math.max(Math.abs(a), Math.abs(b)) || 1;
          lo = -m;
          hi = m;
        } else {
          lo = Number.isFinite(a) ? a : 0;
          hi = Number.isFinite(b) && b > lo ? b : lo + 1;
        }
      } else {
        lo = p.min;
        hi = p.max > p.min ? p.max : p.min + 1;
      }
      // (Re)allocate the texture only when the matrix shape changes.
      if (!tex || tex.image.width !== cols || tex.image.height !== rows) {
        const old = tex;
        texBytes = new Uint8Array(n * 4);
        tex = new T.DataTexture(texBytes, cols, rows, T.RGBAFormat);
        tex.colorSpace = T.SRGBColorSpace;
        tex.magFilter = T.NearestFilter;
        tex.minFilter = T.NearestFilter;
        tex.generateMipmaps = false;
        (quad.material as THREE.MeshBasicMaterial).map = tex;
        (quad.material as THREE.MeshBasicMaterial).needsUpdate = true;
        old?.dispose();
      }
      const span = hi - lo;
      const bytes = lut.bytes;
      for (let r = 0; r < rows; r++) {
        // Texture row 0 is the bottom: flip so matrix row 0 is on top.
        const dst = (rows - 1 - r) * cols * 4;
        for (let c = 0; c < cols; c++) {
          const x = data[r * cols + c];
          const o = dst + c * 4;
          if (!Number.isFinite(x)) {
            texBytes[o] = texBytes[o + 1] = texBytes[o + 2] = 40;
            texBytes[o + 3] = 255;
            continue;
          }
          const li = lutIndex(lut, (x - lo) / span) * 4;
          texBytes[o] = bytes[li];
          texBytes[o + 1] = bytes[li + 1];
          texBytes[o + 2] = bytes[li + 2];
          texBytes[o + 3] = 255;
        }
      }
      tex.needsUpdate = true;
      quad.visible = true;
      barMin?.set(formatNumber(lo, { precision: 3 }));
      barMax?.set(formatNumber(hi, { precision: 3 }));
      layoutLabels();
      if (hoverKey >= 0) {
        const r = Math.floor(hoverKey / 65536);
        const c = hoverKey % 65536;
        if (r < rows && c < cols) showCell(r, c);
        else clearHover();
      }
    }

    function layoutLabels(): void {
      if (!mat) return;
      const ch = (plot.y1 - plot.y0) / mat.rows;
      const cw = (plot.x1 - plot.x0) / mat.cols;
      rowTexts.forEach((t, i) => {
        t.visible = i < mat!.rows;
        t.position.set(plot.x0 - 0.004, plot.y1 - (i + 0.5) * ch, STYLE.zText);
      });
      colTexts.forEach((t, i) => {
        t.visible = i < mat!.cols;
        t.position.set(plot.x0 + (i + 0.5) * cw, plot.y0 - 0.004, STYLE.zText);
      });
    }

    function cellAt(lp: readonly number[]): [number, number] | null {
      if (!mat) return null;
      const u = (lp[0] - plot.x0) / (plot.x1 - plot.x0);
      const v = (plot.y1 - lp[1]) / (plot.y1 - plot.y0);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
      return [Math.floor(v * mat.rows), Math.floor(u * mat.cols)];
    }

    function showCell(r: number, c: number): void {
      if (!mat || !highlight) return;
      const cw = (plot.x1 - plot.x0) / mat.cols;
      const ch = (plot.y1 - plot.y0) / mat.rows;
      highlight.scale.set(cw, ch, 1);
      highlight.position.set(plot.x0 + (c + 0.5) * cw, plot.y1 - (r + 0.5) * ch, STYLE.zOverlay);
      highlight.visible = true;
      const rl = strings(ctx.props.rowLabels)[r];
      const cl = strings(ctx.props.colLabels)[c];
      readout?.set(`${rl ?? r} · ${cl ?? c}  ${formatNumber(mat.data[r * mat.cols + c], { precision: 4 })}`);
    }

    function clearHover(): void {
      if (hoverKey < 0) return;
      hoverKey = -1;
      if (highlight) highlight.visible = false;
      readout?.set('');
      ctx.emit('cell', null);
    }

    build();
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'data') setData(v);
      },
      onInteraction(e: InteractionEvent) {
        if (!ctx.props.interactive || !mat) return;
        if (e.handler === 'hover') {
          if (e.phase === 'end' || e.phase === 'cancel') return clearHover();
          const cell = cellAt(e.localPoint);
          if (!cell) return clearHover();
          const key = cell[0] * 65536 + cell[1];
          if (key === hoverKey) return;
          hoverKey = key;
          showCell(cell[0], cell[1]);
          ctx.emit('cell', { row: cell[0], col: cell[1], value: mat.data[cell[0] * mat.cols + cell[1]] });
          return;
        }
        if (press.handle(e) === 'down') {
          const cell = cellAt(e.localPoint);
          if (cell) ctx.emit('select', { row: cell[0], col: cell[1], value: mat.data[cell[0] * mat.cols + cell[1]] });
        }
      },
      update() {
        if (dirty) redraw();
      },
      dispose() {
        channel.dispose();
        tex?.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
