import { fromMarkdown } from 'mdast-util-from-markdown';
import { compileExpression, diagnoseTeachingVisual, parseTeachingVisual, plotSampleXs } from '../../src/lib/teaching-visuals.ts';
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

// Known spellings of common units: [symbols, words]. A symbol is case-sensitive (mV, MV and V are three units), a word is
// not. Nothing is inferred from a prefix: a prefixed unit is an entry of its own. A unit that is not here is compared by
// its exact spelling.
const UNIT_TABLE = [
  [['V', 'Vcc', 'Vdc'], ['volt', 'volts']],
  [['mV'], ['millivolt', 'millivolts']],
  [['kV'], ['kilovolt', 'kilovolts']],
  [['A'], ['ampere', 'amperes', 'ampère', 'ampères', 'amp', 'amps']],
  [['mA'], ['milliampere', 'milliamperes', 'milliampère', 'milliampères']],
  [['W'], ['watt', 'watts']],
  [['kW'], ['kilowatt', 'kilowatts']],
  [['J'], ['joule', 'joules']],
  [['kJ'], ['kilojoule', 'kilojoules']],
  [['N'], ['newton', 'newtons']],
  [['Pa'], ['pascal', 'pascals']],
  [['kPa'], ['kilopascal', 'kilopascals']],
  [['Hz'], ['hertz']],
  [['kHz'], ['kilohertz']],
  [['MHz'], ['megahertz', 'mégahertz']],
  [['m'], ['metre', 'metres', 'mètre', 'mètres', 'meter', 'meters']],
  [['cm'], ['centimetre', 'centimetres', 'centimètre', 'centimètres', 'centimeter', 'centimeters']],
  [['mm'], ['millimetre', 'millimetres', 'millimètre', 'millimètres', 'millimeter', 'millimeters']],
  [['km'], ['kilometre', 'kilometres', 'kilomètre', 'kilomètres', 'kilometer', 'kilometers']],
  [['s'], ['sec', 'seconde', 'secondes', 'second', 'seconds']],
  [['ms'], ['milliseconde', 'millisecondes', 'millisecond', 'milliseconds']],
  [['min'], ['minute', 'minutes']],
  [['h'], ['heure', 'heures', 'hour', 'hours']],
  [['g'], ['gramme', 'grammes', 'gram', 'grams']],
  [['mg'], ['milligramme', 'milligrammes', 'milligram', 'milligrams']],
  [['kg'], ['kilogramme', 'kilogrammes', 'kilogram', 'kilograms', 'kilo', 'kilos']],
  [['L', 'l'], ['litre', 'litres', 'liter', 'liters']],
  [['mL', 'ml'], ['millilitre', 'millilitres', 'milliliter', 'milliliters']],
  [['mol'], ['mole', 'moles']],
  [['K'], ['kelvin', 'kelvins']],
  [['°C'], ['degré celsius', 'degrés celsius', 'degree celsius', 'degrees celsius']],
  [['Ω', 'Ω'], ['ohm', 'ohms']],
  [['%'], ['pourcent', 'pourcents', 'pour cent', 'percent']],
];
const spellingsOf = ([symbols, words]) => [...symbols.map((text) => ({ text, exact: true })), ...words.map((text) => ({ text, exact: false }))];
const ALL_SPELLINGS = UNIT_TABLE.flatMap(spellingsOf);

// A spelling must end the word: a letter, a digit, an exponent or a compound mark after it (mm, m2, m/s, N.m) makes it another unit.
const spelled = (rest, { text, exact }) => {
  if (!(exact ? rest.startsWith(text) : rest.slice(0, text.length).toLowerCase() === text)) return false;
  const tail = rest.slice(text.length);
  return !/^[\p{L}\p{N}_/^·*⋅²³¹⁰-ⁿ]/u.test(tail) && !/^\.\p{L}/u.test(tail);
};

/** The text right after a number is compatible with the expected unit when it holds no unit, or spells the expected one. */
function compatible(rest, unit) {
  if (!/^[\p{L}%°]/u.test(rest)) return true;
  if (!unit) return !ALL_SPELLINGS.some((spelling) => spelled(rest, spelling));
  const group = UNIT_TABLE.find(([symbols, words]) => symbols.includes(unit) || words.includes(unit.toLowerCase()));
  return (group ? spellingsOf(group) : [{ text: unit, exact: true }]).some((spelling) => spelled(rest, spelling));
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const superscriptValue = (text) => (text.startsWith('⁻') ? -1 : 1) * Number([...text.replace(/[⁺⁻]/, '')].map((digit) => SUPERSCRIPT.indexOf(digit)).join(''));
const decimalOf = (text) => Number(text.replace(',', '.'));
const integerOf = (text) => Number(text.replace('−', '-'));
const DECIMAL = '(\\d+(?:[.,]\\d+)?)';
const MARKS = '[x×*·⋅]';
const SUPER_RUN = `([⁺⁻]?[${SUPERSCRIPT}]+)`;
// What can start at a digit, longest reading first. A form that gives no finite number is skipped.
const FORMS = [
  { pattern: new RegExp(`${DECIMAL}\\s*${MARKS}\\s*10\\s*(?:\\^|\\*\\*)\\s*[{(]?([-+−]?\\d+)[})]?`, 'y'), value: (m) => decimalOf(m[1]) * 10 ** integerOf(m[2]) },
  { pattern: new RegExp(`${DECIMAL}\\s*${MARKS}\\s*10${SUPER_RUN}`, 'y'), value: (m) => decimalOf(m[1]) * 10 ** superscriptValue(m[2]) },
  { pattern: new RegExp(`${DECIMAL}[eE]([-+−]?\\d+)(?![\\p{L}\\p{N}])`, 'yu'), value: (m) => decimalOf(m[1]) * 10 ** integerOf(m[2]) },
  { pattern: new RegExp(`${DECIMAL}\\s*\\^\\s*[{(]?([-+−]?\\d+)[})]?`, 'y'), value: (m) => decimalOf(m[1]) ** integerOf(m[2]) },
  { pattern: new RegExp(`${DECIMAL}${SUPER_RUN}`, 'y'), value: (m) => decimalOf(m[1]) ** superscriptValue(m[2]) },
  { pattern: new RegExp(`${DECIMAL}\\s*/\\s*${DECIMAL}(?![\\d.,]*\\d)`, 'y'), value: (m) => (decimalOf(m[2]) === 0 ? NaN : decimalOf(m[1]) / decimalOf(m[2])), fraction: true },
  { pattern: /\d{1,3}(?:[.,]\d{3}){2,}(?!\d)/y, value: (m) => Number(m[0].replace(/[.,]/g, '')) },
  { pattern: /\d{1,3}(?: \d{3})+(?!\d)(?:[.,]\d+)?/y, value: (m) => decimalOf(m[0].replace(/ /g, '')) },
];
const VULGAR = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

/**
 * An option as a learner reads it: Markdown emphasis, math delimiters and simple LaTeX (\frac, \times, \text, {,}, thin
 * spaces) are removed. `unreadable` is set when LaTeX is left that this cannot read.
 */
function plainText(option) {
  const text = String(option)
    .replace(/\p{Zs}/gu, ' ')
    .replace(/\\[dt]?frac\s*\{\s*([^{}]*?)\s*\}\s*\{\s*([^{}]*?)\s*\}/g, ' $1/$2 ')
    .replace(/\\(?:times|cdot)(?![A-Za-z])/g, '×')
    .replace(/\\approx(?![A-Za-z])/g, '≈')
    .replace(/\\(?:text|textrm|textit|textbf|mathrm|mathit|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:left|right)(?![A-Za-z])/g, '')
    .replace(/\\%/g, '%')
    .replace(/\\[,;:! ]|~/g, ' ')
    .replace(/\{,\}/g, ',')
    .replace(/\^\{\s*([^{}]*?)\s*\}/g, '^$1')
    .replace(/\\[()[\]]|\$/g, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^\s*[*_]([^*_]+)[*_]\s*$/, '$1');
  return { text, unreadable: /\\[A-Za-z]|[{}]/.test(text) };
}

/**
 * Every amount written in an option, in order. `ambiguous` marks a number with two readings (2,500 is 2.5 or 2500, 2 1/2 is
 * a mixed number or two numbers) or none (1.2.3). `decimals` is the number of decimals as written.
 */
function amountsIn(option) {
  const { text, unreadable } = plainText(option);
  const found = [];
  const masked = [...text];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (VULGAR[character] !== undefined) {
      const last = found.at(-1);
      // A whole number glued to a vulgar fraction is one number.
      if (last?.integer && last.end === index) { last.candidates = [last.candidates[0] + Math.sign(last.candidates[0] || 1) * VULGAR[character]]; last.integer = false; last.end = index + 1; }
      else found.push({ candidates: [VULGAR[character]], ambiguous: false, fraction: true, start: index, end: index + 1 });
      masked[index] = ' ';
      index++;
      continue;
    }
    if (!/\d/.test(character) || /\d/.test(text[index - 1] ?? '')) { index++; continue; }
    const plain = /\d+(?:[.,]\d+)*/y;
    plain.lastIndex = index;
    const run = plain.exec(text)[0];
    // A digit that belongs to a name (H2O, P2, x1) or to an exponent (x^2) is not an amount.
    if (/[\p{L}_^]/u.test(text[index - 1] ?? '')) { index += run.length; continue; }
    let candidates, ambiguous = false, end, fraction = false, integer = false, decimals;
    for (const form of FORMS) {
      form.pattern.lastIndex = index;
      const match = form.pattern.exec(text);
      const number = match && form.value(match);
      if (match && Number.isFinite(number)) {
        candidates = [number]; end = index + match[0].length; fraction = form.fraction === true;
        for (let at = index; at < end; at++) masked[at] = ' ';
        break;
      }
    }
    if (!candidates) {
      const parts = run.split(/[.,]/);
      end = index + run.length;
      if (parts.length === 1) { candidates = [Number(run)]; integer = true; }
      else if (parts.length === 2 && !(parts[1].length === 3 && parts[0].length <= 3 && !parts[0].startsWith('0'))) { candidates = [decimalOf(run)]; decimals = parts[1].length; }
      else {
        ambiguous = true;
        candidates = parts.length === 2 ? [decimalOf(run), Number(parts.join(''))] : [];
        if (parts.length === 2) decimals = parts[1].length;
      }
    }
    const signed = /[-+−]/.test(text[index - 1] ?? '') && !/[\p{L}\p{N})\]]/u.test(text[index - 2] ?? '');
    const sign = signed && text[index - 1] !== '+' ? -1 : 1;
    found.push({ candidates: candidates.map((number) => sign * number), ambiguous, fraction, integer, decimals, start: index, end });
    index = end;
  }
  // 2 1/2: a whole number and a fraction apart by spaces may be one mixed number.
  found.forEach((item, position) => {
    const next = found[position + 1];
    if (item.integer && next?.fraction && /^ +$/.test(text.slice(item.end, next.start))) {
      item.candidates = [...item.candidates, item.candidates[0] + Math.sign(item.candidates[0] || 1) * next.candidates[0]];
      item.ambiguous = true;
      next.ambiguous = true;
    }
  });
  const leftover = masked.join('');
  const expression = unreadable || /[\^√]|sqrt|\d\s*!|[A-Za-z]\(\s*\d+\s*[,;]\s*\d+\s*\)/.test(leftover);
  const items = found.map((item, position) => ({ ...item, before: text.slice(0, item.start), rest: text.slice(item.end).trimStart(), gap: position ? text.slice(found[position - 1].end, item.start) : '' }));
  return { items, expression };
}

/**
 * Reads one quiz option against the expected amount. kind: 'match' (an amount equals the value and its unit is absent or a
 * known spelling of the expected unit), 'unit' (the value with another or an unknown unit) or 'none'. `clear` says a match
 * is certain, `clean` that the whole option was read without doubt: only then can its number be called wrong. A number that
 * could be the value in another form (rounded, in another unit, a percentage, an unevaluated expression) is never wrong.
 */
function readOption(option, { value, unit = '', tolerance }) {
  const allowed = tolerance ?? 1e-9 * Math.max(1, Math.abs(value));
  const target = unit.trim();
  const { items, expression } = amountsIn(option);
  const chain = items.some((item) => /^\s*[-+−×x*·⋅/÷^]\s*$/.test(item.gap));
  const percent = (item) => !target && /^%(?![\p{L}\p{N}])/u.test(item.rest);
  const reads = (item) => (percent(item) ? item.candidates.map((number) => number / 100) : item.candidates);
  const equal = (item) => reads(item).some((number) => Math.abs(number - value) <= allowed);
  // A figure that is the value rounded to the decimals it is written with (0,17 for 0.16807) is a rounding, not an error.
  const rounded = (item) => {
    const figures = String(Math.abs(item.candidates[0])).replace(/\D|^0+/g, '').length;
    const readings = [[item.candidates[0], item.decimals], ...(percent(item) ? [[item.candidates[0] / 100, (item.decimals ?? 0) + 2]] : [])];
    return readings.some(([number, decimals]) => decimals >= 1 && (decimals >= 2 || figures >= 2) && Math.abs(Number(value.toFixed(decimals)) - number) <= 1e-12 * Math.max(1, Math.abs(value)));
  };
  const scaled = (item) => target === '%' && item.candidates.some((number) => Math.abs(number * 100 - value) <= allowed * 100);
  const understood = (item) => equal(item) || (!(item.ambiguous && item.candidates.length === 0) && !rounded(item) && !scaled(item) && (percent(item) || compatible(item.rest, target)));
  const clean = items.length > 0 && !chain && !expression && items.every(understood);
  const hits = items.filter(equal);
  const accepted = hits.filter((item) => percent(item) || compatible(item.rest, target));
  if (accepted.length) return { kind: 'match', clear: !expression && accepted.some((item) => !item.ambiguous && (!chain || /[=≈→]\s*$/.test(item.before))), clean };
  return { kind: hits.length ? 'unit' : 'none', clear: false, clean };
}

export const matchAmount = (option, correct) => readOption(option, correct).kind;

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
  const readAll = (quiz) => quiz.options.map((option) => readOption(option, spec.correct));
  const quiz = quizzes.find((item) => readAll(item).some((option) => option.kind === 'match')) ?? quizzes[0];
  const found = readAll(quiz);
  const matching = found.filter((option) => option.kind === 'match');
  const keyed = found[quiz.answer];
  // numeric is a false accusation if it is wrong, and both arms are scored the same way: in doubt the quiz is incomplete.
  const numeric = (message) => ({ type: 'quiz', status: 'numeric', errors: [message] });
  const doubt = (message) => ({ type: 'quiz', status: 'incomplete', errors: [message] });
  const wrongKey = keyed.kind === 'none' && keyed.clean;
  if (matching.length > 1) return matching.filter((option) => option.clear).length > 1 ? numeric(`${matching.length} options match the correct value`) : doubt('several options may match the correct value');
  if (matching.length === 1) {
    if (keyed !== matching[0]) return wrongKey ? numeric('the key points to a wrong option') : doubt('the key points to an option that cannot be read with certainty');
    return keyed.clear ? { type: 'quiz', status: 'complete', errors: [] } : doubt('the keyed option holds the value but not with certainty');
  }
  if (found.some((option) => option.kind === 'unit')) return doubt('the right number has an incompatible unit');
  return wrongKey ? numeric('no option has the correct value') : doubt('the keyed option cannot be read with certainty');
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

/**
 * What the app would have to accept for a model to draw this plot: the sliders become parameters, the curves series and the
 * readouts outputs, and the app's own parser judges them. Reusing it keeps this check from drifting from the app.
 */
function plotProblems(spec) {
  const probe = {
    type: 'plot',
    title: 'case',
    x: { min: spec.x.min, max: spec.x.max, ...(spec.x.step === undefined ? {} : { step: spec.x.step }) },
    parameters: spec.sliders.map((slider) => ({ name: slider.key, label: 'slider', min: slider.min, max: slider.max, step: slider.step, value: slider.value })),
    series: spec.curves.map((expression, index) => ({ label: `curve ${index + 1}`, expression })),
    outputs: (spec.readouts ?? []).map((expression, index) => ({ label: `readout ${index + 1}`, expression })),
  };
  return diagnoseTeachingVisual(JSON.stringify(probe)).errors;
}

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
        const before = problems.length;
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
        if (problems.length === before) for (const message of plotProblems(spec)) bad(`plot: ${message}`);
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

function gateOver(results, expectedCells, invalidations) {
  const expected = new Map(expectedCells.map((item) => [item.cell, item]));
  // The expected cell says which model, arm and kind a row belongs to; a stored row cannot move itself to another model.
  const rows = results.filter((item) => expected.has(item.cell)).map((item) => { const { model, arm, kind } = expected.get(item.cell); return { ...expected.get(item.cell), ...item, model, arm, kind }; });
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
      // Every measured row is in the clocks, a timed out or rejected one at its real elapsed time: the learner waited that long.
      firstText: median(arm('new', model).map((item) => item.firstTextSeconds)),
      oldTotal: median(arm('old', model).map((item) => item.totalSeconds)),
      newTotal: median(arm('new', model).map((item) => item.totalSeconds)),
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
  // Two arms that both gave no usable answer compare nothing: the model is undecided, not a pass.
  for (const model of models) if (arm('old', model).length && arm('new', model).length && !quality.some((item) => item.model === model && !item.failed)) details.reasons.push(`no answered row in either arm for ${model}`);
  const incomplete = details.reasons.length > 0;
  const criteria = {
    moreComplete: details.complete.new > details.complete.old,
    noModelWorse: models.every((model) => details.perModel[model].new >= details.perModel[model].old),
    noNewNumericErrors: details.numeric.new <= details.numeric.old,
    visualRate: explanatoryRate >= .8,
    definitionRate: definitionRate <= .2,
    firstText: models.every((model) => details.perModel[model].firstText <= details.perModel[model].oldTotal),
    noMoreFailures: models.every((model) => details.perModel[model].failed.new <= details.perModel[model].failed.old),
  };
  return { pass: !incomplete && Object.values(criteria).every(Boolean), incomplete, criteria, details };
}

/**
 * Criteria fixed before any result was seen; see the design document. Data validity is decided here, not in the
 * criteria: every expected cell must be measured, and `invalidations` lists reasons the whole run cannot decide.
 * `reportOnly` lists model ids that are measured but decide nothing: their cells take no part in any criterion, in
 * `missing`, in `reasons` or in `incomplete`, and their numbers are reported apart under `details.reportOnly`.
 */
export function decideGate(results, expectedCells, { invalidations = [], reportOnly = [] } = {}) {
  const apart = new Set(reportOnly);
  const cellsOf = (keep) => expectedCells.filter((item) => keep(item.model));
  const resultsOf = (cells) => { const ids = new Set(cells.map((item) => item.cell)); return results.filter((item) => ids.has(item.cell)); };
  const gatedCells = cellsOf((model) => !apart.has(model));
  const gate = gateOver(resultsOf(gatedCells), gatedCells, invalidations);
  if (!apart.size) return gate;
  const reported = {};
  for (const model of apart) {
    const cells = cellsOf((id) => id === model);
    if (!cells.length) continue;
    const { details } = gateOver(resultsOf(cells), cells, []);
    const { failed, firstText, oldTotal, newTotal } = details.perModel[model];
    reported[model] = { complete: details.complete, numeric: details.numeric, failed, firstText, oldTotal, newTotal, explanatoryRate: details.explanatoryRate, definitionRate: details.definitionRate, missing: details.missing.length };
  }
  return { ...gate, details: { ...gate.details, reportOnly: reported } };
}

/** Report-only pairs run after every gated pair, whatever the order of the model list (the sort is stable). */
export const reportOnlyLast = (pairs) => [...pairs].sort((a, b) => Number(Boolean(a.model.reportOnly)) - Number(Boolean(b.model.reportOnly)));
