import { fromMarkdown } from 'mdast-util-from-markdown';
import { compileExpression, parseTeachingVisual, plotSampleXs } from '../../src/lib/teaching-visuals.ts';
import { prepareTutorMarkdown } from '../../src/lib/visual-brief.ts';

export const REQUIRED_HOLDOUTS = 2;
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

/**
 * Compares one quiz option with the expected amount. 'match': some number of the option equals the expected value and its
 * unit is absent or starts with the same letter (V, Vcc, volts; mg, milligrammes). 'unit': the right number with another unit.
 */
export function matchAmount(option, { value, unit = '', tolerance }) {
  const allowed = tolerance ?? 1e-9 * Math.max(1, Math.abs(value));
  const text = String(option);
  let result = 'none';
  for (const found of text.matchAll(/[-+−]?\d+(?:[.,]\d+)?/g)) {
    if (!(Math.abs(Number(found[0].replace('−', '-').replace(',', '.')) - value) <= allowed)) continue;
    const written = /^\s*([\p{L}%°]+)/u.exec(text.slice(found.index + found[0].length))?.[1];
    if (!unit || !written || written[0].toLowerCase() === unit[0].toLowerCase()) return 'match';
    result = 'unit';
  }
  return result;
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
  const outcomes = (quiz) => quiz.options.map((option) => matchAmount(option, spec.correct));
  const quiz = quizzes.find((item) => outcomes(item).includes('match')) ?? quizzes[0];
  const found = outcomes(quiz);
  const matching = found.filter((outcome) => outcome === 'match').length;
  if (matching > 1) return { type: 'quiz', status: 'numeric', errors: [`${matching} options match the correct value`] };
  if (matching === 0) {
    if (found.includes('unit')) return { type: 'quiz', status: 'incomplete', errors: ['the right number has an incompatible unit'] };
    const numbered = quiz.options.some((option) => /\d/.test(option));
    return numbered ? { type: 'quiz', status: 'numeric', errors: ['no option has the correct value'] } : { type: 'quiz', status: 'incomplete', errors: ['no option holds a number'] };
  }
  return found[quiz.answer] === 'match' ? { type: 'quiz', status: 'complete', errors: [] } : { type: 'quiz', status: 'numeric', errors: ['the key points to a wrong option'] };
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

/** A scoring exception is a harness fault, not a model failure: the caller records it and the gate stays incomplete. */
export function scoreSafely(testCase, content) {
  try { return { evaluation: evaluateAnswer(testCase, content) }; }
  catch (error) { return { error: error instanceof Error ? error.message : 'scoring failed' }; }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const KEYS = { plot: ['type', 'x', 'sliders', 'curves', 'readouts', 'yCovers', 'chartType'], quiz: ['type', 'correct'], diagram: ['type', 'minLeaves'] };

/** Checks a list of cases before any request: the exact format, unique ids and expressions the app language compiles. */
export function validateCases(list, { taken = [], allowSplit = false } = {}) {
  if (!Array.isArray(list)) return ['the file must be a JSON array of cases'];
  const errors = [], ids = new Set(taken);
  list.forEach((item, index) => {
    const problems = [];
    const bad = (message) => problems.push(message);
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`case ${index + 1}: must be an object`); return; }
    const label = `case ${index + 1} (${item.id})`;
    const allowed = ['id', 'prompt', 'artefacts', 'proseFacts', ...(allowSplit ? ['split'] : [])];
    for (const name of Object.keys(item)) if (!allowed.includes(name)) bad(`unknown key ${name}`);
    for (const name of ['id', 'prompt', 'artefacts', 'proseFacts']) if (!(name in item)) bad(`missing key ${name}`);
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id)) bad('id must be 1 to 40 letters, digits, - or _');
    else if (ids.has(item.id)) bad(`id ${item.id} is already used`);
    else ids.add(item.id);
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) bad('prompt must be non-empty text');
    if (!Array.isArray(item.artefacts) || !item.artefacts.length) bad('artefacts must be a non-empty array');
    for (const spec of Array.isArray(item.artefacts) ? item.artefacts : []) {
      if (!spec || !KEYS[spec.type]) { bad(`unknown artefact type ${spec?.type}`); continue; }
      for (const name of Object.keys(spec)) if (!KEYS[spec.type].includes(name)) bad(`${spec.type}: unknown key ${name}`);
      if (spec.type === 'quiz') {
        const correct = spec.correct;
        if (typeof correct === 'string') bad('quiz.correct is the old regex format; use { "value": number, "unit": "..." }');
        else if (!correct || !finite(correct.value)) bad('quiz.correct.value must be a number');
        else if (typeof correct.unit !== 'string' || (correct.tolerance !== undefined && !(finite(correct.tolerance) && correct.tolerance >= 0)) || Object.keys(correct).some((name) => !['value', 'unit', 'tolerance'].includes(name))) bad('quiz.correct must be { value, unit, tolerance? } with a text unit');
      } else if (spec.type === 'diagram') {
        if (spec.minLeaves !== undefined && !(Number.isInteger(spec.minLeaves) && spec.minLeaves >= 0)) bad('diagram.minLeaves must be a whole number');
      } else {
        if (!spec.x || !finite(spec.x.min) || !finite(spec.x.max) || spec.x.min >= spec.x.max) bad('plot.x needs min < max');
        if (spec.chartType !== undefined && !['line', 'bar'].includes(spec.chartType)) bad('plot.chartType must be line or bar');
        if (spec.yCovers !== undefined && !(Array.isArray(spec.yCovers) && spec.yCovers.length === 2 && spec.yCovers.every(finite))) bad('plot.yCovers must be two numbers');
        if (!Array.isArray(spec.sliders)) bad('plot.sliders must be an array');
        for (const slider of Array.isArray(spec.sliders) ? spec.sliders : []) {
          const fine = slider && /^[A-Za-z_][A-Za-z0-9_]*$/.test(slider.key) && ['min', 'max', 'step', 'value'].every((name) => finite(slider[name])) && slider.step > 0 && slider.min <= slider.value && slider.value <= slider.max;
          if (!fine) bad(`slider ${slider?.key} needs a key, min <= value <= max and step > 0`);
        }
        if (!Array.isArray(spec.curves) || !spec.curves.length) bad('plot.curves must be a non-empty array');
        for (const curve of Array.isArray(spec.curves) ? spec.curves : []) if (typeof curve !== 'string' || !compileExpression(curve)) bad(`curve ${curve} does not compile`);
        if (spec.readouts !== undefined && !Array.isArray(spec.readouts)) bad('plot.readouts must be an array');
        for (const readout of Array.isArray(spec.readouts) ? spec.readouts : []) if (typeof readout !== 'string' || !compileExpression(readout)) bad(`readout ${readout} does not compile`);
      }
    }
    if (!Array.isArray(item.proseFacts)) bad('proseFacts must be an array');
    for (const fact of Array.isArray(item.proseFacts) ? item.proseFacts : []) {
      try { new RegExp(fact); } catch { bad(`proseFacts entry ${fact} is not a valid regular expression`); }
    }
    errors.push(...problems.map((message) => `${label}: ${message}`));
  });
  return errors;
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
 * criteria: every expected cell must be measured, and `invalidations` lists reasons the whole run cannot decide.
 */
export function decideGate(results, expectedCells, { invalidations = [] } = {}) {
  const expected = new Map(expectedCells.map((item) => [item.cell, item]));
  const rows = results.filter((item) => expected.has(item.cell)).map((item) => ({ ...expected.get(item.cell), ...item }));
  const present = new Set(rows.map((item) => item.cell));
  const missing = expectedCells.filter((item) => !present.has(item.cell)).map((item) => item.cell);
  const quality = rows.filter((item) => item.kind === 'quality');
  const valid = (list) => list.filter((item) => !item.failed);
  const arm = (name, model) => quality.filter((item) => item.arm === name && (model === undefined || item.model === model));
  const everyRow = (name, model) => rows.filter((item) => item.arm === name && item.model === model);
  const models = [...new Set(expectedCells.filter((item) => item.kind === 'quality').map((item) => item.model))];
  const rateRows = (group) => rows.filter((item) => item.kind === 'rate' && item.arm === 'new' && item.group === group);
  const fraction = (list, test) => (list.length ? list.filter(test).length / list.length : NaN);
  const explanatoryRate = fraction(rateRows('explanatory'), (item) => !item.failed && item.requested);
  const definitionRate = fraction(valid(rateRows('definitions')), (item) => item.requested);
  const details = {
    complete: { old: total(arm('old'), 'complete'), new: total(arm('new'), 'complete') },
    numeric: { old: total(arm('old'), 'numeric'), new: total(arm('new'), 'numeric') },
    perModel: Object.fromEntries(models.map((model) => [model, {
      old: total(arm('old', model), 'complete'),
      new: total(arm('new', model), 'complete'),
      failed: { old: everyRow('old', model).filter((item) => item.failed).length, new: everyRow('new', model).filter((item) => item.failed).length },
      firstText: median(valid(arm('new', model)).map((item) => item.firstTextSeconds)),
      oldTotal: median(valid(arm('old', model)).map((item) => item.totalSeconds)),
      newTotal: median(valid(arm('new', model)).map((item) => item.totalSeconds)),
    }])),
    timeouts: { old: rows.filter((item) => item.arm === 'old' && item.timedOut).length, new: rows.filter((item) => item.arm === 'new' && item.timedOut).length },
    explanatoryRate,
    definitionRate,
    duplicates: duplicateSamples(quality),
    missing,
    reasons: [...invalidations],
  };
  if (missing.length) details.reasons.push(`${missing.length} expected cells have no measurement`);
  if (missingHoldouts(expectedCells)) details.reasons.push('no holdouts');
  const unscored = rows.filter((item) => item.unscored).length;
  if (unscored) details.reasons.push(`${unscored} cells could not be scored`);
  // A model whose old arm never produced a valid row has no old clock to compare with: the data is incomplete, not failed.
  const noOldClock = (model) => arm('old', model).length > 0 && valid(arm('old', model)).length === 0;
  for (const model of models) if (noOldClock(model)) details.reasons.push(`no valid old-arm row for ${model}`);
  const incomplete = details.reasons.length > 0;
  const criteria = {
    moreComplete: details.complete.new > details.complete.old,
    noModelWorse: models.every((model) => details.perModel[model].new >= details.perModel[model].old),
    noNewNumericErrors: details.numeric.new <= details.numeric.old,
    visualRate: explanatoryRate >= .8,
    definitionRate: definitionRate <= .2,
    firstText: models.filter((model) => !noOldClock(model)).every((model) => details.perModel[model].firstText <= details.perModel[model].oldTotal),
    noMoreFailures: models.every((model) => details.perModel[model].failed.new <= details.perModel[model].failed.old),
  };
  return { pass: !incomplete && Object.values(criteria).every(Boolean), incomplete, criteria, details };
}
