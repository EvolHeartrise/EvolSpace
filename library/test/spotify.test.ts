// spotify — sign-in overlay, now playing + controls → requests, library rows → play in context, search tab,
// audio output claim. (WebAudio isn't available in Node: the PCM path is covered by the source + manual test.)
import { expect, it } from 'vitest';
import spotify, { fmtTime, positionNow } from '../widgets/spotify/widget.ts';
import { mount } from './harness.ts';

const ready = {
  auth: 'ready', device: 'EvolSpace',
  track: { uri: 'spotify:track:t1', name: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', albumUri: 'spotify:album:a', duration: 320_000 },
  position: 60_000, positionAt: Date.now(), paused: false, volume: 50, shuffle: false, repeatContext: false, repeatTrack: false,
  contextUri: 'spotify:playlist:p1',
};
const requests = (h: Awaited<ReturnType<typeof mount>>) => h.rec.published.filter((p) => p.channel === 'spotify.request').map((p) => p.value as Record<string, unknown>);

it('shows the pairing code until signed in', async () => {
  const h = await mount(spotify, {});
  h.publish('spotify.state', { auth: 'login', login: { url: 'https://spotify.com/pair?code=AB12CD', code: 'AB12CD' } });
  h.frame(3);
  expect(h.hasText('AB12CD')).toBe(true);
  expect(h.hasText(/spotify\.com\/pair/)).toBe(true);
  expect(h.hasText('One More Time')).toBe(false);
  h.dispose();
});

it('now playing, controls and library: tapping sends requests, a track plays within its playlist', async () => {
  const h = await mount(spotify, {});
  h.publish('spotify.state', ready);
  h.frame(3);
  expect(h.hasText('One More Time')).toBe(true);
  expect(h.hasText('Daft Punk')).toBe(true);
  expect(h.hasText('5:20')).toBe(true);
  const lib = requests(h).find((r) => r.cmd === 'library')!;
  expect(lib).toMatchObject({ reply: `spotify.view.${h.ctx.entityId}` });

  h.press('play', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'pause' });
  h.press('next', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'next' });
  h.press('shuffle', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'shuffle', on: true });
  h.press('repeat', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'repeat', mode: 'context' });

  h.publish(`spotify.view.${h.ctx.entityId}`, { nonce: lib.nonce, kind: 'library', items: [
    { uri: 'spotify:collection:tracks', kind: 'collection', name: 'Liked Songs', sub: 'Playlist' },
    { uri: 'spotify:playlist:p1', kind: 'playlist', name: 'Focus', sub: 'By evol · 40 songs' },
  ] });
  h.frame(3);
  expect(h.hasText('Focus')).toBe(true);
  h.press('row:1', 'drag'); // open Focus
  const tr = requests(h).at(-1)!;
  expect(tr).toMatchObject({ cmd: 'tracks', uri: 'spotify:playlist:p1' });
  h.publish(`spotify.view.${h.ctx.entityId}`, { nonce: tr.nonce, kind: 'tracks', uri: 'spotify:playlist:p1', name: 'Focus', items: [
    { uri: 'spotify:track:t9', kind: 'track', name: 'Veridis Quo', sub: 'Daft Punk', duration: 345_000 },
  ] });
  h.frame(3);
  expect(h.hasText('Veridis Quo')).toBe(true);
  expect(h.hasText('5:45')).toBe(true);
  h.press('row:0', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'play', uri: 'spotify:playlist:p1', skipTo: 'spotify:track:t9' });
  h.press('back', 'drag');
  h.frame(3);
  expect(h.hasText('Your Library')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('new search results switch to the Search tab; touching the widget claims the audio output', async () => {
  const h = await mount(spotify, {});
  h.publish('spotify.state', ready);
  h.publish('spotify.output', { client: 'c-other' });
  h.publish('spotify.search', { query: 'daft punk', at: Date.now(), tracks: [{ uri: 'spotify:track:t2', kind: 'track', name: 'Around the World', sub: 'Daft Punk', duration: 429_000 }], albums: [], artists: [], playlists: [] });
  h.frame(3);
  expect(h.rec.setProps.at(-1)).toEqual({ tab: 'search' });
  expect(h.hasText('Around the World')).toBe(true);
  h.press('play', 'drag');
  expect(h.rec.published.find((p) => p.channel === 'spotify.output')?.value).toMatchObject({ client: 'c-test' });
  h.dispose();
});

it('time helpers', () => {
  expect(fmtTime(61_000)).toBe('1:01');
  expect(positionNow({ auth: 'ready', track: { duration: 100_000 } as never, position: 1000, positionAt: 1000, paused: false }, 3000)).toBe(3000);
  expect(positionNow({ auth: 'ready', track: { duration: 100_000 } as never, position: 1000, positionAt: 1000, paused: true }, 3000)).toBe(1000);
});

it('the like button shows and toggles Liked Songs membership', async () => {
  const h = await mount(spotify, {});
  h.publish('spotify.state', { ...ready, liked: true });
  h.frame(3);
  h.press('like', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'like', uri: 'spotify:track:t1', liked: false }); // liked → unlike
  h.publish('spotify.state', { ...ready, liked: false });
  h.frame();
  h.press('like', 'drag');
  expect(requests(h).at(-1)).toEqual({ cmd: 'like', uri: 'spotify:track:t1', liked: true });
  h.dispose();
});

it('after a skip, audio from before the jump (older generation) is dropped', async () => {
  const { chunkOf } = await import('../widgets/spotify/widget.ts');
  const chunk = (gen: number) => ({ $tensor: true, dtype: 'i16', shape: [6], data: new Int16Array([0x5350, gen, 1, 2, 3, 4]) });
  expect(chunkOf(chunk(7) as never)).toEqual({ gen: 7, pcm: new Int16Array([1, 2, 3, 4]) });
  expect(chunkOf({ $tensor: true, dtype: 'i16', shape: [2], data: new Int16Array([1, 2]) } as never)).toBeNull(); // untagged
});
