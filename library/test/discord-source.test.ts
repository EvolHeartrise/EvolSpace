// discord source — READY parsing (user accounts), message normalization, nonces, super properties.
import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs source without types
import { CAPABILITIES, fromReady, makeNonce, plainContent, snowflakeTime, superProperties, toMsg } from '../sources/discord/discord.mjs';

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
  expect(r.dms).toEqual([
    { id: '101', name: 'Alice, bob', kind: 'group', last: '900' },
    { id: '100', name: 'Alice', kind: 'dm', last: '500' },
    { id: '102', name: 'Raid night', kind: 'group', last: null },
  ]);
  expect(r.guilds).toEqual([{ id: '1', name: 'Beat Lab', channels: [
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
  expect(m).toEqual({
    id: '1300000000000000000', author: { id: '11', name: 'Bobby' }, content: 'hey @Alice see #general :pog:', ts: Date.parse('2026-10-10T10:00:00.000Z'),
    edited: true, mine: true, attachments: [{ name: 'a.png', url: 'https://cdn/a.png', type: 'image/png' }], reply: { author: 'alice', content: 'ping' },
  });
  expect(plainContent('<t:1791600000:f>')).toMatch(/2026/);
});

it('nonces are snowflakes for now; identify properties look like one Chrome', () => {
  const now = Date.now();
  expect(Math.abs(snowflakeTime(makeNonce(now)) - now)).toBeLessThan(2);
  const p = superProperties(123);
  expect(p.client_build_number).toBe(123);
  expect(p.browser_user_agent).toContain(`Chrome/${p.browser_version}`);
  expect(CAPABILITIES & 256).toBe(0); // never ask for token refresh: we can't store a new token
});
