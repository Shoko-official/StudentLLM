import { describe, expect, it } from 'vitest';
import { compileExpression } from '../../src/lib/teaching-visuals.ts';
import cases from './cases.json';
import { decideGate, evaluateAnswer, parseAmount, requestedVisual } from './evaluate.mjs';

const fence = (value) => '```student-visual\n' + JSON.stringify(value) + '\n```';
const testCase = {
  artefacts: [
    { type: 'plot', x: { min: 0, max: 4 }, yCovers: [0, 16], sliders: [{ key: 'a', min: 1, max: 4, step: 1, value: 2 }], curves: ['a*x'], readouts: ['a^2'] },
    { type: 'quiz', correct: { value: 8, unit: '' } },
    { type: 'diagram', minLeaves: 2 },
  ],
  proseFacts: ['\\b42\\b'],
};
const plot = { type: 'plot', title: 'P', x: { min: 0, max: 4 }, parameters: [{ name: 'c', label: 'C', min: 1, max: 4, step: 1, value: 2 }], series: [{ label: 'y', expression: 'c*x' }], outputs: [{ label: 'R', expression: 'c*c' }] };
const quiz = { type: 'quiz', title: 'Q', question: 'Q?', options: ['4', '8'], answer: 1, explanation: 'E' };
const diagram = { type: 'diagram', title: 'D', nodes: [{ id: 's', label: 'S' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 's', to: 'a' }, { from: 's', to: 'b' }] };
const brief = '{"id":"v","type":"plot","intent":"i","content":"c"}';
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

  it('does not map two sliders of the same range to one parameter', () => {
    const twins = { artefacts: [{ type: 'plot', x: { min: 0, max: 1 }, sliders: [{ key: 'a', min: 0, max: 1, step: 1, value: 0 }, { key: 'b', min: 0, max: 1, step: 1, value: 0 }], curves: ['b*x'] }] };
    const parameter = (name) => ({ name, label: name, min: 0, max: 1, step: 1, value: 0 });
    const one = { type: 'plot', title: 'P', x: { min: 0, max: 1 }, parameters: [parameter('c')], series: [{ label: 'y', expression: 'c*x' }] };
    expect(evaluateAnswer(twins, fence(one)).artefacts[0].status).toBe('incomplete');
    const two = { ...one, parameters: [parameter('c'), parameter('d')], series: [{ label: 'y', expression: 'c*x' }] };
    expect(evaluateAnswer(twins, fence(two)).artefacts[0].status).toBe('complete');
    expect(evaluateAnswer(twins, fence({ ...two, series: [{ label: 'y', expression: '(c+d)*x' }] })).artefacts[0].status).toBe('numeric');
  });
});

describe('quiz values', () => {
  const check = (correct, option) => {
    const spec = { artefacts: [{ type: 'quiz', correct }] };
    return evaluateAnswer(spec, fence({ ...quiz, options: [option, 'zzz'], answer: 0 })).artefacts[0].status;
  };

  it('reads comma or dot decimals with or without a space before the unit', () => {
    expect(parseAmount('8 V')).toEqual({ value: 8, unit: 'V' });
    expect(parseAmount('2,5')).toEqual({ value: 2.5, unit: '' });
    for (const option of ['8 V', '8V', '8,0 V', '8.00 V']) expect(check({ value: 8, unit: 'V' }, option)).toBe('complete');
  });

  it('does not match a value by accident', () => {
    expect(check({ value: 8, unit: 'V' }, '2,8 V')).toBe('numeric');
    expect(check({ value: 8, unit: 'V' }, '1,8 V')).toBe('numeric');
    expect(check({ value: 8, unit: 'V' }, '8 mV')).toBe('numeric');
    expect(check({ value: 8, unit: 'V' }, '8')).toBe('numeric');
    expect(check({ value: 20, unit: 'mg' }, '5,20 mg')).toBe('numeric');
    expect(check({ value: 2.5, unit: '' }, '2.54')).toBe('numeric');
    expect(check({ value: 2.5, unit: '' }, '12,5')).toBe('numeric');
    expect(check({ value: 0.16807, unit: '', tolerance: 0.0005 }, '16,8 %')).toBe('numeric');
    expect(check({ value: 0.16807, unit: '', tolerance: 0.0005 }, '0,17')).toBe('numeric');
    expect(check({ value: 0.16807, unit: '', tolerance: 0.0005 }, '0,168')).toBe('complete');
  });
});

describe('prose facts', () => {
  const facts = { artefacts: [], proseFacts: ['\\b10\\b'] };

  it('read the prose only, never a visual or a request', () => {
    const request = '```student-visual-request\n{"id":"v","type":"plot","intent":"i","content":"c","checks":[{"output":"o","at":{},"expected":10}]}\n```';
    expect(evaluateAnswer(facts, `Texte.\n\n${request}`).prose.missing).toEqual(['\\b10\\b']);
    expect(evaluateAnswer(facts, `Texte.\n\n${fence({ ...quiz, explanation: 'valeur 10' })}`).prose.missing).toEqual(['\\b10\\b']);
    expect(evaluateAnswer(facts, `Il reste 10 mg.\n\n${request}`).prose.missing).toEqual([]);
  });
});

describe('visual detection follows the app', () => {
  const quizText = fence(quiz);
  const quizStatus = (content) => statuses(content)[1];

  it('counts requests the way the tutor pipeline does', () => {
    expect(requestedVisual('Text.')).toBe(false);
    expect(requestedVisual(`\`\`\`student-visual-request\n${brief}\n\`\`\``)).toBe(true);
    expect(requestedVisual(quizText)).toBe(true);
    expect(requestedVisual(`Texte\r\n\r\n\`\`\`student-visual-request\r\n${brief}\r\n\`\`\``)).toBe(true);
    expect(requestedVisual(`Texte\n\n\`\`\`student-visual-request title\n${brief}\n\`\`\``)).toBe(true);
    expect(requestedVisual(`Texte\n\n~~~student-visual-request\n${brief}\n~~~`)).toBe(true);
  });

  it('does not count what the app would not render', () => {
    expect(requestedVisual('```student-visual-request\n{}\n```')).toBe(false);
    expect(requestedVisual(`Texte\n\n\`\`\`student-visual-request\n{"id":"v bad","type":"plot"}\n\`\`\``)).toBe(false);
    expect(requestedVisual(`- item\n\n  \`\`\`student-visual-request\n  ${brief}\n  \`\`\``)).toBe(false);
    expect(requestedVisual(`\`\`\`\`markdown\n\`\`\`student-visual-request\n${brief}\n\`\`\`\n\`\`\`\``)).toBe(false);
    expect(quizStatus(`\`\`\`\`markdown\n${quizText}\n\`\`\`\``)).toBe('missing');
    expect(quizStatus(`~~~\n${quizText}\n~~~`)).toBe('missing');
  });

  it('accepts a visual with an info string or tilde fence', () => {
    expect(quizStatus(`~~~student-visual\n${JSON.stringify(quiz)}\n~~~`)).toBe('complete');
    expect(quizStatus(`\`\`\`student-visual extra\n${JSON.stringify(quiz)}\n\`\`\``)).toBe('complete');
  });

  it('ignores a visual beyond the budget of eight', () => {
    const figure = fence({ type: 'figure', title: 'F', width: 300, height: 300, shapes: [{ type: 'text', x: 1, y: 1, text: 't' }] });
    expect(quizStatus([...Array.from({ length: 7 }, () => figure), quizText].join('\n\n'))).toBe('complete');
    expect(quizStatus([...Array.from({ length: 8 }, () => figure), quizText].join('\n\n'))).toBe('missing');
  });
});

const MODELS = ['A', 'B'];
const expectedCells = (models = MODELS, cases = [['d1', 'dev'], ['h1', 'holdout'], ['h2', 'holdout']]) => models.flatMap((model) => [
  ...cases.flatMap(([id, split]) => ['old', 'new'].map((arm) => ({ cell: `quality/${model}/${id}/${arm}/0`, kind: 'quality', model, arm, case: id, split, sample: 0 }))),
  ...['explanatory', 'definitions'].flatMap((group) => Array.from({ length: 10 }, (_, index) => ['old', 'new'].map((arm) => ({ cell: `rate/${model}/${group}/${index}/${arm}`, kind: 'rate', model, arm, group, index }))).flat()),
]);
const defaultRow = (entry) => entry.kind === 'quality'
  ? { ...entry, required: 3, complete: entry.arm === 'new' ? 3 : 1, numeric: 0, firstTextSeconds: 5, totalSeconds: entry.arm === 'new' ? 20 : 10, contentHash: `${entry.cell}` }
  : { ...entry, requested: entry.arm === 'new' && entry.group === 'explanatory' ? entry.index < 9 : entry.arm === 'new' && entry.index < 1 };
const world = (tweak = (_entry, row) => row, models = MODELS, cases) => {
  const expected = expectedCells(models, cases);
  const results = expected.map((entry) => tweak(entry, defaultRow(entry))).filter(Boolean);
  return { expected, results };
};
const gateOf = ({ expected, results }) => decideGate(results, expected);
const failed = (row, seconds = 3) => ({ ...row, failed: true, error: 'rejected', complete: 0, numeric: 0, requested: false, firstTextSeconds: seconds, totalSeconds: seconds });

describe('decideGate', () => {
  it('passes when every prospective criterion holds on complete data', () => {
    const gate = gateOf(world());
    expect(gate.incomplete).toBe(false);
    expect(gate.pass).toBe(true);
  });

  it.each([
    ['fewer artefacts in total', (entry, row) => entry.arm === 'new' ? { ...row, complete: 0 } : row, 'moreComplete'],
    ['one model worse', (entry, row) => entry.arm === 'new' && entry.model === 'B' ? { ...row, complete: 0 } : row, 'noModelWorse'],
    ['a new numeric error', (entry, row) => entry.arm === 'new' && entry.cell.includes('/h1/') && entry.model === 'A' ? { ...row, numeric: 1 } : row, 'noNewNumericErrors'],
    ['too few visuals', (entry, row) => entry.arm === 'new' && entry.group === 'explanatory' ? { ...row, requested: entry.index < 7 } : row, 'visualRate'],
    ['too many on definitions', (entry, row) => entry.arm === 'new' && entry.group === 'definitions' ? { ...row, requested: entry.index < 3 } : row, 'definitionRate'],
    ['slow first text', (entry, row) => entry.arm === 'new' && entry.kind === 'quality' ? { ...row, firstTextSeconds: 11 } : row, 'firstText'],
  ])('fails on %s', (_name, tweak, criterion) => {
    const gate = gateOf(world(tweak));
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(false);
    expect(gate.criteria[criterion]).toBe(false);
  });

  it('is incomplete, never a pass, when an expected cell has no measurement', () => {
    const gate = gateOf(world((entry, row) => entry.cell === 'quality/B/h2/new/0' ? null : row));
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
    expect(gate.details.missing).toEqual(['quality/B/h2/new/0']);
  });

  it('does not let a missing model or arm satisfy a criterion', () => {
    const noOldForB = gateOf(world((entry, row) => entry.model === 'B' && entry.arm === 'old' && entry.kind === 'quality' ? null : row));
    expect(noOldForB.pass).toBe(false);
    expect(noOldForB.incomplete).toBe(true);
    expect(noOldForB.criteria.firstText).toBe(false);
    const noModelB = decideGate(world().results.filter((row) => row.model === 'A'), expectedCells(MODELS));
    expect(noModelB.pass).toBe(false);
    expect(noModelB.incomplete).toBe(true);
  });

  it('needs both holdouts', () => {
    const one = gateOf(world(undefined, MODELS, [['d1', 'dev'], ['h1', 'holdout']]));
    expect(one.pass).toBe(false);
    expect(one.incomplete).toBe(true);
    expect(one.details.reasons).toContain('no holdouts');
    expect(gateOf(world(undefined, MODELS, [['d1', 'dev']])).details.reasons).toContain('no holdouts');
  });

  it('counts a failed row as not complete, and lets it satisfy nothing', () => {
    const newFails = gateOf(world((entry, row) => entry.arm === 'new' && entry.cell.includes('/h1/') && entry.model === 'A' ? failed(row) : row));
    expect(newFails.incomplete).toBe(false);
    expect(newFails.details.complete.new).toBe(15);
    expect(newFails.criteria.noModelWorse).toBe(true);
    const bothDead = gateOf(world((entry, row) => entry.model === 'B' && entry.kind === 'quality' ? failed(row) : row));
    expect(bothDead.pass).toBe(false);
    expect(bothDead.incomplete).toBe(true);
  });

  it('ignores the clock of a failed old row', () => {
    const fastFailures = gateOf(world((entry, row) => entry.arm === 'old' && entry.kind === 'quality' && entry.case === 'd1' ? failed(row, 1) : row));
    expect(fastFailures.details.perModel.A.oldTotal).toBe(10);
    expect(fastFailures.criteria.firstText).toBe(true);
    const allOldFailed = gateOf(world((entry, row) => entry.arm === 'old' && entry.kind === 'quality' ? failed(row, 1) : row));
    expect(allOldFailed.criteria.firstText).toBe(false);
    expect(allOldFailed.pass).toBe(false);
  });

  it('does not pass the definition rate when its rows fail', () => {
    const gate = gateOf(world((entry, row) => entry.arm === 'new' && entry.group === 'definitions' ? failed(row) : row));
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(true);
  });

  it('counts a failed explanatory row as not requested', () => {
    const gate = gateOf(world((entry, row) => entry.arm === 'new' && entry.group === 'explanatory' && entry.index < 3 ? failed(row) : row));
    expect(gate.criteria.visualRate).toBe(false);
  });

  it('reports how many samples are identical', () => {
    const cases = [['d1', 'dev'], ['h1', 'holdout'], ['h2', 'holdout']];
    const expected = [0, 1].flatMap((sample) => expectedCells(['A'], cases).filter((entry) => entry.kind === 'quality').map((entry) => ({ ...entry, sample, cell: entry.cell.replace(/\/0$/, `/${sample}`) })));
    const results = expected.map((entry) => ({ ...defaultRow(entry), contentHash: entry.arm === 'old' ? 'same' : `${entry.cell}` }));
    const duplicates = decideGate(results, expected).details.duplicates;
    expect(duplicates).toEqual({ identical: 3, pairs: 6 });
  });
});

describe('cases.json', () => {
  it('states every quiz as a number and a unit, and every expression in the app language', () => {
    for (const item of cases.quality) {
      for (const artefact of item.artefacts) {
        if (artefact.type === 'quiz') expect(Number.isFinite(artefact.correct.value) && typeof artefact.correct.unit === 'string').toBe(true);
        for (const expression of [...(artefact.curves ?? []), ...(artefact.readouts ?? [])]) expect(compileExpression(expression), expression).not.toBeNull();
      }
    }
  });
});
