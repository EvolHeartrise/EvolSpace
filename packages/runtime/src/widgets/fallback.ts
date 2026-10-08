// Built-in fallback for an entity whose widget is missing or broken: a
// wireframe box (the widget's declared size, or 30 cm) with an error label.
// It stays grabbable (entity bounds), so the user can move/delete it.

import * as THREE from 'three';
import type { Vec3 } from '@evolspace/protocol';
import type { RuntimeUiKit } from '../ui/UiKit.ts';
import { unitBoxEdgesGeometry } from '../ui/geometry.ts';
import { SYSTEM_STYLE } from '../theme.ts';

export function createFallback(ui: RuntimeUiKit, widget: string, message: string, size?: Vec3): THREE.Group {
  const s: Vec3 = size && size.every((v) => Number.isFinite(v) && v > 0) ? size : [0.3, 0.3, 0.3];
  const g = new THREE.Group();
  g.name = 'fallback';
  const box = new THREE.LineSegments(unitBoxEdgesGeometry(), ui.lineMaterial(SYSTEM_STYLE.error, 0.9));
  box.scale.set(s[0], s[1], s[2]);
  box.name = 'fallback-box';
  g.add(box);
  const short = message.length > 160 ? message.slice(0, 157) + '…' : message;
  const label = ui.textEx(`${widget}\n${short}`, {
    size: Math.min(0.022, Math.max(0.01, s[0] / 16)),
    color: SYSTEM_STYLE.error,
    maxWidth: Math.max(0.2, s[0]),
    anchorX: 'center',
    anchorY: 'bottom',
    textAlign: 'center',
    outline: { width: 0.0015 },
  });
  label.position.set(0, s[1] / 2 + 0.01, 0);
  label.name = 'fallback-label';
  g.add(label);
  return g;
}
