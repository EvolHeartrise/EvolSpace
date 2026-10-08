// agent-question — Claude's AskUserQuestion, answerable in XR. The PreToolUse hook
// (scripts/hooks/ask-question.mjs) publishes the pending question on `agent.question` and spawns
// this card in front of the user; tapping options publishes the answer on `agent.answer`, which
// the hook hands back to Claude Code. "Answer in terminal" releases the question to the CLI dialog.
//
//   agent.question = {id, questions: [{question, header, options: [{label, description}], multiSelect}],
//                     status: 'open' | 'closed', expiresAt (ms), reason?}
//   agent.answer   = {id, answers: {"<question text>": "label" | "label a, label b"}} | {id, terminal: true}
//
// One single-select question sends on the first tap; otherwise pick per question, then Submit.

import type { ChannelValue, InteractionEvent, WidgetDefinition } from '@evolspace/protocol';
import type * as THREE from 'three';
import { disposeTree, sharedGeometry, ownMaterial } from '../../shared/resources.ts';
import { makeText, textSize, type Text } from '../../shared/text.ts';
import { resolveColor } from '../../shared/color.ts';
import { truncate } from '../../shared/format.ts';
import { dragBinding } from '../../shared/handle.ts';
import { ChannelProp } from '../../shared/binding.ts';
import { STYLE } from '../../shared/style.ts';

interface Props extends Record<string, unknown> {
  channel: string;
  answerChannel: string;
  width: number;
}

interface Question { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
interface Pending { id: string; questions: Question[]; status: string; expiresAt: number | null; reason: string }

const PAD = 0.018;

export function parseQuestion(v: unknown): Pending | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !Array.isArray(o.questions)) return null;
  const questions: Question[] = [];
  for (const q of o.questions) {
    if (!q || typeof q !== 'object') continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string' || !Array.isArray(r.options)) continue;
    const options = r.options.flatMap((x) => {
      const p = x as Record<string, unknown>;
      return p && typeof p.label === 'string' ? [{ label: p.label, description: typeof p.description === 'string' ? p.description : '' }] : [];
    });
    questions.push({ question: r.question, header: typeof r.header === 'string' ? r.header : '', options, multiSelect: r.multiSelect === true });
  }
  return {
    id: o.id, questions, status: typeof o.status === 'string' ? o.status : 'open',
    expiresAt: Number.isFinite(o.expiresAt) ? Number(o.expiresAt) : null, reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

/** The answers map AskUserQuestion expects: question text → label (multi: labels joined with ", "). */
export function answersOf(qs: Question[], picked: Array<Set<number>>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    const sel = [...(picked[i] ?? [])].sort((a, b) => a - b);
    if (!sel.length) return null;
    out[qs[i].question] = sel.map((k) => qs[i].options[k].label).join(', ');
  }
  return out;
}

const definition: WidgetDefinition<Props> = {
  description:
    "Claude's pending AskUserQuestion as a tappable card (spawned by the ask-question hook): questions with option buttons, Submit for " +
    "multi-select / several questions, 'Answer in terminal', fallback countdown. Reads agent.question, publishes agent.answer.",
  version: '1.0.0',
  props: {
    channel: { type: 'channel', default: 'agent.question', description: 'Pending question channel.' },
    answerChannel: { type: 'string', default: 'agent.answer', description: 'Channel the answer is published on.' },
    width: { type: 'number', default: 0.5, min: 0.3, max: 1.5, step: 0.01, description: 'Card width (m).' },
  },
  inputs: {},
  outputs: {},
  interactions: [dragBinding('agent-question-press', 'drag')],
  size: [0.5, 0.35, 0.01],
  create(ctx) {
    const T = ctx.THREE;
    const theme = ctx.theme;
    let group: THREE.Group | null = null;
    let pending: Pending | null = null;
    let picked: Array<Set<number>> = [];
    let sent = '';
    let countdown: Text | null = null;
    let timer = 0;
    let press: { hand: string; part: string } | null = null;

    const W = () => ctx.props.width;
    const single = () => !!pending && pending.questions.length === 1 && !pending.questions[0].multiSelect;

    function button(g: THREE.Group, name: string, w: number, h: number, x: number, y: number, color: string, label: string, sub = '', labelColor = theme.text) {
      const b = ctx.ui.panel(w, h, { color });
      b.position.set(x + w / 2, y - h / 2, STYLE.zContent);
      b.name = name;
      ctx.interactive(b);
      const t = makeText(ctx, label, { size: 0.0135, anchorX: 'left', anchorY: sub ? 'top' : 'middle', color: labelColor, weight: 'semibold', maxWidth: w - 0.02, whiteSpace: 'nowrap' });
      t.position.set(-w / 2 + 0.01, sub ? h / 2 - 0.007 : 0, STYLE.zText);
      b.add(t);
      if (sub) {
        const s = makeText(ctx, sub, { size: 0.0105, anchorX: 'left', anchorY: 'top', color: labelColor === theme.text ? theme.textDim : labelColor, maxWidth: w - 0.02, whiteSpace: 'nowrap' });
        s.position.set(-w / 2 + 0.01, h / 2 - 0.026, STYLE.zText);
        b.add(s);
      }
      g.add(b);
    }

    function build(): void {
      if (group) disposeTree(group);
      group = null;
      countdown = null;
      if (!pending || pending.status !== 'open') {
        // normally removed by the hook when the question closes; a stray card says so
        const g = (group = new T.Group());
        g.add(ctx.ui.panel(W(), 0.05, {}));
        const t = makeText(ctx, 'No question from Claude right now', { size: 0.013, anchorX: 'center', anchorY: 'middle', color: theme.textDim });
        t.position.z = STYLE.zText;
        g.add(t);
        ctx.root.add(g);
        return;
      }
      const g = (group = new T.Group());
      const x0 = -W() / 2 + PAD, cw = W() - 2 * PAD;
      const accent = resolveColor(theme, 'accent');
      const parts: Array<(y: number) => number> = [];
      const add = (f: (y: number) => number) => parts.push(f);

      add((y) => {
        const t = makeText(ctx, 'Claude asks', { size: 0.02, anchorX: 'left', anchorY: 'top', color: theme.text, weight: 'semibold' });
        t.position.set(x0, y, STYLE.zText);
        g.add(t);
        countdown = makeText(ctx, '', { size: 0.0105, anchorX: 'right', anchorY: 'top', color: theme.textDim });
        countdown.position.set(x0 + cw, y - 0.004, STYLE.zText);
        g.add(countdown);
        return y - 0.034;
      });
      pending.questions.forEach((q, qi) => {
        add((y) => {
          if (q.header) {
            const ht = makeText(ctx, q.header.toUpperCase(), { size: 0.0095, anchorX: 'left', anchorY: 'top', color: accent, weight: 'semibold' });
            ht.position.set(x0, y, STYLE.zText);
            g.add(ht);
            y -= 0.017;
          }
          const qt = makeText(ctx, q.question, { size: 0.0145, anchorX: 'left', anchorY: 'top', color: theme.text, maxWidth: cw });
          qt.position.set(x0, y, STYLE.zText);
          g.add(qt);
          y -= textSize(qt, { text: q.question, size: 0.0145, maxWidth: cw }).height + 0.01;
          if (q.multiSelect) {
            const hint = makeText(ctx, 'Pick any', { size: 0.0095, anchorX: 'left', anchorY: 'top', color: theme.textDim });
            hint.position.set(x0, y + 0.004, STYLE.zText);
            g.add(hint);
            y -= 0.012;
          }
          q.options.forEach((o, oi) => {
            const on = picked[qi]?.has(oi) ?? false;
            const h = o.description ? 0.044 : 0.03;
            const chars = Math.floor((cw - 0.02) / (0.0105 * 0.5));
            button(g, `opt:${qi}:${oi}`, cw, h, x0, y, on ? accent : theme.surface, `${q.multiSelect ? (on ? '[x] ' : '[ ] ') : ''}${o.label}`,
              truncate(o.description, chars), on ? theme.background : theme.text);
            y -= h + 0.007;
          });
          return y - 0.008;
        });
      });
      add((y) => {
        const bh = 0.03, gap = 0.008;
        const ready = !!answersOf(pending!.questions, picked);
        const tw = single() ? cw : (cw - gap) / 2;
        button(g, 'btn:terminal', tw, bh, x0, y, theme.surface, 'Answer in terminal', '', theme.textDim);
        if (!single()) button(g, 'btn:submit', tw, bh, x0 + tw + gap, y, ready ? resolveColor(theme, 'positive') : theme.surface, ready ? 'Submit' : 'Pick an option for each', '', ready ? theme.background : theme.textDim);
        return y - bh;
      });

      // lay out top-down from 0, then center the card on the content
      let y = 0;
      for (const f of parts) y = f(y);
      const h = -y + 2 * PAD;
      for (const c of g.children) c.position.y += h / 2 - PAD;
      const card = ctx.ui.panel(W(), h, {});
      card.position.z = 0;
      g.add(card);
      // an accent edge marks it as a request from Claude
      const edge = new T.Mesh(sharedGeometry(T, 'plane'), ownMaterial(T, accent));
      edge.scale.set(W() - 0.02, 0.003, 1);
      edge.position.set(0, h / 2 - 0.0015, STYLE.zContent);
      edge.raycast = () => {};
      g.add(edge);
      ctx.root.add(g);
      renderCountdown();
    }

    function renderCountdown(): void {
      if (!countdown || !pending) return;
      if (sent) { countdown.set(sent); return; }
      if (!pending.expiresAt) { countdown.set(''); return; }
      const s = Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000));
      countdown.set(`terminal in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }

    function send(value: Record<string, unknown>): void {
      if (!pending || sent) return;
      ctx.channels.publish(ctx.props.answerChannel, { id: pending.id, ...value } as never);
      sent = value.terminal ? 'over to the terminal' : 'answer sent';
      ctx.event('agent-question.answer', { id: pending.id, ...value });
      renderCountdown();
    }

    function click(part: string): void {
      if (!pending || sent) return;
      if (part === 'btn:terminal') { send({ terminal: true }); return; }
      if (part === 'btn:submit') {
        const a = answersOf(pending.questions, picked);
        if (a) send({ answers: a });
        return;
      }
      const m = /^opt:(\d+):(\d+)$/.exec(part);
      if (!m) return;
      const qi = Number(m[1]), oi = Number(m[2]);
      const q = pending.questions[qi];
      if (!q) return;
      const set = (picked[qi] ??= new Set());
      if (q.multiSelect) { if (set.has(oi)) set.delete(oi); else set.add(oi); }
      else { set.clear(); set.add(oi); }
      if (single()) { send({ answers: answersOf(pending.questions, picked)! }); }
      build();
    }

    function setQuestion(v: ChannelValue): void {
      const p = parseQuestion(v);
      if (!p) { ctx.error('agent-question: expected {id, questions: [...]}'); return; }
      if (!pending || p.id !== pending.id) { picked = p.questions.map(() => new Set<number>()); sent = ''; }
      pending = p;
      build();
    }

    build();
    const channel = new ChannelProp(ctx, setQuestion);

    return {
      onProps(p, prev) {
        if (p.channel !== prev.channel) channel.refresh();
        if (p.width !== prev.width) build();
      },
      onInteraction(e: InteractionEvent) {
        if (e.handler === 'hover') return;
        const part = e.objectName ?? '';
        if (e.phase === 'start') {
          if (!press && (part.startsWith('opt:') || part.startsWith('btn:'))) press = { hand: e.hand, part };
          return;
        }
        if (!press || e.hand !== press.hand || e.phase === 'move') return;
        const p = press;
        press = null;
        if (e.phase === 'end') click(p.part);
      },
      update(dt) {
        timer += dt;
        if (timer < 0.5) return;
        timer = 0;
        renderCountdown();
      },
      dispose() {
        channel.dispose();
        if (group) disposeTree(group);
      },
    };
  },
};

export default definition;
