// discord — picker (DMs / servers → channels), live messages with author grouping, scrolling, open lease.
import * as THREE from 'three';
import { expect, it } from 'vitest';
import discord, { messageBody } from '../widgets/discord/widget.ts';
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
  dms: [{ id: '111111', name: 'alice', kind: 'dm' }, { id: '222222', name: 'bob, carol', kind: 'group' }],
  guilds: [{ id: '900000', name: 'Beat Lab', channels: [{ id: '333333', name: 'general', kind: 'text', category: 'Text' }] }],
};
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: String(1000 + i), author: { id: i % 4 < 2 ? 'a' : 'b', name: i % 4 < 2 ? 'alice' : 'evol' }, content: `message ${i}`, ts: now - (n - i) * 1000, mine: i % 4 >= 2,
}));

it('picks a DM through the picker, subscribes and leases the channel', async () => {
  const h = await mount(discord, {});
  h.publish('discord.status', { state: 'ready', user: { id: 'b', name: 'evol' } });
  h.publish('discord.channels', channels);
  h.frame();
  expect(h.hasText('Direct messages')).toBe(true);
  expect(h.hasText('Beat Lab')).toBe(true);
  expect(h.hasText('Signed in as evol')).toBe(true);

  // A ray from the user at the first row reaches the row, not the message-area hit box in front of it.
  expect(nearestHit(h.root, 'pick:0')).toBe('pick:0');
  h.press('pick:0', 'drag'); // Direct messages
  h.frame();
  expect(h.hasText('alice')).toBe(true);
  expect(h.hasText('bob, carol')).toBe(true);
  h.press('pick:0', 'drag'); // alice
  expect(h.rec.setProps.at(-1)).toEqual({ channelId: '111111' });
  expect(h.rec.published.at(-1)).toEqual({ channel: 'discord.request', value: { cmd: 'open', channel: '111111' } });

  h.publish('discord.ch.111111', { id: '111111', name: 'alice', kind: 'dm', messages: msgs(6) });
  h.frame();
  expect(h.hasText('message 5')).toBe(true);
  expect(h.hasText(/^alice {2}\d\d:\d\d$/)).toBe(true); // author line, grouped (one per run of messages)
  expect(h.hasText('Direct message')).toBe(true);

  h.press('back');
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ channelId: '' });
  expect(h.hasText('bob, carol')).toBe(true); // back to the DM list it came from
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('shows the newest messages at the bottom and scrolls back by dragging down', async () => {
  const h = await mount(discord, { channelId: '333333', lines: 8 });
  h.publish('discord.ch.333333', { id: '333333', name: 'general', kind: 'text', guild: 'Beat Lab', messages: msgs(40) });
  h.frame();
  expect(h.hasText('message 39')).toBe(true);
  expect(h.hasText('message 10')).toBe(false);
  h.drag('body', [0, -0.15, 0]);
  h.frame();
  expect(h.hasText('message 39')).toBe(false);
  expect(h.hasText(/newer below/)).toBe(true);
  h.dispose();
});

it('explains a missing source, and renders attachments / replies / embeds', async () => {
  const h = await mount(discord, { channelId: '333333' });
  h.frame();
  expect(h.hasText(/DISCORD_USER_TOKEN/)).toBe(true);
  h.dispose();
  expect(messageBody({ id: '1', author: { id: 'a', name: 'a' }, content: 'look', ts: 0, attachments: [{ name: 'cat.png' }], reply: { author: 'bob', content: 'hi' }, embeds: [{ title: 'T', description: 'D' }], edited: true }, 500))
    .toBe('> bob: hi\nlook\n[file] cat.png\n| T — D (edited)');
});
