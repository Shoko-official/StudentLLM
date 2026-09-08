import { Fragment, type ReactNode } from 'react';

const mathPattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\$)(?:\\.|[^$\\\n])+\$)/g;

function unwrapMath(token: string) {
  if (token.startsWith('$$')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\[')) return { source: token.slice(2, -2).trim(), display: true };
  if (token.startsWith('\\(')) return { source: token.slice(2, -2).trim(), display: false };
  return { source: token.slice(1, -1).trim(), display: false };
}

function formatMathSource(source: string) {
  return source
    .replace(/\\operatorname\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\left|\\right/g, '')
    .replace(/\\top/g, 'ᵀ')
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1) / ($2)')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\times/g, ' × ')
    .replace(/\\cdot/g, ' · ')
    .replace(/\\leq/g, ' ≤ ')
    .replace(/\\geq/g, ' ≥ ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\infty/g, '∞')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\pi/g, 'π')
    .replace(/\\mu/g, 'μ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\Delta/g, 'Δ')
    .replace(/\\nabla/g, '∇')
    .replace(/\^\s*\{([^{}]*)\}/g, '^$1')
    .replace(/_\s*\{([^{}]*)\}/g, '_$1')
    .replace(/[{}]/g, '')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
    parts.push(
      <span
        className={math.display ? 'latex-block' : 'latex-inline'}
        key={`math-${partIndex}`}
        role="img"
        aria-label={`LaTeX formula: ${math.source}`}
        title={math.source}
      >
        <span className="latex-source">{formatMathSource(math.source)}</span>
      </span>,
    );
    cursor = match.index + match[0].length;
    partIndex += 1;
  }

  if (cursor < content.length) parts.push(...renderPlainText(content.slice(cursor), `text-${partIndex}`));
  return parts;
}

export function RichText({ content }: { content: string }) {
  return <>{renderRichText(content)}</>;
}
