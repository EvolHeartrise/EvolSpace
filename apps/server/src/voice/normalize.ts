// Transcript normalization for fast-path matching.
//
// normalize(): the contract form (packages/protocol VoiceCommand docs) —
//   lowercase, punctuation stripped, whitespace collapsed. Apostrophes are
//   dropped inside words ("that's" → "thats"); hyphens and other punctuation
//   become spaces ("pass-through" → "pass through", "A.R." → "a r").
// canonical(): normalize() plus removal of conversational padding that never
//   changes the meaning of a short command: leading fillers / politeness /
//   addressing ("um", "okay", "please", "claude", "can you") and trailing
//   "please" / "thanks" / "now". The matcher tries normalize() first, then every
//   intermediate trimmed form (canonicalForms()), least trimmed first.

const APOSTROPHES = /['‘’ʼ`]/g;
/** Anything that is not a letter, digit or whitespace. */
const NON_WORD = /[^\p{L}\p{N}\s]+/gu;

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(NON_WORD, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Leading words/phrases stripped repeatedly ("okay um please undo" → "undo"). */
const LEADING = [
  'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'okay', 'ok', 'so', 'and', 'alright', 'all right',
  'hey', 'hi', 'yo', 'please', 'claude', 'clod', 'just', 'now', 'can you', 'could you', 'would you', 'will you',
  'i want to', 'i want you to', 'id like to', 'lets', 'let us',
];
const TRAILING = ['please', 'thanks', 'thank you', 'now', 'for me', 'right now', 'claude', 'um', 'uh'];

/**
 * Strip fillers one word/phrase at a time (leading first, then trailing).
 * Returns every intermediate form (least trimmed first; the plain form is NOT
 * included) and the fully trimmed result ('' when the text was only filler).
 */
function trimFillers(text: string): { forms: string[]; final: string } {
  let s = normalize(text);
  const forms: string[] = [];
  const step = (list: readonly string[], strip: (s: string, w: string) => string | null) => {
    for (let changed = true; changed && s;) {
      changed = false;
      for (const w of list) {
        if (s === w) { s = ''; return; }
        const next = strip(s, w);
        if (next !== null) { s = next; if (!forms.includes(s)) forms.push(s); changed = true; break; }
      }
    }
  };
  step(LEADING, (x, w) => (x.startsWith(w + ' ') ? x.slice(w.length + 1) : null));
  step(TRAILING, (x, w) => (x.endsWith(' ' + w) ? x.slice(0, -(w.length + 1)) : null));
  return { forms, final: s };
}

/**
 * Every intermediate filler-trimmed form of normalize(text), least trimmed first.
 * Trying each form (rather than only the fully trimmed one) keeps meaningful
 * words that also appear in the filler lists: "hide claude please" →
 * ["hide claude", "hide"], and "hide claude" is what matches.
 */
export function canonicalForms(text: string): string[] {
  return trimFillers(text).forms;
}

/** normalize() + full filler/politeness trimming. May return '' for pure filler ("um"). */
export function canonical(text: string): string {
  return trimFillers(text).final;
}

// ---------------------------------------------------------------- numbers

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * Parse a spoken or written number: "12", "-3.5", "twelve", "twenty one",
 * "one hundred", "minus four", "to"/"too" (common STT confusions for 2) .
 * Returns undefined if `s` is not a number.
 */
export function parseNumber(s: string): number | undefined {
  const raw = s.trim().toLowerCase();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return Number(raw);
  const t = raw.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  let words = t.split(' ');
  let sign = 1;
  if (words[0] === 'minus' || words[0] === 'negative') { sign = -1; words = words.slice(1); }
  if (words.length === 1 && (words[0] === 'to' || words[0] === 'too')) return sign * 2;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (w === 'and') continue;
    if (w in SMALL) { current += SMALL[w]; seen = true; }
    else if (w in TENS) { current += TENS[w]; seen = true; }
    else if (w === 'hundred') { current = (current || 1) * 100; seen = true; }
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; }
    else if (/^\d+$/.test(w)) { current += Number(w); seen = true; }
    else return undefined;
  }
  return seen ? sign * (total + current) : undefined;
}
