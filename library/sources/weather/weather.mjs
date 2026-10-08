// Weather source for the `weather` widget: any number of locations, Open-Meteo (no API key).
//
//   weather.request = {location, units: 'metric'|'imperial', nonce}   a widget asks for a place
//   weather.data    = {"<location>|<units>": Report}                    every requested place
//   Report = {status: 'loading'|'ready'|'error', error?, place: {name, admin1, country, lat, lon, tz,
//             utcOffset (s)}, units: {temp, wind, precip}, current: {temp, feels, humidity, precip,
//             code, wind, windDir, isDay, time}, hourly: [{time, temp, code, pop, isDay}] (next 12 h),
//             daily: [{date, code, max, min, pop, sunrise, sunset}] (6 days), updatedAt (ms)}
//
// Locations: "Delta, BC, Canada" (geocoded; the parts after the first comma pick between same-named
// places by region / country, abbreviations like "BC" match initials), or "49.08, -123.06".
// Every requested location is refreshed every --every seconds (default 600).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PREFIX = arg('prefix', 'weather');
const EVERY = Number(arg('every', '600')) * 1000;
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const STATE = path.resolve(arg('state', '../../../data/weather-locations.json'));

const reports = {};
const places = new Map(); // location text → geocoded place (cached)

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return r.json();
}

const initials = (s) => String(s ?? '').split(/[\s-]+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Score a geocoding result against the qualifier parts ("BC", "Canada"). */
export function scorePlace(r, quals) {
  let score = 0;
  for (const q of quals.map(norm).filter(Boolean)) {
    const fields = [r.admin1, r.admin2, r.country].map(norm);
    if (fields.includes(q)) score += 3;
    else if (q === norm(r.country_code) || q === initials(r.admin1) || q === initials(r.country)) score += 2;
    else if (fields.some((f) => f && (f.startsWith(q) || q.startsWith(f)))) score += 1;
  }
  return score;
}

export async function geocode(location) {
  const text = String(location ?? '').trim();
  if (!text) throw new Error('no location');
  const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (ll) return { name: `${Number(ll[1]).toFixed(2)}, ${Number(ll[2]).toFixed(2)}`, admin1: '', country: '', lat: Number(ll[1]), lon: Number(ll[2]) };
  if (places.has(text)) return places.get(text);
  const [name, ...quals] = text.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=en&format=json`);
  const list = res.results ?? [];
  if (!list.length) throw new Error(`no place called "${name}"`);
  list.sort((a, b) => scorePlace(b, quals) - scorePlace(a, quals) || (b.population ?? 0) - (a.population ?? 0));
  const r = list[0];
  const place = { name: r.name, admin1: r.admin1 ?? '', country: r.country ?? '', lat: r.latitude, lon: r.longitude };
  places.set(text, place);
  return place;
}

async function forecast(place, units) {
  const imperial = units === 'imperial';
  const q = new URLSearchParams({
    latitude: String(place.lat), longitude: String(place.lon), timezone: 'auto', forecast_days: '6', forecast_hours: '13',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  });
  const w = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  const c = w.current, h = w.hourly, d = w.daily;
  const hourly = (h?.time ?? []).map((t, i) => ({ time: t, temp: h.temperature_2m[i], code: h.weather_code[i], pop: h.precipitation_probability?.[i] ?? null, isDay: !!h.is_day?.[i] }))
    .filter((x) => x.time > c.time).slice(0, 12);
  const daily = (d?.time ?? []).map((t, i) => ({ date: t, code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], pop: d.precipitation_probability_max?.[i] ?? null, sunrise: d.sunrise[i], sunset: d.sunset[i] }));
  return {
    status: 'ready',
    place: { ...place, tz: w.timezone, utcOffset: w.utc_offset_seconds },
    units: { temp: imperial ? '°F' : '°C', wind: imperial ? 'mph' : 'km/h', precip: imperial ? 'in' : 'mm' },
    current: { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, precip: c.precipitation, code: c.weather_code, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, isDay: !!c.is_day, time: c.time },
    hourly, daily, updatedAt: Date.now(),
  };
}

let pending = null;
function publish() {
  clearTimeout(pending);
  pending = setTimeout(async () => {
    try {
      const r = await fetch(`${EVOL}/api/channels/${PREFIX}.data?producer=weather`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reports) });
      if (!r.ok) console.error(`publish: ${r.status}`);
    } catch (e) { console.error(String(e)); }
  }, 100);
}

const keyOf = (location, units) => `${String(location).trim()}|${units === 'imperial' ? 'imperial' : 'metric'}`;

async function refresh(key) {
  const [location, units] = key.split('|');
  const prev = reports[key];
  try {
    reports[key] = await forecast(await geocode(location), units);
  } catch (e) {
    // keep showing the last good report on a transient failure
    reports[key] = prev?.status === 'ready' ? { ...prev, stale: String(e.message ?? e) } : { status: 'error', error: String(e.message ?? e) };
    console.error(`${key}: ${e.message ?? e}`);
  }
  publish();
}

function saveState() {
  try { fs.writeFileSync(STATE, JSON.stringify(Object.keys(reports))); } catch { /* data/ missing: fine */ }
}

function request(v) {
  const location = typeof v === 'string' ? v : v?.location;
  if (typeof location !== 'string' || !location.trim()) return;
  const key = keyOf(location, v?.units);
  if (reports[key]?.status === 'ready' && Date.now() - reports[key].updatedAt < EVERY) { publish(); return; }
  if (!reports[key]) { reports[key] = { status: 'loading' }; publish(); saveState(); }
  void refresh(key);
}

function follow(channel) {
  const url = new URL(`${EVOL}/api/channels/${encodeURIComponent(channel)}/events`);
  const connect = () => {
    const req = (url.protocol === 'https:' ? https : http).get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          buf = buf.slice(i + 2);
          if (data) { try { request(JSON.parse(data)); } catch { /* ignore */ } }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

async function main() {
  // places requested before a restart keep refreshing (widgets re-request on load anyway)
  try { for (const k of JSON.parse(fs.readFileSync(STATE, 'utf8'))) if (typeof k === 'string' && k.includes('|')) reports[k] = { status: 'loading' }; } catch { /* none */ }
  for (const k of Object.keys(reports)) void refresh(k);
  follow(`${PREFIX}.request`);
  setInterval(() => { for (const k of Object.keys(reports)) void refresh(k); }, EVERY);
  console.log(`weather: ${Object.keys(reports).length} saved location(s), refresh every ${EVERY / 1000}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
