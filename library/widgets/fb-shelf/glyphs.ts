// fb-shelf — the few Lucide icons this widget draws, as flat stroke meshes (same encoding and look as
// library/shared/icons.ts, but only these glyphs are bundled: the full icon table would push the bundle
// over its size budget). Data copied from library/shared/lucide-icons.ts (lucide-static, ISC license).

import type { WidgetContext } from '@evolspace/protocol';
import type * as THREE from 'three';
import { markShared, ownMaterial } from '../../shared/resources.ts';

const ICONS: Record<string, string> = {
  'corner-left-up': 'SANANAIAIANA YAYARAYAQOX7PeXtOyXVOLW1NrWONTViNFUyNAUANAIA',
  'clock': 'aAQAZ7RQZsSfZTTsYxU0YGV4XTW2WYXtVXYcURZDTGZhR4Z1QoZ_PYZ_OIZ1M6ZhLvZDKpYcJoXtItW2H6V4HPU0GtTsGUSfGFRQGAQAGFOwGUNhGtMUHPLMH6KIItJKJoITKpHkLvG9M6GfOIGLPYGBQoGBR4GLTGGfURG9VXHkWYITXTJKYGKIYxLMZTMUZsNhZ7OwaAQA QAKAQAQAUASA',
  'arrow-down-wide-narrow': 'HAUALAYAPAUA LAYALAIA PAIAZAIA PAMAWAMA PAQATAQA',
  'eye': 'GEQWGAQIGAP4GEPqGpOdHYNVIPMUJOLaKTKpLeKAMuJhOBJMPVJBQrJBR_JMTSJhUiKAVtKpWyLaXxMUYoNVZXOdZ8PqaAP4aAQIZ8QWZXRjYoSrXxTsWyUmVtVXUiWATSWfR_W0QrW_PVW_OBW0MuWfLeWAKTVXJOUmIPTsHYSrGpRjGEQW TAQASxRJSISIRJSxQATAO3SxN4SINPRJNAQANPO3N4N4O3NPQANARJNPSIN4SxO3TAQA',
  'eye-off': 'OvJFQIJARhJHS4JZUNJ3VcKfWmLRXpMMYjNPZVOaZ8PqaAP4aAQHZ8QWZiROZDSDYgS2 SFSKReSoQwS6P-TAPNS5OfSmN4SINaRhNHQzNAQCNGPQNYOiN2N7 VfVgUUWGTFWjRzW2QfW_PLW-N3WyMmWdLYV9KOVUJKUjINTpHXSpGpRiGEQWGAQIGAP4GEPqGrOaHcNQIWMOJXLTKhKh GAGAaAaA',
  'chevron-left': 'TAWANAQATAKA',
  'chevron-right': 'NAWATAQANAKA',
  'x': 'WAKAKAWA KAKAWAWA',
  'message-square': 'aAVAZ6VoZoWLZLWoYoW6YAXAK1XAKUXEJ1XRJaXmHOZyHDZ6G2Z_GpZ_GcZ8GRZ1GIZsGCZfGAZSGAJAGGIYGYH1G1HYHYHGIAHAYAHAYoHGZLHYZoH1Z6IYaAJAaAVA',
  'folder': 'YAYAYoX6ZLXoZoXLZ6WoaAWAaAMAZ6LYZoK1ZLKYYoKGYAKAQGKAPnJ8PJJxOvJfOaJGNmH6NSHiM4HPMbHEL8HAIAHAHYHGG1HYGYH1GGIYGAJAGAWAGGWoGYXLG1XoHYX6IAYAYAYA',
  'file-code': 'KAaAJYZ6I1ZoIYZLIGYoIAYAIAIAIGHYIYG1I1GYJYGGKAGASAGASoGFTNGVTtGtXTKTXrKzX7LYYAMAYAYAX6YoXoZLXLZoWoZ6WAaAKAaA SAGASALASDLUSMLmSaL0SsL9TAMAYAMA OAQgMATAOAVg SAQgUATASAVg',
  'file-text': 'KAaAJYZ6I1ZoIYZLIGYoIAYAIAIAIGHYIYG1I1GYJYGGKAGASAGASoGFTNGVTtGtXTKTXrKzX7LYYAMAYAYAX6YoXoZLXLZoWoZ6WAaAKAaA SAGASALASDLUSMLmSaL0SsL9TAMAYAMA OANAMANA UARAMARA UAVAMAVA',
  'braces': 'MAHALAHAKYHGJ1HYJYH1JGIYJAJAJAOAI6OoIoPLILPoHoP6HAQAHoQGILQYIoQ1I6RYJASAJAXAJFXiJSYAJmYaKAYuKeY7LAZAMAZA UAZAVAZAVoY6WLYoWoYLW6XoXAXAXASAXFReXSRAXmQmYAQSYeQFZAQAYYP6X1PoXYPLXGOoXAOAXAJAW6IYWoH1WLHYVoHGVAHAUAHA',
  'file-image': 'KAaAJYZ6I1ZoIYZLIGYoIAYAIAIAIGHYIYG1I1GYJYGGKAGASAGASoGFTNGVTtGtXTKTXrKzX7LYYAMAYAYAX6YoXoZLXLZoWoZ6WAaAKAaA SAGASALASDLUSMLmSaL0SsL9TAMAYAMA QAQAP2QxPaRaOxR2OASANPR2MmRaMKQxMAQAMKPPMmOmNPOKOAOAOxOKPaOmP2PPQAQA YAVAWtTtWGTRVYTCUoTCT6TRTTTtNAaA',
  'film': 'JAHAXAHAXoHGYLHYYoH1Y6IYZAJAZAXAY6XoYoYLYLYoXoY6XAZAJAZAIYY6H1YoHYYLHGXoHAXAHAJAHGIYHYH1H1HYIYHGJAHA LAHALAZA HALgLALg HAQAZAQA HAUgLAUg VAHAVAZA VALgZALg VAUgZAUg',
  'music': 'NAWANAJAZAHAZAUA NAWAMxXJMIYILJYxKAZAI3YxH4YIHPXJHAWAHPU3H4T4I3TPKATALJTPMIT4MxU3NAWA ZAUAYxVJYIWIXJWxWAXAU3WxT4WITPVJTAUATPS3T4R4U3RPWARAXJRPYIR4YxS3ZAUA',
  'file-archive': 'RqaAWAaAWoZ6XLZoXoZLX6YoYAYAYAMAX7LYXrKzXTKTTtGtTNGVSoGFSAGAKAGAJYGGI1GYIYG1IGHYIAIAIATg SAGASALASDLUSMLmSaL0SsL9TAMAYAMA MAQAMAPA MAWAMAUA MALAMAKA OAYAN2YxNaZaMxZ2MAaALPZ2KmZaKKYxKAYAKKXPKmWmLPWKMAWAMxWKNaWmN2XPOAYA',
  'file-terminal': 'KAaAJYZ6I1ZoIYZLIGYoIAYAIAIAIGHYIYG1I1GYJYGGKAGASAGASoGFTNGVTtGtXTKTXrKzX7LYYAMAYAYAX6YoXoZLXLZoWoZ6WAaAKAaA SAGASALASDLUSMLmSaL0SsL9TAMAYAMA MAUAOASAMAQA QAWAUAWA',
  'file-key': 'SAGASALASDLUSMLmSaL0SsL9TAMAYAMA IAQAIAWA IASAKASA NqaAWAaAWoZ6XLZoXoZLX6YoYAYAYAMAX7LYXrKzXTKTTtGtTNGVSoGFSAGAKAGAJYGGI1GYIYG1IGHYIAIAIAMA KAYAJ2YxJaZaIxZ2IAaAHPZ2GmZaGKYxGAYAGKXPGmWmHPWKIAWAIxWKJaWmJ2XPKAYA',
  'file': 'KAaAJYZ6I1ZoIYZLIGYoIAYAIAIAIGHYIYG1I1GYJYGGKAGASAGASoGFTNGVTtGtXTKTXrKzX7LYYAMAYAYAX6YoXoZLXLZoWoZ6WAaAKAaA SAGASALASDLUSMLmSaL0SsL9TAMAYAMA',
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HALF = 1 / 24;
const JOIN = 8;
let cache: Map<string, THREE.BufferGeometry> | null = null;

/** Positions (non-indexed triangles) of an icon in a unit box centered at 0, y up, facing +Z. */
export function glyphTriangles(name: string): Float32Array {
  const code = ICONS[name] ?? ICONS.file;
  const out: number[] = [];
  const disc = (cx: number, cy: number) => {
    for (let k = 0; k < JOIN; k++) {
      const a0 = (k / JOIN) * Math.PI * 2, a1 = ((k + 1) / JOIN) * Math.PI * 2;
      out.push(cx, cy, 0, cx + HALF * Math.cos(a0), cy + HALF * Math.sin(a0), 0, cx + HALF * Math.cos(a1), cy + HALF * Math.sin(a1), 0);
    }
  };
  for (const pl of code.split(' ').filter(Boolean)) {
    const pts: number[] = [];
    for (let i = 0; i + 1 < pl.length; i += 2) pts.push(((B64.indexOf(pl[i]) << 6) | B64.indexOf(pl[i + 1])) / 64 - 4);
    for (let i = 0; i < pts.length; i += 2) {
      const ax = (pts[i] - 12) / 24, ay = (12 - pts[i + 1]) / 24;
      disc(ax, ay);
      if (i + 3 >= pts.length) continue;
      const bx = (pts[i + 2] - 12) / 24, by = (12 - pts[i + 3]) / 24;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * HALF, ny = (dx / len) * HALF;
      out.push(ax - nx, ay - ny, 0, bx - nx, by - ny, 0, bx + nx, by + ny, 0);
      out.push(ax - nx, ay - ny, 0, bx + nx, by + ny, 0, ax + nx, ay + ny, 0);
    }
  }
  return new Float32Array(out);
}

function geometry(T: typeof THREE, name: string): THREE.BufferGeometry {
  cache ??= new Map();
  const key = ICONS[name] ? name : 'file';
  let g = cache.get(key);
  if (!g) {
    g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(glyphTriangles(key), 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    cache.set(key, markShared(g));
  }
  return g;
}

/** An icon mesh `size` m wide/tall, own material in `color`; never a hit target. */
export function makeGlyph(ctx: Pick<WidgetContext, 'THREE'>, name: string, opts: { size: number; color: string }): THREE.Mesh {
  const T = ctx.THREE;
  const m = new T.Mesh(geometry(T, name), ownMaterial(T, opts.color, { doubleSide: true }));
  m.scale.setScalar(opts.size);
  m.name = `icon:${name}`;
  m.raycast = () => {};
  return m;
}

/** Swap the shape of a glyph mesh (no-op when unchanged). */
export function setGlyph(T: typeof THREE, mesh: THREE.Mesh, name: string): void {
  if (mesh.name === `icon:${name}`) return;
  mesh.geometry = geometry(T, name);
  mesh.name = `icon:${name}`;
}
