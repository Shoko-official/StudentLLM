import { describe, expect, it } from 'vitest';
import { checkVisualAgainstBrief, disagreeingChecks, quizAgreesWithItself, quizWorkingPointsElsewhere, stillPlotNotes, quizWorkingNotes } from './visual-checks';
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
    expect(disagreeingChecks(plot, brief({ checks: [{ output: 'Peak', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });

  describe('a plot that cannot move', () => {
    const slider = (name: string) => ({ name, label: name, min: 0, max: 10, step: 1, value: 5 });
    const moving = (extra: Partial<Extract<TeachingVisual, { type: 'plot' }>>): TeachingVisual => ({ type: 'plot', title: 'T', x: { min: 0, max: 10 }, series: [{ label: 'Distance', expression: 'v*x' }], parameters: [slider('v')], ...extra });

    it('notes a curve that never uses x, which is what a formula copied with a reading slider gives', () => {
      const flat = moving({ parameters: [slider('v'), slider('t')], series: [{ label: 'Distance', expression: 'v*t' }], outputs: [{ label: 'At t', expression: 'v*t' }] });
      const notes = stillPlotNotes(flat);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('series "Distance" never uses x');
    });

    it('says what to do when the curve really is constant, and never rejects it', () => {
      for (const constant of [
        moving({ series: [{ label: 'Speed', expression: 'v' }] }),
        moving({ series: [{ label: 'I', expression: 'U/R' }], parameters: [slider('U'), { ...slider('R'), min: 1 }] }),
        moving({ parameters: [], series: [{ label: 'f', expression: '3' }] }),
      ]) {
        expect(stillPlotNotes(constant)[0]).toMatch(/If it is truly constant, keep it/);
        expect(checkVisualAgainstBrief(constant, brief())).toEqual([]);
      }
    });

    it('notes every curve when none uses x, and no curve when one does', () => {
      expect(stillPlotNotes(moving({ series: [{ label: 'A', expression: 'v' }, { label: 'B', expression: 'max(v,2)' }] }))).toHaveLength(2);
      expect(stillPlotNotes(moving({ series: [{ label: 'Curve', expression: 'v*x' }, { label: 'Threshold', expression: 'v' }] }))).toEqual([]);
    });

    it('accepts x inside a function or a sum, and does not take max or exp for x', () => {
      expect(stillPlotNotes(moving({ series: [{ label: 'S', expression: 'sum(k,0,v,x^k/factorial(k))' }] }))).toEqual([]);
      expect(stillPlotNotes(moving({ series: [{ label: 'S', expression: 'exp(max(v,1))' }] }))[0]).toContain('never uses x');
    });

    it('leaves supplied points alone', () => {
      expect(stillPlotNotes(moving({ parameters: [], series: [{ label: 'Data', points: [[0, 1], [1, 2]] }] }))).toEqual([]);
      expect(stillPlotNotes(moving({ parameters: [], series: [{ label: 'Data', points: [[0, 1], [1, 2]] }, { label: 'Level', expression: '1' }] }))).toEqual([]);
    });

    it('notes a slider that nothing uses, which is what readouts with typed-in values give', () => {
      const dead = moving({ parameters: [slider('v'), slider('n')], outputs: [{ label: 'At 3', expression: '3*2' }] });
      const notes = stillPlotNotes(dead);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('slider "n" changes nothing');
      expect(checkVisualAgainstBrief(dead, brief())).toEqual([]);
    });

    it('accepts a slider used only in a readout, and does not read a slider inside a longer name', () => {
      expect(stillPlotNotes(moving({ parameters: [slider('v'), slider('n')], outputs: [{ label: 'At n', expression: 'v*n' }] }))).toEqual([]);
      expect(stillPlotNotes(moving({ parameters: [slider('v'), slider('n')], outputs: [{ label: 'V', expression: 'sin(v)' }] }))[0]).toContain('slider "n"');
    });

    it('holds nothing to say about other visuals', () => {
      expect(stillPlotNotes({ type: 'quiz', title: 'T', question: 'Q?', options: ['A', 'B'], answer: 0, explanation: 'E' })).toEqual([]);
    });
  });

  it('rejects a different type', () => {
    expect(checkVisualAgainstBrief(quiz, brief())).toEqual(['expected a plot, received a quiz']);
  });

  it('names missing parameters and outputs', () => {
    expect(checkVisualAgainstBrief(plot, brief({ parameters: ['t'], outputs: ['Range'] }))).toEqual(['missing parameter "t"', 'missing readout "Range"']);
  });

  it('reports a check outside its tolerance as a disagreement, never as an error', () => {
    const wrong = brief({ checks: [{ output: 'Peak', at: { v0: 20 }, expected: 30, tolerance: 0.01 }] });
    expect(checkVisualAgainstBrief(plot, wrong)).toEqual([]);
    const [error] = disagreeingChecks(plot, wrong);
    expect(error).toContain('readout "Peak" at v0=20 gives 20.40');
    expect(error).toContain('expected 30');
  });

  it('uses a relative default tolerance and names an undeclared check parameter', () => {
    expect(disagreeingChecks(plot, brief({ checks: [{ output: 'Peak', at: {}, expected: 20.5 }] }))).toEqual([]);
    const undeclared = brief({ checks: [{ output: 'Peak', at: { z: 1 }, expected: 1 }] });
    expect(checkVisualAgainstBrief(plot, undeclared)).toEqual([]);
    expect(disagreeingChecks(plot, undeclared)[0]).toContain('undeclared parameter "z"');
  });

  it('reports disagreements for plots only', () => {
    expect(disagreeingChecks(quiz, brief({ type: 'quiz', checks: [{ output: 'Peak', at: {}, expected: 1 }] }))).toEqual([]);
  });

  it('rejects a series with no finite value at the default parameters', () => {
    const flat: TeachingVisual = { ...plot, series: [{ label: 'broken', expression: 'log(0-1-v0-x^2)' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(flat, brief())).toEqual(['series "broken" has no finite value at the default parameters']);
  });

  it('checks diagram nodes, quiz options and the keyed answer', () => {
    const diagram: TeachingVisual = { type: 'diagram', title: 'T', nodes: [{ id: 'a', label: 'Start' }], edges: [] };
    expect(checkVisualAgainstBrief(diagram, brief({ type: 'diagram', nodes: ['End'] }))).toEqual([]);
    expect(disagreeingChecks(diagram, brief({ type: 'diagram', nodes: ['End'] }))).toEqual(['missing node labelled "End"']);
    expect(checkVisualAgainstBrief({ ...quiz, options: ['A', ' a '] } as TeachingVisual, brief({ type: 'quiz' }))).toEqual(['quiz options must be distinct']);
    expect(disagreeingChecks(quiz, brief({ type: 'quiz', correctAnswer: '1 kPa' }))[0]).toContain('the keyed option is "2 kPa", expected "1 kPa"');
    expect(disagreeingChecks(quiz, brief({ type: 'quiz', correctAnswer: '2 KPA' }))).toEqual([]);
  });

  it('compares readout labels without case, accents or spacing', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite  a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(labelled, brief({ outputs: ['Quantité à t'] }))).toEqual([]);
    expect(disagreeingChecks(labelled, brief({ outputs: ['Quantité à t'], checks: [{ output: ' QUANTITÉ à  t ', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });

  it('still rejects a missing brief.outputs readout, and reports a check on a really different readout or a disagreeing value', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(labelled, brief({ outputs: ['Quantité à x'] }))).toEqual(['missing readout "Quantité à x"']);
    expect(checkVisualAgainstBrief(labelled, brief({ checks: [{ output: 'Quantité à x', at: {}, expected: 1 }] }))).toEqual([]);
    expect(disagreeingChecks(labelled, brief({ checks: [{ output: 'Quantité à x', at: {}, expected: 1 }] }))).toEqual(['missing readout "Quantité à x"']);
    expect(disagreeingChecks(labelled, brief({ outputs: ['Quantité à x'], checks: [{ output: 'Quantité à x', at: {}, expected: 1 }] }))).toEqual([]);
    expect(disagreeingChecks(labelled, brief({ checks: [{ output: 'Quantité à t', at: { v0: 20 }, expected: 30, tolerance: 0.01 }] }))[0]).toContain('gives 20.40');
  });

  it('keeps parameter names exact', () => {
    expect(checkVisualAgainstBrief(plot, brief({ parameters: ['V0'] }))).toEqual(['missing parameter "V0"']);
  });

  it('accepts a diagram node named by its label or by its id', () => {
    const diagram: TeachingVisual = { type: 'diagram', title: 'T', nodes: [{ id: 'depart', label: 'Départ' }, { id: 'S', label: 'Succès' }], edges: [] };
    expect(disagreeingChecks(diagram, brief({ type: 'diagram', nodes: ['depart', 'succes', 'DEPART'] }))).toEqual([]);
    expect(disagreeingChecks(diagram, brief({ type: 'diagram', nodes: ['Echec'] }))).toEqual(['missing node labelled "Echec"']);
  });

  it('treats a decimal comma like a decimal point in quiz answers and options', () => {
    const french: TeachingVisual = { type: 'quiz', title: 'T', question: 'Q?', options: ['0,5', '0,16807'], answer: 1, explanation: 'E' };
    expect(disagreeingChecks(french, brief({ type: 'quiz', correctAnswer: '0.16807' }))).toEqual([]);
    expect(disagreeingChecks(french, brief({ type: 'quiz', correctAnswer: '0.5' }))[0]).toContain('the keyed option is "0,16807"');
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
    expect(disagreeingChecks(options(['Energie', 'Force'], 0), brief({ type: 'quiz', correctAnswer: 'Énergie' }))).toEqual([]);
    expect(disagreeingChecks(options(['ou', 'où'], 0), brief({ type: 'quiz', correctAnswer: 'où' }))[0]).toContain('the keyed option is "ou", expected "où"');
    expect(disagreeingChecks(options(['ou', 'où'], 1), brief({ type: 'quiz', correctAnswer: 'où' }))).toEqual([]);
    expect(disagreeingChecks(options(['x', 'y'], 0), brief({ type: 'quiz', correctAnswer: 'x̄' }))).toEqual([]);
    expect(disagreeingChecks(options(['x', 'x̄'], 0), brief({ type: 'quiz', correctAnswer: 'x̄' }))[0]).toContain('the keyed option is "x"');
  });

  it('never rejects a quiz for its key alone: a wrong key in the request must not win', () => {
    expect(checkVisualAgainstBrief(quiz, brief({ type: 'quiz', correctAnswer: '1 kPa' }))).toEqual([]);
  });

  it('tells whether a quiz key agrees with its own explanation', () => {
    const made = (options: string[], answer: number, explanation: string) => ({ type: 'quiz', title: 'T', question: 'Q?', options, answer, explanation }) as TeachingVisual;
    expect(quizAgreesWithItself(made(['36', '48'], 1, 'On trouve 48 minutes.'))).toBe(true);
    expect(quizAgreesWithItself(made(['36', '48'], 0, 'On trouve 48 minutes.'))).toBe(false);
    expect(quizAgreesWithItself(made(['0,168', '0,5'], 0, 'P = 0.7^5 = 0.16807.'))).toBe(true);
    expect(quizAgreesWithItself(made(['2 kPa', '3 kPa'], 0, 'P = 2,0 kPa.'))).toBe(true);
    // A key with no number cannot be compared, and is not doubted for that.
    expect(quizAgreesWithItself(made(['Energy', 'Force'], 0, 'It is conserved.'))).toBe(true);
  });

  it('prefers an exact readout label over a normalised one', () => {
    const cased: TeachingVisual = { ...plot, outputs: [{ label: 'u', expression: '1' }, { label: 'U', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(disagreeingChecks(cased, brief({ outputs: ['u', 'U'], checks: [{ output: 'U', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
    expect(disagreeingChecks(cased, brief({ checks: [{ output: 'u', at: {}, expected: 1 }] }))).toEqual([]);
    expect(disagreeingChecks(cased, brief({ checks: [{ output: 'U', at: { v0: 20 }, expected: 1 }] }))[0]).toContain('gives 20.40');
    const only: TeachingVisual = { ...plot, outputs: [{ label: 'u', expression: '1' }] } as TeachingVisual;
    expect(checkVisualAgainstBrief(only, brief({ outputs: ['u', 'U'] }))).toEqual(['missing readout "U"']);
  });

  it('falls back to the normalised readout label when no exact label exists', () => {
    const labelled: TeachingVisual = { ...plot, outputs: [{ label: 'Quantite a t', expression: 'v0^2/19.6' }] } as TeachingVisual;
    expect(disagreeingChecks(labelled, brief({ checks: [{ output: 'Quantité à t', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }))).toEqual([]);
  });
});

describe('quizWorkingNotes', () => {
  const quiz = (options: string[], answer: number, explanation: string) => ({ type: 'quiz' as const, title: 'T', question: 'Q?', options, answer, explanation });
  const flagged = (options: string[], answer: number, explanation: string) => quizWorkingNotes(quiz(options, answer, explanation)).length > 0;

  it.each([
    ['a product that goes on', ['12', '36'], 0, 'On a = 3 x 4 = 36.'],
    ['a percentage for a decimal', ['20 %', '40 %'], 1, 'p = 0,2, donc on garde 0,4.'],
    ['a decimal comma', ['2.5', '3'], 1, 'S = 2,5.'],
    ['a fraction', ['1/2', '1/4'], 1, 'P = 0,5.'],
    ['a LaTeX fraction', ['$\\frac{1}{2}$', '$\\frac{1}{4}$'], 1, 'P = 0.5.'],
    ['scientific notation', ['6 x 10^3', '6 x 10^4'], 0, 'N = 60000.'],
    ['a thousands space', ['1 000', '2 000'], 1, 'N = 1000.'],
  ])('flags the key against the result through %s', (_name, options, answer, explanation) => { expect(flagged(options, answer, explanation)).toBe(true); });

  it.each([
    ['the key is the result', ['12', '36'], 1, 'On a = 3 x 12 = 36.'],
    ['the result carries a unit', ['20 mg', '40 mg'], 0, '80 x 1/4 = 20 mg.'],
    ['a bracket holds the only number', ['1', '2'], 0, 'On cherche P(X = 2).'],
    ['the working has no result', ['12', '36'], 0, 'On trouve 36.'],
    ['the options hold no number and none is reached', ['oui', 'non'], 0, 'x = 3.'],
  ])('does not flag when %s', (_name, options, answer, explanation) => { expect(flagged(options, answer, explanation)).toBe(false); });

  it('flags a key with no number when another option holds the result', () => {
    expect(flagged(['aucune', '48'], 0, 'T = 48.')).toBe(true);
  });
});

describe('a key compared with the answer in the request', () => {
  const brief = (correctAnswer: string) => ({ id: 'v1', type: 'quiz' as const, intent: 'I', content: 'C', correctAnswer });
  const checks = (key: string, expected: string) => disagreeingChecks({ type: 'quiz', title: 'T', question: 'Q?', options: [key, 'autre'], answer: 0, explanation: 'E.' }, brief(expected));

  it.each([
    ['3', '-3'], ['2 m/s', '-2 m/s'], ['2 m', '2 km'], ['2 MPa', '2 kPa'], ['0,5 %', '50 %'], ['y = 2', 'x = 2'],
    ['101', '100'], ['1792', '1789'], ['50 %', '0.5 kg'], ['0.5 kg', '50 %'],
    ['0,2', '0,24'], ['1,5', '1,46'], ['0,16807', '0,17'], ['0,17', '0.16807'], ['3', '3,4'],
  ])('tells %j from %j', (key, expected) => { expect(checks(key, expected)).toHaveLength(1); });

  it.each([
    ['1/2', '0.5'], ['50 %', '0.5'], ['0.5', '50 %'], ['48 min', '48'], ['48', '48 min'], ['2,5', '2.5'], ['0,168', '0.16807'], ['3,1416', '3,14'], ['-3', '-3.0'], ['−3', '-3'], ['x = 2', 'x=2'],
  ])('takes %j for %j', (key, expected) => { expect(checks(key, expected)).toEqual([]); });
});

describe('what the working check reads', () => {
  const quiz = (options: string[], answer: number, explanation: string) => ({ type: 'quiz' as const, title: 'T', question: 'Q?', options, answer, explanation });
  const notes = (options: string[], answer: number, explanation: string) => quizWorkingNotes(quiz(options, answer, explanation));

  it.each([
    ['a further result with a unit', ['48 min', '36 min'], 0, 'Total = 48 min, soit 48 min = 0,8 h.'],
    ['a conversion', ['2 km', '2000 km'], 0, 'd = 2 km = 2000 m.'],
    ['a final parameter', ['0.16807', '0.3'], 0, 'P = 0.7^5 = 0.16807. C\'est le cas k=0 de la formule.'],
    ['a check at the end', ['60', '120'], 0, 'v = 120 / 2 = 60. Vérification : 60 x 2 = 120.'],
    ['an aside', ['48', '3'], 0, 'T = 48. Rappel : 3 conditions.'],
    ['a negative result', ['-3', '5'], 0, 'a = 2, b = 5, x = -3.'],
    ['a bold result', ['48', '36'], 0, 'T = 24 + 24 = **48**.'],
    ['a result in brackets', ['48', '36'], 0, 'On trouve bien (T = 48).'],
    ['a bullet after the result', ['48', '36'], 0, 'T = 48\n- 36 vient d\'une erreur'],
    ['a dash after the result', ['48', '36'], 0, 'T = 48 - la bonne valeur'],
    ['a rounded key', ['0,168', '0,3'], 0, 'P = 0.16807.'],
  ])('does not flag a right key through %s', (_name, options, answer, explanation) => { expect(notes(options, answer, explanation)).toEqual([]); });

  it('flags a key that the working only mentions, with a sign read', () => {
    expect(notes(['3', '-3'], 0, 'On obtient x = -3.')[0]).toContain('the option "-3"');
    expect(notes(['36', '48'], 0, 'T = 48. Le 36 vient d\'une erreur.')[0]).toContain('the option "48"');
  });

  it('asks to derive the answer again and keep a right key, and states no reading as fact', () => {
    for (const note of [...notes(['36', '48'], 0, 'T = 48.'), ...notes(['36', '40'], 0, 'T = 48.')]) {
      expect(note).toMatch(/may end on 48/);
      expect(note).toMatch(/Derive the answer again from the question and keep the key if it is right/);
      expect(note).not.toMatch(/reaches/);
    }
  });

  it('says the working points elsewhere only when it states another option and not the key', () => {
    expect(quizWorkingPointsElsewhere(quiz(['0,2', '0,24'], 0, 'P = 0,24.'))).toBe(true);
    expect(quizWorkingPointsElsewhere(quiz(['0,16807', '0,24'], 0, 'P ≈ 0,17.'))).toBe(false);
    expect(quizWorkingPointsElsewhere(quiz(['48', '36'], 0, 'On obtient 48, pas 36.'))).toBe(false);
    expect(quizWorkingPointsElsewhere(quiz(['aucune', '48'], 0, 'T = 48.'))).toBe(false);
  });

  it('does not take 0,5 % for a result of 0,5', () => {
    expect(notes(['0,5 %', '50 %'], 0, 'P = 0,5.')[0]).toContain('the option "50 %"');
  });

  it('accepts a rounded key in the check against its own working', () => {
    expect(quizAgreesWithItself(quiz(['0,168', '0,3'], 0, 'P = 0.16807.'))).toBe(true);
    expect(quizAgreesWithItself(quiz(['0,2', '0,24'], 0, 'P = 0,24.'))).toBe(false);
    expect(quizAgreesWithItself(quiz(['3', '-3'], 0, 'x = -3.'))).toBe(false);
    expect(quizAgreesWithItself(quiz(['3', '3,4'], 0, 'x = 3,4.'))).toBe(false);
  });
});
