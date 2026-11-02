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
  // A formula copied with a reading slider named like its variable, or readouts with typed-in values, parse and draw, but nothing moves.
  const formulas = visual.series.flatMap((series) => (series.expression === undefined ? [] : [series.expression]));
  if (formulas.length === visual.series.length && !formulas.some((formula) => namesIn(formula).includes('x'))) {
    for (const series of visual.series) errors.push(`series "${series.label}" never uses x, so it draws a flat line: write the variable of the horizontal axis as x, even when a slider has the same name as that variable`);
  }
  const used = new Set([...formulas, ...outputs.map((item) => item.expression)].flatMap(namesIn));
  for (const { name } of declared) if (!used.has(name)) errors.push(`slider "${name}" changes nothing: use it by name in a series or a readout, never its value typed as a number`);
  return errors;
}

/** Checks the tutor gave a plot's values for. A disagreement may come from either side, so it never rejects the plot on its own. */
export function disagreeingChecks(visual: TeachingVisual, brief: VisualBrief): string[] {
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
    const keyed = visual.options[visual.answer];
    const expected = brief.correctAnswer;
    if (expected !== undefined && simplified(keyed) !== simplified(expected)) {
      const accentOnly = normalized(keyed) === normalized(expected) && !visual.options.some((option, index) => index !== visual.answer && normalized(option) === normalized(keyed));
      if (!accentOnly) errors.push(`the keyed option is "${keyed}", expected "${expected}"`);
    }
    return errors;
  }
  return [];
}
