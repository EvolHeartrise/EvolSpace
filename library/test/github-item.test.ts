// github-item — the GitHub detail card (+ the github source's markdown → panel markup).
import { expect, it } from 'vitest';
import githubItem, { itemNumber } from '../widgets/github-item/widget.ts';
// @ts-expect-error plain JS module (the source driver)
import { toMarkup } from '../sources/github/github.mjs';
import { mount } from './harness.ts';

const detail = (n: number, kind: 'issue' | 'pr', body: string) => ({
  kind, number: n, title: `Title ${n}`, status: kind === 'pr' ? 'merged' : 'open', color: '#3fb950', author: 'me',
  created: 'Oct 1, 2026', updated: '2d ago', closed: 'Oct 2, 2026', labels: ['model'], url: `https://x/${n}`,
  facts: kind === 'pr' ? ['`feat/x` → `main`', '+10 −2 in 3 files'] : [], body,
  comments: [{ author: 'you', at: 'Oct 3, 2026', body: 'Looks good.' }],
});

it('itemNumber accepts item-list rows, strings, numbers and URLs', () => {
  expect(itemNumber({ id: '#61', title: 'x' })).toBe(61);
  expect(itemNumber('issue 11')).toBe(11);
  expect(itemNumber('PR #62')).toBe(62);
  expect(itemNumber(7)).toBe(7);
  expect(itemNumber('https://github.com/a/b/pull/70')).toBe(70);
  expect(itemNumber('nope')).toBeNaN();
});

it('converts GitHub markdown to panel markup', () => {
  const md = '## Context\r\nWe *are* adding **passive** [docs](http://x) _here_\n* item\n  * sub\n> quote\n***\n```rust\nlet x = 1;\n```\n🤖 Generated with [Claude Code](https://c)';
  expect(toMarkup(md)).toBe('# Context\nWe are adding **passive** docs here\n- item\n  - sub\nquote\n---\n```\nlet x = 1;\n```\nGenerated with Claude Code');
});

it('shows an item from the details channel, follows the item input, scrolls long text', async () => {
  const h = await mount(githubItem, { number: 11, height: 0.4 });
  h.frame();
  expect(h.hasText('Waiting for GitHub data (github source)…')).toBe(true);
  const long = Array.from({ length: 60 }, (_, i) => `- point ${i}`).join('\n');
  h.publish('github.bsrl.details', { items: { 11: detail(11, 'issue', '# Idea\nShort.'), 62: detail(62, 'pr', long) } });
  h.frame();
  expect(h.hasText('Title 11')).toBe(true);
  expect(h.hasText('Issue #11')).toBe(true);
  expect(h.hasText('OPEN')).toBe(true);
  expect(h.hasText('you commented · Oct 3, 2026')).toBe(true);
  const thumb = () => h.root.getObjectByName('scrollbar')!;
  expect(thumb()).toBeTruthy();

  h.input('item', { id: '#62', title: 'Title 62' }); // an item-list select
  h.frame();
  expect(h.rec.setProps.at(-1)).toEqual({ number: 62 });
  expect(h.hasText('Pull request #62')).toBe(true);
  expect(h.hasText('feat/x → main · +10 −2 in 3 files')).toBe(true);
  expect(h.hasText(/^point 0$/)).toBe(true);
  expect(h.hasText(/^point 59$/)).toBe(false); // below the viewport
  expect(h.root.getObjectByName('btn:next')).toBeUndefined(); // no paging any more

  h.drag('body', [0, 0.25, 0]); // pinch-drag the text up → later content
  h.frame();
  expect(h.hasText(/^point 0$/)).toBe(false);
  expect(h.hasText(/^point 2\d$/)).toBe(true);

  h.drag('scrollbar', [0, -1, 0], { from: [0.25, 0, 0] }); // thumb to the bottom
  h.frame();
  expect(h.hasText(/^point 59$/)).toBe(true);
  expect(h.hasText('you commented · Oct 3, 2026')).toBe(true);
  expect(h.rec.errors).toEqual([]);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});
