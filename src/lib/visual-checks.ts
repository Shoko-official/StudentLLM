import { compileExpression, plotSampleXs, type TeachingVisual } from './teaching-visuals';
import type { VisualBrief } from './visual-brief';

// Labels and quiz answers come from two models: ignore case, spacing and a decimal comma. Readout labels and node names also ignore accents, because the brief and the built visual spell the same name differently. Quiz text keeps them (a/à, ou/où are different answers). Parameter names stay exact.
const simplified = (value: string) => value.normalize('NFC').replace(/(\d),(\d)/g, '$1.$2').toLowerCase().trim().replace(/\s+/g, ' ');
const normalized = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/(\d),(\d)/g, '$1.$2').toLowerCase().trim().replace(/\s+/g, ' ');

type Plot = Extract<TeachingVisual, { type: 'plot' }>;
const namesIn = (expression: string): string[] => expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

function plotProblems(visual: Plot, brief: VisualBrief) {
  const errors: string[] = [];
  const declared = visual.parameters ?? [];
  const outputs = visual.outputs ?? [];
  for (const name of brief.parameters ?? []) if (!declared.some((item) => item.name === name)) errors.push(`missing parameter "${name}"`);
  const claimed = new Set<number>();
  const labels = [...new Set(brief.outputs ?? [])];
  const claim = (same: (item: string) => boolean) => {
    const index = outputs.findIndex((item, at) => !claimed.has(at) && same(item.label));
    if (index >= 0) claimed.add(index);
    return index >= 0;
  };
  const unmatched = labels.filter((label) => !claim((item) => item === label));
  for (const label of unmatched) if (!claim((item) => normalized(item) === normalized(label))) errors.push(`missing readout "${label}"`);
  const defaults = Object.fromEntries(declared.map((item) => [item.name, item.value]));
  for (const series of visual.series) {
    if (series.expression === undefined) continue;
    const compute = compileExpression(series.expression);
    if (!plotSampleXs(visual.x).some((x) => Number.isFinite(compute?.({ ...defaults, x })))) errors.push(`series "${series.label}" has no finite value at the default parameters`);
  }
  return errors;
}

/**
 * A formula copied with a reading slider named like its variable, or readouts with typed-in values, parse and draw, but
 * nothing moves. A uniform speed or a direct current is a correct flat line, so these only ever ask, and never reject.
 */
export function stillPlotNotes(visual: TeachingVisual): string[] {
  if (visual.type !== 'plot') return [];
  const notes: string[] = [];
  const formulas = visual.series.flatMap((series) => (series.expression === undefined ? [] : [series.expression]));
  if (formulas.length === visual.series.length && !formulas.some((formula) => namesIn(formula).includes('x'))) {
    for (const series of visual.series) notes.push(`series "${series.label}" never uses x, so it draws a flat line. If this curve is meant to vary along the horizontal axis, write that variable as x, even when a slider has the same name. If it is truly constant, keep it.`);
  }
  const used = new Set([...formulas, ...(visual.outputs ?? []).map((item) => item.expression)].flatMap(namesIn));
  for (const { name } of visual.parameters ?? []) if (!used.has(name)) notes.push(`slider "${name}" changes nothing. If it should act on the plot, use it by name in a series or a readout, never its value typed as a number. Otherwise keep the plot.`);
  return notes;
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`(?:\s*\/\s*(${NUMBER})|\s*(?:[x×*]|\\times|\\cdot)\s*10\^\{?(-?\d+)\}?|\s*(\\?%))?`;
// A minus is a sign when nothing it could subtract from runs into it: "x = -3" and "soit -3", not "5 - 3", "x-3" or "x - 3".
const SIGN = String.raw`(?:(?<![\d)\]}]\s*)(?<!\p{L})[-−]|(?<![\p{L}\d)\]}]\s*)[-−]\s+)?`;
const STATED = new RegExp(String.raw`${SIGN}(?<![\p{L}\d.,^{])(${NUMBER})${SUFFIX}`, 'gu');
const decimal = (text: string) => Number(text.replace(',', '.'));
const written = (text: string) => text.replace(/\*\*/g, '').replace(/\\d?frac\{(\d+)\}\{(\d+)\}/g, '$1/$2').replace(/\{,\}/g, ',').replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1');

/** A number as written. A fraction or a power of ten has no precision of its own. `around` is what an answer holds besides it, a unit or a name. */
interface Stated { value: number; decimals: number; percent: boolean; around?: string }

/** The numbers a text states: 0,5 and 1/2 are one value, and 50 % stays a percentage. */
function statedValues(text: string): (Stated & { index: number; length: number })[] {
  return [...text.matchAll(STATED)].map((match) => {
    const [whole, number, over, power, percent] = match;
    const sign = /^[-−]/.test(whole) ? -1 : 1;
    const size = over ? decimal(number) / decimal(over) : power ? decimal(number) * 10 ** Number(power) : decimal(number);
    return { value: sign * size, decimals: over || power ? Infinity : number.split(/[.,]/)[1]?.length ?? 0, percent: Boolean(percent), index: match.index, length: whole.length };
  });
}

/** Whether `other` rounds to `own` at the precision `own` is written in. A whole number stays exact against a whole number, and within 1% of anything else. */
function atPrecision(own: Stated, other: Stated) {
  const decimals = Number.isFinite(own.decimals) ? own.decimals : other.decimals;
  if (!Number.isFinite(decimals)) return Math.abs(own.value - other.value) <= 1e-9 * Math.max(Math.abs(own.value), Math.abs(other.value));
  const places = Math.min(decimals, 20);
  if (Number(own.value.toFixed(places)) !== Number(other.value.toFixed(places))) return false;
  return places > 0 || (Number.isInteger(own.value) && Number.isInteger(other.value)) || Math.abs(own.value - other.value) <= Math.abs(own.value) * .01;
}

/** `own` is the option or answer. A percentage meets another form of its value only in a bare number: 0,5 % is not 0.5, and 50 % is 50 or 0.5. */
function sameValue(own: Stated, other: Stated) {
  if (own.percent === other.percent) return atPrecision(own, other);
  const [share, plain] = own.percent ? [own, other] : [other, own];
  if (plain.around) return false;
  return atPrecision({ ...share, value: share.value / 100, decimals: share.decimals + 2 }, plain) || (plain.value >= 1 && atPrecision(share, plain));
}

/** The value of an option or an answer: its one number, or what follows its last equals sign. Anything else has no single value. */
function singleValue(raw: string): Stated | null {
  const text = written(raw);
  const from = text.lastIndexOf('=') + 1;
  const found = statedValues(text.slice(from));
  if (found.length !== 1) return null;
  const { index, length, ...value } = found[0];
  return { ...value, around: normalized(text.slice(0, from + index) + text.slice(from + index + length)).replace(/[\s$\\.,;:]/g, '') };
}

/** Two answers are about the same thing when what surrounds the number matches, or one of them is only a number. */
const comparable = (a: Stated, b: Stated) => !a.around || !b.around || a.around === b.around;

// A number after =, ≈ or : that a further operation does not go on from. Inside the brackets of a name, as in P(X = 2), it is a parameter.
const COMPUTED = new RegExp(String.raw`(?<!\p{L}\([^()]*)(?:=|≈|≃|\\approx|:)\s*\$?\s*((?:[-−]\s*)?${NUMBER}${SUFFIX.replace(/\((?!\?)/g, '(?:')})(?![\d.,]*\d)(?![ \t]*(?:[*×/+^·]|\\times|\\cdot|\\div|x[ \t]*[\d(]|[-−][ \t]*[\d(]))`, 'gu');

/** The values a quiz's working computes, in order. The last one is where the working ends, which is not always its answer. */
function computedResults(explanation: string): Stated[] {
  return [...written(explanation).matchAll(COMPUTED)].flatMap((match) => statedValues(match[1]).slice(0, 1));
}

type Quiz = Extract<TeachingVisual, { type: 'quiz' }>;
const optionHolding = (visual: Quiz, value: Stated) => {
  const holding = visual.options.flatMap((option, index) => {
    const own = singleValue(option);
    return own && sameValue(own, value) ? [index] : [];
  });
  return holding.length === 1 ? holding[0] : null;
};
const isComputed = (key: Stated | null, results: Stated[]) => !!key && results.some((result) => sameValue(key, result));

/** Whether the numbers of the keyed option appear in the explanation, rounded or not. A key with no number cannot be compared, so it passes. */
export function quizAgreesWithItself(visual: TeachingVisual): boolean {
  if (visual.type !== 'quiz') return true;
  const worked = statedValues(written(visual.explanation));
  return statedValues(written(visual.options[visual.answer] ?? '')).every((value) => worked.some((item) => sameValue(value, item)));
}

/**
 * When the keyed option is no result of the working, and the working ends on another value. Models were seen working to the
 * right value and then keying another option, so this asks once, and never rejects. A key the working computes anywhere
 * stays: the working may have gone on to a check or an aside.
 */
export function quizWorkingNotes(visual: TeachingVisual): string[] {
  if (visual.type !== 'quiz') return [];
  const results = computedResults(visual.explanation);
  const result = results.at(-1);
  if (!result) return [];
  const keyed = visual.options[visual.answer] ?? '';
  const key = singleValue(keyed);
  if (isComputed(key, results)) return [];
  const other = optionHolding(visual, result);
  if (other !== null) return [`the working reaches ${result.value}, which is the option "${visual.options[other]}", but the keyed option is "${keyed}"`];
  return key ? [`the working reaches ${result.value}, which no option holds, and the keyed option is "${keyed}"`] : [];
}

/**
 * Moves the key with no call when the tutor's answer and the working's last result agree on what one option holds, the
 * current key is no result of the working, and that option reads like the tutor's answer. The last result can still be an
 * aside, and no stored run holds a tutor answer to try this on, so the move is a judgement and is reported back to be
 * recorded. Anything less clear goes to the recheck.
 */
export function quizKeyFromAgreement(visual: TeachingVisual, brief: VisualBrief): { visual: TeachingVisual; rekeyed?: string } {
  if (visual.type !== 'quiz' || brief.correctAnswer === undefined) return { visual };
  const results = computedResults(visual.explanation);
  const result = results.at(-1), expected = singleValue(brief.correctAnswer);
  if (!result || !expected || !sameValue(expected, result) || isComputed(singleValue(visual.options[visual.answer] ?? ''), results)) return { visual };
  const holding = optionHolding(visual, result);
  if (holding === null || holding === visual.answer || !comparable(singleValue(visual.options[holding])!, expected)) return { visual };
  return { visual: { ...visual, answer: holding }, rekeyed: `key moved from "${visual.options[visual.answer]}" to "${visual.options[holding]}": the tutor and the working both give ${result.value}` };
}

/** Values the tutor gave for a plot, and the answer it gave for a quiz. A disagreement may come from either side, so it never rejects a visual on its own. */
export function disagreeingChecks(visual: TeachingVisual, brief: VisualBrief): string[] {
  if (visual.type === 'quiz') {
    const keyed = visual.options[visual.answer];
    const expected = brief.correctAnswer;
    if (expected === undefined || simplified(keyed) === simplified(expected)) return [];
    const [keyValue, expectedValue] = [singleValue(keyed), singleValue(expected)];
    if (keyValue && expectedValue && comparable(keyValue, expectedValue) && sameValue(keyValue, expectedValue)) return [];
    const accentOnly = normalized(keyed) === normalized(expected) && !visual.options.some((option, index) => index !== visual.answer && normalized(option) === normalized(keyed));
    return accentOnly ? [] : [`the keyed option is "${keyed}", expected "${expected}"`];
  }
  if (visual.type !== 'plot') return [];
  const errors: string[] = [];
  const declared = visual.parameters ?? [];
  const outputs = visual.outputs ?? [];
  const defaults = Object.fromEntries(declared.map((item) => [item.name, item.value]));
  for (const check of brief.checks ?? []) {
    const output = outputs.find((item) => item.label === check.output) ?? outputs.find((item) => normalized(item.label) === normalized(check.output));
    if (!output) { if (!(brief.outputs ?? []).some((label) => normalized(label) === normalized(check.output))) errors.push(`missing readout "${check.output}"`); continue; }
    const undeclared = Object.keys(check.at).find((name) => !declared.some((item) => item.name === name));
    if (undeclared) { errors.push(`check on "${check.output}" uses undeclared parameter "${undeclared}"`); continue; }
    const actual = compileExpression(output.expression)?.({ ...defaults, ...check.at }) ?? NaN;
    const tolerance = check.tolerance ?? Math.max(1e-9, Math.abs(check.expected) * .01);
    if (!Number.isFinite(actual) || Math.abs(actual - check.expected) > tolerance) {
      const at = Object.entries(check.at).map(([name, value]) => `${name}=${value}`).join(', ');
      errors.push(`readout "${check.output}"${at ? ` at ${at}` : ''} gives ${actual}, expected ${check.expected}`);
    }
  }
  return errors;
}

/** Detects contradictions with the tutor's request. Agreement here does not prove the mathematics. */
export function checkVisualAgainstBrief(visual: TeachingVisual, brief: VisualBrief): string[] {
  if (visual.type !== brief.type) return [`expected a ${brief.type}, received a ${visual.type}`];
  if (visual.type === 'plot') return plotProblems(visual, brief);
  if (visual.type === 'diagram') {
    return (brief.nodes ?? []).filter((label) => !visual.nodes.some((node) => normalized(node.label) === normalized(label) || normalized(node.id) === normalized(label))).map((label) => `missing node labelled "${label}"`);
  }
  if (visual.type === 'quiz') {
    const errors: string[] = [];
    if (new Set(visual.options.map(simplified)).size !== visual.options.length) errors.push('quiz options must be distinct');
    return errors;
  }
  return [];
}
