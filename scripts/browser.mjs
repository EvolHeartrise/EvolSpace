#!/usr/bin/env node
// Claude's browser: drive the `browser` source's Chromium (live in the XR `browser` widget) over CDP.
// Every action is announced on browser.action (shown in the widget, with a click marker), and is
// paced a little so the user can follow along.
//
//   node scripts/browser.mjs goto <url>             open a URL
//   node scripts/browser.mjs search <query…>        Google (falls back to DuckDuckGo if Google asks for a CAPTCHA)
//   node scripts/browser.mjs snapshot               numbered list of visible links / buttons / inputs  → use with click/fill
//   node scripts/browser.mjs text [maxChars]        visible page text (default 6000 chars)
//   node scripts/browser.mjs click <n | css | "text=…">   click element n from the last snapshot, a selector, or by text
//   node scripts/browser.mjs fill <n | css> <text…> type into an input (clears it first)
//   node scripts/browser.mjs press <key>            e.g. Enter, Escape, PageDown
//   node scripts/browser.mjs scroll <down|up> [px]  scroll the page (default 700 px)
//   node scripts/browser.mjs back | forward | reload
//   node scripts/browser.mjs state                  url + title
//   node scripts/browser.mjs shot <file.png>        screenshot (to look at the page yourself)
// Env: EVOL_URL (default http://127.0.0.1:8787), EVOL_BROWSER_CDP (default http://127.0.0.1:9333).
// Prints a short result; exits 1 with a message on failure (e.g. the browser source is not running).
import { chromium } from 'playwright';

const EVOL = (process.env.EVOL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const CDP = process.env.EVOL_BROWSER_CDP || 'http://127.0.0.1:9333';
const PACE = Number(process.env.EVOL_BROWSER_PACE_MS ?? 350);

const [cmd, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function announce(text, extra = {}) {
  try {
    await fetch(`${EVOL}/api/channels/browser.action?producer=claude`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, at: Date.now(), source: 'claude', ...extra }),
    });
  } catch { /* EvolSpace down: still act */ }
}

let browser;
try {
  browser = await chromium.connectOverCDP(CDP, { timeout: 5000 });
} catch {
  console.error(`No browser at ${CDP}. Start it: sources start browser (EvolSpace), then retry.`);
  process.exit(1);
}
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages[pages.length - 1];
if (!page) { console.error('The browser has no open page.'); process.exit(1); }
const vp = page.viewportSize() ?? { width: 1280, height: 800 };

/** "Title — url", both shortened. */
const where = async (p = page) => {
  const t = (await p.title().catch(() => '')).replace(/\s+/g, ' ').slice(0, 100);
  const u = p.url();
  return `${t || '(untitled)'} — ${u.length > 140 ? u.slice(0, 139) + '…' : u}`;
};

/** Center of an element, normalized to the viewport (for the widget's click marker). */
async function centerOf(loc) {
  const b = await loc.boundingBox().catch(() => null);
  return b ? { x: (b.x + b.width / 2) / vp.width, y: (b.y + b.height / 2) / vp.height } : {};
}

/** Element by snapshot number, CSS selector or "text=…". */
function target(ref) {
  if (/^\d+$/.test(ref)) return page.locator(`[data-evol-id="${ref}"]`).first();
  return page.locator(ref).first();
}

const SNAPSHOT_JS = () => {
  const out = [];
  let n = 0;
  document.querySelectorAll('[data-evol-id]').forEach((e) => e.removeAttribute('data-evol-id'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    const id = String(++n);
    el.setAttribute('data-evol-id', id);
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? `input[${el.type}]` : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const href = tag === 'a' ? ` → ${el.href.slice(0, 100)}` : '';
    out.push(`[${id}] ${kind} "${label}"${href}`);
    if (n >= 150) break;
  }
  return out.join('\n');
};

try {
  switch (cmd) {
    case 'goto': {
      const url = rest.join(' ').trim();
      const u = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      await announce(`Opening ${u}`);
      await page.goto(u, { waitUntil: 'domcontentloaded' });
      console.log(await where());
      break;
    }
    case 'search': {
      const q = rest.join(' ').trim();
      await announce(`Searching Google: ${q}`);
      await page.goto('https://www.google.com/?hl=en', { waitUntil: 'domcontentloaded' });
      const box = page.locator('textarea[name=q], input[name=q]').first();
      let ok = false;
      if (await box.count()) {
        await announce(`Typing "${q}"`, { ...(await centerOf(box)), kind: 'click' });
        await box.click();
        await box.pressSequentially(q, { delay: 35 });
        await page.keyboard.press('Enter');
        // Google answers bots with a redirect to /sorry/ (a CAPTCHA page) after the results URL
        await page.waitForURL((u) => !/google\.[a-z.]+\/?$/.test(u.href), { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await sleep(600);
        ok = !/\/sorry\//.test(page.url()) && !/unusual traffic/i.test(await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''));
      }
      if (!ok) {
        await announce('Google wants a CAPTCHA (bot check) — using DuckDuckGo instead');
        await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
        await sleep(800);
        console.log(`Google blocked the automated search (CAPTCHA); used DuckDuckGo. The user can solve Google's check in the widget once to unblock it.`);
      }
      console.log(await where());
      break;
    }
    case 'snapshot':
      await announce('Reading the page');
      console.log(`${await where()}\n${(await page.evaluate(SNAPSHOT_JS)) || '(no visible interactive elements)'}`);
      break;
    case 'text': {
      const max = Number(rest[0]) || 6000;
      await announce('Reading the page');
      const t = await page.evaluate(() => document.body?.innerText ?? '');
      console.log(`${await where()}\n${t.replace(/\n{3,}/g, '\n\n').slice(0, max)}`);
      break;
    }
    case 'click': {
      const ref = rest.join(' ');
      const loc = target(ref);
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const label = ((await loc.innerText({ timeout: 2000 }).catch(() => '')) || (await loc.getAttribute('aria-label').catch(() => '')) || ref).replace(/\s+/g, ' ').trim().slice(0, 60);
      await announce(`Clicking "${label}"`, { ...(await centerOf(loc)), kind: 'click' });
      await sleep(PACE);
      await loc.click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const now = ctx.pages();
      const p2 = now[now.length - 1];
      console.log(`clicked "${label}" → ${await where(p2)}`);
      break;
    }
    case 'fill': {
      const [ref, ...words] = rest;
      const loc = target(ref);
      const text = words.join(' ');
      await announce(`Typing "${text}"`, { ...(await centerOf(loc)), kind: 'click' });
      await loc.click({ timeout: 8000 });
      await loc.fill('');
      await loc.pressSequentially(text, { delay: 35 });
      console.log(`typed into ${ref}`);
      break;
    }
    case 'press':
      await announce(`Pressing ${rest[0] ?? 'Enter'}`);
      await page.keyboard.press(rest[0] ?? 'Enter');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      console.log(await where());
      break;
    case 'scroll': {
      const dir = rest[0] === 'up' ? -1 : 1, px = Number(rest[1]) || 700;
      await announce(`Scrolling ${dir > 0 ? 'down' : 'up'}`);
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.wheel(0, dir * px);
      await sleep(400);
      console.log('scrolled');
      break;
    }
    case 'back': case 'forward': case 'reload':
      await announce(cmd[0].toUpperCase() + cmd.slice(1));
      if (cmd === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (cmd === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(await where());
      break;
    case 'state':
      console.log(`${await where()} (${pages.length} tab${pages.length === 1 ? '' : 's'})`);
      break;
    case 'shot': {
      const file = rest[0] || 'browser.png';
      await page.screenshot({ path: file });
      console.log(`saved ${file}`);
      break;
    }
    default:
      console.error('usage: node scripts/browser.mjs goto|search|snapshot|text|click|fill|press|scroll|back|forward|reload|state|shot …');
      process.exit(2);
  }
} catch (e) {
  await announce(`Failed: ${String(e.message ?? e).split('\n')[0].slice(0, 100)}`);
  console.error(String(e.message ?? e).split('\n').slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  // detach without closing the user's browser
  await browser.close().catch(() => {});
}
