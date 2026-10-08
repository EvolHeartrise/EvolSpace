// weather — current conditions + hourly + daily forecast for any place, with Lucide weather icons.
// Data from the `weather` source (Open-Meteo): the widget asks for its `location` on
// <prefix>.request and reads its report from <prefix>.data["<location>|<units>"].
//
// Layout (top → bottom): place + local time · big condition icon, temperature, condition, feels
// like, high/low · wind (arrow turned to the wind direction) / humidity / rain chance / next sunrise
// or sunset · next 12 h in 2-hour steps · 5 days with a low–high range bar on a shared scale.

import type { ChannelValue, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, ownMaterial, sharedGeometry } from '../../shared/resources.ts';
import { makeText, type Text } from '../../shared/text.ts';
import { makeIcon, setIcon } from '../../shared/icons.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { formatAge, truncate } from '../../shared/format.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  location: string;
  units: string;
  width: number;
  prefix: string;
}

interface Report {
  status: string;
  error?: string;
  stale?: string;
  place?: { name: string; admin1: string; country: string; utcOffset?: number };
  units?: { temp: string; wind: string };
  current?: { temp: number; feels: number; humidity: number; code: number; wind: number; windDir: number; isDay: boolean; time: string };
  hourly?: Array<{ time: string; temp: number; code: number; pop: number | null; isDay: boolean }>;
  daily?: Array<{ date: string; code: number; max: number; min: number; pop: number | null; sunrise: string; sunset: string }>;
  updatedAt?: number;
}

const PAD = 0.02;
const HOURS = 6; // columns, 2 h apart
const DAYS = 5;

const C = { sun: '#f5b83d', moon: '#c9d1e0', cloud: '#a9bbcf', rain: '#5aa9f0', snow: '#dbe8ff', storm: '#f5d742', fog: '#a7b0bb' };

/** WMO weather code → [label, Lucide icon, color]. */
export function condition(code: number, isDay = true): [string, string, string] {
  const sky = isDay ? C.sun : C.moon;
  if (code === 0) return ['Clear', isDay ? 'sun' : 'moon', sky];
  if (code === 1) return ['Mainly clear', isDay ? 'sun' : 'moon', sky];
  if (code === 2) return ['Partly cloudy', isDay ? 'cloud-sun' : 'cloud-moon', C.cloud];
  if (code === 3) return ['Overcast', 'cloudy', C.cloud];
  if (code === 45 || code === 48) return ['Fog', 'cloud-fog', C.fog];
  if (code >= 51 && code <= 55) return [code === 51 ? 'Light drizzle' : code === 53 ? 'Drizzle' : 'Heavy drizzle', 'cloud-drizzle', C.rain];
  if (code === 56 || code === 57) return ['Freezing drizzle', 'cloud-drizzle', C.snow];
  if (code === 61 || code === 63 || code === 65) return [code === 61 ? 'Light rain' : code === 63 ? 'Rain' : 'Heavy rain', 'cloud-rain', C.rain];
  if (code === 66 || code === 67) return ['Freezing rain', 'cloud-hail', C.snow];
  if (code === 71 || code === 73 || code === 75) return [code === 71 ? 'Light snow' : code === 73 ? 'Snow' : 'Heavy snow', 'cloud-snow', C.snow];
  if (code === 77) return ['Snow grains', 'snowflake', C.snow];
  if (code === 80 || code === 81) return [code === 80 ? 'Light showers' : 'Showers', isDay ? 'cloud-sun-rain' : 'cloud-moon-rain', C.rain];
  if (code === 82) return ['Violent showers', 'cloud-rain-wind', C.rain];
  if (code === 85 || code === 86) return ['Snow showers', 'cloud-snow', C.snow];
  if (code === 95) return ['Thunderstorm', 'cloud-lightning', C.storm];
  if (code === 96 || code === 99) return ['Thunderstorm, hail', 'cloud-lightning', C.storm];
  return ['—', 'cloud', C.cloud];
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** "2026-10-08T16:00" (local to the place) → "4 PM". */
export function hourLabel(iso: string): string {
  const h = Number(iso.slice(11, 13));
  if (!Number.isFinite(h)) return '';
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "…T18:35" → "6:35 PM". */
export function timeLabel(iso: string): string {
  const h = Number(iso.slice(11, 13)), m = iso.slice(14, 16);
  return Number.isFinite(h) ? `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}` : '';
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (date: string, i: number) => (i === 0 ? 'Today' : DOW[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? date);
const deg = (t: number | undefined) => (Number.isFinite(t) ? `${Math.round(t!)}°` : '—');

const definition: WidgetDefinition<Props> = {
  description:
    'Weather card for any place (location: "Delta, BC, Canada", "Paris", "49.08, -123.06"; units metric|imperial) with Lucide weather icons: ' +
    "current conditions, wind/humidity/rain/sunset, next 12 h, 5-day forecast with range bars. Data from the 'weather' source (Open-Meteo).",
  version: '2.0.0',
  props: {
    location: { type: 'string', default: 'Delta, BC, Canada', description: 'Place name (", region, country" picks between same-named places) or "lat, lon".' },
    units: { type: 'enum', options: ['metric', 'imperial'], default: 'metric', description: '°C + km/h, or °F + mph.' },
    width: { type: 'number', default: 0.46, min: 0.3, max: 2, step: 0.01, description: 'Card width (m).' },
    prefix: { type: 'string', default: 'weather', description: "Channel prefix of the 'weather' source (<prefix>.request / <prefix>.data)." },
  },
  inputs: { location: { type: 'string', description: 'Show this place.' } },
  outputs: {},
  size: [0.46, 0.5, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let location = String(ctx.props.location ?? '').trim();
    let report: Report | null = null;
    let group: THREE.Group | null = null;
    let timer = 0;
    let off: (() => void) | null = null;

    // parts updated by render()
    let place: Text, region: Text, clock: Text, heroIcon: THREE.Mesh, temp: Text, cond: Text, feels: Text, hilo: Text, footer: Text, message: Text;
    let windIcon: THREE.Mesh, windText: Text, humText: Text, popText: Text, sunIcon: THREE.Mesh, sunText: Text;
    const hours: Array<{ time: Text; icon: THREE.Mesh; temp: Text }> = [];
    const days: Array<{ name: Text; icon: THREE.Mesh; pop: Text; low: Text; high: Text; bar: THREE.Mesh; barMat: THREE.MeshBasicMaterial }> = [];
    let barX0 = 0, barW = 0;
    let content: THREE.Group;

    const W = () => ctx.props.width;
    const key = () => `${location}|${ctx.props.units === 'imperial' ? 'imperial' : 'metric'}`;
    const text = (s: string, size: number, opts: Partial<{ color: string; ax: 'left' | 'center' | 'right'; weight: 'regular' | 'semibold'; mono: boolean }> = {}) =>
      makeText(ctx, s, { size, anchorX: opts.ax ?? 'left', anchorY: 'middle', color: opts.color ?? theme.text, weight: opts.weight ?? 'regular', font: opts.mono ? 'mono' : 'sans', whiteSpace: 'nowrap' });
    const icon = (name: string, size: number, color: string) => makeIcon(ctx, name, { size, color });
    const place2 = (o: THREE.Object3D, x: number, y: number, z: number = STYLE.zText) => { o.position.set(x, y, z); content.add(o); return o; };

    function build(): void {
      if (group) disposeTree(group);
      hours.length = 0;
      days.length = 0;
      const g = (group = new T.Group());
      content = new T.Group();
      const w = W(), x0 = -w / 2 + PAD, x1 = w / 2 - PAD, cw = x1 - x0;
      let y = 0;

      // header
      place2(icon('map-pin', 0.018, theme.accent), x0 + 0.009, y - 0.012);
      place = place2(text('', 0.021, { weight: 'semibold' }), x0 + 0.024, y - 0.011) as Text;
      clock = place2(text('', 0.011, { color: theme.textDim, ax: 'right' }), x1, y - 0.011) as Text;
      region = place2(text('', 0.0115, { color: theme.textDim }), x0 + 0.024, y - 0.032) as Text;
      y -= 0.052;

      // hero
      const hs = 0.085;
      heroIcon = place2(icon('sun', hs, C.sun), x0 + hs / 2, y - hs / 2) as THREE.Mesh;
      temp = place2(text('', 0.062, { weight: 'semibold' }), x0 + hs + 0.014, y - hs / 2) as Text;
      cond = place2(text('', 0.017, { weight: 'semibold', ax: 'right' }), x1, y - 0.018) as Text;
      feels = place2(text('', 0.012, { color: theme.textDim, ax: 'right' }), x1, y - 0.042) as Text;
      hilo = place2(text('', 0.012, { color: theme.textDim, ax: 'right' }), x1, y - 0.062) as Text;
      message = place2(makeText(ctx, '', { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim, maxWidth: cw, textAlign: 'center' }), 0, y - hs / 2, STYLE.zText + 0.002) as Text;
      y -= hs + 0.014;

      // stats row: 4 cells
      const cell = cw / 4, sy = y - 0.012;
      windIcon = place2(icon('navigation-2', 0.017, theme.textDim), x0 + 0.009, sy) as THREE.Mesh;
      windText = place2(text('', 0.0115), x0 + 0.022, sy) as Text;
      place2(icon('droplets', 0.017, C.rain), x0 + cell + 0.009, sy);
      humText = place2(text('', 0.0115), x0 + cell + 0.022, sy) as Text;
      place2(icon('umbrella', 0.017, C.rain), x0 + 2 * cell + 0.009, sy);
      popText = place2(text('', 0.0115), x0 + 2 * cell + 0.022, sy) as Text;
      sunIcon = place2(icon('sunset', 0.017, C.sun), x0 + 3 * cell + 0.009, sy) as THREE.Mesh;
      sunText = place2(text('', 0.0115), x0 + 3 * cell + 0.022, sy) as Text;
      y -= 0.03;

      const rule = (yy: number) => {
        const r = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.border));
        r.scale.set(cw, 0.0012, 1);
        r.raycast = () => {};
        place2(r, 0, yy, STYLE.zContent);
      };
      rule(y);
      y -= 0.012;

      // hourly: HOURS columns
      const col = cw / HOURS;
      for (let i = 0; i < HOURS; i++) {
        const cx = x0 + col * (i + 0.5);
        hours.push({
          time: place2(text('', 0.0105, { color: theme.textDim, ax: 'center' }), cx, y - 0.008) as Text,
          icon: place2(icon('sun', 0.026, C.sun), cx, y - 0.033) as THREE.Mesh,
          temp: place2(text('', 0.013, { ax: 'center', weight: 'semibold' }), cx, y - 0.059) as Text,
        });
      }
      y -= 0.074;
      rule(y);
      y -= 0.01;

      // daily rows
      const rh = 0.032;
      barX0 = x0 + 0.205;
      barW = x1 - 0.04 - barX0;
      for (let i = 0; i < DAYS; i++) {
        const ry = y - rh / 2;
        const track = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, theme.surface));
        track.scale.set(barW, 0.006, 1);
        track.raycast = () => {};
        place2(track, barX0 + barW / 2, ry, STYLE.zContent);
        const barMat = ownMaterial(T, C.sun);
        const bar = new T.Mesh(sharedGeometry(T, 'plane'), barMat);
        bar.raycast = () => {};
        place2(bar, barX0, ry, STYLE.zOverlay);
        days.push({
          name: place2(text('', 0.0125, { weight: i === 0 ? 'semibold' : 'regular' }), x0, ry) as Text,
          icon: place2(icon('sun', 0.022, C.sun), x0 + 0.078, ry) as THREE.Mesh,
          pop: place2(text('', 0.0105, { color: C.rain }), x0 + 0.097, ry) as Text,
          low: place2(text('', 0.0125, { color: theme.textDim, ax: 'right' }), barX0 - 0.008, ry) as Text,
          high: place2(text('', 0.0125, { weight: 'semibold', ax: 'right' }), x1, ry) as Text,
          bar, barMat,
        });
        y -= rh;
      }
      y -= 0.006;
      footer = place2(text('', 0.0095, { color: theme.textDim }), x0, y - 0.006) as Text;
      y -= 0.016;

      const h = -y + 2 * PAD;
      content.position.y = h / 2 - PAD;
      g.add(ctx.ui.panel(w, h), content);
      ctx.root.add(g);
      render();
    }

    function render(): void {
      if (!group) return;
      const r = report;
      const ready = r?.status === 'ready' && r.current;
      const showAll = (on: boolean) => {
        for (const o of [heroIcon, temp, cond, feels, hilo]) o.visible = on;
        for (const hr of hours) for (const o of [hr.time, hr.icon, hr.temp]) o.visible = on;
        for (const d of days) for (const o of [d.name, d.icon, d.pop, d.low, d.high, d.bar]) o.visible = on;
      };
      if (!ready) {
        place.set(truncate(location.split(',')[0] || 'Weather', 28));
        region.set('');
        clock.set('');
        message.set(!location ? 'Set a location' : r?.status === 'error' ? `Couldn't load: ${truncate(r.error ?? '', 80)}` : 'Loading weather…');
        message.visible = true;
        showAll(false);
        windText.set('—'); humText.set('—'); popText.set('—'); sunText.set('—');
        footer.set('Open-Meteo');
        return;
      }
      message.visible = false;
      showAll(true);
      const c = r.current!, u = r.units ?? { temp: '°C', wind: 'km/h' };
      place.set(truncate(r.place?.name ?? location, 28));
      region.set(truncate([r.place?.admin1, r.place?.country].filter(Boolean).join(', '), 48));
      const [label, iconName, color] = condition(c.code, c.isDay);
      setIcon(T, heroIcon, iconName);
      (heroIcon.material as THREE.MeshBasicMaterial).color.set(color);
      temp.set(deg(c.temp));
      cond.set(label);
      feels.set(`Feels like ${deg(c.feels)}`);
      const today = r.daily?.[0];
      hilo.set(today ? `H ${deg(today.max)}  ·  L ${deg(today.min)}` : '');
      // the arrow points where the wind blows TO (from windDir + 180°); navigation-2 points up
      windIcon.rotation.z = -((c.windDir + 180) * Math.PI) / 180;
      windText.set(`${Math.round(c.wind)} ${u.wind} ${compass(c.windDir)}`);
      humText.set(`${Math.round(c.humidity)}%`);
      const pop = r.hourly?.[0]?.pop ?? today?.pop;
      popText.set(pop == null ? '—' : `${Math.round(pop)}%`);
      // next sunrise or sunset
      const now = c.time;
      const events = (r.daily ?? []).flatMap((d) => [{ t: d.sunrise, kind: 'sunrise' }, { t: d.sunset, kind: 'sunset' }]).filter((e) => e.t > now).sort((a, b) => (a.t < b.t ? -1 : 1));
      const next = events[0];
      setIcon(T, sunIcon, next?.kind ?? 'sunset');
      sunText.set(next ? timeLabel(next.t) : '—');

      for (let i = 0; i < HOURS; i++) {
        const hr = r.hourly?.[i * 2 + 1] ?? r.hourly?.[i * 2];
        const cell = hours[i];
        for (const o of [cell.time, cell.icon, cell.temp]) o.visible = !!hr;
        if (!hr) continue;
        const [, ic, col] = condition(hr.code, hr.isDay);
        cell.time.set(hourLabel(hr.time));
        setIcon(T, cell.icon, ic);
        (cell.icon.material as THREE.MeshBasicMaterial).color.set(col);
        cell.temp.set(deg(hr.temp));
      }

      const ds = (r.daily ?? []).slice(0, DAYS);
      const lo = Math.min(...ds.map((d) => d.min)), hi = Math.max(...ds.map((d) => d.max));
      const span = hi - lo || 1;
      for (let i = 0; i < DAYS; i++) {
        const d = ds[i], row = days[i];
        for (const o of [row.name, row.icon, row.pop, row.low, row.high, row.bar]) o.visible = !!d;
        if (!d) continue;
        const [, ic, col] = condition(d.code, true);
        row.name.set(dayName(d.date, i));
        setIcon(T, row.icon, ic);
        (row.icon.material as THREE.MeshBasicMaterial).color.set(col);
        row.pop.set(d.pop != null && d.pop >= 20 ? `${Math.round(d.pop)}%` : '');
        row.low.set(deg(d.min));
        row.high.set(deg(d.max));
        const a = (d.min - lo) / span, b = (d.max - lo) / span;
        row.bar.scale.set(Math.max(0.004, barW * (b - a)), 0.006, 1);
        row.bar.position.x = barX0 + barW * (a + b) / 2;
        // warm days amber, cool days blue (on the absolute temperature, in °C)
        const mid = (d.max + d.min) / 2, midC = u.temp === '°F' ? ((mid - 32) * 5) / 9 : mid;
        row.barMat.color.set(midC >= 18 ? C.sun : midC >= 8 ? '#8fd18f' : C.rain);
      }
      renderTime();
    }

    function renderTime(): void {
      const r = report;
      if (!r || r.status !== 'ready') return;
      const utcOffset = r.place?.utcOffset;
      if (Number.isFinite(utcOffset)) {
        const t = new Date(Date.now() + (utcOffset as number) * 1000);
        const h = t.getUTCHours(), m = String(t.getUTCMinutes()).padStart(2, '0');
        clock.set(`${DOW[t.getUTCDay()]} ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`);
      }
      const age = r.updatedAt ? Date.now() - r.updatedAt : NaN;
      footer.set(`Open-Meteo${Number.isFinite(age) ? ` · updated ${age < 1000 ? 'now' : `${formatAge(age)} ago`}` : ''}${r.stale ? ' · offline' : ''}`);
    }

    function subscribe(): void {
      off?.();
      const prefix = ctx.props.prefix || 'weather';
      off = ctx.channels.subscribe(`${prefix}.data`, (v: ChannelValue) => {
        const all = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Report>) : {};
        const r = all[key()];
        if (!r) return;
        report = r;
        render();
      });
      if (location) ctx.channels.publish(`${prefix}.request`, { location, units: ctx.props.units, nonce: Date.now() } as never);
    }

    build();
    subscribe();

    return {
      onProps(p, prev) {
        if (p.width !== prev.width) build();
        if (p.location !== prev.location || p.units !== prev.units || p.prefix !== prev.prefix) {
          location = String(p.location ?? '').trim();
          report = null;
          render();
          subscribe();
        }
      },
      onInput(port, v) {
        if (port === 'location' && typeof v === 'string' && v.trim() && v.trim() !== location) {
          location = v.trim();
          report = null;
          render();
          subscribe();
        }
      },
      update(dt) {
        timer += dt;
        if (timer < 5) return;
        timer = 0;
        renderTime();
      },
      dispose() {
        off?.();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
