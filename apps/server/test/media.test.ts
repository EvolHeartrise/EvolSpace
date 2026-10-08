// GET /media/:file range parsing (the route itself is exercised against the live dev server).
import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/routes/media.ts';

describe('parseRange', () => {
  it('handles whole-file, open, closed and suffix ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 });
  });
  it('rejects unsatisfiable or malformed ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('bad');
    expect(parseRange('bytes=20-10', 100)).toBe('bad');
    expect(parseRange('bytes=-', 100)).toBe('bad');
    expect(parseRange('items=0-1', 100)).toBe('bad');
  });
});
