// number: a big formatted numeric read-out with a caption and unit — for
// metrics, slider values, losses, counters. Shows input `value` (or the
// `channel` prop, or the static `value` prop).

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { ChannelProp } from '../../shared/binding.ts';
import { resolveColor } from '../../shared/color.ts';
import { formatNumber, formatValue, NUMBER_FORMATS, type NumberFormat } from '../../shared/format.ts';
import { disposeTree } from '../../shared/resources.ts';
import { makeText, MeasureWatch, textSize, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';
import { isTensor, tensorSignature, toScalar } from '../../shared/tensor.ts';

interface NumberProps extends Record<string, unknown> {
  value: number;
  label: string;
  unit: string;
  format: NumberFormat;
  precision: number;
  size: number;
  width: number;
  color: string;
  signColors: boolean;
  channel: string;
}

const definition: WidgetDefinition<NumberProps> = {
  description:
    'Numeric read-out: big formatted value with caption (`label`) and `unit`. Shows input `value` (number, boolean, string, or 1-element tensor), else the `channel` prop\'s value, else the `value` prop. ' +
    'format auto|fixed|int|sci|si|percent with `precision` (significant digits for auto/sci/si, decimals for fixed/percent).',
  version: '1.0.0',
  props: {
    value: { type: 'number', default: 0, description: 'Static value shown until an input/channel value arrives.' },
    label: { type: 'string', default: '', description: 'Caption above the value.' },
    unit: { type: 'string', default: '' },
    format: { type: 'enum', options: [...NUMBER_FORMATS], default: 'auto' },
    precision: { type: 'integer', default: 4, min: 0, max: 12 },
    size: { type: 'number', default: 0.04, min: 0.005, max: 0.5, description: 'Em height of the value text (m).' },
    width: { type: 'number', default: 0.16, min: 0.03, max: 3, description: 'Card width (m).' },
    color: { type: 'color', default: 'text', description: 'Value color (ignored when signColors and the value is non-zero).' },
    signColors: { type: 'boolean', default: false, description: 'Color positive values with the theme positive color and negative ones with negative.' },
    channel: { type: 'channel', default: '', description: 'Optional data channel to display (alternative to linking into `value`).' },
  },
  inputs: {
    value: { type: 'any', description: 'Value to display.' },
  },
  size: [0.16, 0.08, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let valueText: Text | null = null;
    let current: unknown = undefined;
    let colorKey = '';
    let shown = '';
    const watch = new MeasureWatch();
    const channel = new ChannelProp(ctx, (v) => show(v));

    function build(): void {
      if (group) disposeTree(group);
      const p = ctx.props;
      group = new T.Group();
      group.name = 'number';
      const ls = STYLE.labelSize;
      const H = STYLE.pad * 2 + p.size * 1.2 + (p.label ? ls * 1.6 : 0);
      group.add(ctx.ui.panel(p.width, H));
      if (p.label) {
        const t = makeText(ctx, p.label, { size: ls, color: ctx.theme.textDim, anchorX: 'left', anchorY: 'top', maxWidth: p.width - 2 * STYLE.pad });
        t.position.set(-p.width / 2 + STYLE.pad, H / 2 - STYLE.pad, STYLE.zText);
        group.add(t);
      }
      colorKey = '';
      valueText = null;
      makeValueText(resolveColor(ctx.theme, p.color, 'text'));
      ctx.root.add(group);
      render();
    }

    function makeValueText(color: string): void {
      if (!group) return;
      const p = ctx.props;
      const H = STYLE.pad * 2 + p.size * 1.2 + (p.label ? STYLE.labelSize * 1.6 : 0);
      if (valueText) disposeTree(valueText);
      valueText = makeText(ctx, '', { size: p.size, color, anchorX: 'right', anchorY: 'bottom', font: 'mono', whiteSpace: 'nowrap' });
      valueText.name = 'value';
      valueText.position.set(p.width / 2 - STYLE.pad, -H / 2 + STYLE.pad, STYLE.zText);
      group.add(valueText);
      watch.reset([valueText]);
      colorKey = color;
    }

    function render(): void {
      const p = ctx.props;
      const v = current === undefined ? p.value : current;
      let str: string;
      let n = NaN;
      if (typeof v === 'string' && !Number.isFinite(Number(v))) str = v;
      else if (isTensor(v) && v.data.length !== 1) str = tensorSignature(v);
      else if (typeof v === 'boolean') str = v ? 'true' : 'false';
      else {
        n = toScalar(v);
        str = Number.isNaN(n) && v !== undefined && typeof v === 'object' ? formatValue(v, {}, 24) : formatNumber(n, { format: p.format, precision: p.precision, unit: p.unit });
      }
      const color = p.signColors && n > 0 ? ctx.theme.positive : p.signColors && n < 0 ? ctx.theme.negative : resolveColor(ctx.theme, p.color, 'text');
      if (color !== colorKey) {
        // troika applies `color` at render time (no re-sync), so a sign flip is just an
        // assignment; re-create the text only for hosts whose text lacks the field.
        const live = valueText as unknown as { color?: unknown } | null;
        if (live && 'color' in live) {
          live.color = color;
          colorKey = color;
        } else makeValueText(color);
      }
      shown = str;
      valueText?.set(str);
      fit();
    }

    /** Shrink the value text (never grow) so it fits the card width; re-run when glyphs get measured. */
    function fit(): void {
      if (!valueText) return;
      const p = ctx.props;
      const avail = p.width - 2 * STYLE.pad;
      const s = textSize(valueText, { text: shown, size: p.size, font: 'mono' });
      const k = s.width > avail && s.width > 0 ? avail / s.width : 1;
      valueText.scale.setScalar(k);
    }

    function show(v: unknown): void {
      current = v;
      render();
    }

    build();
    return {
      onProps() {
        channel.refresh();
        build();
      },
      onInput(port, v) {
        if (port === 'value') show(v);
      },
      update() {
        if (watch.changed()) fit();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
