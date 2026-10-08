// Text sanitization: nothing outside the bundled fonts' coverage may reach
// troika (it would fetch fallback fonts from a CDN, and hang offline).

import { describe, expect, it } from 'vitest';
import { Text } from 'troika-three-text';
import { glyphSetOfFont, hasGlyph, sanitizeText } from '../src/ui/glyphs.ts';
import { RuntimeUiKit } from '../src/ui/UiKit.ts';
import { stubTextFactory } from '../src/ui/stubText.ts';
import { createTheme } from '../src/theme.ts';
import { fontUrl } from '../src/ui/fonts.ts';
import type { TextLike } from '../src/ui/UiKit.ts';

const allCovered = (s: string, set: 'sans' | 'mono') => [...s].every((c) => c === '\n' || hasGlyph(set, c.codePointAt(0)!));

describe('sanitizeText', () => {
  it('passes printable ASCII through untouched and covers it in both fonts', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
    expect(sanitizeText(ascii)).toBe(ascii);
    expect(allCovered(ascii, 'sans')).toBe(true);
    expect(allCovered(ascii, 'mono')).toBe(true);
    expect(sanitizeText('a\nb')).toBe('a\nb');
  });

  it('keeps covered non-ASCII (typography the system UI uses)', () => {
    const s = 'Claude · idle — “quoted” → ok… ×3 ↓ ✓ ⚠';
    expect(sanitizeText(s)).toBe(s);
  });

  it('maps emoji to look-alikes or □, and drops invisible joiners/selectors', () => {
    expect(sanitizeText('done ✅')).toBe('done ✓');
    expect(sanitizeText('⚠️ careful')).toBe('⚠ careful'); // VS16 dropped
    expect(sanitizeText('fail ❌')).toBe('fail ×');
    const out = sanitizeText('hi 😀 👨‍👩‍👧 漢');
    expect(out).toBe('hi □ □□□ □');
    expect(allCovered(out, 'sans')).toBe(true);
  });

  it('normalizes control characters and leading newlines', () => {
    expect(sanitizeText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitizeText('a\tb')).toBe('a  b');
    expect(sanitizeText('x\u0007y')).toBe('xy');
    expect(sanitizeText('\nfirst')).toBe(' \nfirst');
    expect(sanitizeText('\n✓')).toBe(' \n✓');
  });

  it('uses the coverage of the requested font family', () => {
    // Box drawing exists in JetBrains Mono but not in Inter.
    expect(sanitizeText('├─', 'mono')).toBe('├─');
    expect(sanitizeText('├─', 'sans')).toBe('□□');
  });

  it('recognizes bundled font URLs', () => {
    expect(glyphSetOfFont(fontUrl('mono'))).toBe('mono');
    expect(glyphSetOfFont(fontUrl('sansSemiBold'))).toBe('sans');
    expect(glyphSetOfFont(null)).toBe('sans');
    expect(glyphSetOfFont('https://example.com/Other.woff')).toBeNull();
  });
});

describe('UiKit text sanitization', () => {
  const kit = () => new RuntimeUiKit(createTheme(), { textFactory: stubTextFactory });

  it('sanitizes initial content, set(), and direct .text assignment', () => {
    const k = kit();
    const t = k.text('ok ✅');
    expect(t.text).toBe('ok ✓');
    t.set('🚀 go');
    expect(t.text).toBe('→ go');
    t.text = 'raw 😀';
    expect(t.text).toBe('raw □');
    // set() with the same raw string after a direct assignment still applies.
    t.set('🚀 go');
    expect(t.text).toBe('→ go');
  });

  it('mono texts keep box-drawing characters', () => {
    const t = kit().text('└─ x', { font: 'mono' });
    expect(t.text).toBe('└─ x');
  });

  it('wraps troika Text (prototype accessor) as well', () => {
    const k = new RuntimeUiKit(createTheme(), { textFactory: () => new Text() as unknown as TextLike });
    const t = k.text('a ✅');
    expect(t.text).toBe('a ✓');
    t.text = '😀';
    expect(t.text).toBe('□');
    // Other instances / the prototype are unaffected.
    const plain = new Text();
    plain.text = '😀';
    expect(plain.text).toBe('😀');
  });

  it('does not sync texts that were disposed before the flush', () => {
    const k = kit();
    const t = k.text('x') as unknown as { syncCount: number; dispose(): void };
    t.dispose();
    k.flush();
    expect(t.syncCount).toBe(0);
  });
});
