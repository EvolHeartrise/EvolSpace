// discord — picker (DMs / servers → channels, unread + mentions), Discord-style messages (stable slots,
// shown once laid out), scrolling, open lease.
import * as THREE from 'three';
import { expect, it } from 'vitest';
import discord, { cleanName, discordTime, messageBody } from '../widgets/discord/widget.ts';
import { mount } from './harness.ts';

/** Name of the nearest visible hit along a ray from +Z through the named part (like the runtime picker). */
function nearestHit(root: THREE.Object3D, part: string): string {
  root.updateMatrixWorld(true);
  const target = root.getObjectByName(part)!.getWorldPosition(new THREE.Vector3());
  const rc = new THREE.Raycaster(target.clone().add(new THREE.Vector3(0, 0, 1)), new THREE.Vector3(0, 0, -1));
  const hits: THREE.Intersection[] = [];
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if ((o as THREE.Mesh).geometry) o.raycast(rc, hits);
    o.children.forEach(visit);
  };
  visit(root);
  hits.sort((a, b) => a.distance - b.distance);
  return hits.map((x) => x.object.name).find(Boolean) ?? '';
}

const now = Date.now();
const channels = {
  dms: [{ id: '111111', name: 'alice', kind: 'dm', unread: true, mentions: 2 }, { id: '222222', name: 'bob, carol', kind: 'group' }],
  guilds: [{ id: '900000', name: 'Beat Lab', unread: true, channels: [{ id: '333333', name: 'general', kind: 'text', category: 'Text', unread: true }, { id: '444444', name: 'quiet', kind: 'text', category: 'Text' }] }],
};
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: String(1000 + i), author: { id: i % 4 < 2 ? 'a' : 'b', name: i % 4 < 2 ? 'alice' : 'evol' }, content: `message ${i}`, ts: now - (n - i) * 1000, mine: i % 4 >= 2,
}));

it('picks a DM through the picker (unread badges), subscribes and leases the channel', async () => {
  const h = await mount(discord, {});
  h.publish('discord.status', { state: 'ready', user: { id: 'b', name: 'evol' } });
  h.publish('discord.channels', channels);
  h.frame();
  expect(h.hasText('Direct Messages')).toBe(true);
  expect(h.hasText('Beat Lab')).toBe(true);
  expect(h.hasText(/Signed in/)).toBe(false);
  expect(h.hasText('2')).toBe(true); // mention badge on Direct Messages
  // A ray from the user at the first row reaches the row, not the message-area hit box in front of it.
  expect(nearestHit(h.root, 'pick:0')).toBe('pick:0');

  h.press('pick:0', 'drag'); // Direct Messages
  h.frame();
  expect(h.hasText('alice')).toBe(true);
  expect(h.hasText('bob, carol')).toBe(true);
  h.press('pick:0', 'drag'); // alice
  expect(h.rec.setProps.at(-1)).toEqual({ channelId: '111111' });
  expect(h.rec.published.at(-1)).toEqual({ channel: 'discord.request', value: { cmd: 'open', channel: '111111' } });

  h.publish('discord.ch.111111', { id: '111111', name: 'alice', kind: 'dm', messages: msgs(6) });
  h.frame(3); // slots appear once their text is laid out
  expect(h.hasText('message 5')).toBe(true);
  expect(h.hasText(/^Today at /)).toBe(true);
  expect(h.hasText('Message @alice')).toBe(true);

  h.press('back');
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ channelId: '' });
  expect(h.hasText('bob, carol')).toBe(true); // back to the DM list it came from
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('server channels: category headers, header rows are not tappable', async () => {
  const h = await mount(discord, {});
  h.publish('discord.status', { state: 'ready' });
  h.publish('discord.channels', channels);
  h.frame();
  h.press('pick:1', 'drag'); // Beat Lab
  h.frame();
  expect(h.hasText('TEXT')).toBe(true);
  h.press('pick:0', 'drag'); // the header: nothing
  expect(h.rec.setProps).toEqual([]);
  h.press('pick:1', 'drag'); // general
  expect(h.rec.setProps.at(-1)).toEqual({ channelId: '333333' });
  h.dispose();
});

it('shows the newest messages at the bottom; scrolling keeps messages in their slots (no re-layout)', async () => {
  const h = await mount(discord, { channelId: '333333', lines: 8 });
  h.publish('discord.ch.333333', { id: '333333', name: 'general', kind: 'text', guild: 'Beat Lab', messages: msgs(40) });
  h.frame(3);
  expect(h.hasText('message 39')).toBe(true);
  expect(h.hasText('message 10')).toBe(false);
  const slotOf39 = h.root.getObjectsByProperty('text', 'message 39')[0];
  h.drag('body', [0, -0.03, 0], { steps: 3 }); // a little: message 39 stays in view
  h.frame();
  expect(h.root.getObjectsByProperty('text', 'message 39')[0]).toBe(slotOf39); // same slot: nothing re-wrapped
  h.drag('body', [0, -0.2, 0]);
  h.frame(3);
  expect(h.hasText('message 39')).toBe(false);
  expect(h.hasText(/newer below/)).toBe(true);
  h.dispose();
});

it('explains a missing source; message bodies and Discord timestamps', async () => {
  const h = await mount(discord, { channelId: '333333' });
  h.frame();
  expect(h.hasText(/DISCORD_USER_TOKEN/)).toBe(true);
  h.dispose();
  const b = messageBody({ id: '1', author: { id: 'a', name: 'a' }, content: 'look @bob', ts: 0, attachments: [{ name: 'notes.txt' }, { name: 'cat.png', image: { src: '/media/x.png', w: 10, h: 10 } }], embeds: [{ title: 'T', description: 'D' }], edited: true }, 500, { text: 1, link: 2, mention: 3, faint: 4 });
  expect(b.text).toBe('look @bob\n[file] notes.txt\n| T — D (edited)'); // images are shown inline, not as text
  expect(b.ranges).toMatchObject({ 0: 1, 5: 3, 9: 1, 10: 2 });
  const d = new Date(2026, 9, 10, 16, 5).getTime();
  expect(discordTime(d, d + 60_000)).toBe('Today at 4:05 PM');
  expect(discordTime(d, d + 86_400_000)).toBe('Yesterday at 4:05 PM');
  expect(discordTime(d, d + 5 * 86_400_000)).toBe('10/10/2026 4:05 PM');
  expect(cleanName('👋welcome')).toBe('welcome');
  expect(cleanName('🇨🇦 general ❤️')).toBe('general');
  expect(cleanName('🔥')).toBe('🔥'); // nothing left: keep it
});
