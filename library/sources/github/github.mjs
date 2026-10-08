// GitHub source: polls a repo's issues and pull requests with the `gh` CLI (its own auth) and
// publishes them as `item-list` rows:
//   <prefix>.issues / <prefix>.prs = {title, updatedAt, items: [{id, title, status, color, meta, url, labels}]}
// Open items first, then by last update. Status colors follow GitHub's (open green, merged/completed
// purple, closed PR red, not planned / draft gray). Every item's full details are prefetched for the
// `github-item` card (instant display, no round trip):
//   <prefix>.details = {repo, updatedAt, items: {"<number>": Detail}}
//   Detail = {kind: issue|pr, number, title, status, color, author, created, updated, closed, labels,
//             url, facts: string[], body (panel markup), comments: [{author, at, body}]}
//   node github.mjs --repo EvolHeartrise/BeatSaberRL --prefix github.bsrl --name BeatSaberRL --every 300
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/** GitHub markdown → the panel markup subset (# heading, - bullets, 1. lists, ``` code, ---, **bold**, `code`). */
export function toMarkup(md) {
  const out = [];
  let fence = false, fenceLines = 0;
  for (let line of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      fenceLines = 0;
      out.push('```');
      continue;
    }
    if (fence) {
      if (++fenceLines <= 16) out.push(line.replace(/\t/g, '  '));
      else if (fenceLines === 17) out.push('…');
      continue;
    }
    line = line
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[image: ${alt}]` : '[image]'))
      .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
      .replace(/__([^_]+)__/g, '**$1**')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1$2')
      .replace(/(^|\W)_([^_\s][^_]*?)_(?=\W|$)/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1');
    let m;
    if ((m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line))) out.push(`# ${m[1]}`);
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('---');
    else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) out.push(`${'  '.repeat(Math.min(3, Math.floor(m[1].length / 2)))}- ${m[2]}`);
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) out.push(m[1]);
    else out.push(line.trim());
  }
  if (fence) out.push('```');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const commentsOf = (x) => (x.comments ?? []).map((c) => ({ author: c.author?.login ?? '?', at: day(c.createdAt), body: toMarkup(c.body) }));

async function tick() {
  const [issues, prs] = await Promise.all([
    gh(['issue', 'list', '-R', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,state,stateReason,labels,author,createdAt,updatedAt,closedAt,comments,url,body']),
    gh(['pr', 'list', '-R', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,state,isDraft,labels,author,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,changedFiles,headRefName,baseRefName,url,statusCheckRollup,body,comments,reviewDecision']),
  ]);
  const details = {};
  const issueItems = issues.map((x) => {
    const status = x.state === 'OPEN' ? 'open' : x.stateReason === 'NOT_PLANNED' ? 'not planned' : 'closed';
    const when = x.state === 'OPEN' ? `opened ${ago(x.createdAt)}` : `closed ${ago(x.closedAt ?? x.updatedAt)}`;
    const color = status === 'open' ? COLORS.open : status === 'closed' ? COLORS.completed : COLORS.notPlanned;
    details[x.number] = {
      kind: 'issue', number: x.number, title: x.title, status, color, author: x.author?.login ?? '?',
      created: day(x.createdAt), updated: ago(x.updatedAt), closed: day(x.closedAt), labels: (x.labels ?? []).map((l) => l.name), url: x.url,
      facts: [], body: toMarkup(x.body), comments: commentsOf(x),
    };
    return {
      id: `#${x.number}`, title: x.title, status, color,
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
    const review = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[x.reviewDecision] ?? '';
    details[x.number] = {
      kind: 'pr', number: x.number, title: x.title, status, color: COLORS[status] ?? COLORS.closed, author: x.author?.login ?? '?',
      created: day(x.createdAt), updated: ago(x.updatedAt), closed: day(x.mergedAt ?? x.closedAt), labels: (x.labels ?? []).map((l) => l.name), url: x.url,
      facts: [
        `\`${x.headRefName}\` → \`${x.baseRefName}\``,
        `+${x.additions} −${x.deletions} in ${plural(x.changedFiles ?? 0, 'file')}`,
        ...(ci ? [ci.slice(3)] : []),
        ...(review ? [review] : []),
      ],
      body: toMarkup(x.body), comments: commentsOf(x),
    };
    return {
      id: `#${x.number}`, title: x.title, status, color: COLORS[status] ?? COLORS.closed,
      meta: `${when} · ${x.headRefName} · +${x.additions} −${x.deletions}${ci}`,
      url: x.url, labels: labelsOf(x), updated: x.updatedAt,
    };
  }).sort(order);
  const stamp = new Date().toISOString();
  await publish(`${PREFIX}.issues`, { title: `${NAME} · Issues`, updatedAt: stamp, items: issueItems });
  await publish(`${PREFIX}.prs`, { title: `${NAME} · Pull requests`, updatedAt: stamp, items: prItems });
  await publish(`${PREFIX}.details`, { repo: REPO, updatedAt: stamp, items: details });
  console.log(`${REPO}: ${issueItems.length} issues, ${prItems.length} PRs`);
}

async function loop() {
  try { await tick(); } catch (e) { console.error(String(e)); }
  setTimeout(loop, EVERY);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) loop(); // not when imported (tests)
