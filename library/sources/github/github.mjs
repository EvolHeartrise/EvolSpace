// GitHub source: polls a repo's issues and pull requests with the `gh` CLI (its own auth) and
// publishes them as `item-list` rows:
//   <prefix>.issues / <prefix>.prs = {title, updatedAt, items: [{id, title, status, color, meta, url, labels}]}
// Open items first, then by last update. Status colors follow GitHub's (open green, merged/completed
// purple, closed PR red, not planned / draft gray).
//   node github.mjs --repo EvolHeartrise/BeatSaberRL --prefix github.bsrl --name BeatSaberRL --every 300
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const REPO = arg('repo', 'EvolHeartrise/BeatSaberRL');
const PREFIX = arg('prefix', 'github.bsrl');
const NAME = arg('name', REPO.split('/')[1]);
const EVERY = Number(arg('every', '300')) * 1000;
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ENV = { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH ?? ''}`, GH_PROMPT_DISABLED: '1' };

const COLORS = { open: '#3fb950', merged: '#a371f7', completed: '#a371f7', closed: '#f85149', notPlanned: '#8b949e', draft: '#8b949e' };

function gh(args) {
  return new Promise((resolve, reject) =>
    execFile('gh', args, { env: ENV, maxBuffer: 64 << 20, timeout: 60000 }, (err, out, errOut) =>
      err ? reject(new Error(`gh ${args[0]} ${args[1]}: ${errOut || err.message}`)) : resolve(JSON.parse(out))));
}

async function publish(channel, value) {
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=github`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`publish ${channel}: ${r.status} ${await r.text()}`);
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 86400 / 30)}mo ago`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const order = (a, b) => (a.status === 'open' || a.status === 'draft' ? 0 : 1) - (b.status === 'open' || b.status === 'draft' ? 0 : 1) || Date.parse(b.updated) - Date.parse(a.updated);
const labelsOf = (x) => (x.labels ?? []).map((l) => ({ name: l.name, color: `#${l.color}` }));

async function tick() {
  const [issues, prs] = await Promise.all([
    gh(['issue', 'list', '-R', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,state,stateReason,labels,author,createdAt,updatedAt,closedAt,comments,url']),
    gh(['pr', 'list', '-R', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,state,isDraft,labels,author,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,headRefName,url,statusCheckRollup']),
  ]);
  const issueItems = issues.map((x) => {
    const status = x.state === 'OPEN' ? 'open' : x.stateReason === 'NOT_PLANNED' ? 'not planned' : 'closed';
    const when = x.state === 'OPEN' ? `opened ${ago(x.createdAt)}` : `closed ${ago(x.closedAt ?? x.updatedAt)}`;
    return {
      id: `#${x.number}`, title: x.title, status,
      color: status === 'open' ? COLORS.open : status === 'closed' ? COLORS.completed : COLORS.notPlanned,
      meta: `${when} · ${plural(x.comments?.length ?? 0, 'comment')} · updated ${ago(x.updatedAt)}`,
      url: x.url, labels: labelsOf(x), updated: x.updatedAt,
    };
  }).sort(order);
  const prItems = prs.map((x) => {
    const status = x.state === 'MERGED' ? 'merged' : x.state === 'CLOSED' ? 'closed' : x.isDraft ? 'draft' : 'open';
    const checks = x.statusCheckRollup ?? [];
    const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state)).length;
    const pending = checks.filter((c) => c.status && c.status !== 'COMPLETED').length;
    const ci = !checks.length ? '' : failing ? ` · CI failing (${failing})` : pending ? ' · CI running' : ' · CI passing';
    const when = x.state === 'MERGED' ? `merged ${ago(x.mergedAt)}` : x.state === 'CLOSED' ? `closed ${ago(x.closedAt ?? x.updatedAt)}` : `opened ${ago(x.createdAt)}`;
    return {
      id: `#${x.number}`, title: x.title, status, color: COLORS[status] ?? COLORS.closed,
      meta: `${when} · ${x.headRefName} · +${x.additions} −${x.deletions}${ci}`,
      url: x.url, labels: labelsOf(x), updated: x.updatedAt,
    };
  }).sort(order);
  const stamp = new Date().toISOString();
  await publish(`${PREFIX}.issues`, { title: `${NAME} · Issues`, updatedAt: stamp, items: issueItems });
  await publish(`${PREFIX}.prs`, { title: `${NAME} · Pull requests`, updatedAt: stamp, items: prItems });
  console.log(`${REPO}: ${issueItems.length} issues, ${prItems.length} PRs`);
}

async function loop() {
  try { await tick(); } catch (e) { console.error(String(e)); }
  setTimeout(loop, EVERY);
}
loop();
