import { Fragment, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { isExtractedMathSourceLine } from './extracted-math';
import { decodeMojibakeUtf8, repairBareLatexCommandPrefixes, repairCorruptedLatexCommands } from './document-text';

const mathPattern = /(\$\$[\s\S]*?\$\$|(?<!\\)\\\[[\s\S]*?\\\]|(?<!\\)\\\([\s\S]*?\\\)|\$(?!\$)(?:\\.|[^$\\\n])+\$)/g;
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
    // (?<!\\) keeps a LaTeX line break with spacing, such as \\[6pt], from opening a block.
    .replace(/(?<!\\)\\\[([\s\S]*?)\\\]/g, (_match, source: string) => `$$${source.trim()}$$`)
    .replace(/(?<!\\)\\\(([\s\S]*?)\\\)/g, (_match, source: string) => `$${source.trim()}$`)
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

function wrapBareLatexParagraph(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes('$') || trimmed.startsWith('>') || trimmed.startsWith('#')) return line;
  if (!bareLatexCommand.test(trimmed) || !trimmed.startsWith('\\')) return line;
  const start = line.indexOf(trimmed);
  const end = start + trimmed.length;
  return line.slice(0, start) + '$' + trimmed + '$' + line.slice(end);
}

function normalizeMarkdownLatex(content: string) {
  let inCodeFence = false;
  let inDisplayMath = false;

  return content.split('\n').map((line) => {
    if (line.trimStart().startsWith(String.fromCharCode(96, 96, 96))) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    // Lines inside a multi-line $$ or \[ block are already math: wrapping \begin{cases}
    // or \end{cases} in $ there would split the block and leave it unrendered.
    const trimmed = line.trim();
    const opensBracketDisplay = !inDisplayMath && trimmed.startsWith('\\[') && !trimmed.includes('\\]');
    const closesBracketDisplay = inDisplayMath && trimmed.includes('\\]');
    if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1 || opensBracketDisplay || closesBracketDisplay) {
      inDisplayMath = !inDisplayMath;
      return line;
    }
    if (inDisplayMath) return line;
    const repaired = decodeMojibakeUtf8(repairBareLatexCommandPrefixes(repairCorruptedLatexCommands(line)));
    if (repaired.includes('|')) return repaired.split('|').map(wrapBareLatexCell).join('|');
    if (/^\s*(?:[-*+]|\d+[.)])\s+/u.test(repaired)) return wrapBareLatexListItem(repaired);
    return wrapBareLatexParagraph(repaired);
  }).join('\n');
}

function repairUnclosedInlineLatex(content: string) {
  let inDisplayMath = false;
  return content.split('\n').map((line) => {
    // Display math ($$ ... $$, possibly over several lines) is never an unclosed inline formula.
    const displayDelimiters = line.match(/\$\$/g)?.length ?? 0;
    if (inDisplayMath || displayDelimiters % 2 === 1) {
      if (displayDelimiters % 2 === 1) inDisplayMath = !inDisplayMath;
      return line;
    }
    // Only a table row's pipes separate cells; elsewhere |x| is an absolute value.
    const isTableRow = line.trimStart().startsWith('|');
    let repaired = '';
    let cursor = 0;
    while (cursor < line.length) {
      const delimiterIndex = line.indexOf('$', cursor);
      if (delimiterIndex === -1) {
        repaired += line.slice(cursor);
        break;
      }
      if (line[delimiterIndex + 1] === '$') {
        const closing = line.indexOf('$$', delimiterIndex + 2);
        const end = closing === -1 ? line.length : closing + 2;
        repaired += line.slice(cursor, end);
        cursor = end;
        continue;
      }
      repaired += line.slice(cursor, delimiterIndex + 1);
      const candidate = line.slice(delimiterIndex + 1).trimStart();
      const nextDelimiter = line.indexOf('$', delimiterIndex + 1);
      const nextPipe = isTableRow ? line.indexOf('|', delimiterIndex + 1) : -1;
      const boundary = nextPipe === -1 ? line.length : nextPipe;
      if (/^\\[A-Za-z]+/u.test(candidate) && (nextDelimiter === -1 || nextDelimiter > boundary)) {
        repaired += line.slice(delimiterIndex + 1, boundary) + '$';
        cursor = boundary;
      } else {
        cursor = delimiterIndex + 1;
      }
    }
    return repaired;
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

// Memoized: parsing Markdown and typesetting KaTeX is the expensive part of a render, and the workspace re-renders on
// every keystroke in a search field or the chat composer. The props are plain strings, so a shallow compare is exact.
export const RichText = memo(function RichText({ content, highlightExtractedMath = false, className }: RichTextProps) {
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
          // Only real external addresses are links. An empty, relative or in-page href would reload or navigate this single-page
          // app away from the course (and an empty href reloads it outright), so it is shown as plain text instead.
          a: ({ href, children }) => (typeof href === 'string' && /^(?:https?:|mailto:)/i.test(href.trim())
            ? <a href={href}>{children}</a>
            : <span className="rich-link-inert">{children}</span>),
        }}
      >
        {normalizeMathDelimiters(repairUnclosedInlineLatex(normalizeMarkdownLatex(content)))}
      </ReactMarkdown>
    </div>
  );
});
