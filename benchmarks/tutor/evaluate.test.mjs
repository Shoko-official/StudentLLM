import { describe, expect, it } from 'vitest';
import { compileExpression } from '../../src/lib/teaching-visuals.ts';
import cases from './cases.json';
import { decideGate, evaluateAnswer, matchAmount, requestedVisual, scoreSafely, validateCases } from './evaluate.mjs';

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
  const check = (correct, option, others = ['zzz'], answer = 0) => {
    const spec = { artefacts: [{ type: 'quiz', correct }] };
    return evaluateAnswer(spec, fence({ ...quiz, options: [option, ...others], answer })).artefacts[0].status;
  };
  const volts = { value: 8, unit: 'V' }, milligrams = { value: 20, unit: 'mg' }, plain = { value: 2.5, unit: '' }, probability = { value: 0.16807, unit: '', tolerance: 0.0005 };

  it('finds the expected number among the numbers of an option', () => {
    expect(matchAmount('P2(1) = 2,5', plain)).toBe('match');
    expect(matchAmount('≈ 0,168', probability)).toBe('match');
    expect(matchAmount('2,8 V', volts)).toBe('none');
  });

  it('accepts comma or dot decimals, a missing unit and a compatible unit', () => {
    for (const option of ['8 V', '8V', '8,0 V', '8.00 V', '8', '8 Vcc', '8 volts']) expect(check(volts, option)).toBe('complete');
    for (const option of ['20', '20 mg', '20 milligrammes', '20 mg restants']) expect(check(milligrams, option)).toBe('complete');
    expect(check(plain, 'P2(1) = 2,5')).toBe('complete');
    expect(check(probability, '≈ 0,168')).toBe('complete');
  });

  it('does not match a value by accident', () => {
    for (const option of ['2,8 V', '1,8 V']) expect(check(volts, option)).toBe('numeric');
    expect(check(milligrams, '5,20 mg')).toBe('numeric');
    for (const option of ['2.54', '12,5']) expect(check(plain, option)).toBe('numeric');
    for (const option of ['1,6 %', '0,2', '0,5']) expect(check(probability, option), option).toBe('numeric');
  });

  it('calls the right number with an incompatible unit incomplete, and a wrong key numeric', () => {
    expect(check(volts, '8 mV')).toBe('incomplete');
    expect(check(volts, '8 A', ['4 V'])).toBe('incomplete');
    expect(check(volts, '4 V', ['no number'])).toBe('numeric');
    expect(check(volts, 'none', ['nothing'])).toBe('incomplete');
    expect(check(volts, '4 V', ['8 V'], 0)).toBe('numeric');
  });

  it('does not take the first letter of a unit for the unit', () => {
    for (const option of ['20 min', '20 mL', '20 m', '20 mol', '20 g']) expect(check(milligrams, option), option).toBe('incomplete');
    expect(matchAmount('20 min', milligrams)).toBe('unit');
    expect(matchAmount('20 mg', milligrams)).toBe('match');
    const metre = { value: 5, unit: 'm' };
    expect(check(metre, '5 m', ['5 mm', '5 cm'])).toBe('complete');
    expect(check(metre, '5 mm', ['5 m', '5 cm'], 0)).toBe('incomplete');
    expect(check(metre, '5 mm', ['5 cm', '5 km'])).toBe('incomplete');
    for (const option of ['5 m', '5m', '5 mètres', '5 metres', '5 Mètres', '5 m.']) expect(check(metre, option), option).toBe('complete');
    for (const option of ['5 min', '5 mm', '5 m2', '5 m²', '5 m/s', '5 m.s-1', '5 mol', '5 mmol']) expect(check(metre, option), option).toBe('incomplete');
  });

  it('knows common spellings, with their plural, and keeps the case that changes the meaning', () => {
    const cases = [
      [{ value: 8, unit: 'V' }, ['8 V', '8 Vcc', '8 volt', '8 volts', '8 Volts', 'U = 8 V'], ['8 mV', '8 MV', '8 kV', '8 v', '8 V/m', '8 A', '8 Vrms']],
      [{ value: 3, unit: 'A' }, ['3 A', '3 ampères', '3 ampere'], ['3 mA', '3 Ah', '3 a']],
      [{ value: 3, unit: 'W' }, ['3 W', '3 watts'], ['3 mW', '3 Wh', '3 kW']],
      [{ value: 3, unit: 'J' }, ['3 J', '3 joules'], ['3 kJ', '3 mJ']],
      [{ value: 3, unit: 'N' }, ['3 N', '3 newtons'], ['3 mN', '3 N.m']],
      [{ value: 3, unit: 'Pa' }, ['3 Pa', '3 pascals'], ['3 kPa', '3 hPa', '3 P']],
      [{ value: 3, unit: 'Hz' }, ['3 Hz', '3 hertz'], ['3 kHz', '3 MHz']],
      [{ value: 3, unit: 's' }, ['3 s', '3 secondes', '3 seconds', '3 sec'], ['3 ms', '3 min', '3 S']],
      [{ value: 3, unit: 'g' }, ['3 g', '3 grammes'], ['3 kg', '3 mg', '3 G']],
      [{ value: 3, unit: 'kg' }, ['3 kg', '3 kilogrammes'], ['3 g', '3 Kg', '3 mg']],
      [{ value: 3, unit: 'L' }, ['3 L', '3 l', '3 litres'], ['3 mL', '3 dL', '3 cl']],
      [{ value: 3, unit: 'mol' }, ['3 mol', '3 moles'], ['3 mmol', '3 m', '3 mole/L']],
      [{ value: 3, unit: 'K' }, ['3 K', '3 kelvins'], ['3 k', '3 mK']],
      [{ value: 3, unit: '%' }, ['3 %', '3%', '3 pour cent', '3 pourcents', '3 percent'], ['3 V', '3 %o']],
      [{ value: 3, unit: 'mV' }, ['3 mV', '3 millivolts'], ['3 MV', '3 V', '3 mv']],
      [{ value: 3, unit: 'volts' }, ['3 V', '3 volts'], ['3 mV']],
    ];
    for (const [correct, fine, wrong] of cases) {
      for (const option of fine) expect(check(correct, option), `${correct.unit}: ${option}`).toBe('complete');
      for (const option of wrong) expect(check(correct, option), `${correct.unit}: ${option}`).toBe('incomplete');
    }
  });

  it('compares a unit that is not in the table by its exact spelling', () => {
    const custom = { value: 4, unit: 'N.m' };
    expect(check(custom, '4 N.m')).toBe('complete');
    expect(check(custom, '4 N')).toBe('incomplete');
    expect(check({ value: 4, unit: 'm/s' }, '4 m/s')).toBe('complete');
    expect(check({ value: 4, unit: 'm/s' }, '4 m')).toBe('incomplete');
    expect(check({ value: 4, unit: ' V ' }, '4 V')).toBe('complete');
    expect(check({ value: 4, unit: 'foo' }, '4 foo bar')).toBe('complete');
    expect(check({ value: 4, unit: 'foo' }, '4 fo')).toBe('incomplete');
  });

  it('calls a right number with a unit it does not know incomplete, and a unitless value followed by a unit too', () => {
    expect(check(volts, '8 foo')).toBe('incomplete');
    expect(check(volts, '8 restants')).toBe('incomplete');
    expect(check(plain, '2,5 m')).toBe('incomplete');
    expect(check(plain, '2,5 environ')).toBe('complete');
    expect(check({ value: 16.8, unit: '%' }, '16,8 V')).toBe('incomplete');
  });

  it('reads thousands groups, powers of ten and fractions', () => {
    const joules = { value: 1000, unit: 'J' }, big = { value: 2500, unit: '' }, half = { value: 2.5, unit: '' };
    for (const option of ['1 000 J', '1 000', '1000 J', '1\u00a0000 J', '1\u202f000 J', '1 000,0 J']) expect(check(joules, option), option).toBe('complete');
    expect(check({ value: 1000.5, unit: 'J' }, '1 000,5 J')).toBe('complete');
    expect(check({ value: 1000000, unit: '' }, '1 000 000')).toBe('complete');
    for (const option of ['2,5 x 10^3', '2,5 x 10^3 ', '2.5 \u00d7 10^3', '2,5\u00d710^3', '2,5 * 10^3', '2,5 \u00b7 10^3', '2,5 x 10\u00b3', '2.5e3', '2,5E3', '2,5 x 10^(3)', '2500']) expect(check(big, option), option).toBe('complete');
    expect(check({ value: 0.0025, unit: '' }, '2,5 x 10^-3')).toBe('complete');
    expect(check({ value: 0.0025, unit: '' }, '2,5 x 10\u207b\u00b3')).toBe('complete');
    expect(check({ value: 2500, unit: 'm' }, '2,5 x 10^3 m')).toBe('complete');
    expect(check({ value: 2500, unit: 'm' }, '2,5 x 10^3 mm')).toBe('incomplete');
    for (const option of ['5/2', '5 / 2', '5/2 ', '\u2248 5/2', 'P = 5/2']) expect(check(half, option), option).toBe('complete');
    expect(check({ value: 0.5, unit: '' }, '\u00bd')).toBe('complete');
    expect(check({ value: 2.5, unit: 'V' }, '5/2 V')).toBe('complete');
    expect(check(half, '2,5 x 10^3')).toBe('numeric');
    expect(check(big, '25 x 10^3')).toBe('numeric');
    expect(check(half, '3/2')).toBe('numeric');
    expect(check({ value: 8, unit: 'V' }, '2^3 V')).toBe('complete');
  });

  it('calls numeric only when the keyed number is read cleanly and is wrong, or several options clearly equal the value', () => {
    expect(check(volts, '4 V', ['6 V'])).toBe('numeric');
    expect(check(volts, '-8 V', ['6 V'])).toBe('numeric');
    expect(check(volts, '8 V', ['8 volts'])).toBe('numeric');
    expect(check({ value: 5, unit: 'm' }, '5 m', ['5 m\u00e8tres', '5 mm'], 2)).toBe('numeric');
    expect(check(volts, '8 V', ['4 V', '8,0 Vcc'], 1)).toBe('numeric');
    // in doubt: incomplete
    expect(check(volts, '4 + 4 V', ['6 V'])).toBe('incomplete');
    expect(check(volts, '2 x 3 = 6 V', ['5 V'])).toBe('incomplete');
    expect(check(volts, '5-10 V', ['5 V'])).toBe('incomplete');
    expect(check(volts, '2,500 V', ['5 V'])).toBe('numeric');
    expect(check(volts, '1.234.567 V', ['5 V'])).toBe('numeric');
    expect(check(volts, '1.2.3 V', ['5 V'])).toBe('incomplete');
    expect(check({ value: 1000, unit: 'J' }, '1,000 J', ['5 J'])).toBe('incomplete');
    expect(check({ value: 1, unit: 'J' }, '1,000 J', ['5 J'])).toBe('incomplete');
    expect(check(volts, '4 V', ['huit volts'], 1)).toBe('incomplete');
    expect(check(volts, '8 V', ['8 volts', '8 mV'], 0)).toBe('numeric');
    expect(check(volts, '8 V', ['8 mV', '4 V'], 1)).toBe('incomplete');
    expect(check(volts, '4 V', ['8 mV'], 0)).toBe('incomplete');
    expect(check(volts, '8 mV', ['4 V'], 1)).toBe('incomplete');
    expect(check(volts, '12 - 4 V', ['5 V'], 0)).toBe('incomplete');
    expect(check(volts, 'U = 2 x 4 = 8 V', ['5 V'], 0)).toBe('complete');
  });

  it('reads Markdown emphasis, math delimiters and simple LaTeX, and thin or no-break spaces', () => {
    const half = { value: 2.5, unit: '' };
    for (const option of ['$2{,}5$', '$\\frac{5}{2}$', '\\frac{5}{2}', '$\\dfrac{5}{2}$', '**2,5**', '2\u00bd', '$2{,}5\\times 10^{0}$']) expect(check(half, option), option).toBe('complete');
    for (const option of ['**8 V**', '*8 V*', '__8 V__', '`8 V`', '$8\\,\\text{V}$', '$8\\ \\mathrm{V}$', '\\(8\\) V', '**8** V']) expect(check(volts, option, ['**5 V**']), option).toBe('complete');
    expect(check(milligrams, '**20 mg**')).toBe('complete');
    expect(check({ value: 2500, unit: '' }, '$2{,}5 \\times 10^{3}$')).toBe('complete');
    for (const space of ['\u2009', '\u00a0', '\u202f', '\u2007', '\\,']) expect(check({ value: 1000, unit: 'J' }, `1${space}000 J`), space).toBe('complete');
    expect(check({ value: 1000, unit: 'J' }, '$1\\,000\\ \\text{J}$')).toBe('complete');
    expect(check(volts, '**4 V**', ['6 V'])).toBe('numeric');
    expect(check(volts, '$4\\,\\text{V}$', ['6 V'])).toBe('numeric');
  });

  it('does not call an unevaluated expression, a mixed number or another unit numeric', () => {
    const probabilityValue = { value: 0.16807, unit: '', tolerance: 0.0005 };
    for (const option of ['(0,7)^5', '$(0{,}7)^5$', 'C(5,3) x 0,7^3', '$\\binom{5}{3}$', '$\\sqrt{2}$', '\u221a2', '5!', 'x^2', '$\\frac{a}{b}$']) expect(check(probabilityValue, option, ['zzz']), option).toBe('incomplete');
    expect(check(probabilityValue, '0,7^5', ['zzz'])).toBe('complete');
    expect(check({ value: 0.5, unit: 's' }, '500 ms', ['zzz'])).toBe('incomplete');
    expect(check({ value: 0.5, unit: 's' }, '0,5 s', ['500 ms'])).toBe('complete');
    expect(check({ value: 0.5, unit: 's' }, '0,5 s', ['500 ms'], 1)).toBe('incomplete');
    expect(check({ value: 2.5, unit: '' }, '2 1/2', ['zzz'])).toBe('incomplete');
    expect(check({ value: 2.5, unit: '' }, '$2\\frac{1}{2}$', ['zzz'])).toBe('incomplete');
    expect(check(volts, '4 restants', ['zzz'])).toBe('incomplete');
    expect(check(volts, '4 mV', ['zzz'])).toBe('incomplete');
    expect(check(volts, '$\\alpha$ 4 V', ['zzz'])).toBe('incomplete');
  });

  it('calls a wrong key with three decimals numeric when neither reading of the comma is the value', () => {
    expect(check(volts, '2,828 V', ['5 V'])).toBe('numeric');
    expect(check(volts, '2,718', ['5 V'])).toBe('numeric');
    expect(check(volts, '2.718 V', ['5 V'])).toBe('numeric');
    expect(check({ value: 20, unit: 'mg' }, '1,250 mg', ['5 mg'])).toBe('numeric');
    expect(check({ value: 1.75, unit: '' }, '2,667', ['5'])).toBe('numeric');
    // one reading is the value: certain only when the comma is not ambiguous
    expect(check({ value: 2.5, unit: '' }, '2,500', ['5'])).toBe('incomplete');
    expect(check({ value: 2500, unit: '' }, '2,500', ['5'])).toBe('incomplete');
  });

  it('does not turn a right value in another form into a numeric error', () => {
    const probabilityValue = { value: 0.16807, unit: '', tolerance: 0.0005 };
    expect(check(probabilityValue, '16,8 %', ['zzz'])).toBe('complete');
    expect(check(probabilityValue, '\u2248 16,81 %', ['zzz'])).toBe('complete');
    expect(check(probabilityValue, '0,17', ['zzz'])).toBe('incomplete');
    expect(check(probabilityValue, '0,168', ['zzz'])).toBe('complete');
    expect(check(probabilityValue, '0,17', ['16,8 %'], 1)).toBe('complete');
    expect(check(probabilityValue, '17 %', ['zzz'])).toBe('incomplete');
    expect(check({ value: 16.8, unit: '%' }, '16,8 %', ['zzz'])).toBe('complete');
    expect(check({ value: 16.8, unit: '%' }, '0,168', ['zzz'])).toBe('incomplete');
    expect(check({ value: 16.8, unit: '%' }, '25 %', ['zzz'])).toBe('numeric');
  });

  it('ignores digits that belong to a name or a power', () => {
    expect(check({ value: 2, unit: '' }, 'H2O', ['zzz'])).toBe('incomplete');
    expect(check({ value: 2, unit: '' }, 'x^2', ['zzz'])).toBe('incomplete');
    expect(check({ value: 2, unit: '' }, 'CO2 = 5', ['zzz'])).toBe('numeric');
  });
});

describe('scoreSafely', () => {
  it('reports a scoring exception instead of throwing', () => {
    const broken = { artefacts: [{ type: 'plot' }] };
    const scored = scoreSafely(broken, fence(plot));
    expect(scored.evaluation).toBeUndefined();
    expect(scored.error).toBeTruthy();
    expect(scoreSafely(testCase, 'text').evaluation.artefacts).toHaveLength(3);
  });
});

describe('validateCases', () => {
  const good = { id: 'h1', prompt: 'P', artefacts: [{ type: 'plot', x: { min: 0, max: 1 }, sliders: [{ key: 'a', min: 0, max: 2, step: 1, value: 1 }], curves: ['a*x'], readouts: ['a'] }, { type: 'quiz', correct: { value: 1, unit: '' } }, { type: 'diagram', minLeaves: 2 }], proseFacts: ['1'] };
  const errors = (list, taken = []) => validateCases(list, { taken }).join(' | ');

  it('accepts the documented format', () => {
    expect(validateCases([good, { ...good, id: 'h2' }])).toEqual([]);
  });

  it('refuses what a run cannot score', () => {
    expect(errors({})).toMatch(/array/);
    expect(errors([{ ...good, extra: 1 }])).toMatch(/extra/);
    expect(errors([good, good])).toMatch(/h1.*already/);
    expect(errors([good], ['h1'])).toMatch(/h1.*already/);
    expect(errors([{ ...good, artefacts: [] }])).toMatch(/artefacts/);
    expect(errors([{ ...good, artefacts: [{ type: 'quiz', correct: '\\b8\\b' }] }])).toMatch(/regex|old/i);
    expect(errors([{ ...good, artefacts: [{ type: 'quiz', correct: { value: 'x', unit: '' } }] }])).toMatch(/value/);
    expect(errors([{ ...good, artefacts: [{ ...good.artefacts[0], curves: ['nosuchfn(x)'] }] }])).toMatch(/nosuchfn/);
    expect(errors([{ ...good, artefacts: [{ ...good.artefacts[0], readouts: ['1+'] }] }])).toMatch(/readout/);
    expect(errors([{ ...good, artefacts: [{ ...good.artefacts[0], sliders: [{ key: 'a', min: 0, max: 2, step: 1, value: 5 }] }] }])).toMatch(/slider/);
    expect(errors([{ ...good, proseFacts: ['('] }])).toMatch(/proseFacts/);
    expect(errors([{ ...good, artefacts: [{ type: 'video' }] }])).toMatch(/type/);
  });

  const plotWith = (change) => [{ ...good, artefacts: [{ ...good.artefacts[0], ...change }, ...good.artefacts.slice(1)] }];
  const slider = (change = {}) => ({ key: 'a', min: 0, max: 2, step: 1, value: 1, ...change });

  it('checks the names of every expression against the sliders, with the compiler of the app', () => {
    expect(errors(plotWith({ curves: ['b*x'] }))).toMatch(/undeclared names: b/);
    expect(errors(plotWith({ curves: ['a*x', 'a*x+c'] }))).toMatch(/undeclared names: c/);
    expect(errors(plotWith({ readouts: ['x'] }))).toMatch(/undeclared names: x/);
    expect(errors(plotWith({ readouts: ['a*x'] }))).toMatch(/undeclared names: x/);
    expect(errors(plotWith({ readouts: ['b'] }))).toMatch(/undeclared names: b/);
    expect(errors(plotWith({ curves: ['sum(k,1,3,k*a)*x+pi+e'], readouts: ['sqrt(a)+sum(k,0,2,k)'] }))).toBe('');
    expect(errors(plotWith({ curves: ['k*x'] }))).toMatch(/undeclared names: k/);
    expect(errors(plotWith({ curves: ['x'], sliders: [], readouts: [] }))).toBe('');
    expect(errors(plotWith({ curves: ['a*x'], sliders: [], readouts: undefined }))).toMatch(/undeclared names: a/);
  });

  it('refuses the sliders that the app parser would refuse', () => {
    expect(errors(plotWith({ sliders: [slider({ value: 0.5 })] }))).toMatch(/whole number of steps/);
    expect(errors(plotWith({ sliders: [slider({ min: 0, max: 1, step: 0.3, value: 0.5 })] }))).toMatch(/whole number of steps/);
    expect(errors(plotWith({ sliders: [slider({ min: 0, max: 1, step: 0.1, value: 0.3 })] }))).toBe('');
    expect(errors(plotWith({ sliders: [slider({ key: 'x' })], curves: ['x'], readouts: [] }))).toMatch(/reserved/);
    for (const key of ['pi', 'e', 'k', 'sin', 'constructor']) expect(errors(plotWith({ sliders: [slider({ key })], curves: ['x'], readouts: [] })), key).toMatch(/reserved/);
    expect(errors(plotWith({ sliders: [slider({ step: 5 })] }))).toMatch(/no larger than max - min/);
    expect(errors(plotWith({ sliders: [slider({ min: 2, max: 2, value: 2 })] }))).toMatch(/min < max/);
    expect(errors(plotWith({ sliders: [slider(), slider()] }))).toMatch(/declared twice/);
    expect(errors(plotWith({ sliders: [slider({ key: 'a' }), slider({ key: 'b' }), slider({ key: 'c' }), slider({ key: 'd' }), slider({ key: 'f' })] }))).toMatch(/at most 4/);
    expect(errors(plotWith({ sliders: [slider({ key: 'a'.repeat(25) })], curves: ['x'], readouts: [] }))).toMatch(/at most 24/);
  });

  it('refuses a plot the app would refuse to draw', () => {
    expect(errors(plotWith({ x: { min: 0, max: 4, step: '0.5' } }))).toMatch(/x needs/);
    expect(errors(plotWith({ x: { min: 0, max: 4, step: 0 } }))).toMatch(/x needs/);
    expect(errors(plotWith({ x: { min: 0, max: 4, step: -1 } }))).toMatch(/x needs/);
    expect(errors(plotWith({ x: { min: 0, max: 4, step: 0.001 } }))).toMatch(/161 samples/);
    expect(errors(plotWith({ x: { min: 0, max: 4, step: 0.5 } }))).toBe('');
    expect(errors(plotWith({ x: { min: 0, max: 4, step: null } }))).toMatch(/x needs/);
    expect(errors(plotWith({ curves: ['a', 'a', 'a', 'a', 'a'] }))).toMatch(/1 to 4/);
    expect(errors(plotWith({ readouts: ['a', 'a', 'a', 'a', 'a'] }))).toMatch(/at most 4/);
  });

  it('does not repeat an expression error', () => {
    expect(validateCases(plotWith({ curves: ['nosuchfn(x)'] }))).toHaveLength(1);
    expect(validateCases(plotWith({ readouts: ['1+'] }))).toHaveLength(1);
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
    ['more failed rows than the old arm', (entry, row) => entry.arm === 'new' && entry.cell.includes('/h1/') && entry.model === 'A' ? failed(row) : row, 'noMoreFailures'],
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
    expect(newFails.criteria.noMoreFailures).toBe(false);
    const bothDead = gateOf(world((entry, row) => entry.model === 'B' && entry.kind === 'quality' ? failed(row) : row));
    // Both arms measured, none usable: the rows are decisions, not missing data.
    expect(bothDead.incomplete).toBe(false);
    expect(bothDead.details.reasons).toEqual([]);
    expect(bothDead.details.perModel.B.failed).toEqual({ old: 3, new: 3 });
    expect(bothDead.details.perModel.B.new).toBe(0);
  });

  it('keeps every measured row in both clocks, a timed out or rejected one included', () => {
    const cases = [...'abcdefghij'].map((id) => [id, 'dev']).concat([['h1', 'holdout'], ['h2', 'holdout']]);
    const slowOld = (newSeconds) => world((entry, row) => {
      if (entry.kind !== 'quality' || entry.model !== 'A') return row;
      if (entry.arm === 'old') return ['a', 'b'].includes(entry.case) ? row : failed({ ...row, timedOut: true }, 120);
      return { ...row, firstTextSeconds: newSeconds };
    }, MODELS, cases);
    const fine = gateOf(slowOld(80));
    expect(fine.details.perModel.A.oldTotal).toBe(120);
    expect(fine.criteria.firstText).toBe(true);
    expect(fine.incomplete).toBe(false);
    expect(fine.details.timeouts.old).toBe(10);
    const slow = gateOf(slowOld(130));
    expect(slow.criteria.firstText).toBe(false);
    expect(slow.pass).toBe(false);
    expect(slow.incomplete).toBe(false);
  });

  it('counts a failed new row at its real elapsed time in the first text clock', () => {
    const cases = [['d1', 'dev'], ['d2', 'dev'], ['d3', 'dev'], ['h1', 'holdout'], ['h2', 'holdout']];
    const gate = gateOf(world((entry, row) => entry.kind === 'quality' && entry.model === 'A' && entry.arm === 'new' && ['d1', 'd2', 'd3'].includes(entry.case) ? failed({ ...row, timedOut: true }, 120) : row, MODELS, cases));
    expect(gate.details.perModel.A.firstText).toBe(120);
    expect(gate.criteria.firstText).toBe(false);
  });

  it('decides a model whose old arm only fails: its failed rows are measured, not missing', () => {
    const gate = gateOf(world((entry, row) => entry.arm === 'old' && entry.kind === 'quality' && entry.model === 'B' ? failed({ ...row, timedOut: true }, 120) : row));
    expect(gate.incomplete).toBe(false);
    expect(gate.details.reasons).toEqual([]);
    expect(gate.details.perModel.B.oldTotal).toBe(120);
    expect(gate.criteria.firstText).toBe(true);
    const quick = gateOf(world((entry, row) => entry.arm === 'old' && entry.kind === 'quality' && entry.model === 'B' ? failed(row, 1) : row));
    expect(quick.incomplete).toBe(false);
    expect(quick.criteria.firstText).toBe(false);
    expect(quick.pass).toBe(false);
  });

  it('is incomplete for a model with no measured row at all', () => {
    const gate = gateOf(world((entry, row) => entry.model === 'B' && entry.arm === 'old' && entry.kind === 'quality' ? null : row));
    expect(gate.incomplete).toBe(true);
    expect(gate.criteria.firstText).toBe(false);
  });

  it('does not pass the definition rate when its rows fail', () => {
    const gate = gateOf(world((entry, row) => entry.arm === 'new' && entry.group === 'definitions' ? failed(row) : row));
    expect(gate.pass).toBe(false);
    expect(gate.incomplete).toBe(false);
    expect(gate.criteria.definitionRate).toBe(false);
  });

  it('does not let one measured failure block the gate for ever', () => {
    const sameFailure = (entry, row) => entry.cell.includes('/h1/') && entry.model === 'A' && entry.kind === 'quality' ? failed(row, 30) : row;
    const gate = gateOf(world(sameFailure));
    expect(gate.incomplete).toBe(false);
    expect(gate.criteria.noMoreFailures).toBe(true);
    expect(gate.pass).toBe(true);
  });

  it('counts the failures and the timeouts of each arm', () => {
    const gate = gateOf(world((entry, row) => entry.kind === 'quality' && entry.model === 'A' && entry.case === 'h1' ? { ...failed(row, 120), timedOut: entry.arm === 'new' } : row));
    expect(gate.details.timeouts).toEqual({ old: 0, new: 1 });
    expect(gate.details.perModel.A.failed).toEqual({ old: 1, new: 1 });
  });

  it('is never a pass when the run itself is invalid or a cell could not be scored', () => {
    const forced = decideGate(world().results, world().expected, { invalidations: ['run with --allow-dirty'] });
    expect(forced.pass).toBe(false);
    expect(forced.incomplete).toBe(true);
    expect(forced.details.reasons).toContain('run with --allow-dirty');
    const unscored = gateOf(world((entry, row) => entry.cell === 'quality/A/d1/new/0' ? { ...row, unscored: true, complete: 0 } : row));
    expect(unscored.pass).toBe(false);
    expect(unscored.incomplete).toBe(true);
    expect(unscored.details.reasons.join(' ')).toMatch(/could not be scored/);
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

describe('cases.json format', () => {
  it('passes the validation every run applies', () => {
    expect(validateCases(cases.quality, { allowSplit: true })).toEqual([]);
  });
});
