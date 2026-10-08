// button: a pressable plate. Pinch it or poke it with an extended index
// finger. Emits `press` (event) on release — or on contact with
// fireOn=press — plus `pressed` (true/false) for hold behaviour. Optionally
// sends a request to Claude (`ask`) and logs the press to the event log.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { mixHex, resolveColor } from '../../shared/color.ts';
import { PressTracker } from '../../shared/handle.ts';
import { disposeTree, ownMaterial } from '../../shared/resources.ts';
import { makeText } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface ButtonProps extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
  color: string;
  fireOn: 'release' | 'press';
  ask: string;
  logEvent: boolean;
}

const FLASH_S = 0.18;
const DEPTH = 0.004; // press travel (m)

const definition: WidgetDefinition<ButtonProps> = {
  description:
    'Push button: pinch or poke it. Emits `press` (event, payload {label, count}) on release (fireOn=press: on contact) and `pressed` true/false while held. ' +
    'Optional `ask` sends that text to Claude when pressed. Link `press` to a port or channel to trigger things.',
  version: '1.0.0',
  props: {
    label: { type: 'string', default: 'Button' },
    width: { type: 'number', default: 0.12, min: 0.02, max: 2 },
    height: { type: 'number', default: 0.045, min: 0.02, max: 1 },
    color: { type: 'color', default: 'accent', description: 'Highlight color when pressed/hovered.' },
    fireOn: { type: 'enum', options: ['release', 'press'], default: 'release', description: 'release = fire when the pinch/poke ends (can be cancelled by sliding off); press = fire on contact.' },
    ask: { type: 'string', default: '', description: 'If set, pressing sends this request to Claude (with this button as context).' },
    logEvent: { type: 'boolean', default: true, description: 'Log each press to the server event log (visible to Claude).' },
  },
  outputs: {
    press: { type: 'event', description: 'Fired once per press: {label, count}.' },
    pressed: { type: 'boolean', description: 'true while held, false on release.' },
  },
  size: [0.12, 0.045, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    let group: THREE.Group | null = null;
    let plate: THREE.Mesh | null = null;
    let mat: THREE.MeshBasicMaterial | null = null;
    let hovered = false;
    let flash = 0;
    let count = 0;
    const press = new PressTracker(['press']);
    const cIdle = new T.Color();
    const cHover = new T.Color();
    const cDown = new T.Color();

    function build(): void {
      if (group) disposeTree(group);
      // A rebuild drops the hit target mid-press: release `pressed` so holders don't stick.
      if (press.pressed) ctx.emit('pressed', false);
      press.reset();
      const p = ctx.props;
      const accent = resolveColor(ctx.theme, p.color, 'accent');
      cIdle.set(ctx.theme.surface);
      cHover.set(mixHex(ctx.theme.surface, accent.startsWith('#') ? accent : ctx.theme.accent, 0.3));
      cDown.set(accent);
      group = new T.Group();
      group.name = 'button';
      // Rounded plate from the UiKit (keeps the themed border); own material so it can change color.
      plate = ctx.ui.panel(p.width, p.height, { color: ctx.theme.surface, opacity: 1 });
      mat = ownMaterial(T, ctx.theme.surface, { doubleSide: true });
      plate.material = mat;
      plate.name = 'button';
      group.add(plate);
      const label = makeText(ctx, p.label, { size: Math.min(STYLE.bodySize * 1.1, p.height * 0.45), color: ctx.theme.text, anchorX: 'center', anchorY: 'middle', maxWidth: p.width - 0.01, weight: 'semibold' });
      label.position.z = STYLE.zText;
      plate.add(label); // label travels with the plate
      ctx.interactive(plate);
      ctx.root.add(group);
      paint();
    }

    function paint(): void {
      if (!mat || !plate) return;
      if (press.pressed) mat.color.copy(cDown);
      else if (flash > 0) mat.color.lerpColors(hovered ? cHover : cIdle, cDown, flash / FLASH_S);
      else mat.color.copy(hovered ? cHover : cIdle);
      plate.position.z = press.pressed ? -DEPTH : 0;
    }

    function fire(): void {
      count++;
      const payload = { label: ctx.props.label, count };
      ctx.emit('press', payload);
      if (ctx.props.logEvent) ctx.event('press', payload);
      if (ctx.props.ask) ctx.askAgent(ctx.props.ask);
    }

    build();
    ctx.emit('pressed', false);
    return {
      onProps: build,
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') {
          hovered = e.phase === 'start' || e.phase === 'move';
          paint();
          return;
        }
        const r = press.handle(e);
        if (r === 'down') {
          ctx.emit('pressed', true);
          if (ctx.props.fireOn === 'press') fire();
        } else if (r === 'up' || r === 'cancel') {
          ctx.emit('pressed', false);
          if (r === 'up' && ctx.props.fireOn !== 'press') fire();
          flash = r === 'up' ? FLASH_S : 0;
        }
        paint();
      },
      update(dt) {
        if (flash > 0) {
          flash = Math.max(0, flash - dt);
          paint();
        }
      },
      dispose() {
        if (press.pressed) ctx.emit('pressed', false);
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
