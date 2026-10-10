// shared/syntax.ts — language detection, token spans (incl. multi-line state), colorRanges offsets.
import { expect, it } from 'vitest';
import { colorRanges, highlight, languageFor, type Span, type TokenKind } from '../shared/syntax.ts';

const kinds = (line: string, spans: Span[]) => spans.map(([a, b, k]) => `${k}:${line.slice(a, b)}`);

it('detects languages from names and extensions', () => {
  expect(languageFor('widget.ts')?.id).toBe('ts');
  expect(languageFor('main.PY')?.id).toBe('py');
  expect(languageFor('Dockerfile')?.id).toBe('docker');
  expect(languageFor('config.yml')?.id).toBe('yaml');
  expect(languageFor('notes.txt')).toBeNull();
});

it('highlights TypeScript', () => {
  const line = "const n = 42; // the answer";
  expect(kinds(line, highlight(line, languageFor('a.ts'))[0])).toEqual(['keyword:const', 'number:42', 'comment:// the answer']);
  const l2 = "import { Foo } from 'bar'; f(x);";
  expect(kinds(l2, highlight(l2, languageFor('a.ts'))[0])).toEqual(['keyword:import', 'type:Foo', 'keyword:from', "string:'bar'", 'function:f']);
  // a block comment carries over to the next lines
  const src = 'a /* start\nstill comment\nend */ let b';
  const out = highlight(src, languageFor('a.ts'));
  expect(out[1]).toEqual([[0, 13, 'comment']]);
  expect(kinds('end */ let b', out[2])).toEqual(['comment:end */', 'keyword:let']);
});

it('highlights Python, JSON, YAML, Markdown', () => {
  const py = 'def f(x):\n    """doc\n    more"""\n    return None  # done';
  const p = highlight(py, languageFor('a.py'));
  expect(kinds('def f(x):', p[0])).toEqual(['keyword:def', 'function:f']);
  expect(p[2][0][2]).toBe('string'); // inside the triple-quoted string
  expect(kinds('    return None  # done', p[3])).toEqual(['keyword:return', 'constant:None', 'comment:# done']);

  const json = '{"name": "x", "n": 1.5, "ok": true}';
  expect(kinds(json, highlight(json, languageFor('a.json'))[0])).toEqual(['key:"name"', 'string:"x"', 'key:"n"', 'number:1.5', 'key:"ok"', 'constant:true']);

  const yaml = 'server:\n  port: 8080 # http\n  - item';
  const y = highlight(yaml, languageFor('a.yaml'));
  expect(kinds('server:', y[0])).toEqual(['key:server']);
  expect(kinds('  port: 8080 # http', y[1])).toEqual(['key:port', 'number:8080', 'comment:# http']);

  const md = '# Title\n- item with `code`\n```\nx = 1\n```';
  const m = highlight(md, languageFor('a.md'));
  expect(m[0]).toEqual([[0, 7, 'heading']]);
  expect(kinds('- item with `code`', m[1])).toEqual(['keyword:-', 'string:`code`']);
  expect(m[3]).toEqual([[0, 5, 'string']]); // inside the fence
});

it('maps spans of displayed lines to troika colorRanges, stopping before an ellipsis', () => {
  const colors = { keyword: 1, string: 2 } as Record<TokenKind, number>;
  const r = colorRanges([[[0, 5, 'keyword']], [[2, 9, 'string']]], [10, 6], colors, 0, [10, 5]);
  // line 2 starts at 11; its string is clipped at 5 (the 6th char is the ellipsis)
  expect(r).toEqual({ 0: 1, 5: 0, 13: 2, 16: 0 });
  expect(colorRanges([[]], [3], colors, 0)).toBeNull();
});
