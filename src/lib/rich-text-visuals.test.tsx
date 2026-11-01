import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './rich-text';

const plot = { type: 'plot', title: 'Explorer une fonction', x: { min: -2, max: 2 }, parameters: [{ name: 'a', label: 'Pente', min: 1, max: 4, step: 1, value: 1 }], series: [{ label: 'Droite', expression: 'a*x' }], outputs: [{ label: 'Valeur en 2', expression: 'a*2' }] };
const fence = (value: unknown) => '\n```student-visual\n' + JSON.stringify(value) + '\n```\n';

describe('teaching visuals in Markdown', () => {
  it('renders interleaved prose, formulas and an interactive plot only when enabled', () => {
    const { container } = render(<RichText content={'## Comprendre la pente\n\nAvant le graphique.\n' + fence(plot) + '\nAprès le graphique : $y=ax$.'} allowTeachingVisuals />);
    expect(screen.getByText('Avant le graphique.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Pente/)).toHaveValue('1');
    fireEvent.change(screen.getByLabelText(/Pente/), { target: { value: '3' } });
    expect(screen.getByLabelText(/Pente/)).toHaveValue('3');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('pre figure')).toBeNull();
  });

  it('keeps user/imported code inert and preserves ordinary fenced code', () => {
    const { container } = render(<RichText content={fence(plot) + '\n```python\nprint(42)\n```'} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(container.querySelector('code.language-student-visual')).toBeInTheDocument();
    expect(container.querySelector('code.language-python')).toHaveTextContent('print(42)');
  });

  it('keeps surrounding explanation when a generated block is invalid or incomplete', () => {
    render(<RichText content={'Le début.\n' + fence({ ...plot, series: [{ label: 'Unsafe', expression: 'fetch("https://example.com")' }] }) + '\nLa suite.'} allowTeachingVisuals />);
    expect(screen.getByText('Le début.')).toBeInTheDocument();
    expect(screen.getByText('La suite.')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText(/visualization could not be displayed/i)).toBeInTheDocument();
  });

  it('does not mount more than eight model-created interactive blocks in one answer', () => {
    render(<RichText content={Array(12).fill(fence(plot)).join('\n')} allowTeachingVisuals />);
    expect(screen.getAllByRole('slider')).toHaveLength(8);
  });

  it('preserves JSON-escaped LaTeX and display math inside generated specifications', () => {
    const quiz = { type: 'quiz', title: 'Une formule', question: 'Quelle expression vaut $$\\frac{1}{2}$$ ?', options: ['$0.5$', '$2$'], answer: 0, explanation: '$$\\frac{1}{2}=0.5$$' };
    render(<RichText content={fence(quiz)} allowTeachingVisuals />);
    expect(screen.getByLabelText(/0.5/)).toBeInTheDocument();
    expect(screen.queryByText(/visualization could not be displayed/i)).toBeNull();
  });

  it.each(['quote', 'list'])('preserves formula specifications inside a Markdown %s', (container) => {
    const quiz = { type: 'quiz', title: 'Une fraction', question: 'Quelle expression vaut $$\\frac{1}{2}$$ ?', options: ['0.5', '2'], answer: 0, explanation: '$$\\frac{1}{2}=0.5$$' };
    const code = fence(quiz).trim().split('\n');
    const markdown = container === 'quote' ? code.map(line => '> ' + line).join('\n') : code.map((line, index) => (index ? '  ' : '- ') + line).join('\n');
    render(<RichText content={markdown} allowTeachingVisuals />);
    expect(screen.getByLabelText('0.5')).toBeInTheDocument();
    expect(screen.queryByText(/visualization could not be displayed/i)).toBeNull();
  });
});
