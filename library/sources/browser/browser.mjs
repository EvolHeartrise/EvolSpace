// Browser source: one Chromium (Playwright, headless, persistent profile in data/browser-profile)
// that Claude drives and the user watches live in the `browser` widget.
//
//   <P>.frame   u8 tensor [n] — the latest JPEG screen frame (CDP screencast; sent only on change)
//   <P>.state   {url, title, loading, canGoBack, canGoForward, viewport: {w, h}, pages, frameAt}
//   <P>.action  {text, x?, y?, kind?, at} — what the agent is doing (x/y normalized 0..1 → click marker);
//               published by scripts/browser.mjs (Claude's control script) and by this source for
//               widget/voice commands
//   <P>.ctl     commands from the widget / voice fast path:
//               {cmd: 'click', x, y} (normalized) | {cmd: 'scroll', dy (px), x?, y?} | {cmd: 'goto', url} |
//               {cmd: 'back'|'forward'|'reload'} | {cmd: 'type', text} | {cmd: 'key', key} | {cmd: 'search', query}
//
// Claude attaches to the same browser over CDP (http://127.0.0.1:<--cdp-port>, default 9333) with
// scripts/browser.mjs, so everything it does shows up in the widget. The newest tab is the one shown.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const P = arg('prefix', 'browser');
const CDP_PORT = Number(arg('cdp-port', '9333'));
const W = Number(arg('width', '1280')), H = Number(arg('height', '800'));
const QUALITY = Number(arg('quality', '60'));
const MAX_FPS = Number(arg('max-fps', '15'));
const PROFILE = path.resolve(arg('profile', '../../../data/browser-profile'));
const HOME = arg('home', 'https://duckduckgo.com/');
const EVOL = (process.env.EVOL_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
// A regular desktop Chrome UA: the default "HeadlessChrome" one gets bot pages on many sites.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

async function put(channel, body, headers) {
  const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}?producer=browser`, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`publish ${channel}: ${r.status}`);
}
const publishJson = (ch, v) => put(ch, JSON.stringify(v), { 'Content-Type': 'application/json' }).catch((e) => console.error(String(e)));

// ---- frames: latest wins, at most MAX_FPS, never more than one upload in flight ----------------
let pendingFrame = null, sending = false, lastSent = 0, frameAt = 0;
async function pumpFrame() {
  if (sending || !pendingFrame) return;
  const wait = 1000 / MAX_FPS - (Date.now() - lastSent);
  if (wait > 0) { setTimeout(pumpFrame, wait); return; }
  const buf = pendingFrame;
  pendingFrame = null;
  sending = true;
  try {
    await put(`${P}.frame`, buf, { 'Content-Type': 'application/octet-stream', 'X-Dtype': 'u8', 'X-Shape': String(buf.length) });
    frameAt = Date.now();
  } catch (e) { console.error(String(e)); }
  lastSent = Date.now();
  sending = false;
  if (pendingFrame) void pumpFrame();
}

// ---- browser ----------------------------------------------------------------------------------
fs.mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true, viewport: { width: W, height: H }, deviceScaleFactor: 1, userAgent: UA, locale: 'en-US',
  acceptDownloads: false,
  args: [`--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', '--disable-blink-features=AutomationControlled'],
});
let page = null, cdp = null;

async function show(p) {
  if (p === page) return;
  try { await cdp?.send('Page.stopScreencast'); await cdp?.detach(); } catch { /* old page gone */ }
  page = p;
  cdp = await ctx.newCDPSession(p);
  cdp.on('Page.screencastFrame', (f) => {
    pendingFrame = Buffer.from(f.data, 'base64');
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    void pumpFrame();
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  for (const ev of ['framenavigated', 'load', 'domcontentloaded']) p.on(ev, () => void publishState());
  p.on('close', () => { const rest = ctx.pages(); if (p === page && rest.length) void show(rest[rest.length - 1]); });
  void publishState();
}

let lastState = '';
async function publishState(loading) {
  if (!page) return;
  let title = '';
  try { title = await page.title(); } catch { /* navigating */ }
  let hist = { back: false, fwd: false };
  try { hist = await page.evaluate(() => ({ back: history.length > 1, fwd: false })); } catch { /* navigating */ }
  const state = {
    url: page.url(), title, loading: loading ?? false, canGoBack: hist.back, canGoForward: hist.fwd,
    viewport: { w: W, h: H }, pages: ctx.pages().length, frameAt,
  };
  const s = JSON.stringify({ ...state, frameAt: 0 });
  if (s === lastState) return;
  lastState = s;
  await publishJson(`${P}.state`, state);
}

const action = (text, extra = {}) => publishJson(`${P}.action`, { text, at: Date.now(), source: 'user', ...extra });

const looksLikeUrl = (s) => /^[a-z]+:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s.trim());

async function command(c) {
  if (!c || typeof c !== 'object' || !page) return;
  const nx = Math.min(1, Math.max(0, Number(c.x))), ny = Math.min(1, Math.max(0, Number(c.y)));
  try {
    switch (c.cmd) {
      case 'click':
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        await action('You clicked', { x: nx, y: ny, kind: 'click' });
        await page.mouse.click(nx * W, ny * H);
        break;
      case 'scroll':
        if (Number.isFinite(nx) && Number.isFinite(ny)) await page.mouse.move(nx * W, ny * H);
        await page.mouse.wheel(0, Number(c.dy) || 0);
        break;
      case 'goto': {
        const u = String(c.url ?? '').trim();
        if (!u) return;
        await action(`Opening ${u}`);
        await page.goto(looksLikeUrl(u) ? (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`) : `https://duckduckgo.com/?q=${encodeURIComponent(u)}`, { waitUntil: 'domcontentloaded' });
        break;
      }
      case 'search': {
        const q = String(c.query ?? '').trim();
        if (!q) return;
        await action(`Searching: ${q}`);
        await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
        break;
      }
      case 'back': await action('Back'); await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
      case 'forward': await action('Forward'); await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
      case 'reload': await action('Reload'); await page.reload({ waitUntil: 'domcontentloaded' }); break;
      case 'type': await page.keyboard.type(String(c.text ?? ''), { delay: 25 }); break;
      case 'key': await page.keyboard.press(String(c.key ?? 'Enter')); break;
      default: return;
    }
  } catch (e) {
    await action(`Failed: ${String(e.message ?? e).split('\n')[0].slice(0, 120)}`);
  }
  void publishState();
}

/** Follow a channel over SSE; cb gets only values published after we connected (by seq). */
async function follow(channel, cb) {
  let lastSeq = 0;
  try { const r = await fetch(`${EVOL}/api/channels/${encodeURIComponent(channel)}`); if (r.ok) lastSeq = Number(r.headers.get('x-seq')) || 0; } catch { /* none yet */ }
  const url = new URL(`${EVOL}/api/channels/${encodeURIComponent(channel)}/events`);
  const connect = () => {
    const req = (url.protocol === 'https:' ? https : http).get(url, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const lines = buf.slice(0, i).split('\n');
          buf = buf.slice(i + 2);
          const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          const seq = Number(lines.find((l) => l.startsWith('id: '))?.slice(4));
          if (!data || !Number.isFinite(seq)) continue;
          if (seq < lastSeq) { lastSeq = seq; continue; } // the server restarted: its current value is history
          if (seq === lastSeq) continue;
          lastSeq = seq;
          try { cb(JSON.parse(data)); } catch { /* ignore */ }
        }
      });
      res.on('end', () => setTimeout(connect, 2000));
    });
    req.on('error', () => setTimeout(connect, 2000));
  };
  connect();
}

ctx.on('page', (p) => void show(p)); // new tabs / popups (incl. ones Claude opens) take over the view
const first = ctx.pages()[0] ?? (await ctx.newPage());
await show(first);
if (first.url() === 'about:blank') await first.goto(HOME, { waitUntil: 'domcontentloaded' }).catch(() => {});
setInterval(() => void publishState(), 2000); // titles/URLs that change without navigation events
await follow(`${P}.ctl`, (c) => void command(c));
console.log(`browser: ${W}×${H}, CDP on 127.0.0.1:${CDP_PORT}, profile ${PROFILE}`);

const shutdown = async () => { try { await ctx.close(); } catch { /* already gone */ } process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
