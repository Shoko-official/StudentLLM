export interface SnippetPart {
  text: string;
  match: boolean;
}

const LATEX_SYMBOLS: Record<string, string> = {
  mid: '\u0001' /* restored to "|" after table-pipe stripping */, cdot: '·', times: '×', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', in: '∈', cup: '∪', cap: '∩', subset: '⊂', sum: 'Σ',
  prod: 'Π', int: '∫', partial: '∂', nabla: '∇', pm: '±', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', Omega: 'Ω',
  Delta: 'Δ', Sigma: 'Σ', emptyset: '∅', ldots: '…', dots: '…', cdots: '…',
};

function latexToReadable(source: string) {
  let value = source;
  // \frac{a}{b} -> (a)/(b), repeated so simple nesting resolves
  for (let i = 0; i < 4; i += 1) {
    value = value.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  }
  return value
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:left|right|big|Big)\b/g, '')
    .replace(/\\([A-Za-z]+)/g, (_match, name: string) => LATEX_SYMBOLS[name] ?? name)
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([{}%$&#_])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn Markdown/LaTeX source into one line of readable plain text.
 * Math is converted to a readable form (not removed) so a match inside a formula still shows.
 */
export function toPlainText(source: string): string {
  let text = source.replace(/\r\n?/g, '\n');
  text = text.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, ' $1 ');
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => ` ${latexToReadable(math)} `);
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => ` ${latexToReadable(math)} `);
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => latexToReadable(math));
  text = text.replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_match, math: string) => latexToReadable(math));
  text = text
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
  return text.replace(/\u0001/g, '|').replace(/\s+/g, ' ').trim();
}

/** Plain-text excerpt around the first match, split into highlightable parts. */
export function buildSnippet(source: string, query: string, maxLength = 160): SnippetPart[] {
  const plain = toPlainText(source);
  if (!plain) return [];
  const needle = query.trim().toLocaleLowerCase();
  const lower = plain.toLocaleLowerCase();
  // Lowercasing can change length for rare characters; skip highlighting then.
  const index = needle && lower.length === plain.length ? lower.indexOf(needle) : -1;
  let start = 0;
  if (index >= 0) {
    start = Math.max(0, index - Math.floor(Math.max(0, maxLength - needle.length) / 3));
    if (start > 0) {
      const space = plain.indexOf(' ', start);
      if (space >= 0 && space < index) start = space + 1;
    }
  }
  const end = Math.min(plain.length, start + maxLength);
  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: '… ', match: false });
  if (index >= start && index + needle.length <= end) {
    if (index > start) parts.push({ text: plain.slice(start, index), match: false });
    parts.push({ text: plain.slice(index, index + needle.length), match: true });
    if (index + needle.length < end) parts.push({ text: plain.slice(index + needle.length, end), match: false });
  } else {
    parts.push({ text: plain.slice(start, end), match: false });
  }
  if (end < plain.length) {
    const last = parts[parts.length - 1];
    parts[parts.length - 1] = { ...last, text: last.text.trimEnd() };
    parts.push({ text: ' …', match: false });
  }
  return parts;
}
