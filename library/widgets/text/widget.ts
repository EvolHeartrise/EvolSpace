// text: a free-floating label. SDF text (crisp at any distance), optional
// backing plate, optional billboarding toward the viewer. Input 'text'
// replaces the content (numbers are formatted).

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { Billboard, BILLBOARD_MODES, type BillboardMode } from '../../shared/billboard.ts';
import { resolveColor } from '../../shared/color.ts';
import { formatValue } from '../../shared/format.ts';
import { disposeTree } from '../../shared/resources.ts';
import { makeText, MeasureWatch, textSize, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface TextProps extends Record<string, unknown> {
  text: string;
  size: number;
  color: string;
  maxWidth: number;
  align: 'center' | 'left' | 'right';
  font: 'sans' | 'mono';
  billboard: BillboardMode;
  background: boolean;
}

const definition: WidgetDefinition<TextProps> = {
  description:
    'A text label (SDF, crisp at any distance). Props: text, size (em height, m), color, maxWidth (wrap, m; 0 = none), align, font sans|mono, ' +
    'billboard off|yaw|full (turn to face the viewer), background (plate behind the text). Input `text` replaces the content.',
  version: '1.0.0',
  props: {
    text: { type: 'string', default: 'Text', description: 'Content; \\n for line breaks.' },
    size: { type: 'number', default: 0.03, min: 0.002, max: 1, description: 'Em height in meters (0.02 ≈ small label at arm length, 0.05 = heading).' },
    color: { type: 'color', default: 'text', description: 'Theme token or CSS color.' },
    maxWidth: { type: 'number', default: 0, min: 0, description: 'Wrap width in meters; 0 = no wrapping.' },
    align: { type: 'enum', options: ['center', 'left', 'right'], default: 'center', description: 'Horizontal anchor (the entity origin is at this edge).' },
    font: { type: 'enum', options: ['sans', 'mono'], default: 'sans' },
    billboard: { type: 'enum', options: [...BILLBOARD_MODES], default: 'off', description: 'yaw = turn around vertical axis toward the viewer; full = face the viewer completely.' },
    background: { type: 'boolean', default: false, description: 'Draw a panel behind the text.' },
  },
  inputs: {
    text: { type: 'any', description: 'Replaces the text (numbers formatted, objects as JSON).' },
  },
  size: [0.2, 0.05, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const pivot = new T.Group();
    pivot.name = 'text-pivot';
    ctx.root.add(pivot);
    const billboard = new Billboard(T, pivot, 'off');
    const watch = new MeasureWatch();
    let label: Text | null = null;
    let plate: THREE.Mesh | null = null;
    let override: string | null = null;

    const content = () => override ?? String(ctx.props.text ?? '');

    function build(): void {
      if (label) disposeTree(label);
      const p = ctx.props;
      label = makeText(ctx, content(), {
        size: p.size,
        color: resolveColor(ctx.theme, p.color, 'text'),
        maxWidth: p.maxWidth > 0 ? p.maxWidth : undefined,
        anchorX: p.align,
        anchorY: 'middle',
        font: p.font,
        textAlign: p.align,
      });
      label.name = 'text';
      label.position.z = STYLE.zText;
      pivot.add(label);
      watch.reset([label]);
      plateKey = '';
      layoutPlate();
      billboard.setMode(p.billboard);
      billboard.refresh();
    }

    let plateKey = '';
    function layoutPlate(): void {
      if (!ctx.props.background || !label) {
        plate?.removeFromParent();
        plate = null;
        plateKey = '';
        return;
      }
      const p = ctx.props;
      const s = textSize(label, { text: content(), size: p.size, maxWidth: p.maxWidth > 0 ? p.maxWidth : undefined, font: p.font });
      const pad = p.size * 0.5;
      // Quantize to 5 mm so frequently changing text doesn't churn panel geometries.
      const w = Math.ceil((s.width + 2 * pad) / 0.005) * 0.005;
      const h = Math.ceil((s.height + 2 * pad) / 0.005) * 0.005;
      const key = `${w.toFixed(3)}|${h.toFixed(3)}|${p.align}`;
      if (plate && key === plateKey) return;
      plate?.removeFromParent();
      plateKey = key;
      plate = ctx.ui.panel(w, h, { radius: Math.min(0.012, h / 4) });
      plate.position.x = p.align === 'left' ? w / 2 - pad : p.align === 'right' ? -w / 2 + pad : 0;
      pivot.add(plate);
      billboard.refresh();
    }

    build();
    return {
      onProps: build,
      onInput(port, v) {
        if (port !== 'text') return;
        override = v === undefined ? null : typeof v === 'string' ? v : formatValue(v, {}, 400);
        label?.set(content());
        layoutPlate();
      },
      update() {
        // Re-fit the plate once troika has measured the real glyphs.
        if (ctx.props.background && watch.changed()) layoutPlate();
      },
      dispose() {
        billboard.detach();
        disposeTree(pivot);
      },
    };
  },
};

export default definition;
