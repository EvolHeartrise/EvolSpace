// shape: a primitive solid (box, sphere, cylinder, …) — the basic building
// block for diagrams, markers and simple 3D sketches. Unlit, shared unit
// geometry scaled per instance (cheap on Quest), optional outline and label.

import type { InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import { buildShape, SHAPE_INPUTS, SHAPE_KINDS, SHAPE_OUTPUTS, shapeProps, type ShapeProps } from '../../shared/shape.ts';

const definition: WidgetDefinition<ShapeProps> = {
  description:
    'A primitive solid: kind = box | sphere | cylinder | cone | torus | capsule | plane | ring | tetra | octa. ' +
    'Unlit theme-colored mesh sized by `size` (meters) × `dims`, optional wireframe, opacity, outline and label; set pressable to make it a button that emits `press`.',
  version: '1.0.0',
  props: shapeProps(SHAPE_KINDS[0]),
  inputs: SHAPE_INPUTS,
  outputs: SHAPE_OUTPUTS,
  size: [0.1, 0.1, 0.1],
  create(ctx) {
    const s = buildShape(ctx);
    return {
      onProps: () => s.rebuild(),
      onInput: (port, v) => s.input(port, v),
      onInteraction: (e: InteractionEvent) => s.interact(e),
      dispose: () => s.dispose(),
    };
  },
};

export default definition;
