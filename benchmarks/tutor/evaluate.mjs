import { fromMarkdown } from 'mdast-util-from-markdown';
import { compileExpression, parseTeachingVisual, plotSampleXs } from '../../src/lib/teaching-visuals.ts';
import { prepareTutorMarkdown } from '../../src/lib/visual-brief.ts';

export const REQUIRED_HOLDOUTS = 2;
// A model is measurable only if at least this share of its new-arm rows is a valid measurement.
const MIN_VALID_SHARE = 0.5;
// rich-text.tsx renders at most this many student-visual fences per message.
const APP_VISUAL_BUDGET = 8;
const VISUAL_LANGUAGES = ['student-visual', 'student-visual-request'];

const close = (a, b) => (!Number.isFinite(a) && !Number.isFinite(b)) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)));
const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

function codeNodes(markdown) {
  const nodes = [];
  const visit = (node) => { if (node.type === 'code') nodes.push(node); node.children?.forEach(visit); };
  visit(fromMarkdown(markdown));
  return nodes;
}

/** Reads an answer the way the app does: the tutor pipeline normalizes it, the renderer budgets the visuals. */
export function analyse(content) {
  const prepared = prepareTutorMarkdown(content);
  let seen = 0;
  const visuals = [];
  for (const node of codeNodes(prepared.markdown)) {
    if (node.lang !== 'student-visual' || seen++ >= APP_VISUAL_BUDGET) continue;
    const visual = parseTeachingVisual(String(node.value ?? '').trim());
    if (visual) visuals.push(visual);
  }
  let prose = content;
  const cuts = codeNodes(content).filter((node) => VISUAL_LANGUAGES.includes(node.lang) || String(node.value ?? '').includes('student-visual'));
  for (const node of cuts.sort((a, b) => b.position.start.offset - a.position.start.offset)) prose = prose.slice(0, node.position.start.offset) + prose.slice(node.position.end.offset);
  return { visuals, requests: prepared.jobs.map((job) => job.brief), prose };
}

export const extractVisuals = (content) => analyse(content).visuals;

export function requestedVisual(content) {
  const { visuals, requests } = analyse(content);
  return visuals.length > 0 || requests.length > 0;
}

/** Reads "8 V", "8V", "2,5" or "0.168": one number with a comma or dot decimal, then an optional unit. */
export function parseAmount(text) {
  const match = /^\s*([-+−]?\d+(?:[.,]\d+)?)\s*(.*?)\s*\.?\s*$/.exec(String(text));
  if (!match) return null;
  const value = Number(match[1].replace('−', '-').replace(',', '.'));
  return Number.isFinite(value) ? { value, unit: match[2] } : null;
}

function sliderCombinations(sliders) {
  return sliders.reduce((combos, slider) => combos.flatMap((combo) => [...new Set([slider.min, slider.value, slider.max])].map((value) => ({ ...combo, [slider.key]: value }))), [{}]);
}

/** Every one-to-one pairing of sliders with parameters of the same range, keeping the most complete ones. */
function assignments(sliders, parameters) {
  const fits = sliders.map((slider) => parameters.filter((item) => sameNumber(item.min, slider.min) && sameNumber(item.max, slider.max) && sameNumber(item.step, slider.step) && sameNumber(item.value, slider.value)));
  const found = [];
  const used = new Set();
  const choose = (index, picked) => {
    if (index === sliders.length) { found.push(picked); return; }
    const options = fits[index].filter((item) => !used.has(item));
    if (!options.length) { choose(index + 1, [...picked, undefined]); return; }
    for (const item of options) { used.add(item); choose(index + 1, [...picked, item]); used.delete(item); }
  };
  choose(0, []);
  const best = Math.max(...found.map((picked) => picked.filter(Boolean).length));
  return found.filter((picked) => picked.filter(Boolean).length === best);
}

function checkPlot(spec, plot, picked) {
  const errors = [], numeric = [];
  const mapped = spec.sliders.map((slider, index) => ({ slider, parameter: picked[index] }));
  for (const { slider, parameter } of mapped) if (!parameter) errors.push(`missing slider ${slider.key}`);
  if (spec.chartType && plot.chartType !== spec.chartType) errors.push(`expected chartType ${spec.chartType}`);
  if (!sameNumber(plot.x.min, spec.x.min) || !sameNumber(plot.x.max, spec.x.max) || (spec.x.step && plot.x.step !== spec.x.step)) errors.push('wrong x domain');
  if (spec.yCovers && plot.y && (plot.y.min > spec.yCovers[0] || plot.y.max < spec.yCovers[1])) errors.push('y axis clips the requested range');
  if (!errors.length) {
    const defaults = Object.fromEntries((plot.parameters ?? []).map((item) => [item.name, item.value]));
    const combos = sliderCombinations(spec.sliders);
    const modelVariables = (combo) => ({ ...defaults, ...Object.fromEntries(mapped.map(({ slider, parameter }) => [parameter.name, combo[slider.key]])) });
    const xs = plotSampleXs(plot.x);
    const agrees = (reference, compute) => combos.every((combo) => xs.every((x) => close(compute({ ...modelVariables(combo), x }), reference({ ...combo, x }))));
    for (const curve of spec.curves) {
      const reference = compileExpression(curve);
      const found = plot.series.some((series) => series.expression && agrees(reference, compileExpression(series.expression)));
      if (!found) numeric.push(`no series matches ${curve}`);
    }
    for (const readout of spec.readouts ?? []) {
      const reference = compileExpression(readout);
      const found = (plot.outputs ?? []).some((output) => {
        const compute = compileExpression(output.expression);
        return combos.every((combo) => close(compute(modelVariables(combo)), reference(combo)));
      });
      if (!found) numeric.push(`no readout matches ${readout}`);
    }
  }
  return { type: 'plot', status: numeric.length ? 'numeric' : errors.length ? 'incomplete' : 'complete', errors: [...errors, ...numeric] };
}

function evaluatePlot(spec, visuals) {
  const plots = visuals.filter((visual) => visual.type === 'plot');
  if (!plots.length) return { type: 'plot', status: 'missing', errors: ['no plot'] };
  const choices = plots.map((plot) => ({ plot, options: assignments(spec.sliders, plot.parameters ?? []) }));
  const { plot, options } = choices.find(({ options }) => options.every((picked) => picked.every(Boolean))) ?? choices[0];
  const results = options.map((picked) => checkPlot(spec, plot, picked));
  return results.find((result) => result.status === 'complete') ?? results[0];
}

function evaluateQuiz(spec, visuals) {
  const quizzes = visuals.filter((visual) => visual.type === 'quiz');
  if (!quizzes.length) return { type: 'quiz', status: 'missing', errors: ['no quiz'] };
  const { value, unit = '', tolerance } = spec.correct;
  const allowed = tolerance ?? 1e-9 * Math.max(1, Math.abs(value));
  const isCorrect = (option) => {
    const amount = parseAmount(option);
    return Boolean(amount) && amount.unit === unit && Math.abs(amount.value - value) <= allowed;
  };
  const quiz = quizzes.find((item) => item.options.some(isCorrect)) ?? quizzes[0];
  const matching = quiz.options.filter(isCorrect);
  if (matching.length !== 1) return { type: 'quiz', status: 'numeric', errors: [`${matching.length} options match the correct value`] };
  return isCorrect(quiz.options[quiz.answer]) ? { type: 'quiz', status: 'complete', errors: [] } : { type: 'quiz', status: 'numeric', errors: ['the key points to a wrong option'] };
}

function evaluateDiagram(spec, visuals) {
  const diagrams = visuals.filter((visual) => visual.type === 'diagram');
  if (!diagrams.length) return { type: 'diagram', status: 'missing', errors: ['no diagram'] };
  const leaves = (diagram) => diagram.nodes.filter((node) => !diagram.edges.some((edge) => edge.from === node.id) && diagram.edges.some((edge) => edge.to === node.id)).length;
  const best = Math.max(...diagrams.map(leaves));
  return best >= (spec.minLeaves ?? 0) ? { type: 'diagram', status: 'complete', errors: [] } : { type: 'diagram', status: 'incomplete', errors: [`${best} leaves, expected ${spec.minLeaves}`] };
}

export function evaluateAnswer(testCase, content) {
  const { visuals, prose } = analyse(content);
  const artefacts = testCase.artefacts.map((spec) => {
    if (spec.type === 'plot') return evaluatePlot(spec, visuals);
    if (spec.type === 'quiz') return evaluateQuiz(spec, visuals);
    if (spec.type === 'diagram') return evaluateDiagram(spec, visuals);
    return visuals.some((visual) => visual.type === spec.type) ? { type: spec.type, status: 'complete', errors: [] } : { type: spec.type, status: 'missing', errors: [`no ${spec.type}`] };
  });
  return { artefacts, prose: { missing: (testCase.proseFacts ?? []).filter((fact) => !new RegExp(fact).test(prose)) } };
}

// An empty list has no median: NaN fails every comparison, so a missing arm can never satisfy a criterion.
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN; };
const total = (runs, key) => runs.reduce((sum, run) => sum + run[key], 0);

export function missingHoldouts(expectedCells) {
  const holdouts = new Set(expectedCells.filter((item) => item.kind === 'quality' && item.split === 'holdout').map((item) => item.case));
  return holdouts.size < REQUIRED_HOLDOUTS;
}

function duplicateSamples(quality) {
  const groups = new Map();
  for (const row of quality) {
    if (row.failed || !row.contentHash) continue;
    const key = `${row.model}/${row.case}/${row.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let pairs = 0, identical = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    pairs++;
    if (rows.every((row) => row.contentHash === rows[0].contentHash)) identical++;
  }
  return { identical, pairs };
}

/**
 * Criteria fixed before any result was seen; see the design document. Data validity is decided here, not in the
 * criteria: every expected cell must be measured, and a model must have enough valid new-arm rows to be judged.
 */
export function decideGate(results, expectedCells) {
  const expected = new Map(expectedCells.map((item) => [item.cell, item]));
  const rows = results.filter((item) => expected.has(item.cell)).map((item) => ({ ...expected.get(item.cell), ...item }));
  const present = new Set(rows.map((item) => item.cell));
  const missing = expectedCells.filter((item) => !present.has(item.cell)).map((item) => item.cell);
  const quality = rows.filter((item) => item.kind === 'quality');
  const valid = (list) => list.filter((item) => !item.failed);
  const arm = (name, model) => quality.filter((item) => item.arm === name && (model === undefined || item.model === model));
  const models = [...new Set(expectedCells.filter((item) => item.kind === 'quality').map((item) => item.model))];
  const rateRows = (group, model) => rows.filter((item) => item.kind === 'rate' && item.arm === 'new' && item.group === group && (model === undefined || item.model === model));
  const fraction = (list, test) => (list.length ? list.filter(test).length / list.length : NaN);
  const explanatoryRate = fraction(rateRows('explanatory'), (item) => !item.failed && item.requested);
  const definitionRate = fraction(valid(rateRows('definitions')), (item) => item.requested);
  const details = {
    complete: { old: total(arm('old'), 'complete'), new: total(arm('new'), 'complete') },
    numeric: { old: total(arm('old'), 'numeric'), new: total(arm('new'), 'numeric') },
    perModel: Object.fromEntries(models.map((model) => [model, {
      old: total(arm('old', model), 'complete'),
      new: total(arm('new', model), 'complete'),
      firstText: median(valid(arm('new', model)).map((item) => item.firstTextSeconds)),
      oldTotal: median(valid(arm('old', model)).map((item) => item.totalSeconds)),
      newTotal: median(valid(arm('new', model)).map((item) => item.totalSeconds)),
    }])),
    explanatoryRate,
    definitionRate,
    duplicates: duplicateSamples(quality),
    missing,
    reasons: [],
  };
  if (missing.length) details.reasons.push(`${missing.length} expected cells have no measurement`);
  if (missingHoldouts(expectedCells)) details.reasons.push('no holdouts');
  const measurable = (list, expectedCount) => valid(list).length >= Math.max(1, Math.ceil(expectedCount * MIN_VALID_SHARE));
  for (const model of models) {
    const planned = (test) => expectedCells.filter((item) => item.model === model && item.arm === 'new' && test(item)).length;
    if (!measurable(arm('new', model), planned((item) => item.kind === 'quality'))) details.reasons.push(`too few valid new-arm quality rows for ${model}`);
    for (const group of ['explanatory', 'definitions']) {
      if (!measurable(rateRows(group, model), planned((item) => item.kind === 'rate' && item.group === group))) details.reasons.push(`too few valid ${group} rows for ${model}`);
    }
  }
  const incomplete = details.reasons.length > 0;
  const criteria = {
    moreComplete: details.complete.new > details.complete.old,
    noModelWorse: models.every((model) => details.perModel[model].new >= details.perModel[model].old),
    noNewNumericErrors: details.numeric.new <= details.numeric.old,
    visualRate: explanatoryRate >= .8,
    definitionRate: definitionRate <= .2,
    firstText: models.every((model) => details.perModel[model].firstText <= details.perModel[model].oldTotal),
  };
  return { pass: !incomplete && Object.values(criteria).every(Boolean), incomplete, criteria, details };
}
