import { compileExpression, plotSampleXs, type TeachingVisual } from './teaching-visuals';
import type { VisualBrief } from './visual-brief';

const normalized = (value: string) => value.trim().toLowerCase();

type Plot = Extract<TeachingVisual, { type: 'plot' }>;

function plotProblems(visual: Plot, brief: VisualBrief) {
  const errors: string[] = [];
  const declared = visual.parameters ?? [];
  const outputs = visual.outputs ?? [];
  for (const name of brief.parameters ?? []) if (!declared.some((item) => item.name === name)) errors.push(`missing parameter "${name}"`);
  for (const label of brief.outputs ?? []) if (!outputs.some((item) => item.label === label)) errors.push(`missing readout "${label}"`);
  const defaults = Object.fromEntries(declared.map((item) => [item.name, item.value]));
  for (const series of visual.series) {
    if (series.expression === undefined) continue;
    const compute = compileExpression(series.expression);
    if (!plotSampleXs(visual.x).some((x) => Number.isFinite(compute?.({ ...defaults, x })))) errors.push(`series "${series.label}" has no finite value at the default parameters`);
  }
  for (const check of brief.checks ?? []) {
    const output = outputs.find((item) => item.label === check.output);
    if (!output) { if (!(brief.outputs ?? []).includes(check.output)) errors.push(`missing readout "${check.output}"`); continue; }
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
    return (brief.nodes ?? []).filter((label) => !visual.nodes.some((node) => normalized(node.label) === normalized(label))).map((label) => `missing node labelled "${label}"`);
  }
  if (visual.type === 'quiz') {
    const errors: string[] = [];
    if (new Set(visual.options.map(normalized)).size !== visual.options.length) errors.push('quiz options must be distinct');
    const keyed = visual.options[visual.answer];
    if (brief.correctAnswer !== undefined && normalized(keyed) !== normalized(brief.correctAnswer)) errors.push(`the keyed option is "${keyed}", expected "${brief.correctAnswer}"`);
    return errors;
  }
  return [];
}
