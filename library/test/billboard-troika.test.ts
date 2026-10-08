// Billboarding must chain, never replace, troika Text's onBeforeRender (troika
// prepares its material there; replacing it makes the text silently vanish).
// Uses the real troika Text class when it loads in Node (its prototype method
// is spied, so no font/worker work happens); otherwise the test is skipped.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Billboard } from '../shared/billboard.ts';
import text from '../widgets/text/widget.ts';
import { mount, type Harness } from './harness.ts';

type TroikaText = THREE.Mesh & { text: string; onBeforeRender: (...a: unknown[]) => void };
let TextClass: (new () => TroikaText) | null = null;
try {
  TextClass = ((await import('troika-three-text')) as unknown as { Text: new () => TroikaText }).Text;
} catch {
  TextClass = null;
}

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  vi.restoreAllMocks();
});

describe.skipIf(!TextClass)('billboard × real troika Text', () => {
  it('chains the prototype onBeforeRender and restores it on detach', () => {
    const spy = vi.spyOn(TextClass!.prototype, 'onBeforeRender').mockImplementation(() => {});
    const pivot = new THREE.Group();
    const t = new TextClass!();
    t.text = 'hello';
    pivot.add(t);
    const bb = new Billboard(THREE, pivot, 'full');
    bb.attach();
    expect(Object.prototype.hasOwnProperty.call(t, 'onBeforeRender')).toBe(true);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 0, 2);
    cam.updateMatrixWorld();
    t.onBeforeRender({ info: { render: { frame: 3 } } }, new THREE.Scene(), cam, t.geometry, t.material, null);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.contexts[0]).toBe(t);
    // Re-attaching (rebuild) does not double-wrap.
    bb.attach();
    t.onBeforeRender({ info: { render: { frame: 4 } } }, new THREE.Scene(), cam, t.geometry, t.material, null);
    expect(spy).toHaveBeenCalledTimes(2);
    bb.detach();
    expect(Object.prototype.hasOwnProperty.call(t, 'onBeforeRender')).toBe(false);
    expect(t.onBeforeRender).toBe(TextClass!.prototype.onBeforeRender);
  });
});

describe('text widget renders', () => {
  it('in every billboard mode its label exists, is visible, and troika preparation runs every frame', async () => {
    for (const mode of ['off', 'yaw', 'full']) {
      h = await mount(text, { text: 'Visible', billboard: mode, background: true });
      h.frame(2);
      const label = h.texts.find((x) => x.text === 'Visible' && !x.disposed)!;
      expect(label, mode).toBeTruthy();
      let visible = true;
      label.traverseAncestors((a) => { if (!a.visible) visible = false; });
      expect(visible && label.visible).toBe(true);
      const cam = new THREE.PerspectiveCamera();
      cam.position.set(0.5, 0.2, 1);
      cam.updateMatrixWorld();
      for (let f = 0; f < 3; f++) label.onBeforeRender({ info: { render: { frame: 10 + f } } } as never, new THREE.Scene(), cam, label.geometry, label.material as THREE.Material, null as never);
      expect(label.prepared, mode).toBe(3);
      expect(h.rec.errors).toEqual([]);
      h.dispose();
      h = null;
    }
  });
});

describe('labels render on panel / number / slider', () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ['panel', { title: 'Notes', body: '- item' }, ['Notes', 'item']],
    ['number', { value: 3.5, label: 'Loss', unit: 'ms' }, ['Loss']],
    ['slider', { label: 'Gain', value: 0.25 }, ['Gain', '0.25']],
  ];
  for (const [id, props, want] of cases) {
    it(`${id}: label texts are visible and sit in front of the card`, async () => {
      const def = (await import(`../widgets/${id}/widget.ts`)).default;
      h = await mount(def, props);
      h.frame(2);
      h.root.updateMatrixWorld(true);
      for (const w of want) {
        const t = h.texts.find((x) => !x.disposed && x.text.includes(w));
        expect(t, `${id} '${w}'`).toBeTruthy();
        let visible = t!.visible;
        t!.traverseAncestors((a) => { if (!a.visible) visible = false; });
        expect(visible, `${id} '${w}' visible`).toBe(true);
        expect(t!.getWorldPosition(new THREE.Vector3()).z, `${id} '${w}' in front`).toBeGreaterThan(0);
        expect(t!.fontSize).toBeGreaterThan(0.005);
      }
      expect(h.rec.errors).toEqual([]);
    });
  }
});
