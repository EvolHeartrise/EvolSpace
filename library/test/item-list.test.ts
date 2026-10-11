// item-list — rows, status tabs with counts, filtering, selection, drag scrolling.
import { expect, it } from 'vitest';
import itemList from '../widgets/item-list/widget.ts';
import { mount } from './harness.ts';

const items = Array.from({ length: 14 }, (_, i) => ({
  id: `#${100 - i}`, title: `Item ${i}`, status: i < 3 ? 'open' : 'merged', meta: `meta ${i}`, labels: i === 0 ? [{ name: 'bug' }] : [],
}));

it('shows rows, tabs with counts, filters by tab and selects a row', async () => {
  const h = await mount(itemList, { channel: 'gh.prs', rows: 5 });
  h.publish('gh.prs', { title: 'Repo · Pull requests', updatedAt: new Date().toISOString(), items });
  h.frame(3);
  expect(h.hasText('Repo · Pull requests')).toBe(true);
  expect(h.hasText('#100  Item 0')).toBe(true);
  expect(h.hasText('OPEN · meta 0 · bug')).toBe(true);
  expect(h.hasText('All  14')).toBe(true);
  expect(h.hasText('Open  3')).toBe(true);
  expect(h.hasText('Merged  11')).toBe(true);
  expect(h.hasText('#95  Item 5')).toBe(false); // only 5 rows visible

  h.press('tab:2', 'drag'); // Merged
  h.frame(3);
  expect(h.rec.setProps.at(-1)).toEqual({ filter: 'merged' });
  expect(h.hasText('#97  Item 3')).toBe(true);
  expect(h.hasText('#100  Item 0')).toBe(false);
  expect(h.hasText('11 of 14 · updated now')).toBe(true); // count shows the filtered size

  h.press('row:1', 'drag');
  expect(h.emitsOn('select').at(-1)).toMatchObject({ id: '#96', title: 'Item 4', status: 'merged' });
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('pinch-dragging the rows scrolls; bad data reports an error and keeps the list', async () => {
  const h = await mount(itemList, { rows: 4 });
  h.input('items', items);
  h.frame(3);
  expect(h.hasText('#100  Item 0')).toBe(true);
  h.drag('row:2', [0, 0.5, 0]); // drag up → later items (clamped at the end)
  h.frame(3);
  expect(h.hasText('#100  Item 0')).toBe(false);
  expect(h.emitsOn('select')).toEqual([]); // a scroll is not a selection
  h.input('items', 42);
  h.frame(3);
  expect(h.rec.errors.length).toBe(1);
  expect(h.hasText('#90  Item 10')).toBe(true);
  h.dispose();
});
