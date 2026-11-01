import { describe, expect, it } from 'vitest';
import { checkVisualAgainstBrief } from './visual-checks';
import type { TeachingVisual } from './teaching-visuals';
import type { VisualBrief } from './visual-brief';

const brief = (extra: Partial<VisualBrief> = {}): VisualBrief => ({ id: 'v1', type: 'plot', intent: 'I', content: 'C', ...extra });
const plot: TeachingVisual = {
  type: 'plot', title: 'Height', x: { min: 0, max: 7 },
  parameters: [{ name: 'v0', label: 'Speed', min: 5, max: 30, step: 5, value: 20 }],
  series: [{ label: 'h', expression: 'v0*x-4.9*x^2' }],
  outputs: [{ label: 'Peak', expression: 'v0^2/19.6', unit: 'm' }],
};
const quiz: TeachingVisual = { type: 'quiz', title: 'T', question: 'Q?', options: ['1 kPa', '2 kPa'], answer: 1, explanation: 'E' };

describe('checkVisualAgainstBrief', () => {
  it('accepts a visual that satisfies its brief', () => {
    expect(checkVisualAgainstBrief(plot, brief({ parameters: ['v0'], outputs: ['Peak'], checks: [{ output: 'Peak', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });

  it('rejects a different type', () => {
    expect(checkVisualAgainstBrief(quiz, brief())).toEqual(['expected a plot, received a quiz']);
  });

  it('names missing parameters and outputs', () => {
    expect(checkVisualAgainstBrief(plot, brief({ parameters: ['t'], outputs: ['Range'] }))).toEqual(['missing parameter "t"', 'missing readout "Range"']);
  });

  it('reports a check outside its tolerance with both values', () => {
    const [error] = checkVisualAgainstBrief(plot, brief({ checks: [{ output: 'Peak', at: { v0: 20 }, expected: 30, tolerance: 0.01 }] }));
    expect(error).toContain('readout "Peak" at v0=20 gives 20.40');
    expect(error).toContain('expected 30');
  });

  it('uses a relative default tolerance and names an undeclared check parameter', () => {
    expect(checkVisualAgainstBrief(plot, brief({ checks: [{ output: 'Peak', at: {}, expected: 20.5 }] }))).toEqual([]);
    expect(checkVisualAgainstBrief(plot, brief({ checks: [{ output: 'Peak', at: { z: 1 }, expected: 1 }] }))[0]).toContain('undeclared parameter "z"');
  });

  it('rejects a series with no finite value at the default parameters', () => {
    const flat: TeachingVisual = { ...plot, series: [{ label: 'broken', expression: 'log(0-1-v0-x^2)' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(flat, brief())).toEqual(['series "broken" has no finite value at the default parameters']);
  });

  it('checks diagram nodes, quiz options and the keyed answer', () => {
    const diagram: TeachingVisual = { type: 'diagram', title: 'T', nodes: [{ id: 'a', label: 'Start' }], edges: [] };
    expect(checkVisualAgainstBrief(diagram, brief({ type: 'diagram', nodes: ['End'] }))).toEqual(['missing node labelled "End"']);
    expect(checkVisualAgainstBrief({ ...quiz, options: ['A', ' a '] } as TeachingVisual, brief({ type: 'quiz' }))).toEqual(['quiz options must be distinct']);
    expect(checkVisualAgainstBrief(quiz, brief({ type: 'quiz', correctAnswer: '1 kPa' }))[0]).toContain('the keyed option is "2 kPa", expected "1 kPa"');
    expect(checkVisualAgainstBrief(quiz, brief({ type: 'quiz', correctAnswer: '2 KPA' }))).toEqual([]);
  });

  it('compares readout labels without case, accents or spacing', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite  a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(labelled, brief({ outputs: ['Quantité à t'], checks: [{ output: ' QUANTITÉ à  t ', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });

  it('still rejects a readout that is really different, or a value that disagrees', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(labelled, brief({ outputs: ['Quantité à x'] }))).toEqual(['missing readout "Quantité à x"']);
    expect(checkVisualAgainstBrief(labelled, brief({ checks: [{ output: 'Quantité à x', at: {}, expected: 1 }] }))).toEqual(['missing readout "Quantité à x"']);
    expect(checkVisualAgainstBrief(labelled, brief({ checks: [{ output: 'Quantité à t', at: { v0: 20 }, expected: 30, tolerance: 0.01 }] }))[0]).toContain('gives 20.40');
  });

  it('keeps parameter names exact', () => {
    expect(checkVisualAgainstBrief(plot, brief({ parameters: ['V0'] }))).toEqual(['missing parameter "V0"']);
  });

  it('accepts a diagram node named by its label or by its id', () => {
    const diagram: TeachingVisual = { type: 'diagram', title: 'T', nodes: [{ id: 'depart', label: 'Départ' }, { id: 'S', label: 'Succès' }], edges: [] };
    expect(checkVisualAgainstBrief(diagram, brief({ type: 'diagram', nodes: ['depart', 'succes', 'DEPART'] }))).toEqual([]);
    expect(checkVisualAgainstBrief(diagram, brief({ type: 'diagram', nodes: ['Echec'] }))).toEqual(['missing node labelled "Echec"']);
  });

  it('treats a decimal comma like a decimal point in quiz answers and options', () => {
    const french: TeachingVisual = { type: 'quiz', title: 'T', question: 'Q?', options: ['0,5', '0,16807'], answer: 1, explanation: 'E' };
    expect(checkVisualAgainstBrief(french, brief({ type: 'quiz', correctAnswer: '0.16807' }))).toEqual([]);
    expect(checkVisualAgainstBrief(french, brief({ type: 'quiz', correctAnswer: '0.5' }))[0]).toContain('the keyed option is "0,16807"');
    expect(checkVisualAgainstBrief({ ...french, options: ['0,5', '0.5'] } as TeachingVisual, brief({ type: 'quiz' }))).toEqual(['quiz options must be distinct']);
    expect(checkVisualAgainstBrief({ ...french, options: ['a, b', 'a. b'] } as TeachingVisual, brief({ type: 'quiz' }))).toEqual([]);
  });
  it('keeps diacritics when comparing quiz options', () => {
    const options = (list: string[]) => ({ ...quiz, options: list, answer: 0 }) as TeachingVisual;
    for (const pair of [['a', 'à'], ['ou', 'où'], ['мой', 'мои'], ['か', 'が']]) {
      expect(checkVisualAgainstBrief(options(pair), brief({ type: 'quiz' }))).toEqual([]);
    }
    expect(checkVisualAgainstBrief(options(['Où', ' où ']), brief({ type: 'quiz' }))).toEqual(['quiz options must be distinct']);
  });

  it('accepts an accent-only key mismatch only when no other option folds to the same text', () => {
    const options = (list: string[], answer: number) => ({ ...quiz, options: list, answer }) as TeachingVisual;
    expect(checkVisualAgainstBrief(options(['Energie', 'Force'], 0), brief({ type: 'quiz', correctAnswer: 'Énergie' }))).toEqual([]);
    expect(checkVisualAgainstBrief(options(['ou', 'où'], 0), brief({ type: 'quiz', correctAnswer: 'où' }))[0]).toContain('the keyed option is "ou", expected "où"');
    expect(checkVisualAgainstBrief(options(['ou', 'où'], 1), brief({ type: 'quiz', correctAnswer: 'où' }))).toEqual([]);
    expect(checkVisualAgainstBrief(options(['x', 'y'], 0), brief({ type: 'quiz', correctAnswer: 'x̄' }))).toEqual([]);
    expect(checkVisualAgainstBrief(options(['x', 'x̄'], 0), brief({ type: 'quiz', correctAnswer: 'x̄' }))[0]).toContain('the keyed option is "x"');
  });

  it('prefers an exact readout label over a normalised one', () => {
    const cased: TeachingVisual = { ...plot, outputs: [{ label: 'u', expression: '1' }, { label: 'U', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(cased, brief({ outputs: ['u', 'U'], checks: [{ output: 'U', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
    expect(checkVisualAgainstBrief(cased, brief({ checks: [{ output: 'u', at: {}, expected: 1 }] }))).toEqual([]);
    const only: TeachingVisual = { ...plot, outputs: [{ label: 'u', expression: '1' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(only, brief({ outputs: ['u', 'U'] }))).toEqual(['missing readout "U"']);
  });

  it('falls back to the normalised readout label when no exact label exists', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(labelled, brief({ checks: [{ output: 'Quantité à t', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });
});
