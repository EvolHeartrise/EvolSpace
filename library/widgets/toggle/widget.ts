// toggle: a labeled on/off switch. Pinch or poke to flip. Boolean in/out;
// the state persists in the scene.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { resolveColor } from '../../shared/color.ts';
import { PressTracker } from '../../shared/handle.ts';
import { estimateTextWidth } from '../../shared/layout.ts';
import { disposeTree, hitMaterial, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface ToggleProps extends Record<string, unknown> {
  value: boolean;
  label: string;
  color: string;
  width: number;
}

const SW = 0.05; // switch width
const SH = 0.026; // switch height
const ANIM_S = 0.12;

const definition: WidgetDefinition<ToggleProps> = {
  description:
    'On/off switch with a label: pinch or poke to flip. Emits boolean `value` on create and on every change; input `value` sets it (not persisted). User flips persist in the scene.',
  version: '1.0.0',
  props: {
    value: { type: 'boolean', default: false },
    label: { type: 'string', default: 'Toggle' },
    color: { type: 'color', default: 'accent', description: 'Track color when on.' },
    width: { type: 'number', default: 0, min: 0, max: 2, description: 'Card width in meters; 0 = fit the label.' },
  },
  inputs: {
    value: { type: 'boolean', description: 'Sets the state (truthy/falsy); re-emitted if it changed.' },
  },
  outputs: {
    value: { type: 'boolean', description: 'Current state.' },
  },
  size: [0.16, 0.05, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let value = !!ctx.props.value;
    let group: THREE.Group | null = null;
    let dot: THREE.Mesh | null = null;
    let trackMat: THREE.MeshBasicMaterial | null = null;
    let anim = value ? 1 : 0; // 0 = off position, 1 = on position
    const press = new PressTracker(['press']);
    const cOff = new T.Color();
    const cOn = new T.Color();

    function build(): void {
      if (group) disposeTree(group);
      press.reset();
      const p = ctx.props;
      cOff.set(ctx.theme.border);
      cOn.set(resolveColor(ctx.theme, p.color, 'accent'));
      const ls = STYLE.bodySize;
      const W = p.width > 0 ? p.width : Math.max(0.1, estimateTextWidth(p.label, ls) + SW + 3 * STYLE.pad);
      const H = SH + 2 * STYLE.pad;
      group = new T.Group();
      group.name = 'toggle';
      group.add(ctx.ui.panel(W, H));
      const label = makeText(ctx, p.label, { size: ls, color: ctx.theme.text, anchorX: 'left', anchorY: 'middle', maxWidth: W - SW - 3 * STYLE.pad });
      label.position.set(-W / 2 + STYLE.pad, 0, STYLE.zText);
      group.add(label);
      const sw = new T.Group();
      sw.name = 'switch-frame';
      sw.position.set(W / 2 - STYLE.pad - SW / 2, 0, 0.002);
      group.add(sw);
      // Pill = two discs + a box (shared unit geometry).
      trackMat = ownMaterial(T, ctx.theme.border);
      for (const x of [-(SW - SH) / 2, (SW - SH) / 2]) {
        const cap = new T.Mesh(sharedGeometry(T, 'disc'), trackMat);
        cap.scale.set(SH, SH, 1);
        cap.position.x = x;
        cap.raycast = () => {};
        sw.add(cap);
      }
      const mid = new T.Mesh(sharedGeometry(T, 'plane'), trackMat);
      mid.scale.set(SW - SH, SH, 1);
      mid.raycast = () => {};
      sw.add(mid);
      dot = new T.Mesh(sharedGeometry(T, 'disc'), ownMaterial(T, ctx.theme.text));
      dot.scale.set(SH * 0.75, SH * 0.75, 1);
      dot.position.z = 0.001;
      dot.raycast = () => {};
      sw.add(dot);
      const hit = new T.Mesh(sharedGeometry(T, 'box'), hitMaterial(T));
      hit.scale.set(SW + 0.01, SH + 0.01, 0.02);
      hit.name = 'switch';
      sw.add(hit);
      ctx.interactive(hit);
      ctx.root.add(group);
      paint();
    }

    function paint(): void {
      if (!dot || !trackMat) return;
      dot.position.x = -(SW - SH) / 2 + anim * (SW - SH);
      trackMat.color.lerpColors(cOff, cOn, anim);
    }

    function set(v: boolean, persist: boolean): void {
      if (v === value) return;
      value = v;
      ctx.emit('value', v);
      if (persist) ctx.setProps({ value: v });
    }

    build();
    ctx.emit('value', value);
    return {
      onProps(p, prev) {
        build();
        // Only a changed `value` prop overrides the state (it may have come from an input link).
        if (p.value !== prev.value && !!p.value !== value) set(!!p.value, false);
        anim = value ? 1 : 0;
        paint();
      },
      onInput(port, v) {
        if (port === 'value') set(!!v && v !== 'false' && v !== '0', false);
      },
      onInteraction(e: InteractionEvent) {
        if (press.handle(e) === 'down') set(!value, true);
      },
      update(dt) {
        const target = value ? 1 : 0;
        if (anim !== target) {
          const step = dt / ANIM_S;
          anim = target > anim ? Math.min(target, anim + step) : Math.max(target, anim - step);
          paint();
        }
      },
      dispose() {
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
