// usage — usage bars, levels, reset countdowns.
import { expect, it } from 'vitest';
import usage, { formatDuration } from '../widgets/usage/widget.ts';
import { mount } from './harness.ts';

it('formats countdowns', () => {
  expect(formatDuration(45_000)).toBe('45s');
  expect(formatDuration(26 * 60_000)).toBe('26m');
  expect(formatDuration((60 + 26) * 60_000)).toBe('1h 26m');
  expect(formatDuration((6 * 24 + 17) * 3600_000)).toBe('6d 17h');
});

it('shows one bar per window with % and a reset countdown; waits politely without data', async () => {
  const h = await mount(usage, {});
  h.frame();
  expect(h.hasText('Waiting for usage data (claude-usage source)…')).toBe(true);
  h.publish('claude.usage', { windows: [], note: 'No usage yet.' });
  h.frame();
  expect(h.hasText('No usage yet.')).toBe(true);
  const now = Date.now();
  h.publish('claude.usage', {
    windows: [
      { key: 'five_hour', label: 'Current session · 5 h', pct: 87.4, resetsAt: now + (60 + 26) * 60_000 + 30_000 },
      { key: 'seven_day', label: 'Weekly · all models', pct: 2, resetsAt: now + 3 * 86400_000 },
    ],
    model: 'Opus', at: now,
  });
  h.frame();
  expect(h.hasText('Current session · 5 h')).toBe(true);
  expect(h.hasText('87%')).toBe(true);
  expect(h.hasText(/^Resets in 1h 2[67]m · /)).toBe(true);
  expect(h.hasText('Weekly · all models')).toBe(true);
  expect(h.hasText('2%')).toBe(true);
  expect(h.hasText(/^updated (now|\d+ s ago) · from Claude Code's status line$/)).toBe(true);
  h.publish('claude.usage', { nope: 1 } as never);
  expect(h.rec.errors.length).toBe(1);
  expect(h.hasText('87%')).toBe(true); // keeps the last good state
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
