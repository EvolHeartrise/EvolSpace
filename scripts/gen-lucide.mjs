#!/usr/bin/env node
// Generates library/shared/lucide-icons.ts: Lucide icons (lucide-static, ISC) flattened to
// polylines in their 24×24 viewBox, for library/shared/icons.ts to stroke as flat meshes (crisp in
// XR at any distance, no textures). Widgets can't import npm packages at runtime, so the data is
// generated here and committed.
//
//   node scripts/gen-lucide.mjs                 regenerate the default set (ICONS below)
//   node scripts/gen-lucide.mjs heart star …    default set + these icons
// Names: https://lucide.dev/icons (kebab-case, e.g. "fast-forward").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'library/shared/lucide-icons.ts');
const ICONS = [
  // media
  'play', 'pause', 'rewind', 'fast-forward', 'skip-back', 'skip-forward', 'rotate-ccw', 'rotate-cw',
  'volume', 'volume-1', 'volume-2', 'volume-x', 'repeat', 'maximize', 'minimize',
  // general UI
  'x', 'check', 'plus', 'minus', 'chevron-left', 'chevron-right', 'chevron-up', 'chevron-down',
  'circle-question-mark', 'info', 'triangle-alert', 'settings', 'search', 'refresh-cw', 'external-link', 'clock', 'list',
  'terminal', 'message-circle-question-mark', 'circle-check', 'circle-x', 'circle-dot',
  // github
  'git-pull-request', 'git-merge', 'git-branch', 'gauge', 'timer',
  // weather
  'sun', 'moon', 'cloud', 'cloudy', 'cloud-sun', 'cloud-moon', 'cloud-rain', 'cloud-drizzle', 'cloud-snow', 'cloud-lightning',
  'cloud-fog', 'cloud-hail', 'cloud-sun-rain', 'cloud-moon-rain', 'cloud-rain-wind', 'snowflake', 'haze', 'wind', 'droplets',
  'droplet', 'thermometer', 'umbrella', 'sunrise', 'sunset', 'navigation-2', 'map-pin', 'arrow-up',
  // browser
  'arrow-left', 'arrow-right', 'globe', 'lock', 'mouse-pointer-2', 'bot',
  // files
  'folder', 'folder-open', 'file', 'file-text', 'file-code', 'file-image', 'file-archive', 'file-spreadsheet', 'file-terminal',
  'file-key', 'file-cog', 'braces', 'image', 'film', 'music', 'house', 'corner-left-up', 'eye', 'eye-off', 'message-square', 'hard-drive',
];

const nodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/lucide-static/icon-nodes.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/lucide-static/package.json'), 'utf8')).version;

const r3 = (v) => Math.round(v * 1000) / 1000;

/** SVG path data → polylines ({pts: [x,y,...], closed}). */
function flattenPath(d) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cpx = 0, cpy = 0, prev = '';
  let cur = null;
  const num = () => Number(toks[i++]);
  const flag = () => { // arc flags may be glued: "0 0 1" or "011"
    const t = toks[i];
    if (t.length > 1 && /^[01]/.test(t) && !t.includes('.')) { toks[i] = t.slice(1); return Number(t[0]); }
    i++;
    return Number(t);
  };
  const start = (px, py) => { cur = { pts: [px, py], closed: false }; out.push(cur); };
  const lineTo = (px, py) => { if (!cur) start(x, y); cur.pts.push(px, py); };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const n = Math.max(6, Math.min(24, Math.ceil(Math.hypot(x3 - x, y3 - y) * 2)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      lineTo(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  };
  const quad = (x1, y1, x2, y2) => {
    const n = Math.max(6, Math.min(20, Math.ceil(Math.hypot(x2 - x, y2 - y) * 2)));
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      lineTo(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
    }
  };
  const arc = (rx, ry, rot, large, sweep, x2, y2) => {
    // SVG 1.1 F.6.5: endpoint → center parameterization
    if (rx === 0 || ry === 0) { lineTo(x2, y2); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (rot * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x - x2) / 2, dy = (y - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num_ = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num_ / den));
    if (large === sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cp * cxp - sp * cyp + (x + x2) / 2, cy = sp * cxp + cp * cyp + (y + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(3, Math.ceil(Math.abs(dt) / (Math.PI / 16) * Math.min(1.5, Math.max(0.6, Math.max(rx, ry) / 4))));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
      lineTo(cp * ex - sp * ey + cx, sp * ex + cp * ey + cy);
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': { x = ox + num(); y = oy + num(); sx = x; sy = y; start(x, y); cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const nx = ox + num(), ny = oy + num(); lineTo(nx, ny); x = nx; y = ny; break; }
      case 'H': { const nx = (rel ? x : 0) + num(); lineTo(nx, y); x = nx; break; }
      case 'V': { const ny = (rel ? y : 0) + num(); lineTo(x, ny); y = ny; break; }
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3); cpx = x2; cpy = y2; x = x3; y = y3; break;
      }
      case 'S': {
        const x1 = 'CS'.includes(prev) ? 2 * x - cpx : x, y1 = 'CS'.includes(prev) ? 2 * y - cpy : y;
        const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3); cpx = x2; cpy = y2; x = x3; y = y3; break;
      }
      case 'Q': { const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(); quad(x1, y1, x2, y2); cpx = x1; cpy = y1; x = x2; y = y2; break; }
      case 'T': {
        const x1 = 'QT'.includes(prev) ? 2 * x - cpx : x, y1 = 'QT'.includes(prev) ? 2 * y - cpy : y;
        const x2 = ox + num(), y2 = oy + num(); quad(x1, y1, x2, y2); cpx = x1; cpy = y1; x = x2; y = y2; break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), x2 = ox + num(), y2 = oy + num();
        arc(rx, ry, rot, large, sweep, x2, y2); x = x2; y = y2; break;
      }
      case 'Z': { if (cur) { cur.pts.push(sx, sy); cur.closed = true; } x = sx; y = sy; cur = null; break; }
      default: throw new Error(`unsupported path command ${cmd} in ${d}`);
    }
    prev = C;
  }
  return out;
}

function ellipse(cx, cy, rx, ry) {
  const n = Math.max(16, Math.ceil(Math.max(rx, ry) * 5));
  const pts = [];
  for (let k = 0; k <= n; k++) { const t = (k / n) * 2 * Math.PI; pts.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t)); }
  return [{ pts, closed: true }];
}

function rect(x, y, w, h, rx, ry) {
  rx = Math.min(rx || ry || 0, w / 2); ry = Math.min(ry || rx || 0, h / 2);
  if (!rx) return [{ pts: [x, y, x + w, y, x + w, y + h, x, y + h, x, y], closed: true }];
  const d = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  return flattenPath(d);
}

function flatten(name) {
  const icon = nodes[name];
  if (!icon) throw new Error(`no Lucide icon "${name}"`);
  const lines = [];
  for (const [tag, a] of icon) {
    const n = (k) => Number(a[k] ?? 0);
    if (tag === 'path') lines.push(...flattenPath(a.d));
    else if (tag === 'circle') lines.push(...ellipse(n('cx'), n('cy'), n('r'), n('r')));
    else if (tag === 'ellipse') lines.push(...ellipse(n('cx'), n('cy'), n('rx'), n('ry')));
    else if (tag === 'rect') lines.push(...rect(n('x'), n('y'), n('width'), n('height'), n('rx'), n('ry')));
    else if (tag === 'line') lines.push({ pts: [n('x1'), n('y1'), n('x2'), n('y2')], closed: false });
    else if (tag === 'polyline' || tag === 'polygon') {
      const pts = a.points.trim().split(/[\s,]+/).map(Number);
      if (tag === 'polygon') pts.push(pts[0], pts[1]);
      lines.push({ pts, closed: tag === 'polygon' });
    } else throw new Error(`unsupported element ${tag} in ${name}`);
  }
  // drop consecutive duplicates, round
  return lines.map((l) => {
    const p = [];
    for (let k = 0; k < l.pts.length; k += 2) {
      const px = r3(l.pts[k]), py = r3(l.pts[k + 1]);
      if (p.length && Math.abs(p[p.length - 2] - px) < 1e-3 && Math.abs(p[p.length - 1] - py) < 1e-3) continue;
      p.push(px, py);
    }
    return p;
  }).filter((p) => p.length >= 2);
}

const names = [...new Set([...ICONS, ...process.argv.slice(2)])].sort();
let body = '';
for (const name of names) body += `  '${name}': ${JSON.stringify(flatten(name))},\n`;
fs.writeFileSync(OUT, `// GENERATED by scripts/gen-lucide.mjs from lucide-static ${version} (ISC license, https://lucide.dev).
// Do not edit: add icons with \`node scripts/gen-lucide.mjs <name> …\`.
// Each icon: polylines [x0, y0, x1, y1, …] in Lucide's 24×24 viewBox (y down), stroke width 2.

export const LUCIDE_ICONS: Record<string, number[][]> = {
${body}};
`);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${names.length} icons`);
