import { useEffect, useState, type ReactNode } from 'react';
import { formatLocal, localZoneName, parseMarkdown, type Block, type Inline } from '@zoria/core';

/** Local time with the zone named once per value (CL-38). */
export function LocalTime({ value, zone = false }: { value: string | number | null; zone?: boolean }) {
  if (value === null) return <span className="muted">—</span>;
  const iso = typeof value === 'number' ? new Date(value).toISOString() : value;
  return (
    <time dateTime={iso} title={`${iso} UTC`}>
      {formatLocal(value)}
      {zone ? <span className="zone"> {localZoneName()}</span> : null}
    </time>
  );
}

/** Re-renders every `ms` for countdowns. The interval dies with the component. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [ms]);
  return now;
}

/** A URL that wraps after `/` instead of mid-word (the CSS `anywhere` wrap stays as a last resort). */
export function BreakableUrl({ url }: { url: string }) {
  const parts = url.split(/(?<=\/)/);
  return (
    <code>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </code>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Panel({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title || actions ? (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function CopyButton({ text, label = 'Копировать' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        setTimeout(() => {
          setDone(false);
        }, 1500);
      },
      () => {
        setDone(false);
      },
    );
  };
  return (
    <button type="button" className="ghost" onClick={copy}>
      {done ? 'Скопировано' : label}
    </button>
  );
}

// ---------- safe Markdown (CL-30): tree → elements, no HTML path ----------

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <span key={i}>{n.text}</span>;
          case 'code':
            return <code key={i}>{n.text}</code>;
          case 'strong':
            return (
              <strong key={i}>
                <InlineNodes nodes={n.children} />
              </strong>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
                <InlineNodes nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[block.level - 1] ?? 'h6';
      return (
        <Tag>
          <InlineNodes nodes={block.children} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <InlineNodes nodes={block.children} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <InlineNodes nodes={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'codeblock':
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
  }
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} />
      ))}
    </div>
  );
}
