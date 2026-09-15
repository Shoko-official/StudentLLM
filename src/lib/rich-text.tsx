import { Fragment, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { isExtractedMathSourceLine } from './extracted-math';
import { repairCorruptedLatexCommands } from './document-text';

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

const bareLatexCommand = /\\(?:alpha|arccos|arcsin|arctan|begin|cdot|end|frac|int|left|lim|nabla|operatorname|partial|pmatrix|right|sqrt|sum|text|times|vec)\b/u;
const inlineLatexFragment = /\\operatorname\{[^{}\n]+\}\([^()\n]*\)(?:\s*=\s*(?:(?:\\[A-Za-z]+(?:\{[^{}\n]*\})?|[A-Za-zΔ∇][A-Za-z0-9Δ∇]*)(?:\s+(?:\\[A-Za-z]+(?:\{[^{}\n]*\})?|[A-Za-z0-9Δ∇]+))*))?|\\(?:frac|sqrt|text|vec|partial|nabla|times|cdot|int|sum|lim)\{[^{}\n]*\}(?:\{[^{}\n]*\})?/gu;

function wrapBareLatexCell(cell: string) {
  const trimmed = cell.trim();
  if (!trimmed || trimmed.includes('$') || trimmed.startsWith('---') || !bareLatexCommand.test(trimmed)) return cell;
  const start = cell.indexOf(trimmed);
  const end = start + trimmed.length;
  return cell.slice(0, start) + '$' + trimmed + '$' + cell.slice(end);
}

function wrapBareLatexListItem(line: string) {
  const match = /^(\s*(?:[-*+]|\d+[.)])\s+)(.+?)\s*$/u.exec(line);
  if (!match || match[2].includes('$') || !bareLatexCommand.test(match[2])) return line;
  const body = match[2];
  if (body.trimStart().startsWith('\\')) return match[1] + '$' + body + '$';
  return match[1] + body.replace(inlineLatexFragment, (fragment) => `$${fragment}$`);
}

function normalizeMarkdownLatex(content: string) {
  const repaired = repairCorruptedLatexCommands(content);
  let inCodeFence = false;

  return repaired.split('\n').map((line) => {
    if (line.trimStart().startsWith(String.fromCharCode(96, 96, 96))) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    if (line.includes('|')) return line.split('|').map(wrapBareLatexCell).join('|');
    return wrapBareLatexListItem(line);
  }).join('\n');
}

function safeUrlTransform(url: string) {
  try {
    const parsed = new URL(url, 'https://studentllm.invalid');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return url;
    if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  } catch {
    // Invalid URLs are omitted from rendered content.
  }
  return '';
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
        urlTransform={safeUrlTransform}
        components={{
          img: ({ alt }) => <span className="rich-image-alt" role="img" aria-label={alt || 'Image omitted'}>{alt || 'Image omitted'}</span>,
        }}
      >
        {normalizeMathDelimiters(normalizeMarkdownLatex(content))}
      </ReactMarkdown>
    </div>
  );
}
