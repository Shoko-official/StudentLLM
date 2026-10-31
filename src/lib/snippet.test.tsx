import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildSnippet, textMatchesQuery, toPlainText } from './snippet';
import { Snippet } from './snippet-view';

const sample = '# Introduction to probability\n\n## Definitions\n\n- A **sample space** is the set of outcomes.\n\n$$P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$$\n\n```python\nprint("Bayes")\n```\n\n| Outcome | Probability |\n|---|---|\n| Heads | 0.5 |\n';

describe('toPlainText', () => {
  it('removes Markdown syntax', () => {
    const plain = toPlainText(sample);
    expect(plain).not.toMatch(/[#*`]|---/);
    expect(toPlainText('| Outcome | Probability |\n|---|---|\n| Heads | 0.5 |')).toBe('Outcome Probability Heads 0.5');
    expect(plain).toContain('Introduction to probability Definitions A sample space is the set of outcomes.');
    expect(plain).toContain('Heads 0.5');
  });

  it('keeps math readable', () => {
    const plain = toPlainText(sample);
    expect(plain).toContain('P(A | B) = (P(B | A)P(A))/(P(B))');
    expect(plain).not.toContain('\\');
    expect(plain).not.toContain('$');
  });

  it('handles inline math, links and Greek letters but leaves prices alone', () => {
    expect(toPlainText('Let $\\alpha \\leq 1$ see [the notes](http://x.y/z).')).toBe('Let α ≤ 1 see the notes.');
    expect(toPlainText('It costs $5 and $6 today')).toBe('It costs $5 and $6 today');
  });

  it('tolerates an unterminated code fence', () => {
    expect(toPlainText('intro\n```js\nlet x = 1')).toBe('intro let x = 1');
  });
});

describe('buildSnippet', () => {
  it('highlights the match case-insensitively and centres a bounded excerpt', () => {
    const long = `${'word '.repeat(80)}Bayes theorem ${'tail '.repeat(80)}`;
    const parts = buildSnippet(long, 'bayes', 80);
    expect(parts.filter((part) => part.match)).toEqual([{ text: 'Bayes', match: true }]);
    expect(parts.map((part) => part.text).join('').length).toBeLessThan(100);
    expect(parts[0].text).toBe('… ');
    expect(parts[parts.length - 1].text).toBe(' …');
  });

  it('finds a match inside formatted text and shows no raw syntax', () => {
    const parts = buildSnippet(sample, 'sample space');
    expect(parts.some((part) => part.match && part.text === 'sample space')).toBe(true);
    expect(parts.map((part) => part.text).join('')).not.toMatch(/[#*`]/);
  });

  it('returns the start of the text when there is no query or no match', () => {
    expect(buildSnippet('# Title\nbody', '').map((part) => part.text).join('')).toBe('Title body');
    expect(buildSnippet('# Title\nbody', 'zzz').some((part) => part.match)).toBe(false);
  });

  it('returns nothing for empty text', () => {
    expect(buildSnippet('', 'a')).toEqual([]);
  });
});

describe('search and snippet agree', () => {
  const joined = (source: string, query: string) => buildSnippet(source, query).map((part) => part.text).join('');
  const matched = (source: string, query: string) => buildSnippet(source, query).filter((part) => part.match).map((part) => part.text);

  it('matches Greek-letter names and stripped Markdown queries', () => {
    expect(textMatchesQuery('let $\\alpha$ x', 'alpha')).toBe(true);
    expect(matched(`${'filler '.repeat(60)}let $\\alpha$ x`, 'alpha')).toEqual(['α']);
    expect(textMatchesQuery('a **sample space** b', '**sample')).toBe(true);
    expect(matched('a **sample space** b', '**sample')).toEqual(['sample']);
  });

  it('matches raw LaTeX command names even when the snippet cannot highlight them', () => {
    expect(textMatchesQuery('$\\frac{a}{b}$', 'frac')).toBe(true);
    expect(joined('$\\frac{a}{b}$', 'frac')).toBe('(a)/(b)');
  });

  it('falls back to the start of the text for a speaker-only match', () => {
    expect(matched('# Heading body', 'speaker')).toEqual([]);
    expect(joined('# Heading body', 'speaker')).toBe('Heading body');
    expect(textMatchesQuery('body', 'nothing')).toBe(false);
  });
});

describe('robustness', () => {
  it('stays fast on pathological input', () => {
    const started = performance.now();
    toPlainText(`${' '.repeat(40_000)}x`);
    toPlainText('[a'.repeat(30_000));
    toPlainText('$$'.repeat(20_000));
    toPlainText('\\('.repeat(20_000));
    // Generous on purpose: shared CI runners took ~1 s here. This only guards against runaway backtracking.
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('strips a 20,000-space line quickly and keeps table separators working', () => {
    const started = performance.now();
    toPlainText(' '.repeat(20_000));
    toPlainText(`${' '.repeat(20_000)}x`);
    toPlainText(`${'\t '.repeat(10_000)}|`);
    // Generous on purpose: this guards against quadratic backtracking (~200 ms before the fix), not CI speed.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(toPlainText('a | b\n  | --- | :---: |  \nc | d')).toBe('a b c d');
    expect(toPlainText('x\n \t---\t|\t---\ny')).toBe('x y');
  });

  it('never returns a stale result after a segment text is edited', () => {
    const segment = { id: 's1', text: 'the **sample space** of outcomes' };
    expect(textMatchesQuery(segment.text, 'sample space')).toBe(true);
    expect(textMatchesQuery(segment.text, 'sample space')).toBe(true); // second call is served from the cache
    segment.text = 'the **event** of outcomes';
    expect(textMatchesQuery(segment.text, 'sample space')).toBe(false);
    expect(textMatchesQuery(segment.text, 'event')).toBe(true);
    segment.text = 'the **sample space** again';
    expect(textMatchesQuery(segment.text, 'sample space')).toBe(true);
  });

  it('stays correct when more segments than the cache holds are searched', () => {
    const segments = Array.from({ length: 25_000 }, (_, index) => `item **${index}** of $\\alpha_{${index}}$`);
    for (const segment of segments) textMatchesQuery(segment, 'zzz');
    expect(textMatchesQuery(segments[0], 'item 0 of')).toBe(true);
    expect(textMatchesQuery(segments[24_999], 'item 24999 of')).toBe(true);
    expect(textMatchesQuery(segments[24_999], 'item 0 of')).toBe(false);
  });

  it('bounds very long text but still finds a late match', () => {
    const long = `${'word '.repeat(10_000)}needle ${'tail '.repeat(10_000)}`;
    expect(buildSnippet(long, 'needle').some((part) => part.match)).toBe(true);
    expect(buildSnippet(long, 'zzz').map((part) => part.text).join('').length).toBeLessThan(200);
  });
});

describe('LaTeX and Markdown details', () => {
  it('unwraps unknown commands and drops environments', () => {
    expect(toPlainText('$\\mathbb{R}$ and $\\hat{x}$ and $\\forall x$')).toBe('R and x and ∀ x');
    expect(toPlainText('$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$')).toBe('a b c d');
  });

  it('unescapes backslash escapes outside math', () => {
    expect(toPlainText('\\*not bold\\* \\# tag snake\\_case costs \\$5')).toBe('*not bold* # tag snake_case costs $5');
  });

  it('handles nested link parentheses, task boxes, rules and setext underlines', () => {
    expect(toPlainText('[a](http://x/(y)) b')).toBe('a b');
    expect(toPlainText('- [ ] todo\n- [x] done')).toBe('todo done');
    expect(toPlainText('Title\n=====\nbody\n***\nmore\n---\nend')).toBe('Title body more end');
  });
});

describe('Snippet', () => {
  it('renders plain text with a <mark> around the match', () => {
    const { container } = render(<Snippet text={'## Bayes **rule**'} query="rule" />);
    expect(container.textContent).toBe('Bayes rule');
    expect(container.querySelector('mark')?.textContent).toBe('rule');
  });
});
