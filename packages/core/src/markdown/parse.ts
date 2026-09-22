// The Markdown subset of client spec §5.6, parsed into a tree the UI renders as plain
// elements. There is no HTML path at all: raw HTML stays literal text (CL-30).

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'codeblock'; text: string };

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const BULLET_RE = /^\s{0,3}[-*]\s+(.*)$/;
const ORDERED_RE = /^\s{0,3}\d{1,9}\.\s+(.*)$/;
const FENCE_RE = /^\s{0,3}```/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (FENCE_RE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      blocks.push({ type: 'codeblock', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        children: parseInline(heading[2].trim()),
      });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = !bullet;
      const re = isOrdered ? ORDERED_RE : BULLET_RE;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i] ?? '');
        if (!m) break;
        items.push(parseInline(m[1] ?? ''));
        i++;
      }
      i--;
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

/** Only absolute http(s) links become links; anything else (javascript:, data:, relative) is text. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '[') {
      const close = text.indexOf('](', i + 1);
      const end = close === -1 ? -1 : text.indexOf(')', close + 2);
      if (close > i && end > close) {
        const label = text.slice(i + 1, close);
        const href = safeHref(text.slice(close + 2, end));
        if (href !== null && !label.includes('[')) {
          flush();
          out.push({ type: 'link', href, children: parseInline(label) });
          i = end + 1;
          continue;
        }
      }
    }

    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** Plain text of a tree, e.g. for previews. */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children))).join('');
}
