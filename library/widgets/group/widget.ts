// group: an empty container entity. Parent other entities to it to move,
// rotate, scale, hide or remove them together. Without a handle it has no
// visuals and is not hit-testable (grabbing a child moves only that child);
// `handle: true` adds a small grab bar so the user can move the whole group.

import type { WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText } from '../../shared/text.ts';
import { STYLE } from '../../shared/style.ts';

interface GroupProps extends Record<string, unknown> {
  handle: boolean;
  label: string;
}

const definition: WidgetDefinition<GroupProps> = {
  description:
    'Empty container: parent entities to it (entity.parent = group id) to move/scale/hide/remove them as one. ' +
    'Invisible and not grabbable by default; handle=true shows a small grab bar (with optional label) that moves the whole group.',
  version: '1.0.0',
  props: {
    handle: { type: 'boolean', default: false, description: 'Show a grab bar at the group origin.' },
    label: { type: 'string', default: '', description: 'Caption next to the grab bar (only with handle).' },
  },
  // No `size` on purpose: the runtime picker treats an entity with empty content
  // as a box of its declared size, which would make an invisible group a phantom
  // grab target that steals pinches from its own children near the origin.
  create(ctx) {
    const T = ctx.THREE;
    let g: THREE.Group | null = null;
    const build = () => {
      if (g) disposeTree(g);
      g = null;
      if (!ctx.props.handle) return;
      g = new T.Group();
      g.name = 'group-handle';
      const bar = new T.Mesh(sharedGeometry(T, 'capsule'), ownMaterial(T, ctx.theme.textDim, { opacity: 0.8 }));
      bar.name = 'grab-bar';
      bar.rotation.z = Math.PI / 2;
      bar.scale.set(0.024, 0.07, 0.024); // unit capsule: d=0.5, h=1 → 12 mm × 70 mm
      g.add(bar);
      if (ctx.props.label) {
        const t = makeText(ctx, String(ctx.props.label), { size: STYLE.labelSize, color: ctx.theme.textDim, anchorX: 'left', anchorY: 'middle' });
        t.position.set(0.04, 0, 0);
        g.add(t);
      }
      ctx.root.add(g);
    };
    build();
    return {
      onProps: build,
      dispose: () => { if (g) disposeTree(g); },
    };
  },
};

export default definition;
