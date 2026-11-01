import { describe, expect, it } from 'vitest';
import { compileExpression, parseTeachingVisual } from './teaching-visuals';

const validPlot = {
  type: 'plot', title: 'Taylor', x: { min: -2, max: 2 },
  parameters: [{ name: 'n', label: 'Degree', min: 0, max: 10, step: 1, value: 3 }],
  series: [{ label: 'Exact', expression: 'exp(x)' }, { label: 'Approximation', expression: 'sum(k,0,n,x^k/factorial(k))' }],
  outputs: [{ label: 'Error at one', expression: 'abs(exp(1)-sum(k,0,n,1/factorial(k)))' }],
};

describe('bounded teaching expressions', () => {
  it('calculates Taylor terms from the selected degree and conventional operator precedence', () => {
    const f = compileExpression('sum(k,0,n,x^k/factorial(k))')!;
    expect(f({ x: 1, n: 0 })).toBe(1);
    expect(f({ x: 1, n: 3 })).toBeCloseTo(8 / 3);
    expect(f({ x: 1, n: 10 })).toBeCloseTo(Math.E, 6);
    expect(compileExpression('-2^2')!({})).toBe(-4);
    expect(compileExpression('2^-2')!({})).toBe(0.25);
    expect(compileExpression('2^3^2')!({})).toBe(512);
    expect(compileExpression('1 + 2 * 3')!({})).toBe(7);
    expect(compileExpression('sin(pi/2) + log(e) + .5e1')!({})).toBe(7);
  });

  it('computes a binomial distribution including boundary probabilities', () => {
    const f = compileExpression('binomial(n,x,p)')!;
    expect(f({ n: 8, x: 2, p: 0.3 })).toBeCloseTo(0.29647548);
    expect(Array.from({ length: 9 }, (_, x) => f({ n: 8, x, p: 0.3 })).reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(f({ n: 8, x: 0, p: 0 })).toBe(1);
    expect(f({ n: 8, x: 8, p: 1 })).toBe(1);
    expect(f({ n: 8, x: 12, p: 0.3 })).toBe(0);
    expect(f({ n: 8, x: -1, p: 0.3 })).toBe(0);
    expect(f({ n: 8, x: 2.5, p: 0.3 })).toBeNaN();
    expect(f({ n: 8, x: 2, p: 2 })).toBeNaN();
  });

  it('returns gaps for mathematical domain errors and unavailable variables', () => {
    for (const source of ['sqrt(-1)', 'log(0)', '1/0', 'exp(10000)', 'factorial(171)', 'factorial(-1)', 'missing+1']) {
      expect(compileExpression(source)!({}), source).toBeNaN();
    }
    expect(compileExpression('x')!(Object.create({ x: 2 }))).toBeNaN();
    expect(compileExpression('x')!({ x: Infinity })).toBeNaN();
  });

  it('preserves undefined intermediate values instead of turning them into plotted numbers', () => {
    for (const source of ['1/(1/x)', '(1/x)^0', 'sqrt(x)^0', '(exp(10000))^0']) {
      expect(compileExpression(source)!({ x: source.startsWith('sqrt') ? -1 : 0 }), source).toBeNaN();
    }
    expect(compileExpression('1/(1/x)')!({ x: 2 })).toBe(2);
    expect(compileExpression('(1/x)^0')!({ x: 2 })).toBe(1);
  });

  it('does not accept JavaScript, property access, implicit calls or malformed arithmetic', () => {
    for (const source of ['alert(1)', 'Math.sin(x)', 'x.constructor', 'constructor(1)', '__proto__', 'toString', 'valueOf', '__defineGetter__', 'window', 'fetch(1)', '2x', 'x=1', '1;2', '1,2', 'sin()', 'min(1)', 'sum(n,0,2,n)', '2**3', '2^', '(1+2', '1+2)', '"1"', '1e1000']) {
      expect(compileExpression(source), source).toBeNull();
    }
  });

  it('bounds nested work and syntax independently of requested numeric magnitudes', () => {
    expect(compileExpression('1+'.repeat(151) + '1')).toBeNull();
    expect(compileExpression('('.repeat(22) + '1' + ')'.repeat(22))).toBeNull();
    expect(compileExpression('sum(k,0,1000000000,1)')!({})).toBeNaN();
    expect(compileExpression('sum(k,0,63,sum(k,0,63,factorial(170)))')!({})).toBeNaN();
    expect(compileExpression('sum(k,0,-1,k)')!({})).toBe(0);
    expect(compileExpression('sum(k,0,63,1)')!({})).toBe(64);
    expect(compileExpression('sum(k,0,64,1)')!({})).toBeNaN();
  });
});

describe('teaching visualization JSON contract', () => {
  it.each(['', ' ', '\t\n'])('omits a blank optional readout unit %j without rejecting the plot', (unit) => {
    const result = parseTeachingVisual(JSON.stringify({ ...validPlot, outputs: [{ label: 'Approximation', expression: 'sum(k,0,n,1/factorial(k))', unit }] }));
    expect(result?.type).toBe('plot');
    if (result?.type !== 'plot') throw new Error('Expected the complete plot to remain available.');
    expect(result.outputs).toEqual([{ label: 'Approximation', expression: 'sum(k,0,n,1/factorial(k))' }]);
    expect(result.series).toEqual(validPlot.series);
    expect(compileExpression(result.outputs![0].expression)!({ n: 5 })).toBeCloseTo(163 / 60);
  });

  it('preserves real units and rejects wrong types, oversized units and invalid required fields', () => {
    const output = { label: 'Pressure', expression: 'n', unit: ' Pa ' };
    const real = parseTeachingVisual(JSON.stringify({ ...validPlot, outputs: [output] }));
    expect(real?.type === 'plot' && real.outputs?.[0].unit).toBe(' Pa ');
    for (const unit of [null, 42, {}, ' '.repeat(41), 'P'.repeat(41)]) {
      expect(parseTeachingVisual(JSON.stringify({ ...validPlot, outputs: [{ ...output, unit }] }))).toBeNull();
    }
    expect(parseTeachingVisual(JSON.stringify({ ...validPlot, outputs: [{ ...output, label: ' ', unit: ' ' }] }))).toBeNull();
    expect(parseTeachingVisual(JSON.stringify({ ...validPlot, outputs: [{ ...output, expression: 'missing', unit: ' ' }] }))).toBeNull();
  });

  it('normalizes a generic interactive Taylor plot and strips executable extras', () => {
    const result = parseTeachingVisual(JSON.stringify({ ...validPlot, onChange: 'alert(1)' }));
    expect(result).toEqual(validPlot);
    expect(result).not.toHaveProperty('onChange');
  });

  it('accepts static coordinate data, weighted graphs, vector figures and quizzes', () => {
    expect(parseTeachingVisual(JSON.stringify({ type: 'plot', title: 'Measured', chartType: 'bar', x: { min: 0, max: 3 }, series: [{ label: 'Values', points: [[0, -1], [3, 2]] }] }))).not.toBeNull();
    expect(parseTeachingVisual(JSON.stringify({ type: 'diagram', title: 'Tree', nodes: [{ id: 'root', label: 'Start' }, { id: 'end', label: 'Success' }], edges: [{ from: 'root', to: 'end', label: '0.3' }] }))).not.toBeNull();
    expect(parseTeachingVisual(JSON.stringify({ type: 'figure', title: 'Sets', width: 400, height: 240, shapes: [
      { type: 'circle', x: 150, y: 120, r: 80, label: 'A', color: 'blue' },
      { type: 'circle', x: 240, y: 120, r: 80, label: 'B', color: 'orange' },
      { type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 100, label: 'Flow' },
      { type: 'rect', x: 0, y: 0, width: 40, height: 40 },
      { type: 'text', x: 200, y: 220, text: 'A union B' },
    ] }))).not.toBeNull();
    expect(parseTeachingVisual(JSON.stringify({ type: 'quiz', title: 'Check', question: 'Which?', options: ['A', 'B'], answer: 1, explanation: 'Because B.', hint: 'Look again.' }))).not.toBeNull();
  });

  it('rejects unknown variables, conflicting data, duplicate and reserved parameters', () => {
    const change = (overrides: Record<string, unknown>) => parseTeachingVisual(JSON.stringify({ ...validPlot, ...overrides }));
    expect(change({ series: [{ label: 'Wrong', expression: 'secret+x' }] })).toBeNull();
    expect(change({ series: [{ label: 'Wrong', expression: 'k+x' }] })).toBeNull();
    expect(change({ series: [{ label: 'Wrong', expression: 'x', points: [[0, 0], [1, 1]] }] })).toBeNull();
    expect(change({ outputs: [{ label: 'Wrong', expression: 'x+1' }] })).toBeNull();
    for (const name of ['x', 'k', 'pi', 'e', '__proto__', 'constructor', 'sin', '1bad', 'a.b']) {
      expect(change({ parameters: [{ ...validPlot.parameters[0], name }] }), name).toBeNull();
    }
    expect(change({ parameters: [validPlot.parameters[0], validPlot.parameters[0]] })).toBeNull();
  });

  it('enforces finite dimensions, slider ranges, count and text bounds', () => {
    const change = (overrides: Record<string, unknown>) => parseTeachingVisual(JSON.stringify({ ...validPlot, ...overrides }));
    for (const x of [{ min: 1, max: 1 }, { min: 2, max: 1 }, { min: -1, max: null }, { min: -1e12, max: 1 }]) expect(change({ x })).toBeNull();
    for (const p of [{ step: 0 }, { step: -1 }, { value: 20 }, { min: 10, max: 0 }, { step: 11 }]) expect(change({ parameters: [{ ...validPlot.parameters[0], ...p }] })).toBeNull();
    expect(change({ series: Array(5).fill(validPlot.series[0]) })).toBeNull();
    expect(change({ x: { min: 0, max: 20, step: 1 } })).not.toBeNull();
    expect(change({ x: { min: 0, max: 20, step: 0.01 } })).toBeNull();
    expect(change({ x: { min: 0, max: 20, step: 0 } })).toBeNull();
    expect(change({ series: [{ label: 'Too much', points: Array(162).fill([0, 0]) }] })).toBeNull();
    expect(change({ title: 'x'.repeat(181) })).toBeNull();
    expect(parseTeachingVisual(' '.repeat(32769))).toBeNull();
    expect(parseTeachingVisual('{bad}')).toBeNull();
    expect(parseTeachingVisual('null')).toBeNull();
  });

  it('requires slider defaults to align with the minimum and step while tolerating decimal roundoff', () => {
    const withParameter = (parameter: Record<string, unknown>) => parseTeachingVisual(JSON.stringify({ ...validPlot, parameters: [{ ...validPlot.parameters[0], ...parameter }] }));
    expect(withParameter({ min: 0, max: 10, step: 1, value: 2.3 })).toBeNull();
    expect(withParameter({ min: 0.05, max: 0.95, step: 0.05, value: 0.3 })).not.toBeNull();
    expect(withParameter({ min: 0.05, max: 0.95, step: 0.05, value: 0.31 })).toBeNull();
  });

  it('rejects dangling edges, duplicate IDs and SVG or external shape payloads', () => {
    const graph = { type: 'diagram', title: 'Tree', nodes: [{ id: 'a', label: 'A' }], edges: [] };
    expect(parseTeachingVisual(JSON.stringify({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }))).toBeNull();
    expect(parseTeachingVisual(JSON.stringify({ ...graph, edges: [{ from: 'a', to: 'b' }] }))).toBeNull();
    const figure = { type: 'figure', title: 'Figure', width: 400, height: 240 };
    for (const shape of [
      { type: 'image', href: 'https://example.org/track' }, { type: 'path', d: 'M0 0' },
      { type: 'circle', x: 1, y: 1, r: 20 }, { type: 'rect', x: 390, y: 20, width: 20, height: 20 },
      { type: 'arrow', x1: 0, y1: 0, x2: 500, y2: 10 },
      { type: 'circle', x: 100, y: 100, r: 20, color: 'url(https://example.org)' },
    ]) expect(parseTeachingVisual(JSON.stringify({ ...figure, shapes: [shape] }))).toBeNull();
  });

  it('rejects invalid or oversized answer choices', () => {
    const quiz = { type: 'quiz', title: 'Quiz', question: 'Which?', options: ['A', 'B'], answer: 1, explanation: 'B is correct.' };
    for (const change of [{ answer: -1 }, { answer: 2 }, { answer: 0.5 }, { options: ['A'] }, { options: Array(7).fill('A') }]) expect(parseTeachingVisual(JSON.stringify({ ...quiz, ...change }))).toBeNull();
  });
});
