import { compileExpression, parseTeachingVisual, plotSampleXs } from '../../src/lib/teaching-visuals.ts';

const close = (a, b) => (!Number.isFinite(a) && !Number.isFinite(b)) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)));
const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

export function extractVisuals(content) {
  return Array.from(content.matchAll(/```student-visual\n([\s\S]*?)\n```/g), (match) => parseTeachingVisual(match[1])).filter(Boolean);
}

export const requestedVisual = (content) => /```student-visual(?:-request)?\n/.test(content);

function sliderCombinations(sliders) {
  return sliders.reduce((combos, slider) => combos.flatMap((combo) => [...new Set([slider.min, slider.value, slider.max])].map((value) => ({ ...combo, [slider.key]: value }))), [{}]);
}

function evaluatePlot(spec, visuals) {
  const plots = visuals.filter((visual) => visual.type === 'plot');
  if (!plots.length) return { type: 'plot', status: 'missing', errors: ['no plot'] };
  const mapping = (plot) => spec.sliders.map((slider) => ({ slider, parameter: (plot.parameters ?? []).find((item) => sameNumber(item.min, slider.min) && sameNumber(item.max, slider.max) && sameNumber(item.step, slider.step) && sameNumber(item.value, slider.value)) }));
  const plot = plots.find((item) => mapping(item).every(({ parameter }) => parameter)) ?? plots[0];
  const errors = [], numeric = [];
  const mapped = mapping(plot);
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

function evaluateQuiz(spec, visuals) {
  const quizzes = visuals.filter((visual) => visual.type === 'quiz');
  if (!quizzes.length) return { type: 'quiz', status: 'missing', errors: ['no quiz'] };
  const pattern = new RegExp(spec.correct);
  const quiz = quizzes.find((item) => item.options.some((option) => pattern.test(option))) ?? quizzes[0];
  const matching = quiz.options.filter((option) => pattern.test(option));
  if (matching.length !== 1) return { type: 'quiz', status: 'numeric', errors: [`${matching.length} options match the correct value`] };
  return pattern.test(quiz.options[quiz.answer]) ? { type: 'quiz', status: 'complete', errors: [] } : { type: 'quiz', status: 'numeric', errors: ['the key points to a wrong option'] };
}

function evaluateDiagram(spec, visuals) {
  const diagrams = visuals.filter((visual) => visual.type === 'diagram');
  if (!diagrams.length) return { type: 'diagram', status: 'missing', errors: ['no diagram'] };
  const leaves = (diagram) => diagram.nodes.filter((node) => !diagram.edges.some((edge) => edge.from === node.id) && diagram.edges.some((edge) => edge.to === node.id)).length;
  const best = Math.max(...diagrams.map(leaves));
  return best >= (spec.minLeaves ?? 0) ? { type: 'diagram', status: 'complete', errors: [] } : { type: 'diagram', status: 'incomplete', errors: [`${best} leaves, expected ${spec.minLeaves}`] };
}

export function evaluateAnswer(testCase, content) {
  const visuals = extractVisuals(content);
  const artefacts = testCase.artefacts.map((spec) => {
    if (spec.type === 'plot') return evaluatePlot(spec, visuals);
    if (spec.type === 'quiz') return evaluateQuiz(spec, visuals);
    if (spec.type === 'diagram') return evaluateDiagram(spec, visuals);
    return visuals.some((visual) => visual.type === spec.type) ? { type: spec.type, status: 'complete', errors: [] } : { type: spec.type, status: 'missing', errors: [`no ${spec.type}`] };
  });
  return { artefacts, prose: { missing: (testCase.proseFacts ?? []).filter((fact) => !new RegExp(fact).test(content)) } };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : Infinity; };
const total = (runs, key) => runs.reduce((sum, run) => sum + run[key], 0);

/** Criteria fixed before any result was seen; see the design document. */
export function decideGate(results) {
  const quality = results.filter((item) => item.kind === 'quality');
  const arm = (name, model) => quality.filter((item) => item.arm === name && (model === undefined || item.model === model));
  const models = [...new Set(quality.map((item) => item.model))];
  const rate = (group) => {
    const runs = results.filter((item) => item.kind === 'rate' && item.arm === 'new' && item.group === group);
    return runs.length ? runs.filter((item) => item.requested).length / runs.length : 0;
  };
  const details = {
    complete: { old: total(arm('old'), 'complete'), new: total(arm('new'), 'complete') },
    numeric: { old: total(arm('old'), 'numeric'), new: total(arm('new'), 'numeric') },
    perModel: Object.fromEntries(models.map((model) => [model, { old: total(arm('old', model), 'complete'), new: total(arm('new', model), 'complete'), firstText: median(arm('new', model).map((item) => item.firstTextSeconds)), oldTotal: median(arm('old', model).map((item) => item.totalSeconds)), newTotal: median(arm('new', model).map((item) => item.totalSeconds)) }])),
    explanatoryRate: rate('explanatory'),
    definitionRate: rate('definitions'),
  };
  const criteria = {
    moreComplete: details.complete.new > details.complete.old,
    noModelWorse: models.every((model) => details.perModel[model].new >= details.perModel[model].old),
    noNewNumericErrors: details.numeric.new <= details.numeric.old,
    visualRate: details.explanatoryRate >= .8,
    definitionRate: details.definitionRate <= .2,
    firstText: models.every((model) => details.perModel[model].firstText <= details.perModel[model].oldTotal),
  };
  return { pass: Object.values(criteria).every(Boolean), criteria, details };
}
