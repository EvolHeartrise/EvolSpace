// ScoreSaber source: polls the global ranking (public API, no key) and publishes panel markup for the
// top N players to `<prefix>.body` plus the raw rows to `<prefix>.top`.
//   node scoresaber.mjs --top 10 --prefix scoresaber --every 300
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const TOP = Number(arg('top', '10'));
const PREFIX = arg('prefix', 'scoresaber');
const EVERY = Number(arg('every', '300')) * 1000;
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

async function publish(channel, value) {
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=scoresaber`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`publish ${channel}: ${r.status} ${await r.text()}`);
}

const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

async function tick() {
  const r = await fetch('https://scoresaber.com/api/players?page=1', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`scoresaber ${r.status}`);
  const { players } = await r.json();
  const top = players.slice(0, TOP).map((p) => ({
    rank: p.rank, name: p.name, country: p.country, pp: p.pp, acc: p.scoreStats?.averageRankedAccuracy ?? null,
  }));
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const body = [
    ...top.map((p) => `${p.rank}. **${p.name}** (${p.country}) — ${fmt(p.pp)} pp · ${p.acc == null ? '–' : fmt(p.acc, 1) + '%'}`),
    '',
    `Updated ${now} · scoresaber.com`,
  ].join('\n');
  await publish(`${PREFIX}.top`, top);
  await publish(`${PREFIX}.body`, body);
  console.log(`top ${top.length}: ${top.map((p) => p.name).join(', ')}`);
}

async function loop() {
  try { await tick(); } catch (e) { console.error(String(e)); }
  setTimeout(loop, EVERY);
}
loop();
