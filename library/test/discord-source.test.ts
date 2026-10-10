// discord source — READY parsing (user accounts), message normalization, nonces, super properties.
import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs source without types
import { attachmentRef, avatarRef, CAPABILITIES, fromReady, makeNonce, plainContent, snowflakeTime, superProperties, toMsg } from '../sources/discord/discord.mjs';

it('reads a deduped user READY: DMs from recipient_ids + users, guilds with categories, unavailable guilds skipped', () => {
  const r = fromReady({
    users: [{ id: '10', username: 'alice', global_name: 'Alice' }, { id: '11', username: 'bob' }],
    private_channels: [
      { id: '100', type: 1, recipient_ids: ['10'], last_message_id: '500' },
      { id: '101', type: 3, recipient_ids: ['10', '11'], last_message_id: '900' },
      { id: '102', type: 3, name: 'Raid night', recipient_ids: ['11'], last_message_id: null },
    ],
    guilds: [
      { id: '1', properties: { name: 'Beat Lab' }, channels: [
        { id: '20', type: 4, name: 'Text', position: 0 },
        { id: '21', type: 0, name: 'general', parent_id: '20', position: 1 },
        { id: '22', type: 2, name: 'Voice', parent_id: '20', position: 2 },
        { id: '23', type: 5, name: 'news', position: 0 },
      ] },
      { id: '2', unavailable: true },
    ],
  });
  expect(r.dms).toMatchObject([
    { id: '101', name: 'Alice, bob', kind: 'group', last: '900' },
    { id: '100', name: 'Alice', kind: 'dm', last: '500' },
    { id: '102', name: 'Raid night', kind: 'group', last: null },
  ]);
  expect(r.guilds).toMatchObject([{ id: '1', name: 'Beat Lab', channels: [
    { id: '23', name: 'news', kind: 'announcement' },
    { id: '21', name: 'general', kind: 'text', category: 'Text' },
  ] }]);
  expect(r.channelNames.get('21')).toBe('general');
});

it('normalizes messages: nick > global name > username, mentions, replies, attachments, own messages', () => {
  const m = toMsg({
    id: '1300000000000000000', type: 19, content: 'hey <@10> see <#21> <:pog:123>', timestamp: '2026-10-10T10:00:00.000Z', edited_timestamp: '2026-10-10T10:01:00.000Z',
    author: { id: '11', username: 'bob' }, member: { nick: 'Bobby' },
    mentions: [{ id: '10', username: 'alice', global_name: 'Alice' }],
    attachments: [{ filename: 'a.png', url: 'https://cdn/a.png', content_type: 'image/png' }],
    referenced_message: { author: { id: '10', username: 'alice' }, content: 'ping' },
  }, { selfId: '11', channelNames: new Map([['21', 'general']]) });
  expect(m).toMatchObject({
    id: '1300000000000000000', author: { id: '11', name: 'Bobby' }, content: 'hey @Alice see #general :pog:', ts: Date.parse('2026-10-10T10:00:00.000Z'),
    edited: true, mine: true, attachments: [{ name: 'a.png', url: 'https://cdn/a.png', type: 'image/png' }], reply: { author: 'alice', content: 'ping' },
  });
  expect(plainContent('<t:1791600000:f>')).toMatch(/2026/);
});

it('media refs: avatars (custom / default), image thumbnails through the media proxy', () => {
  expect(avatarRef({ id: '84607994645450752', avatar: 'abc' })).toEqual({ url: 'https://cdn.discordapp.com/avatars/84607994645450752/abc.png?size=64', name: 'discord-a-84607994645450752-abc.png' });
  expect(avatarRef({ id: '84607994645450752', avatar: null, discriminator: '0' })?.name).toMatch(/^discord-d-[0-5]\.png$/);
  expect(avatarRef({ id: '1', discriminator: '1337' })?.name).toBe('discord-d-2.png');
  const ref = attachmentRef({ id: '9', content_type: 'image/png', width: 1600, height: 900, proxy_url: 'https://media.discordapp.net/a.png?ex=1' });
  expect(ref).toEqual({ url: 'https://media.discordapp.net/a.png?ex=1&width=400&height=225&format=png', name: 'discord-i-9.png', w: 400, h: 225 });
  expect(attachmentRef({ id: '9', content_type: 'text/plain', proxy_url: 'x' })).toBeNull();
  const refs: unknown[] = [];
  const m = toMsg({ id: '5', content: '', author: { id: '11', username: 'bob', avatar: 'h' }, attachments: [{ id: '9', filename: 'a.png', url: 'u', content_type: 'image/png', width: 100, height: 50, proxy_url: 'p' }] }, { refs, channelNames: new Map() });
  expect(m.author.avatar).toBe('/media/discord-a-11-h.png');
  expect(m.attachments[0].image).toEqual({ src: '/media/discord-i-9.png', w: 100, h: 50 });
  expect(refs).toHaveLength(2); // queued for download before the channel is published
});

it('nonces are snowflakes for now; identify properties look like one Chrome', () => {
  const now = Date.now();
  expect(Math.abs(snowflakeTime(makeNonce(now)) - now)).toBeLessThan(2);
  const p = superProperties(123);
  expect(p.client_build_number).toBe(123);
  expect(p.browser_user_agent).toContain(`Chrome/${p.browser_version}`);
  expect(CAPABILITIES & 256).toBe(0); // never ask for token refresh: we can't store a new token
});

it('unread state: permissions hide channels, read markers + mention counts, mutes', async () => {
  // @ts-expect-error plain .mjs source without types
  const { canView, readStates, mutedIds, isUnread } = await import('../sources/discord/discord.mjs');
  const VIEW = String(1 << 10);
  const guild = { id: 'g', owner_id: 'o', roles: [{ id: 'g', permissions: VIEW }, { id: 'mod', permissions: '0' }] };
  const me = { roles: ['mod'] };
  expect(canView(guild, { permission_overwrites: [] }, me, 'u')).toBe(true);
  const staff = { permission_overwrites: [{ id: 'g', type: 0, allow: '0', deny: VIEW }] };
  expect(canView(guild, staff, me, 'u')).toBe(false);
  expect(canView(guild, { permission_overwrites: [...staff.permission_overwrites, { id: 'mod', type: 0, allow: VIEW, deny: '0' }] }, me, 'u')).toBe(true);
  expect(canView(guild, { permission_overwrites: [...staff.permission_overwrites, { id: 'u', type: 1, allow: VIEW, deny: '0' }] }, me, 'u')).toBe(true);
  expect(canView(guild, staff, me, 'o')).toBe(true); // owner
  expect(canView(guild, staff, null, 'u')).toBe(true); // unknown member: shown

  const rs = readStates({ entries: [{ id: '1', last_message_id: '100', mention_count: 0 }, { id: '2', last_message_id: '50', mention_count: 3 }, { id: '9', read_state_type: 1 }] });
  expect(isUnread('100', rs.get('1'))).toBe(false);
  expect(isUnread('101', rs.get('1'))).toBe(true);
  expect(isUnread('50', rs.get('2'))).toBe(true); // mentions
  expect(isUnread('5', undefined)).toBe(false); // never read: not flagged
  expect(rs.has('9')).toBe(false);

  const m = mutedIds({ entries: [{ guild_id: 'g', muted: true }, { guild_id: 'h', muted: true, mute_config: { end_time: '2000-01-01T00:00:00Z' } }, { guild_id: null, channel_overrides: [{ channel_id: 'c', muted: true }] }] });
  expect([...m.guilds]).toEqual(['g']);
  expect([...m.channels]).toEqual(['c']);
});
