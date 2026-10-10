// browser — the agent-browser view: URL bar, status line, tap → click, pinch-drag → scroll, buttons.
import { expect, it, vi } from 'vitest';
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


it('scrolls in small steps while dragging and keeps scrolling after a flick', async () => {
  const h = await mount(browser, {});
  h.publish('browser.state', { url: 'https://example.com/', title: 'Example', loading: false, viewport: { w: 1280, h: 800 } });
  h.frame();
  const scrolls = () => h.rec.published.filter((p) => (p.value as { cmd?: string }).cmd === 'scroll').map((p) => (p.value as { dy: number }).dy);
  // drag with frames in between (update() sends what the hand moved, ≥ 4 px, ≤ 1 per 33 ms)
  let clock = 1000;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  h.interact({ handler: 'drag', phase: 'start', objectName: 'screen', localPoint: [0, -0.05, 0] });
  let y = -0.05;
  for (let i = 0; i < 6; i++) {
    clock += 40;
    y += 0.08 / 6;
    h.interact({ handler: 'drag', phase: 'move', objectName: 'screen', localPoint: [0, y, 0] });
    h.frame(1, 0.04);
  }
  const duringDrag = scrolls();
  clock += 4;
  h.interact({ handler: 'drag', phase: 'end', objectName: 'screen', localPoint: [0, y, 0] });
  spy.mockRestore();
  expect(duringDrag.length).toBeGreaterThan(2); // many small steps, not one jump
  expect(duringDrag.every((d) => d > 0)).toBe(true);
  const sumAtRelease = scrolls().reduce((a, b) => a + b, 0); // includes the remainder flushed on release
  h.frame(60, 1 / 30);
  const after = scrolls();
  expect(after.length).toBeGreaterThan(duringDrag.length);
  expect(after.reduce((a, b) => a + b, 0)).toBeGreaterThan(sumAtRelease); // the glide went on in the same direction
  h.dispose();
});
