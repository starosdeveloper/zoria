import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from '../src/markdown/parse.ts';

describe('markdown subset (spec §5.6, CL-30)', () => {
  it('parses headings, lists, paragraphs, code blocks', () => {
    const blocks = parseMarkdown('# Заголовок\n\nПервая строка\nвторая\n\n- один\n- два\n\n1. раз\n2. два\n\n```\n<b>код</b>\n```\n#### h4');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'codeblock', 'heading']);
    expect(blocks[4]).toEqual({ type: 'codeblock', text: '<b>код</b>' });
    expect(blocks[3]).toMatchObject({ ordered: true });
  });

  it('keeps ##### and deeper as plain paragraph text', () => {
    expect(parseMarkdown('##### deep')[0]?.type).toBe('paragraph');
  });

  it('inline bold, code, links', () => {
    expect(parseInline('**жирный** и `код` и [ссылка](https://zoria.net/x)')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'жирный' }] },
      { type: 'text', text: ' и ' },
      { type: 'code', text: 'код' },
      { type: 'text', text: ' и ' },
      { type: 'link', href: 'https://zoria.net/x', children: [{ type: 'text', text: 'ссылка' }] },
    ]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>', '/relative', 'ftp://x.y', 'JaVaScRiPt:alert(1)'])(
    'does not turn %s into a link',
    (href) => {
      expect(safeHref(href)).toBeNull();
      const nodes = parseInline(`[x](${href})`);
      expect(nodes.every((n) => n.type !== 'link')).toBe(true);
    },
  );

  it('raw HTML stays literal text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });

  it('unterminated markers are text', () => {
    expect(parseInline('**open `tick [x](')).toEqual([{ type: 'text', text: '**open `tick [x](' }]);
  });
});
