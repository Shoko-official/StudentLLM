import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeachingVisualView } from './teaching-visual-view';
import type { TeachingVisual } from './teaching-visuals';

const taylor: TeachingVisual = {
  type: 'plot', title: 'Taylor approximation', x: { min: -2, max: 2, label: 'x' },
  parameters: [{ name: 'n', label: 'Degree', min: 0, max: 10, step: 1, value: 1 }],
  series: [{ label: 'Exact exponential', expression: 'exp(x)' }, { label: 'Taylor polynomial', expression: 'sum(k,0,n,x^k/factorial(k))' }],
  outputs: [{ label: 'Approximation at x=1', expression: 'sum(k,0,n,1/factorial(k))' }],
};

it('preserves tiny nonzero scientific values while displaying actual zero as zero', () => {
  const { container } = render(<TeachingVisualView visual={{
    type: 'plot', title: 'Scientific quantities', x: { min: 0, max: 1 },
    series: [{ label: 'Tiny quantity', expression: 'x*1e-13' }],
    outputs: [
      { label: 'Tiny positive', expression: '1e-13' },
      { label: 'Tiny negative', expression: '-1e-13' },
      { label: 'Planck-scale example', expression: '6.626e-34' },
      { label: 'Exact zero', expression: '0' },
    ],
  }} />);
  expect(Array.from(container.querySelectorAll('dd'), (element) => element.textContent)).toEqual(['1.000e-13', '-1.000e-13', '6.626e-34', '0']);
});

it('recalculates the Taylor curve and readout from a labelled native slider', () => {
  const { container } = render(<TeachingVisualView visual={taylor} />);
  const before = container.querySelector('[data-series="Taylor polynomial"]')!.getAttribute('d');
  expect(screen.getByText('2', { selector: 'dd' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('slider', { name: /Degree/ }), { target: { value: '4' } });
  expect(screen.getByText('2.7083', { selector: 'dd' })).toBeInTheDocument();
  expect(container.querySelector('[data-series="Taylor polynomial"]')!.getAttribute('d')).not.toBe(before);
  expect(container.querySelector('[data-series="Taylor polynomial"]')).toHaveAttribute('stroke-dasharray', '9 4');
  expect(screen.getByRole('slider', { name: /Degree/ })).toHaveAttribute('min', '0');
});

it('uses integer x steps for binomial probabilities and exposes current exact values', async () => {
  const user = userEvent.setup();
  const { container } = render(<TeachingVisualView visual={{ type: 'plot', title: 'Binomial distribution', chartType: 'bar', x: { min: 0, max: 4, step: 1, label: 'Successes' }, series: [{ label: 'P(X=k)', expression: 'binomial(4,x,p)' }], parameters: [{ name: 'p', label: 'Probability', min: 0, max: 1, step: .1, value: .5 }] }} />);
  expect(container.querySelectorAll('g.teaching-series > rect')).toHaveLength(5);
  const bars = Array.from(container.querySelectorAll('g.teaching-series > rect'));
  expect(Number(bars[0].getAttribute('x'))).toBeGreaterThanOrEqual(76);
  expect(Number(bars.at(-1)!.getAttribute('x')) + Number(bars.at(-1)!.getAttribute('width'))).toBeLessThanOrEqual(616);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  await user.click(screen.getByText('Read graph values'));
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  expect(within(table).getByText('0.375')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('slider', { name: /Probability/ }), { target: { value: '0' } });
  expect(within(table).getByText('1', { selector: 'td:nth-child(3)' })).toBeInTheDocument();
});

it('breaks a reciprocal curve at its undefined point without invalid SVG coordinates', () => {
  const { container } = render(<TeachingVisualView visual={{ type: 'plot', title: 'Reciprocal', x: { min: -1, max: 1 }, y: { min: -5, max: 5 }, series: [{ label: '1/x', expression: '1/x' }] }} />);
  const path = container.querySelector('[data-series="1/x"]')!.getAttribute('d')!;
  expect((path.match(/M/g) ?? []).length).toBeGreaterThan(1);
  expect(path).not.toMatch(/NaN|Infinity/);
  expect(screen.getByText(/shown as gaps/)).toBeInTheDocument();
});

it('keeps two sparse valid linear points connected and handles an entirely undefined domain', () => {
  const { container, rerender } = render(<TeachingVisualView visual={{ type: 'plot', title: 'Straight line', x: { min: -1, max: 1 }, series: [{ label: 'Line', points: [[-1, -1], [1, 1]] }] }} />);
  expect(container.querySelector('[data-series="Line"]')!.getAttribute('d')).toContain('L');
  rerender(<TeachingVisualView visual={{ type: 'plot', title: 'Outside the real domain', x: { min: -2, max: -1 }, series: [{ label: 'Square root', expression: 'sqrt(x)' }] }} />);
  expect(container.querySelector('[data-series="Square root"]')).toHaveAttribute('d', expect.not.stringMatching(/NaN|Infinity/));
  expect(screen.getByText(/shown as gaps/)).toBeInTheDocument();
});

it('requires an explicit check, provides feedback and permits retrying a quiz', async () => {
  const user = userEvent.setup();
  render(<TeachingVisualView visual={{ type: 'quiz', title: 'Conditional probability', question: 'If $P(A)=0.5$, what is $P(\\overline A)$?', options: ['0', '0.5', '1'], answer: 1, explanation: 'Use $1-P(A)$.', hint: 'A and its complement cover the whole sample space.' }} />);
  expect(screen.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  await user.click(screen.getByRole('radio', { name: '0' }));
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  await user.click(screen.getByRole('button', { name: 'Check answer' }));
  expect(screen.getByRole('status')).toHaveTextContent('differs from the expected answer');
  await user.click(screen.getByRole('radio', { name: '0.5' }));
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  await user.click(screen.getByRole('button', { name: 'Check answer' }));
  expect(screen.getByRole('status')).toHaveTextContent('Correct according to this exercise');
  await user.click(screen.getByText('Read explanation'));
  expect(screen.getByText('Expected answer: 2')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Start again' }));
  expect(screen.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  expect(screen.getAllByRole('radio').every((input) => !(input as HTMLInputElement).checked)).toBe(true);
});

it('gives math-only quiz radios explicit accessible names independent of the KaTeX tree', () => {
  const options = ['$\\frac{1}{2}$', '$\\frac{1}{4}$'];
  const { container } = render(<TeachingVisualView visual={{ type: 'quiz', title: 'Fraction exercise', question: 'Choose one half.', options, answer: 0, explanation: 'One half is the first option.' }} />);
  const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
  expect(radios[0]).toHaveAccessibleName(options[0]);
  expect(radios[1]).toHaveAccessibleName(options[1]);
});

it('retains natural SVG widths so long diagrams and wide illustrations scroll without shrinking text', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `step-${index}`, label: `Step ${index + 1}` }));
  const { container } = render(<>
    <TeachingVisualView visual={{ type: 'diagram', title: 'Twelve-step pipeline', nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })) }} />
    <TeachingVisualView visual={{ type: 'figure', title: 'Wide scientific illustration', width: 1200, height: 200, shapes: [{ type: 'text', x: 20, y: 40, text: 'Readable annotation' }] }} />
  </>);
  const diagram = container.querySelector<SVGSVGElement>('.teaching-diagram .teaching-canvas > svg')!;
  const illustration = container.querySelector<SVGSVGElement>('.teaching-figure .teaching-canvas > svg')!;
  expect(diagram.style.minWidth).toBe('2760px');
  expect(illustration.style.minWidth).toBe('1200px');
});

it('renders branching/cyclic diagrams with unique arrow IDs and a complete textual equivalent', async () => {
  const user = userEvent.setup();
  const visual: TeachingVisual = { type: 'diagram', title: 'Probability tree', nodes: [{ id: 'a', label: 'Experiment' }, { id: 'b', label: 'A very long outcome name which remains available in the relationship list' }], edges: [{ from: 'a', to: 'b', label: 'p=0.3' }, { from: 'b', to: 'a', label: 'retry' }] };
  const { container } = render(<><TeachingVisualView visual={visual} /><TeachingVisualView visual={visual} /></>);
  const ids = Array.from(container.querySelectorAll('marker')).map((marker) => marker.id);
  expect(new Set(ids).size).toBe(2);
  expect(container.querySelectorAll('.teaching-edge')).toHaveLength(4);
  await user.click(screen.getAllByText('Read diagram relationships')[0]);
  await waitFor(() => expect(screen.getAllByText(/Experiment → A very long outcome name/)[0]).toBeVisible());
});

it('renders only typed SVG primitives and escapes labels while giving illustrations distinct markers', () => {
  const visual: TeachingVisual = { type: 'figure', title: 'Set intersection', width: 340, height: 180, shapes: [{ type: 'circle', x: 130, y: 85, r: 60, color: 'blue', label: 'A' }, { type: 'circle', x: 210, y: 85, r: 60, color: 'orange', label: 'B' }, { type: 'arrow', x1: 20, y1: 160, x2: 100, y2: 160 }, { type: 'text', x: 10, y: 20, text: '<script>not executable</script>' }] };
  const { container } = render(<><TeachingVisualView visual={visual} /><TeachingVisualView visual={visual} /></>);
  expect(container.querySelector('script, image, foreignObject')).toBeNull();
  expect(container.querySelectorAll('circle')).toHaveLength(4);
  expect(new Set(Array.from(container.querySelectorAll('marker')).map((marker) => marker.id)).size).toBe(2);
  expect(screen.getAllByText('<script>not executable</script>').length).toBeGreaterThan(0);
});
