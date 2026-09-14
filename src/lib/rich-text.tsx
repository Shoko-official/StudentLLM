import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { isExtractedMathSourceLine } from './extracted-math';

const mathPattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\$)(?:\\.|[^$\\\n])+\$)/g;
const renderedMathCache = new Map<string, string>();

function unwrapMath(token: string) {
  if (token.startsWith('$$')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\[')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\(')) return { source: token.slice(2, -2).trim(), display: false };
  return { source: token.slice(1, -1).trim(), display: false };
}

function renderPlainText(text: string, keyPrefix: string): ReactNode[] {
  return text.split('\n').map((line, index, lines) => (
    <Fragment key={`${keyPrefix}-${index}`}>
      {isExtractedMathSourceLine(line)
        ? <span className="extracted-math-line" aria-label="Extracted mathematical source">{line}</span>
        : line}
      {index < lines.length - 1 && <br />}
    </Fragment>
  ));
}

function renderExtractedText(content: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let partIndex = 0;
  mathPattern.lastIndex = 0;

  while ((match = mathPattern.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push(...renderPlainText(content.slice(cursor, match.index), `text-${partIndex}`));
      partIndex += 1;
    }
    const math = unwrapMath(match[0]);
    const cacheKey = `${math.display ? 'display' : 'inline'}:${math.source}`;
    let renderedMath = renderedMathCache.get(cacheKey) ?? null;
    if (renderedMath === null) {
      try {
        renderedMath = katex.renderToString(math.source, {
          displayMode: math.display,
          output: 'htmlAndMathml',
          throwOnError: true,
          strict: false,
        });
        renderedMathCache.set(cacheKey, renderedMath);
      } catch {
        renderedMath = null;
      }
    }
    const mathProps = {
      className: math.display ? 'latex-block' : 'latex-inline',
      role: 'img',
      'aria-label': `LaTeX formula: ${math.source}`,
      title: math.source,
    } as const;
    parts.push(renderedMath
      ? <span key={`math-${partIndex}`} {...mathProps} dangerouslySetInnerHTML={{ __html: renderedMath }} />
      : <span key={`math-${partIndex}`} {...mathProps}>{math.source}</span>);
    cursor = match.index + match[0].length;
    partIndex += 1;
  }

  mathPattern.lastIndex = 0;
  if (cursor < content.length) parts.push(...renderPlainText(content.slice(cursor), `text-${partIndex}`));
  return parts;
}

function normalizeMathDelimiters(content: string) {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, source: string) => `$$${source.trim()}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, source: string) => `$${source.trim()}$`)
    .replace(/([^\n])\$\$/g, (_match, before: string) => `${before}\n\n$$`)
    .replace(/\$\$(?!\n)/g, () => '$$\n\n');
}

interface RichTextProps {
  content: string;
  highlightExtractedMath?: boolean;
  className?: string;
}

export function RichText({ content, highlightExtractedMath = false, className }: RichTextProps) {
  const classes = ['rich-text', className].filter(Boolean).join(' ');
  if (highlightExtractedMath) return <div className={classes}>{renderExtractedText(content)}</div>;

  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore', errorColor: 'currentColor' }]]}
      >
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
