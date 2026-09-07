import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

describe('RichText', () => {
  it('formats inline and display LaTeX without losing the source formula', () => {
    render(<RichText content={'Scale by $\\sqrt{d_k}$ before applying softmax.\n$$y = \\frac{x}{2}$$'} />);

    expect(screen.getByRole('img', { name: 'LaTeX formula: \\sqrt{d_k}' })).toHaveTextContent('√(d_k)');
    expect(screen.getByRole('img', { name: 'LaTeX formula: y = \\frac{x}{2}' })).toHaveTextContent('(x) / (2)');
  });
});
