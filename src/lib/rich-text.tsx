import { Fragment, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

const mathPattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\$)(?:\\.|[^$\\\n])+\$)/g;

function unwrapMath(token: string) {
  if (token.startsWith('$$')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\[')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\(')) return { source: token.slice(2, -2).trim(), display: false };
  return { source: token.slice(1, -1).trim(), display: false };
}

function renderPlainText(text: string, keyPrefix: string): ReactNode[] {
  return text.split('\n').map((line, index, lines) => (
    <Fragment key={`${keyPrefix}-${index}`}>
      {line}
      {index < lines.length - 1 && <br />}
    </Fragment>
  ));
}

function renderRichText(content: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let partIndex = 0;

  while ((match = mathPattern.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push(...renderPlainText(content.slice(cursor, match.index), `text-${partIndex}`));
      partIndex += 1;
    }
    const math = unwrapMath(match[0]);
    let renderedMath: string | null = null;
    try {
      renderedMath = katex.renderToString(math.source, {
        displayMode: math.display,
        output: 'htmlAndMathml',
        throwOnError: false,
        strict: false,
      });
    } catch {
      renderedMath = null;
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

  if (cursor < content.length) parts.push(...renderPlainText(content.slice(cursor), `text-${partIndex}`));
  return parts;
}

export function RichText({ content }: { content: string }) {
  return <>{renderRichText(content)}</>;
}
