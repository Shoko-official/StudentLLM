export interface TeachingParameter { name: string; label: string; min: number; max: number; step: number; value: number }
export interface TeachingOutput { label: string; expression: string; unit?: string }
export interface TeachingPlot {
  type: 'plot'; title: string; description?: string;
  x: { min: number; max: number; label?: string; step?: number }; y?: { min: number; max: number; label?: string };
  chartType?: 'line' | 'bar';
  series: Array<{ label: string; expression?: string; points?: Array<[number, number]> }>;
  parameters?: TeachingParameter[]; outputs?: TeachingOutput[];
}
export interface TeachingDiagram {
  type: 'diagram'; title: string; description?: string;
  nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string; label?: string }>;
}
export interface TeachingFigure {
  type: 'figure'; title: string; description?: string; width: number; height: number;
  shapes: Array<
    { type: 'rect'; x: number; y: number; width: number; height: number; label?: string; color?: string }
    | { type: 'circle'; x: number; y: number; r: number; label?: string; color?: string }
    | { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; label?: string; color?: string }
    | { type: 'text'; x: number; y: number; text: string }
  >;
}
export interface TeachingQuiz {
  type: 'quiz'; title: string; question: string; options: string[]; answer: number; explanation: string; hint?: string;
}
export type TeachingVisual = TeachingPlot | TeachingDiagram | TeachingFigure | TeachingQuiz;
export const MAX_PLOT_SAMPLES = 161;

type ExpressionNode = { kind: 'number'; value: number } | { kind: 'variable'; name: string }
  | { kind: 'unary'; sign: string; node: ExpressionNode }
  | { kind: 'binary'; operator: string; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'call'; name: string; args: ExpressionNode[] };
const forbiddenNames = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'window', 'document', 'globalThis', 'this', 'eval', 'Function', 'function', 'return', 'var', 'let', 'const', 'new', 'class', 'for', 'while', 'fetch', 'import', 'await', 'yield', 'delete', 'typeof', 'Infinity', 'NaN', 'true', 'false', 'null', 'undefined']);
const arities: Record<string, number[]> = {
  sin: [1], cos: [1], tan: [1], exp: [1], log: [1], sqrt: [1], abs: [1], floor: [1], ceil: [1], round: [1],
  min: [2], max: [2], pow: [2], factorial: [1], binomial: [3], sum: [4],
};

function expressionTree(source: string): ExpressionNode | null {
  if (!source.length || source.length > 300) return null;
  const tokens: string[] = [];
  const scanner = /\s*([0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|[+*/^(),-])/y;
  let cursor = 0;
  while (cursor < source.length) {
    scanner.lastIndex = cursor;
    const match = scanner.exec(source);
    if (!match) { if (!source.slice(cursor).trim()) break; return null; }
    tokens.push(match[1]);
    cursor = scanner.lastIndex;
  }
  let index = 0;
  let nodeCount = 0;
  const make = (node: ExpressionNode) => { if (++nodeCount > 160) throw new Error('Expression limit'); return node; };
  const take = () => tokens[index++];
  const requireToken = (token: string) => { if (take() !== token) throw new Error('Unexpected token'); };
  function primary(depth: number): ExpressionNode {
    if (depth > 20) throw new Error('Expression depth');
    const token = take();
    if (token === '(') { const inner = add(depth + 1); requireToken(')'); return inner; }
    if (/^(?:[0-9]|\.[0-9])/.test(token ?? '')) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('Invalid number');
      return make({ kind: 'number', value });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token ?? '') || forbiddenNames.has(token)) throw new Error('Invalid identifier');
    if (tokens[index] !== '(') return make({ kind: 'variable', name: token });
    if (!Object.hasOwn(arities, token)) throw new Error('Unknown function');
    take();
    const args: ExpressionNode[] = [];
    if (tokens[index] !== ')') {
      do { if (args.length) requireToken(','); args.push(add(depth + 1)); } while (tokens[index] === ',');
    }
    requireToken(')');
    if (!arities[token].includes(args.length)) throw new Error('Function arity');
    if (token === 'sum' && !(args[0].kind === 'variable' && args[0].name === 'k')) throw new Error('Sum index');
    return make({ kind: 'call', name: token, args });
  }
  function power(depth: number): ExpressionNode {
    const left = primary(depth);
    return tokens[index] === '^' ? (take(), make({ kind: 'binary', operator: '^', left, right: unary(depth + 1) })) : left;
  }
  function unary(depth: number): ExpressionNode {
    if (depth > 20) throw new Error('Expression depth');
    return tokens[index] === '+' || tokens[index] === '-'
      ? make({ kind: 'unary', sign: take(), node: unary(depth + 1) }) : power(depth);
  }
  function multiply(depth: number): ExpressionNode {
    let result = unary(depth);
    while (tokens[index] === '*' || tokens[index] === '/') result = make({ kind: 'binary', operator: take(), left: result, right: unary(depth) });
    return result;
  }
  function add(depth: number): ExpressionNode {
    let result = multiply(depth);
    while (tokens[index] === '+' || tokens[index] === '-') result = make({ kind: 'binary', operator: take(), left: result, right: multiply(depth) });
    return result;
  }
  try { const result = add(0); return index === tokens.length ? result : null; } catch { return null; }
}

function evaluateTree(tree: ExpressionNode, variables: Record<string, number>) {
  let remaining = 4096;
  function calculate(node: ExpressionNode, boundK?: number): number {
    if (--remaining < 0) return NaN;
    if (node.kind === 'number') return node.value;
    if (node.kind === 'variable') {
      if (node.name === 'pi') return Math.PI;
      if (node.name === 'e') return Math.E;
      if (node.name === 'k' && boundK !== undefined) return boundK;
      return Object.hasOwn(variables, node.name) && Number.isFinite(variables[node.name]) ? variables[node.name] : NaN;
    }
    if (node.kind === 'unary') return (node.sign === '-' ? -1 : 1) * calculate(node.node, boundK);
    if (node.kind === 'binary') {
      const left = calculate(node.left, boundK); const right = calculate(node.right, boundK);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
      if (node.operator === '+') return left + right;
      if (node.operator === '-') return left - right;
      if (node.operator === '*') return left * right;
      if (node.operator === '/') return left / right;
      return Math.pow(left, right);
    }
    if (node.name === 'sum') {
      const start = calculate(node.args[1], boundK); const end = calculate(node.args[2], boundK);
      if (!Number.isInteger(start) || !Number.isInteger(end) || Math.abs(start) > 10000 || Math.abs(end) > 10000 || end - start >= 64) return NaN;
      let total = 0;
      for (let k = start; k <= end; k++) { total += calculate(node.args[3], k); if (!Number.isFinite(total) || remaining < 0) return NaN; }
      return total;
    }
    const args = node.args.map((item) => calculate(item, boundK));
    if (args.some((value) => !Number.isFinite(value))) return NaN;
    const [a, b, c] = args;
    switch (node.name) {
      case 'sin': return Math.sin(a); case 'cos': return Math.cos(a); case 'tan': return Math.tan(a);
      case 'exp': return Math.exp(a); case 'log': return Math.log(a); case 'sqrt': return Math.sqrt(a);
      case 'abs': return Math.abs(a); case 'floor': return Math.floor(a); case 'ceil': return Math.ceil(a); case 'round': return Math.round(a);
      case 'min': return Math.min(a, b); case 'max': return Math.max(a, b); case 'pow': return Math.pow(a, b);
      case 'factorial': {
        if (!Number.isInteger(a) || a < 0 || a > 170) return NaN;
        let product = 1;
        for (let k = 2; k <= a; k++) { if (--remaining < 0) return NaN; product *= k; }
        return product;
      }
      case 'binomial': {
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 170 || c < 0 || c > 1) return NaN;
        if (b < 0 || b > a) return 0;
        let combinations = 1;
        for (let k = 1; k <= Math.min(b, a - b); k++) { if (--remaining < 0) return NaN; combinations *= (a - k + 1) / k; }
        return combinations * Math.pow(c, b) * Math.pow(1 - c, a - b);
      }
      default: return NaN;
    }
  }
  const result = calculate(tree);
  return Number.isFinite(result) ? result : NaN;
}

/** Parses a small arithmetic language. This never evaluates JavaScript or accesses object properties. */
export function compileExpression(source: string): ((variables: Record<string, number>) => number) | null {
  const tree = expressionTree(source);
  return tree ? (variables) => evaluateTree(tree, variables) : null;
}

function expressionProblem(value: unknown, allowed: Set<string>): string | null {
  if (typeof value !== 'string') return 'must be a string';
  const tree = expressionTree(value);
  if (!tree) return 'cannot be parsed: check the syntax, function names and argument counts';
  const unknown = new Set<string>();
  function visit(node: ExpressionNode, bound = false): void {
    if (node.kind === 'number') return;
    if (node.kind === 'variable') {
      if (!(node.name === 'pi' || node.name === 'e' || (node.name === 'k' ? bound : allowed.has(node.name)))) unknown.add(node.name);
      return;
    }
    if (node.kind === 'unary') return visit(node.node, bound);
    if (node.kind === 'binary') { visit(node.left, bound); visit(node.right, bound); return; }
    if (node.name === 'sum') { visit(node.args[1], bound); visit(node.args[2], bound); visit(node.args[3], true); return; }
    node.args.forEach((item) => visit(item, bound));
  }
  visit(tree);
  return unknown.size ? `uses undeclared names: ${[...unknown].join(', ')}` : null;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit = 180): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value); }
function number(value: unknown, minimum = -1e9, maximum = 1e9): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum; }
function list(value: unknown, min: number, max: number): value is unknown[] { return Array.isArray(value) && value.length >= min && value.length <= max; }
function optionalText(value: unknown, limit?: number) { return value === undefined || text(value, limit); }
function axis(value: unknown): value is TeachingPlot['x'] {
  return record(value) && number(value.min) && number(value.max) && value.max > value.min && optionalText(value.label, 80)
    && (value.step === undefined || (number(value.step, 1e-9) && Math.ceil((value.max - value.min) / value.step) + 1 <= MAX_PLOT_SAMPLES));
}
function normalizedAxis(value: TeachingPlot['x']) {
  return { min: value.min, max: value.max, ...(value.label === undefined ? {} : { label: value.label }), ...(value.step === undefined ? {} : { step: value.step }) };
}
function alignedParameterDefault(min: number, step: number, value: number) {
  const snapped = min + Math.round((value - min) / step) * step;
  // Compare coordinates to avoid cancellation around a large nonzero minimum.
  // Cap tolerance to a tiny fraction of a step so decimal roundoff cannot hide an off-grid default.
  const tolerance = Math.min(step * 1e-7, Number.EPSILON * 8 * Math.max(1, Math.abs(min), Math.abs(value), Math.abs(snapped)));
  return Math.abs(snapped - value) <= tolerance;
}
const colors = new Set(['blue', 'orange', 'green', 'purple', 'red', 'neutral']);

function parameterProblem(item: unknown, names: Set<string>): string | null {
  if (!record(item)) return 'must be an object';
  if (!text(item.name, 24) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)) return 'name must be an ASCII identifier of at most 24 characters';
  if (forbiddenNames.has(item.name) || ['x', 'k', 'pi', 'e'].includes(item.name) || Object.hasOwn(arities, item.name)) return `name "${item.name}" is reserved`;
  if (names.has(item.name)) return `name "${item.name}" is declared twice`;
  if (!text(item.label, 100)) return 'label must be nonblank text of at most 100 characters';
  if (!number(item.min) || !number(item.max) || item.max <= item.min) return 'needs numeric min < max';
  if (!number(item.step, 1e-9) || item.step > item.max - item.min) return 'step must be positive and no larger than max - min';
  if (!number(item.value, item.min, item.max)) return 'value must lie between min and max';
  if (!alignedParameterDefault(item.min, item.step, item.value)) return 'value must equal min plus a whole number of steps';
  return null;
}

function plot(value: Record<string, unknown>, errors: string[]): TeachingPlot | null {
  if (!axis(value.x)) errors.push('x needs numeric min < max, an optional label of at most 80 characters, and a step that gives at most 161 samples');
  if (value.y !== undefined && !axis(value.y)) errors.push('y needs numeric min < max and an optional label of at most 80 characters');
  if (value.chartType !== undefined && value.chartType !== 'line' && value.chartType !== 'bar') errors.push('chartType must be line or bar');
  if (!list(value.series, 1, 4)) errors.push('series needs 1 to 4 entries');
  if (value.parameters !== undefined && !list(value.parameters, 0, 4)) errors.push('parameters allows at most 4 entries');
  if (value.outputs !== undefined && !list(value.outputs, 0, 4)) errors.push('outputs allows at most 4 entries');
  const parameters: TeachingParameter[] = [];
  const names = new Set<string>();
  (list(value.parameters, 0, 4) ? value.parameters : []).forEach((item, index) => {
    const problem = parameterProblem(item, names);
    if (problem) { errors.push(`parameters[${index}]: ${problem}`); return; }
    const { name, label, min, max, step, value: initial } = item as TeachingParameter;
    names.add(name);
    parameters.push({ name, label, min, max, step, value: initial });
  });
  const allowed = new Set([...names, 'x']);
  const series: TeachingPlot['series'] = [];
  (list(value.series, 1, 4) ? value.series : []).forEach((item, index) => {
    if (!record(item) || !text(item.label, 100)) { errors.push(`series[${index}]: label must be nonblank text of at most 100 characters`); return; }
    if ((item.expression === undefined) === (item.points === undefined)) { errors.push(`series "${item.label}": needs exactly one of expression or points`); return; }
    if (item.expression !== undefined) {
      const problem = expressionProblem(item.expression, allowed);
      if (problem) errors.push(`series "${item.label}": expression ${problem}`);
      else series.push({ label: item.label, expression: item.expression as string });
    } else if (!list(item.points, 2, MAX_PLOT_SAMPLES) || !item.points.every((point) => Array.isArray(point) && point.length === 2 && number(point[0]) && number(point[1]))) {
      errors.push(`series "${item.label}": points must be 2 to 161 numeric [x,y] pairs`);
    } else series.push({ label: item.label, points: item.points.map((point) => [...point as [number, number]]) });
  });
  const outputs: TeachingOutput[] = [];
  (list(value.outputs, 0, 4) ? value.outputs : []).forEach((item, index) => {
    if (!record(item)) { errors.push(`outputs[${index}]: must be an object`); return; }
    // An empty optional unit carries no display information; keep the valid calculation.
    const unit = typeof item.unit === 'string' && item.unit.length <= 40 && !item.unit.trim() ? undefined : item.unit;
    if (!text(item.label, 100)) { errors.push(`outputs[${index}]: label must be nonblank text of at most 100 characters`); return; }
    if (!optionalText(unit, 40)) { errors.push(`outputs "${item.label}": unit must be text of at most 40 characters`); return; }
    const problem = expressionProblem(item.expression, names);
    if (problem) { errors.push(`outputs "${item.label}": expression ${problem}`); return; }
    outputs.push({ label: item.label, expression: item.expression as string, ...(unit === undefined ? {} : { unit: unit as string }) });
  });
  if (errors.length) return null;
  return { type: 'plot', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }),
    x: normalizedAxis(value.x as TeachingPlot['x']), ...(value.y === undefined ? {} : { y: normalizedAxis(value.y as TeachingPlot['x']) }),
    ...(value.chartType === undefined ? {} : { chartType: value.chartType as 'line' | 'bar' }), series,
    ...(value.parameters === undefined ? {} : { parameters }), ...(value.outputs === undefined ? {} : { outputs }) };
}

function diagram(value: Record<string, unknown>, errors: string[]): TeachingDiagram | null {
  if (!list(value.nodes, 1, 24)) errors.push('nodes needs 1 to 24 entries');
  if (!list(value.edges, 0, 48)) errors.push('edges needs an array of at most 48 entries');
  const nodes: TeachingDiagram['nodes'] = [];
  const ids = new Set<string>();
  (list(value.nodes, 1, 24) ? value.nodes : []).forEach((item, index) => {
    if (!record(item) || !text(item.id, 64) || !text(item.label, 160)) { errors.push(`nodes[${index}]: needs id (at most 64 characters) and label (at most 160 characters)`); return; }
    if (ids.has(item.id)) { errors.push(`nodes[${index}]: id "${item.id}" is used twice`); return; }
    ids.add(item.id); nodes.push({ id: item.id, label: item.label });
  });
  const edges: TeachingDiagram['edges'] = [];
  (list(value.edges, 0, 48) ? value.edges : []).forEach((item, index) => {
    if (!record(item)) { errors.push(`edges[${index}]: must be an object`); return; }
    if (typeof item.from !== 'string' || !ids.has(item.from)) { errors.push(`edges[${index}]: from names unknown node "${String(item.from)}"`); return; }
    if (typeof item.to !== 'string' || !ids.has(item.to)) { errors.push(`edges[${index}]: to names unknown node "${String(item.to)}"`); return; }
    if (!optionalText(item.label, 100)) { errors.push(`edges[${index}]: label must be text of at most 100 characters`); return; }
    edges.push({ from: item.from, to: item.to, ...(item.label === undefined ? {} : { label: item.label as string }) });
  });
  if (errors.length) return null;
  return { type: 'diagram', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }), nodes, edges };
}

function figure(value: Record<string, unknown>, errors: string[]): TeachingFigure | null {
  if (!number(value.width, 240, 1200) || !number(value.height, 120, 900)) { errors.push('width must be 240 to 1200 and height 120 to 900'); return null; }
  if (!list(value.shapes, 1, 64)) { errors.push('shapes needs 1 to 64 entries'); return null; }
  const shapes: TeachingFigure['shapes'] = [];
  const w = value.width; const h = value.height;
  value.shapes.forEach((item, index) => {
    const at = `shapes[${index}]`;
    if (!record(item) || !optionalText(item.label, 100) || (item.color !== undefined && (typeof item.color !== 'string' || !colors.has(item.color)))) { errors.push(`${at}: label must be short text and color one of blue, orange, green, purple, red, neutral`); return; }
    const extras = { ...(item.label === undefined ? {} : { label: item.label as string }), ...(item.color === undefined ? {} : { color: item.color as string }) };
    if (item.type === 'line' || item.type === 'arrow') {
      if (!number(item.x1, 0, w) || !number(item.x2, 0, w) || !number(item.y1, 0, h) || !number(item.y2, 0, h)) { errors.push(`${at}: endpoints must stay inside the ${w} by ${h} canvas`); return; }
      shapes.push({ type: item.type, x1: item.x1, x2: item.x2, y1: item.y1, y2: item.y2, ...extras });
      return;
    }
    if (!number(item.x, 0, w) || !number(item.y, 0, h)) { errors.push(`${at}: x and y must stay inside the ${w} by ${h} canvas`); return; }
    if (item.type === 'rect') {
      if (!number(item.width, 1, w - item.x) || !number(item.height, 1, h - item.y)) { errors.push(`${at}: the rectangle must stay inside the canvas`); return; }
      shapes.push({ type: 'rect', x: item.x, y: item.y, width: item.width, height: item.height, ...extras });
    } else if (item.type === 'circle') {
      if (!number(item.r, 1, Math.min(item.x, w - item.x, item.y, h - item.y))) { errors.push(`${at}: the circle must stay inside the canvas`); return; }
      shapes.push({ type: 'circle', x: item.x, y: item.y, r: item.r, ...extras });
    } else if (item.type === 'text' && text(item.text, 180)) shapes.push({ type: 'text', x: item.x, y: item.y, text: item.text });
    else errors.push(`${at}: type must be rect, circle, line, arrow or text, and text needs nonblank content`);
  });
  if (errors.length) return null;
  return { type: 'figure', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }), width: w, height: h, shapes };
}

function quiz(value: Record<string, unknown>, errors: string[]): TeachingQuiz | null {
  if (!text(value.question, 2000)) errors.push('question must be nonblank text of at most 2000 characters');
  const options = list(value.options, 2, 6) && value.options.every((option) => text(option, 500));
  if (!options) errors.push('options needs 2 to 6 nonblank strings of at most 500 characters');
  if (options && (!number(value.answer, 0, (value.options as unknown[]).length - 1) || !Number.isInteger(value.answer))) errors.push('answer must be a zero-based index of options');
  if (!text(value.explanation, 3000)) errors.push('explanation must be nonblank text of at most 3000 characters');
  if (!optionalText(value.hint, 1000)) errors.push('hint must be text of at most 1000 characters');
  if (errors.length) return null;
  return { type: 'quiz', title: value.title as string, question: value.question as string, options: [...value.options as string[]], answer: value.answer as number, explanation: value.explanation as string, ...(value.hint === undefined ? {} : { hint: value.hint as string }) };
}

/** Accepts data only; the errors are written for the model that must correct the object. */
export function diagnoseTeachingVisual(content: string): { visual: TeachingVisual | null; errors: string[] } {
  if (content.length > 32768) return { visual: null, errors: ['the object exceeds 32768 characters'] };
  let value: unknown;
  try { value = JSON.parse(content); } catch { return { visual: null, errors: ['the output is not valid JSON'] }; }
  if (!record(value)) return { visual: null, errors: ['the output must be a JSON object'] };
  const errors: string[] = [];
  if (!text(value.title)) errors.push('title must be nonblank text of at most 180 characters');
  if (!optionalText(value.description, 1200)) errors.push('description must be text of at most 1200 characters');
  let visual: TeachingVisual | null = null;
  try {
    if (value.type === 'plot') visual = plot(value, errors);
    else if (value.type === 'diagram') visual = diagram(value, errors);
    else if (value.type === 'figure') visual = figure(value, errors);
    else if (value.type === 'quiz') visual = quiz(value, errors);
    else errors.push('type must be plot, diagram, figure or quiz');
  } catch { errors.push('the object could not be read'); }
  return errors.length || !visual ? { visual: null, errors: errors.length ? errors : ['the object could not be read'] } : { visual, errors: [] };
}

/** Accepts data only and returns a normalized object with no event handlers, URLs or unknown fields. */
export function parseTeachingVisual(content: string): TeachingVisual | null {
  return diagnoseTeachingVisual(content).visual;
}

export function plotSampleXs(x: TeachingPlot['x']): number[] {
  const count = x.step ? Math.min(MAX_PLOT_SAMPLES, Math.floor((x.max - x.min) / x.step + 1e-9) + 1) : MAX_PLOT_SAMPLES;
  return Array.from({ length: count }, (_, sample) => x.step ? x.min + sample * x.step : x.min + sample / (MAX_PLOT_SAMPLES - 1) * (x.max - x.min));
}
