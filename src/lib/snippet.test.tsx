import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildSnippet, toPlainText } from './snippet';
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

describe('Snippet', () => {
  it('renders plain text with a <mark> around the match', () => {
    const { container } = render(<Snippet text={'## Bayes **rule**'} query="rule" />);
    expect(container.textContent).toBe('Bayes rule');
    expect(container.querySelector('mark')?.textContent).toBe('rule');
  });
});
