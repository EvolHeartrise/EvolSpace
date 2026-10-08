// Links in 3D: a line between the entities of every port→port link (disabled
// links dim), a stub with a '#channel' label for channel endpoints, and a dot
// that travels along the link whenever a new value flows (detected by polling
// the source port's last output and the target port's input value — identity
// changes; momentary `event` values are not cached by the runtime, so they
// don't animate).

import type * as THREE_NS from 'three';
import type { Link } from '@evolspace/protocol';
import type { DebugContext, OverlayDef, OverlayInstance } from '../types.ts';
import { LabelLayer, LineBatch, OverlayRoot, disposeTree, esc, inert, overlayColors } from './common.ts';

const MAX_PULSES = 96;
const PULSE_MS = 450;

export const linksOverlay: OverlayDef = {
  id: 'links',
  title: 'Links',
  description: 'Lines between linked entities; a dot travels along a link when a value flows',
  create(ctx): OverlayInstance {
    const T = ctx.THREE;
    const root = new OverlayRoot(ctx, 'links');
    const batch = new LineBatch(T, { opacity: 0.85, depthTest: false, renderOrder: 935, name: 'links' });
    root.world.add(batch.lines);
    const col = overlayColors(ctx);
    const linkCol = new T.Color('#a98bff');
    const flash = new T.Color('#e3d8ff');
    const off = col.dim.clone().multiplyScalar(0.7);
    const dots = new T.InstancedMesh(new T.OctahedronGeometry(0.014, 0), new T.MeshBasicMaterial({ color: '#f1ebff', depthTest: false, transparent: true, toneMapped: false }), MAX_PULSES);
    dots.name = 'link-pulses';
    dots.count = 0;
    dots.renderOrder = 936;
    dots.instanceMatrix.setUsage(T.DynamicDrawUsage);
    inert(dots);
    root.world.add(dots);
    const layer = new LabelLayer(ctx);
    const seen = new Map<string, { out: unknown; inp: unknown }>();
    const pulses: Array<{ link: string; t0: number }> = [];
    const flashing = new Set<string>();
    const a = new T.Vector3(), b = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 0.15, 0);
    const m = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3();

    const centerOf = (id: string, out: THREE_NS.Vector3): boolean => {
      const node = ctx.runtime.entityObject(id);
      if (!node) return false;
      const lb = ctx.runtime.picker.localBounds(id);
      if (lb && !lb.isEmpty()) { lb.getCenter(out).applyMatrix4(node.matrixWorld); return true; }
      node.getWorldPosition(out);
      return true;
    };
    const valueKey = (l: Link) => ({
      out: l.from.kind === 'port' ? ctx.runtime.links.lastOutput(l.from.entity, l.from.port) : undefined,
      inp: l.to.kind === 'port' ? ctx.runtime.widgets.inputValue(l.to.entity, l.to.port) : undefined,
    });

    return {
      update() {
        const now = performance.now();
        const links = ctx.runtime.sceneState.links;
        batch.begin();
        layer.begin();
        flashing.clear();
        for (let i = pulses.length - 1; i >= 0; i--) {
          if (now - pulses[i].t0 > PULSE_MS) pulses.splice(i, 1); else flashing.add(pulses[i].link);
        }
        for (const id in links) {
          const l = links[id];
          // Flow detection.
          const v = valueKey(l);
          const prev = seen.get(id);
          if (!prev) seen.set(id, v);
          else if (prev.out !== v.out || prev.inp !== v.inp) {
            prev.out = v.out; prev.inp = v.inp;
            if (l.enabled && pulses.length < MAX_PULSES) { pulses.push({ link: id, t0: now }); flashing.add(id); }
          }
          const c = !l.enabled ? off : flashing.has(id) ? flash : linkCol;
          const fromOk = l.from.kind === 'port' && centerOf(l.from.entity, a);
          const toOk = l.to.kind === 'port' && centerOf(l.to.entity, b);
          if (fromOk && toOk) batch.segV(a, b, c);
          else if (fromOk && l.to.kind === 'channel') {
            b.copy(a).add(up); batch.segV(a, b, c);
            layer.put(`ch-${id}`, b, `→ #${esc(l.to.channel)}`, '', -2);
          } else if (toOk && l.from.kind === 'channel') {
            a.copy(b).add(up); batch.segV(a, b, c);
            layer.put(`ch-${id}`, a, `#${esc(l.from.channel)} →`, '', -2);
          }
        }
        for (const k of seen.keys()) if (!links[k]) seen.delete(k);
        // Pulses.
        let n = 0;
        for (const pu of pulses) {
          const l = links[pu.link];
          if (!l) continue;
          const fromOk = l.from.kind === 'port' ? centerOf(l.from.entity, a) : false;
          const toOk = l.to.kind === 'port' ? centerOf(l.to.entity, b) : false;
          if (!fromOk && !toOk) continue;
          if (!fromOk) a.copy(b).add(up);
          if (!toOk) b.copy(a).add(up);
          const k = Math.min(1, (now - pu.t0) / PULSE_MS);
          p.copy(a).lerp(b, k * k * (3 - 2 * k));
          const s = 1 - 0.4 * k;
          m.compose(p, q, sc.set(s, s, s));
          dots.setMatrixAt(n++, m);
        }
        dots.count = n;
        dots.instanceMatrix.needsUpdate = true;
        dots.visible = n > 0;
        batch.end();
        layer.end();
      },
      dispose() {
        batch.dispose();
        layer.dispose();
        dots.removeFromParent();
        disposeTree(dots);
        dots.dispose();
        root.dispose();
        seen.clear();
      },
    };
  },
};
