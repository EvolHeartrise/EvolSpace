// slider: a numeric control. Pinch the knob (or anywhere on the track) and
// move the hand to drag; poke the track to jump. Emits `value` while it
// changes and `commit` when the drag ends; persists its value into the scene
// (throttled) so it survives reloads. Input `value` sets it without
// persisting (e.g. when a channel drives it).

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { Throttle } from '../../shared/binding.ts';
import { resolveColor } from '../../shared/color.ts';
import { formatNumber } from '../../shared/format.ts';
import { along, DragHandle, dragBinding, KnobVisual } from '../../shared/handle.ts';
import { clamp, estimateTextWidth, snap } from '../../shared/layout.ts';
import { disposeTree, hitMaterial, ownMaterial, shadedGeometry, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';
import { toScalar } from '../../shared/tensor.ts';

interface SliderProps extends Record<string, unknown> {
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  orientation: 'horizontal' | 'vertical';
  length: number;
  showValue: boolean;
  decimals: number;
  unit: string;
  color: string;
}

const KNOB = 0.022; // knob diameter (m)
const TRACK_H = 0.006;
const PERSIST_MS = 250;

const definition: WidgetDefinition<SliderProps> = {
  description:
    'Numeric slider: pinch-drag the knob (or the track) to change `value` within [min, max] snapped to `step`; poke the track to jump. ' +
    'Outputs `value` on every change and `commit` when a drag ends; input `value` sets it. Shows label + formatted value; persists the value.',
  version: '1.0.0',
  props: {
    min: { type: 'number', default: 0 },
    max: { type: 'number', default: 1 },
    step: { type: 'number', default: 0, min: 0, description: 'Snap increment; 0 = continuous. Integer steps ≤ 24 show tick marks.' },
    value: { type: 'number', default: 0.5, description: 'Current value (persisted as the user drags).' },
    label: { type: 'string', default: '', description: 'Caption shown above the track.' },
    orientation: { type: 'enum', options: ['horizontal', 'vertical'], default: 'horizontal' },
    length: { type: 'number', default: 0.24, min: 0.05, max: 2, description: 'Track length in meters.' },
    showValue: { type: 'boolean', default: true },
    decimals: { type: 'integer', default: -1, min: -1, max: 10, description: 'Decimals in the value read-out; -1 = derived from step.' },
    unit: { type: 'string', default: '', description: 'Unit suffix for the read-out.' },
    color: { type: 'color', default: 'accent', description: 'Fill/knob color.' },
  },
  inputs: {
    value: { type: 'number', description: 'Sets the value (clamped/snapped); re-emitted on `value` if it changed. Not persisted.' },
  },
  outputs: {
    value: { type: 'number', description: 'Current value; emitted on create and whenever it changes.' },
    commit: { type: 'number', description: 'Final value when a drag/jump ends (use for expensive consumers).' },
  },
  interactions: [dragBinding('slider-drag', 'drag')],
  size: [0.28, 0.07, 0.02],
  create(ctx) {
    const T = ctx.THREE;
    let value = Number.NaN;
    let group: THREE.Group | null = null;
    let track: THREE.Group | null = null;
    let fill: THREE.Mesh | null = null;
    let knob: THREE.Mesh | null = null;
    let knobVis: KnobVisual | null = null;
    let valueText: Text | null = null;
    let dragStartValue = 0;
    const persist = new Throttle<number>((v) => ctx.setProps({ value: v }), PERSIST_MS);

    const range = () => {
      const { min, max } = ctx.props;
      return Number.isFinite(min) && Number.isFinite(max) && max !== min ? { min, max } : { min: 0, max: 1 };
    };
    const axis = (): [number, number, number] => (ctx.props.orientation === 'vertical' ? [0, 1, 0] : [1, 0, 0]);
    const quantize = (v: number) => {
      const { min, max } = range();
      // Continuous sliders still snap to range/1e6 so float noise (e.g. from f32
      // tensors) doesn't count as a change and the read-out stays clean.
      return snap(v, min, max, ctx.props.step > 0 ? ctx.props.step : Math.abs(max - min) * 1e-6);
    };
    const fraction = (v: number) => {
      const { min, max } = range();
      return clamp((v - min) / (max - min), 0, 1);
    };
    const format = (v: number) => {
      const p = ctx.props;
      const decimals = p.decimals >= 0 ? p.decimals : p.step > 0 ? Math.max(0, Math.min(6, Math.ceil(-Math.log10(p.step) - 1e-9))) : -1;
      return decimals >= 0 ? formatNumber(v, { format: 'fixed', precision: decimals, unit: p.unit }) : formatNumber(v, { precision: 3, unit: p.unit });
    };

    const drag = new DragHandle(T, {
      onStart(p, part) {
        knobVis?.setActive(true);
        if (part === 'track') {
          // Jump to the pinched point, then drag relative from there.
          const { min, max } = range();
          const center = track!.position;
          const s = (p.x - center.x) * axis()[0] + (p.y - center.y) * axis()[1];
          setValue(min + (s / ctx.props.length + 0.5) * (max - min), 'user');
        }
        dragStartValue = value;
      },
      onMove(_p, delta) {
        const { min, max } = range();
        setValue(dragStartValue + (along(delta, axis()) / ctx.props.length) * (max - min), 'user');
      },
      onEnd() {
        knobVis?.setActive(false);
        persist.flush();
        ctx.emit('commit', value);
      },
      onHover(h) {
        knobVis?.setHover(h);
      },
    });

    function build(): void {
      knobVis?.dispose();
      if (group) disposeTree(group);
      // An ongoing drag survives a rebuild (the agent may edit props mid-drag): the drag
      // state lives in ctx.root coordinates, independent of the meshes rebuilt here.
      const p = ctx.props;
      const vertical = p.orientation === 'vertical';
      const L = p.length;
      const pad = STYLE.pad;
      const ls = STYLE.labelSize;
      const row = ls * 1.6;
      const color = resolveColor(ctx.theme, p.color, 'accent');
      group = new T.Group();
      group.name = 'slider';

      // Card geometry.
      let W: number, H: number, trackX: number, trackY: number;
      if (vertical) {
        const labelW = Math.max(estimateTextWidth(p.label, ls), estimateTextWidth(format(range().max), ls));
        W = Math.max(0.07, labelW + 2 * pad);
        H = pad + (p.label ? row : 0) + L + KNOB + (p.showValue ? row : 0) + pad;
        trackX = 0;
        trackY = H / 2 - pad - (p.label ? row : 0) - (L + KNOB) / 2;
      } else {
        W = L + KNOB + 2 * pad;
        H = pad + (p.label || p.showValue ? row : 0) + KNOB + 0.008 + pad;
        trackX = 0;
        trackY = -H / 2 + pad + (KNOB + 0.008) / 2;
      }
      const card = ctx.ui.panel(W, H);
      card.name = 'card';
      group.add(card);

      // Track assembly in its own frame: +X runs from min to max.
      track = new T.Group();
      track.name = 'track-frame';
      track.position.set(trackX, trackY, 0);
      if (vertical) track.rotation.z = Math.PI / 2;
      group.add(track);
      const rail = new T.Mesh(sharedGeometry(T, 'box'), ownMaterial(T, ctx.theme.surface));
      rail.scale.set(L, TRACK_H, 0.003);
      rail.position.z = 0.0025;
      rail.name = 'rail';
      rail.raycast = () => {};
      track.add(rail);
      fill = new T.Mesh(sharedGeometry(T, 'box'), ownMaterial(T, color, { opacity: 0.9 }));
      fill.name = 'fill';
      fill.raycast = () => {};
      track.add(fill);
      // Tick marks for coarse integer-ish steps.
      const { min, max } = range();
      const steps = p.step > 0 ? Math.round((max - min) / p.step) : 0;
      if (steps >= 2 && steps <= 24) {
        const pos = new Float32Array((steps + 1) * 6);
        for (let i = 0; i <= steps; i++) {
          const x = -L / 2 + (i / steps) * L;
          pos.set([x, -TRACK_H, 0.004, x, -TRACK_H - 0.005, 0.004], i * 6);
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        const ticks = new T.LineSegments(g, new T.LineBasicMaterial({ color: ctx.theme.textDim }));
        ticks.raycast = () => {};
        ticks.name = 'ticks';
        track.add(ticks);
      }
      // Generous invisible hit area over the track (pinch anywhere on it).
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(L + KNOB, KNOB * 1.4, 0.02);
      hit.position.z = 0.006;
      hit.name = 'track';
      track.add(hit);
      ctx.interactive(hit);
      const shaded = { shaded: true };
      const mats = { idle: ownMaterial(T, color, shaded), hover: ownMaterial(T, ctx.theme.text, shaded), active: ownMaterial(T, ctx.theme.accent2, shaded) };
      knob = new T.Mesh(shadedGeometry(T, 'sphere'), mats.idle);
      knob.name = 'knob';
      knob.position.z = 0.008;
      knobVis = new KnobVisual(knob, mats, KNOB, 1.2);
      knobVis.setActive(drag.dragging);
      knobVis.setHover(drag.hovered);
      track.add(knob);
      ctx.interactive(knob);

      // Labels.
      valueText = null;
      if (vertical) {
        if (p.label) {
          const t = makeText(ctx, p.label, { size: ls, color: ctx.theme.textDim, anchorX: 'center', anchorY: 'middle' });
          t.position.set(0, H / 2 - pad - row / 2, STYLE.zText);
          group.add(t);
        }
        if (p.showValue) {
          valueText = makeText(ctx, '', { size: ls, color: ctx.theme.text, anchorX: 'center', anchorY: 'middle', font: 'mono' });
          valueText.position.set(0, -H / 2 + pad + row / 2, STYLE.zText);
          group.add(valueText);
        }
      } else {
        const y = H / 2 - pad - row / 2;
        if (p.label) {
          const t = makeText(ctx, p.label, { size: ls, color: ctx.theme.textDim, anchorX: 'left', anchorY: 'middle', maxWidth: L * 0.7 });
          t.position.set(-W / 2 + pad, y, STYLE.zText);
          group.add(t);
        }
        if (p.showValue) {
          valueText = makeText(ctx, '', { size: ls, color: ctx.theme.text, anchorX: 'right', anchorY: 'middle', font: 'mono' });
          valueText.position.set(W / 2 - pad, y, STYLE.zText);
          group.add(valueText);
        }
      }
      ctx.root.add(group);
      render();
    }

    /** Move knob/fill and update the read-out for the current value. */
    function render(): void {
      if (!knob || !fill || !Number.isFinite(value)) return;
      const L = ctx.props.length;
      const t = fraction(value);
      knob.position.x = -L / 2 + t * L;
      const w = Math.max(1e-4, t * L);
      fill.scale.set(w, TRACK_H * 1.05, 0.0035);
      fill.position.set(-L / 2 + w / 2, 0, 0.0028);
      fill.visible = t > 0.001;
      valueText?.set(format(value));
    }

    function setValue(raw: number, source: 'user' | 'input' | 'props' | 'init'): void {
      if (!Number.isFinite(raw)) return;
      const v = quantize(raw);
      if (v === value) return;
      value = v;
      render();
      ctx.emit('value', v);
      if (source === 'user') persist.call(v);
    }

    build();
    setValue(Number.isFinite(ctx.props.value) ? ctx.props.value : range().min, 'init');

    return {
      onProps(p, prev) {
        build();
        // A changed `value` prop (agent / undo) wins unless the user is dragging right now.
        // An unchanged one must not: the current value may come from an input link
        // (not persisted) and an unrelated prop edit would otherwise revert it.
        const valueChanged = p.value !== prev.value && Number.isFinite(p.value);
        if (valueChanged && !drag.dragging && quantize(p.value as number) !== value) setValue(p.value as number, 'props');
        else {
          // Range/step may have changed: re-clamp.
          const v = quantize(value);
          if (v !== value) setValue(v, 'props');
          else render();
        }
      },
      onInput(port, v) {
        if (port === 'value') setValue(toScalar(v), 'input');
      },
      onInteraction(e: InteractionEvent) {
        drag.handle(e);
      },
      dispose() {
        // Write a pending drag value before going away (hot reload mid-drag).
        persist.flush();
        persist.cancel();
        knobVis?.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
