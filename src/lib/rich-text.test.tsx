import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

describe('RichText', () => {
  it('renders inline and display LaTeX with semantic KaTeX markup', () => {
    render(<RichText content={'Scale by $\\sqrt{d_k}$ before applying softmax.\n$$y = \\frac{x}{2}$$'} />);

    const inline = screen.getByRole('img', { name: 'LaTeX formula: \\sqrt{d_k}' });
    const display = screen.getByRole('img', { name: 'LaTeX formula: y = \\frac{x}{2}' });

    expect(inline.querySelector('.katex')).not.toBeNull();
    expect(inline.querySelector('math')).not.toBeNull();
    expect(display).toHaveClass('latex-block');
    expect(display.querySelector('.katex-display')).not.toBeNull();
    expect(display.querySelector('math')).not.toBeNull();
  });

  it('keeps malformed LaTeX legible instead of displaying a KaTeX error', () => {
    render(<RichText content={'\\(\\notARealCommand{x}\\)'} />);

    const formula = screen.getByRole('img', { name: 'LaTeX formula: \\notARealCommand{x}' });
    expect(formula).toHaveTextContent('\\notARealCommand{x}');
    expect(formula.querySelector('.katex-error')).toBeNull();
    expect(formula.querySelector('[style*="color"]')).toBeNull();
  });
});
