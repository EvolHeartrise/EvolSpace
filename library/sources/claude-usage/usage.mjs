// Claude plan usage for the `usage` widget. Claude Code hands its status line command the
// plan's rate-limit windows (rate_limits.five_hour / seven_day: used_percentage, resets_at; Pro/Max
// only, after the first response of a session). ~/.claude/statusline-command.sh saves that JSON to
// ~/.cache/evolspace/claude-usage.json; this source watches the file and publishes
//   claude.usage = {windows: [{key, label, pct, resetsAt (ms)}], model, at (ms)} | {windows: [], note}
// Windows whose reset time has passed are dropped (their usage has reset).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const FILE = arg('file', path.join(os.homedir(), '.cache/evolspace/claude-usage.json'));
const CHANNEL = arg('channel', 'claude.usage');
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

const LABELS = { five_hour: 'Current session · 5 h', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

let last = '';
async function publish(value) {
  const body = JSON.stringify(value);
  if (body === last) return;
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(CHANNEL)}?producer=claude-usage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error(`publish: ${r.status} ${await r.text()}`);
  last = body;
}

function read() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {
    return { windows: [], note: 'No usage yet: it appears after Claude Code (Pro/Max) answers in any session.' };
  }
  const now = Date.now();
  const windows = Object.entries(raw.rate_limits ?? {})
    .filter(([, w]) => w && Number.isFinite(w.used_percentage))
    .map(([key, w]) => ({ key, label: LABELS[key] ?? key.replace(/_/g, ' '), pct: w.used_percentage, resetsAt: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null }))
    .filter((w) => !(w.resetsAt && w.resetsAt <= now))
    .sort((a, b) => (ORDER.indexOf(a.key) + 99) % 99 - (ORDER.indexOf(b.key) + 99) % 99);
  return { windows, model: raw.model ?? '', at: Number.isFinite(raw.at) ? Math.round(raw.at * 1000) : null };
}

async function tick() {
  try { await publish(read()); } catch (e) { console.error(String(e)); }
}

fs.mkdirSync(path.dirname(FILE), { recursive: true });
// the status line replaces the file atomically (rename), so watch the directory, plus a slow poll
fs.watch(path.dirname(FILE), (_, name) => { if (!name || name === path.basename(FILE)) void tick(); });
setInterval(tick, 30000);
void tick();
console.log(`watching ${FILE} → ${CHANNEL}`);
