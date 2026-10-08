// box: convenience alias of `shape` with kind fixed to 'box' (the most common
// primitive; also what many examples and tests spawn by default).

import type { WidgetDefinition } from '@evolspace/protocol';
import { buildShape, SHAPE_INPUTS, SHAPE_OUTPUTS, shapeProps, type ShapeProps } from '../../shared/shape.ts';

const definition: WidgetDefinition<ShapeProps> = {
  description:
    'A box (alias of the `shape` widget with kind=box): unlit theme-colored cube sized by `size` (meters) × `dims`, with optional wireframe, opacity, outline and label.',
  version: '1.0.0',
  props: shapeProps('box', false),
  inputs: SHAPE_INPUTS,
  outputs: SHAPE_OUTPUTS,
  size: [0.1, 0.1, 0.1],
  create(ctx) {
    const s = buildShape(ctx, 'box');
    return {
      onProps: () => s.rebuild(),
      onInput: (port, v) => s.input(port, v),
      onInteraction: (e) => s.interact(e),
      dispose: () => s.dispose(),
    };
  },
};

export default definition;
