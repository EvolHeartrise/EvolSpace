// video — URL routing (fetch via the video source vs. play directly), time format, the no-DOM fallback.
import { expect, it } from 'vitest';
import video, { clock, needsFetch } from '../widgets/video/widget.ts';
import { mount } from './harness.ts';

it('fetches remote links through the video source, plays same-origin paths directly', () => {
  expect(needsFetch('https://www.youtube.com/watch?v=abc', 'https://x:8443')).toBe(true);
  expect(needsFetch('https://example.com/a.mp4', 'https://x:8443')).toBe(true);
  expect(needsFetch('/media/abc.mp4', 'https://x:8443')).toBe(false);
  expect(needsFetch('https://x:8443/media/abc.mp4', 'https://x:8443')).toBe(false);
  expect(needsFetch('', null)).toBe(false);
  expect(needsFetch('ftp://nope', null)).toBe(false);
});

it('formats times', () => {
  expect(clock(0)).toBe('0:00');
  expect(clock(19.6)).toBe('0:19');
  expect(clock(3725)).toBe('1:02:05');
  expect(clock(NaN)).toBe('0:00');
});

it('asks the video source for a YouTube URL and shows its progress (no DOM in tests: no <video>)', async () => {
  const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const h = await mount(video, { url });
  h.frame();
  expect(h.rec.published.at(-1)).toMatchObject({ channel: 'video.request', value: { url } });
  h.publish('video.media', { [url]: { status: 'downloading', progress: 0.42, src: '', title: 'Me at the zoo', duration: 19 } });
  h.frame();
  expect(h.hasText('Downloading 42%')).toBe(true);
  expect(h.hasText('Me at the zoo')).toBe(true);
  expect(h.hasText('0:00 / 0:19')).toBe(true);
  h.publish('video.media', { [url]: { status: 'error', progress: 0, src: '', title: '', duration: null, error: 'Video unavailable' } });
  h.frame();
  expect(h.hasText("Couldn't fetch: Video unavailable")).toBe(true);
  h.press('btn:play', 'drag'); // no video element: harmless
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
