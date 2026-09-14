import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

describe('RichText', () => {
  it('renders GitHub-flavored Markdown, code, tables, and LaTeX together', () => {
    const { container } = render(<RichText content={'## Key ideas\n\n- Scale by $\\sqrt{d_k}$\n- Keep the source visible\n\n```ts\nconst answer = 42;\n```\n\n| Term | Value |\n| --- | ---: |\n| Batch | 32 |'} />);

    expect(container.querySelector('h2')).toHaveTextContent('Key ideas');
    expect(container.querySelector('ul')).toHaveTextContent('Scale by');
    expect(screen.getByText('const answer = 42;')).toBeVisible();
    expect(container.querySelector('table')).toHaveTextContent('Batch');
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('renders inline and display LaTeX with semantic KaTeX markup', () => {
    const { container } = render(<RichText content={'Scale by $\\sqrt{d_k}$ before applying softmax.\n$$y = \\frac{x}{2}$$'} />);

    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelectorAll('math')).toHaveLength(2);
  });

  it('keeps malformed LaTeX legible instead of displaying a KaTeX error', () => {
    const { container } = render(<RichText content={'\\(\\notARealCommand{x}\\)'} />);

    expect(container).toHaveTextContent('\\notARealCommand{x}');
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.querySelector('[style*="color: red"]')).toBeNull();
  });

  it('sets extracted mathematical source apart from surrounding prose', () => {
    render(<div><RichText content={'Divergence of a vector field\n∂Fₓ/∂x + ∂Fᵧ/∂y'} highlightExtractedMath /></div>);

    const source = screen.getByText('∂Fₓ/∂x + ∂Fᵧ/∂y');
    expect(source).toHaveClass('extracted-math-line');
    expect(source).toHaveAttribute('aria-label', 'Extracted mathematical source');
  });
});
