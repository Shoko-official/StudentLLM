import { describe, expect, it } from 'vitest';
import { decideGate, evaluateAnswer, requestedVisual } from './evaluate.mjs';

const fence = (value) => '```student-visual\n' + JSON.stringify(value) + '\n```';
const testCase = {
  artefacts: [
    { type: 'plot', x: { min: 0, max: 4 }, yCovers: [0, 16], sliders: [{ key: 'a', min: 1, max: 4, step: 1, value: 2 }], curves: ['a*x'], readouts: ['a^2'] },
    { type: 'quiz', correct: '\\b8\\b' },
    { type: 'diagram', minLeaves: 2 },
  ],
  proseFacts: ['\\b42\\b'],
};
const plot = { type: 'plot', title: 'P', x: { min: 0, max: 4 }, parameters: [{ name: 'c', label: 'C', min: 1, max: 4, step: 1, value: 2 }], series: [{ label: 'y', expression: 'c*x' }], outputs: [{ label: 'R', expression: 'c*c' }] };
const quiz = { type: 'quiz', title: 'Q', question: 'Q?', options: ['4', '8'], answer: 1, explanation: 'E' };
const diagram = { type: 'diagram', title: 'D', nodes: [{ id: 's', label: 'S' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 's', to: 'a' }, { from: 's', to: 'b' }] };
const statuses = (content) => evaluateAnswer(testCase, content).artefacts.map((item) => item.status);

describe('evaluateAnswer', () => {
  it('marks correct artefacts complete, matching sliders by range rather than by name', () => {
    expect(statuses(`42\n\n${fence(plot)}\n\n${fence(quiz)}\n\n${fence(diagram)}`)).toEqual(['complete', 'complete', 'complete']);
  });

  it('separates a wrong curve, readout or key (numeric) from a missing feature (incomplete) and an absent artefact (missing)', () => {
    expect(statuses(fence({ ...plot, series: [{ label: 'y', expression: 'c*x+1' }] }))[0]).toBe('numeric');
    expect(statuses(fence({ ...plot, outputs: [{ label: 'R', expression: 'c' }] }))[0]).toBe('numeric');
    expect(statuses(fence({ ...plot, parameters: [{ name: 'c', label: 'C', min: 1, max: 5, step: 1, value: 2 }] }))[0]).toBe('incomplete');
    expect(statuses(fence({ ...plot, y: { min: 0, max: 4 } }))[0]).toBe('incomplete');
    expect(statuses(fence({ ...quiz, answer: 0 }))[1]).toBe('numeric');
    expect(statuses(fence({ ...quiz, options: ['8', '8.0'], answer: 0 }))[1]).toBe('numeric');
    expect(statuses('No visual.')).toEqual(['missing', 'missing', 'missing']);
  });

  it('counts tree leaves and reports missing prose facts for review', () => {
    expect(statuses(fence({ ...diagram, edges: [{ from: 's', to: 'a' }] }))[2]).toBe('incomplete');
    expect(evaluateAnswer(testCase, 'text').prose.missing).toEqual(['\\b42\\b']);
    expect(evaluateAnswer(testCase, 'la valeur 42').prose.missing).toEqual([]);
  });

  it('does not count an unresolved request as an artefact', () => {
    expect(statuses('```student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n```')[1]).toBe('missing');
  });
});

describe('requestedVisual', () => {
  it('recognizes both pipelines', () => {
    expect(requestedVisual('Text.')).toBe(false);
    expect(requestedVisual('```student-visual-request\n{}\n```')).toBe(true);
    expect(requestedVisual(fence(quiz))).toBe(true);
  });
});

describe('decideGate', () => {
  const run = (arm, model, complete, numeric, extra = {}) => ({ kind: 'quality', arm, model, complete, numeric, required: 3, firstTextSeconds: 5, totalSeconds: 10, ...extra });
  const rates = (arm, explanatory, definitions) => [
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'rate', arm, group: 'explanatory', requested: index < explanatory })),
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'rate', arm, group: 'definitions', requested: index < definitions })),
  ];

  it('passes when every prospective criterion holds', () => {
    const results = [run('old', 'A', 1, 1), run('new', 'A', 3, 0, { firstTextSeconds: 4 }), run('old', 'B', 1, 0), run('new', 'B', 1, 0), ...rates('new', 8, 2)];
    expect(decideGate(results).pass).toBe(true);
  });

  it.each([
    ['fewer artefacts in total', [run('old', 'A', 3, 0), run('new', 'A', 2, 0), ...rates('new', 8, 2)], 'moreComplete'],
    ['one model worse', [run('old', 'A', 3, 0), run('new', 'A', 2, 0), run('old', 'B', 0, 0), run('new', 'B', 3, 0), ...rates('new', 8, 2)], 'noModelWorse'],
    ['a new numeric error', [run('old', 'A', 1, 0), run('new', 'A', 2, 1), ...rates('new', 8, 2)], 'noNewNumericErrors'],
    ['too few visuals', [run('old', 'A', 1, 0), run('new', 'A', 2, 0), ...rates('new', 7, 2)], 'visualRate'],
    ['too many on definitions', [run('old', 'A', 1, 0), run('new', 'A', 2, 0), ...rates('new', 8, 3)], 'definitionRate'],
    ['slow first text', [run('old', 'A', 1, 0), run('new', 'A', 2, 0, { firstTextSeconds: 11 }), ...rates('new', 8, 2)], 'firstText'],
  ])('fails on %s', (_name, results, criterion) => {
    const gate = decideGate(results);
    expect(gate.pass).toBe(false);
    expect(gate.criteria[criterion]).toBe(false);
  });
});
