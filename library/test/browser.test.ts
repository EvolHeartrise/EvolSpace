// browser — the agent-browser view: URL bar, status line, tap → click, pinch-drag → scroll, buttons.
import { expect, it } from 'vitest';
import browser, { displayUrl, scrollPixels } from '../widgets/browser/widget.ts';
import { mount } from './harness.ts';

it('formats URLs and converts hand travel to wheel pixels', () => {
  expect(displayUrl('https://www.google.com/')).toBe('www.google.com');
  expect(displayUrl('http://example.com/a/b')).toBe('example.com/a/b');
  expect(scrollPixels(0.1, 0.5, 800)).toBe(240);
  expect(scrollPixels(-0.05, 0.5, 800)).toBe(-120);
});

it('shows state + agent actions, and sends taps, scrolls and buttons as commands', async () => {
  const h = await mount(browser, {});
  h.frame();
  expect(h.hasText("Start the 'browser' source to see the agent's browser")).toBe(true);
  h.publish('browser.state', { url: 'https://duckduckgo.com/?q=cats', title: 'cats at DuckDuckGo', loading: false, canGoBack: true, viewport: { w: 1280, h: 800 } });
  h.publish('browser.action', { text: 'Clicking "Cats"', at: Date.now(), source: 'claude', x: 0.5, y: 0.25, kind: 'click' });
  h.frame();
  expect(h.hasText('duckduckgo.com/?q=cats')).toBe(true);
  expect(h.hasText('Claude: Clicking "Cats"')).toBe(true);
  expect(h.root.getObjectByName('icon:lock')).toBeTruthy();

  // tap in the middle of the page → click at (0.5, 0.5)
  h.press('screen', 'drag');
  expect(h.rec.published.at(-1)).toMatchObject({ channel: 'browser.ctl', value: { cmd: 'click', x: 0.5, y: 0.5 } });
  // pinch-drag up → scroll down (positive dy)
  h.drag('screen', [0, 0.1, 0], { steps: 5 });
  const scrolls = h.rec.published.filter((p) => (p.value as { cmd?: string }).cmd === 'scroll');
  expect(scrolls.length).toBeGreaterThan(0);
  expect(scrolls.reduce((a, p) => a + (p.value as { dy: number }).dy, 0)).toBeGreaterThan(0);
  expect(h.rec.published.some((p) => (p.value as { cmd?: string }).cmd === 'click' && p !== h.rec.published[0])).toBe(false); // the drag did not click
  h.press('btn:back', 'drag');
  expect(h.rec.published.at(-1)?.value).toMatchObject({ cmd: 'back' });
  h.press('btn:reload', 'drag');
  expect(h.rec.published.at(-1)?.value).toMatchObject({ cmd: 'reload' });
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
