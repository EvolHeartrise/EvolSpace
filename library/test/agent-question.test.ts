// agent-question — Claude's AskUserQuestion card: parsing, answers map, tap/submit/terminal.
import { expect, it } from 'vitest';
import agentQuestion, { answersOf, parseQuestion } from '../widgets/agent-question/widget.ts';
import { mount } from './harness.ts';

const color = { question: 'Which color?', header: 'Color', options: [{ label: 'Cyan', description: 'current' }, { label: 'Purple', description: '' }], multiSelect: false };
const parts = { question: 'Which parts?', header: 'Parts', options: [{ label: 'HUD', description: '' }, { label: 'Trails', description: '' }, { label: 'Walls', description: '' }], multiSelect: true };

it('parses questions and builds the AskUserQuestion answers map', () => {
  const p = parseQuestion({ id: 'q1', questions: [color, parts], status: 'open', expiresAt: 5 })!;
  expect(p.questions.map((q) => q.multiSelect)).toEqual([false, true]);
  expect(parseQuestion({ questions: [] })).toBeNull();
  expect(answersOf(p.questions, [new Set([1]), new Set()])).toBeNull(); // every question needs an answer
  expect(answersOf(p.questions, [new Set([1]), new Set([2, 0])])).toEqual({ 'Which color?': 'Purple', 'Which parts?': 'HUD, Walls' });
});

it('one single-select question: the first tap answers', async () => {
  const h = await mount(agentQuestion, {});
  h.publish('agent.question', { id: 'q1', questions: [color], status: 'open', expiresAt: Date.now() + 60_000 });
  h.frame();
  expect(h.hasText('Claude asks')).toBe(true);
  expect(h.hasText('Which color?')).toBe(true);
  expect(h.hasText(/^terminal in [01]:\d\d$/)).toBe(true);
  h.press('opt:0:1', 'drag');
  expect(h.rec.published.at(-1)).toEqual({ channel: 'agent.answer', value: { id: 'q1', answers: { 'Which color?': 'Purple' } } });
  h.frame();
  expect(h.hasText('answer sent')).toBe(true);
  h.press('opt:0:0', 'drag'); // answered: further taps do nothing
  expect(h.rec.published.length).toBe(1);
  h.publish('agent.question', { id: 'q1', questions: [color], status: 'closed' });
  h.frame();
  expect(h.hasText('Claude asks')).toBe(false);
  expect(h.hasText('No question from Claude right now')).toBe(true);
  h.dispose();
  expect(h.rec.afterDispose).toEqual([]);
});

it('several / multi-select questions: pick, then Submit; or hand over to the terminal', async () => {
  const h = await mount(agentQuestion, {});
  h.publish('agent.question', { id: 'q2', questions: [color, parts], status: 'open' });
  h.frame();
  expect(h.hasText('Pick an option for each')).toBe(true);
  h.press('opt:0:0', 'drag');
  h.press('opt:1:1', 'drag');
  h.press('opt:1:2', 'drag');
  h.press('opt:1:1', 'drag'); // toggles off
  expect(h.rec.published).toEqual([]);
  h.frame();
  expect(h.hasText('Submit')).toBe(true);
  h.press('btn:submit', 'drag');
  expect(h.rec.published.at(-1)?.value).toEqual({ id: 'q2', answers: { 'Which color?': 'Cyan', 'Which parts?': 'Walls' } });

  h.publish('agent.question', { id: 'q3', questions: [color], status: 'open' });
  h.frame();
  h.press('btn:terminal', 'drag');
  expect(h.rec.published.at(-1)?.value).toEqual({ id: 'q3', terminal: true });
  expect(h.rec.errors).toEqual([]);
  h.dispose();
});
