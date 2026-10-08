// Regression: entity screenshots (mirror → runtime.frameEntity → Picker.subtreeBounds)
// framed the resid-lens rig at about a third of the image. The node / delta-tick
// InstancedMeshes had the whole layout box written into their GEOMETRY bounds, and
// the runtime measures an InstancedMesh as geometry box × every instance matrix, so
// each instance contributed a stack-sized box. Measured here with the runtime's own
// objectBox so the test sees exactly what framing sees.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { WidgetContext } from '@evolspace/protocol';
import { objectBox } from '../../../../packages/runtime/src/interaction/Picker.ts';
import def from '../widget.ts';
import type { ResidFlow, ResidProps } from '../controller.ts';
import { layerY } from '../layout.ts';
import { generateSample } from '../demo-data.ts';
import { makeCtx, propDefaults, tick } from './fake-ctx.ts';

function isStubText(o: THREE.Object3D): boolean {
  return typeof (o as unknown as { set?: unknown }).set === 'function' && typeof (o as unknown as { text?: unknown }).text === 'string';
}

/** Runtime framing bounds of `root`'s visible meshes (texts excluded: their real bounds come from troika). */
function framingBounds(root: THREE.Object3D, only?: (o: THREE.Object3D) => boolean): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const out = new THREE.Box3();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (!isStubText(o) && (!only || only(o))) {
      const b = objectBox(o);
      if (b) out.union(b.clone().applyMatrix4(o.matrixWorld));
    }
    o.children.forEach(visit);
  };
  visit(root);
  return out;
}

describe('resid-flow framing bounds (runtime objectBox)', () => {
  it('node and delta-tick instances are bounded by the plane stack, not stack × instances', async () => {
    const f = makeCtx({ width: 0.6, height: 0.8 }, propDefaults(def));
    const w = (await def.create(f.ctx as WidgetContext<ResidProps>)) as ResidFlow;
    const s = generateSample(0, { layers: 3, heads: 2 });
    for (const [k, v] of Object.entries({ meta: s.meta, 'resid.proj': s.proj, 'resid.norm': s.norm, 'resid.delta': s.delta, 'resid.mask': s.mask, attn: s.attn })) {
      f.push(`interp.${k}`, v);
    }
    tick(w);
    const L = w.debug().layout!;
    expect(L).toBeTruthy();
    const yLo = layerY(L, 0), yHi = layerY(L, L.L1 - 1);
    const half = L.width / 2;
    // Delta ticks stand up to ~0.42·spacing above their node (shader-sized), nodes ~nodeSize.
    const margin = L.spacing * 0.5 + 0.04;

    for (const name of ['nodes', 'delta-ticks']) {
      const mesh = f.root.getObjectByName(name) as THREE.InstancedMesh | undefined;
      expect(mesh, name).toBeTruthy();
      mesh!.visible = true;
      const b = framingBounds(mesh!);
      expect(b.isEmpty(), name).toBe(false);
      expect(b.min.y, `${name} min.y`).toBeGreaterThan(yLo - margin);
      expect(b.max.y, `${name} max.y`).toBeLessThan(yHi + margin);
      expect(b.min.x, `${name} min.x`).toBeGreaterThan(-half - margin);
      expect(b.max.x, `${name} max.x`).toBeLessThan(half + margin);
    }

    // The whole widget (minus text) stays close to the stack: the readout card sits
    // to the right, but nothing doubles the height.
    const all = framingBounds(f.root).getSize(new THREE.Vector3());
    const stackH = yHi - yLo;
    expect(all.y).toBeLessThan(stackH + 3 * L.spacing + 0.2);
    expect(all.z).toBeLessThan(L.width + 0.2);
    expect(f.errors).toEqual([]);
  });
});

describe('resid-flow header subtitle', () => {
  it('separates the sample / lens / size groups visibly (troika collapses space runs)', async () => {
    const f = makeCtx({}, propDefaults(def));
    const w = (await def.create(f.ctx as WidgetContext<ResidProps>)) as ResidFlow;
    const s = generateSample(0, { layers: 3, heads: 2 });
    for (const [k, v] of Object.entries({ meta: s.meta, 'resid.proj': s.proj, 'resid.mask': s.mask })) f.push(`interp.${k}`, v);
    tick(w);
    const sub = f.ui.texts.map((t) => t.text).find((t) => t.includes('tokens'));
    expect(sub, 'subtitle').toBeTruthy();
    expect(sub).toMatch(/ \| lens /);
    expect(sub).not.toMatch(/ {2}/);
  });
});
