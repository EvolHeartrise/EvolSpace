// Weather source: polls Open-Meteo (no API key) and publishes panel markup to `<prefix>.body`
// plus the raw current conditions to `<prefix>.current`. Location/interval via args:
//   node weather.mjs --name "Delta, BC" --lat 49.0847 --lon -123.0586 --tz America/Vancouver --prefix weather.delta --every 600
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const NAME = arg('name', 'Delta, BC');
const LAT = arg('lat', '49.0847');
const LON = arg('lon', '-123.0586');
const TZ = arg('tz', 'America/Vancouver');
const PREFIX = arg('prefix', 'weather.delta');
const EVERY = Number(arg('every', '600')) * 1000;
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, heavy hail',
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

async function publish(channel, value) {
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=weather`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`publish ${channel}: ${r.status} ${await r.text()}`);
}

async function tick() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${LAT}&longitude=${LON}&timezone=${encodeURIComponent(TZ)}&forecast_days=1`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const w = await r.json();
  const c = w.current, d = w.daily;
  const sky = WMO[c.weather_code] ?? `Code ${c.weather_code}`;
  const dir = COMPASS[Math.round(c.wind_direction_10m / 45) % 8];
  const body = [
    `# ${Math.round(c.temperature_2m)}°C · ${sky}`,
    `Feels like **${Math.round(c.apparent_temperature)}°C**`,
    '---',
    `- High / low: **${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°**`,
    `- Humidity: **${c.relative_humidity_2m}%**`,
    `- Wind: **${Math.round(c.wind_speed_10m)} km/h ${dir}**`,
    `- Rain chance: **${d.precipitation_probability_max[0]}%** (now ${c.precipitation} mm)`,
    '',
    `Updated ${c.time.slice(11, 16)} · Open-Meteo`,
  ].join('\n');
  await publish(`${PREFIX}.current`, { location: NAME, sky, ...c });
  await publish(`${PREFIX}.body`, body);
  console.log(`${c.time} ${c.temperature_2m}°C ${sky}`);
}

async function loop() {
  try { await tick(); } catch (e) { console.error(String(e)); }
  setTimeout(loop, EVERY);
}
loop();
