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

function validExpression(value: unknown, allowed: Set<string>): value is string {
  if (typeof value !== 'string') return false;
  const tree = expressionTree(value);
  if (!tree) return false;
  function valid(node: ExpressionNode, bound = false): boolean {
    if (node.kind === 'number') return true;
    if (node.kind === 'variable') return node.name === 'pi' || node.name === 'e' || (node.name === 'k' ? bound : allowed.has(node.name));
    if (node.kind === 'unary') return valid(node.node, bound);
    if (node.kind === 'binary') return valid(node.left, bound) && valid(node.right, bound);
    if (node.name === 'sum') return valid(node.args[1], bound) && valid(node.args[2], bound) && valid(node.args[3], true);
    return node.args.every((item) => valid(item, bound));
  }
  return valid(tree);
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

function plot(value: Record<string, unknown>): TeachingPlot | null {
  if (!axis(value.x) || (value.y !== undefined && !axis(value.y)) || (value.chartType !== undefined && value.chartType !== 'line' && value.chartType !== 'bar') || !list(value.series, 1, 4)) return null;
  if (value.parameters !== undefined && !list(value.parameters, 0, 4)) return null;
  const parameters: TeachingParameter[] = [];
  const names = new Set<string>();
  for (const item of (value.parameters ?? []) as unknown[]) {
    if (!record(item) || !text(item.name, 24) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || forbiddenNames.has(item.name) || ['x', 'k', 'pi', 'e'].includes(item.name) || Object.hasOwn(arities, item.name) || names.has(item.name)
      || !text(item.label, 100) || !number(item.min) || !number(item.max) || item.max <= item.min || !number(item.step, 1e-9) || item.step > item.max - item.min || !number(item.value, item.min, item.max)
      || !alignedParameterDefault(item.min, item.step, item.value)) return null;
    names.add(item.name);
    parameters.push({ name: item.name, label: item.label, min: item.min, max: item.max, step: item.step, value: item.value });
  }
  const allowed = new Set([...names, 'x']);
  const series: TeachingPlot['series'] = [];
  for (const item of value.series) {
    if (!record(item) || !text(item.label, 100) || (item.expression === undefined) === (item.points === undefined)) return null;
    if (item.expression !== undefined) {
      if (!validExpression(item.expression, allowed)) return null;
      series.push({ label: item.label, expression: item.expression });
    } else {
      if (!list(item.points, 2, MAX_PLOT_SAMPLES) || !item.points.every((point) => Array.isArray(point) && point.length === 2 && number(point[0]) && number(point[1]))) return null;
      series.push({ label: item.label, points: item.points.map((point) => [...point as [number, number]]) });
    }
  }
  if (value.outputs !== undefined && !list(value.outputs, 0, 4)) return null;
  const outputs: TeachingOutput[] = [];
  for (const item of (value.outputs ?? []) as unknown[]) {
    if (!record(item)) return null;
    // An empty optional unit carries no display information; keep the valid calculation.
    const unit = typeof item.unit === 'string' && item.unit.length <= 40 && !item.unit.trim() ? undefined : item.unit;
    if (!text(item.label, 100) || !validExpression(item.expression, names) || !optionalText(unit, 40)) return null;
    outputs.push({ label: item.label, expression: item.expression, ...(unit === undefined ? {} : { unit: unit as string }) });
  }
  return { type: 'plot', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }),
    x: normalizedAxis(value.x), ...(value.y === undefined ? {} : { y: normalizedAxis(value.y as TeachingPlot['x']) }),
    ...(value.chartType === undefined ? {} : { chartType: value.chartType }), series,
    ...(value.parameters === undefined ? {} : { parameters }), ...(value.outputs === undefined ? {} : { outputs }) };
}

function diagram(value: Record<string, unknown>): TeachingDiagram | null {
  if (!list(value.nodes, 1, 24) || !list(value.edges, 0, 48)) return null;
  const nodes: TeachingDiagram['nodes'] = [];
  const ids = new Set<string>();
  for (const item of value.nodes) {
    if (!record(item) || !text(item.id, 64) || !text(item.label, 160) || ids.has(item.id)) return null;
    ids.add(item.id); nodes.push({ id: item.id, label: item.label });
  }
  const edges: TeachingDiagram['edges'] = [];
  for (const item of value.edges) {
    if (!record(item) || typeof item.from !== 'string' || typeof item.to !== 'string' || !ids.has(item.from) || !ids.has(item.to) || !optionalText(item.label, 100)) return null;
    edges.push({ from: item.from, to: item.to, ...(item.label === undefined ? {} : { label: item.label as string }) });
  }
  return { type: 'diagram', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }), nodes, edges };
}

function figure(value: Record<string, unknown>): TeachingFigure | null {
  if (!number(value.width, 240, 1200) || !number(value.height, 120, 900) || !list(value.shapes, 1, 64)) return null;
  const shapes: TeachingFigure['shapes'] = [];
  const w = value.width; const h = value.height;
  for (const item of value.shapes) {
    if (!record(item) || !optionalText(item.label, 100) || (item.color !== undefined && (typeof item.color !== 'string' || !colors.has(item.color)))) return null;
    const extras = { ...(item.label === undefined ? {} : { label: item.label as string }), ...(item.color === undefined ? {} : { color: item.color as string }) };
    if (item.type === 'line' || item.type === 'arrow') {
      if (!number(item.x1, 0, w) || !number(item.x2, 0, w) || !number(item.y1, 0, h) || !number(item.y2, 0, h)) return null;
      shapes.push({ type: item.type, x1: item.x1, x2: item.x2, y1: item.y1, y2: item.y2, ...extras });
    } else {
      if (!number(item.x, 0, w) || !number(item.y, 0, h)) return null;
      if (item.type === 'rect') {
        if (!number(item.width, 1, w - item.x) || !number(item.height, 1, h - item.y)) return null;
        shapes.push({ type: 'rect', x: item.x, y: item.y, width: item.width, height: item.height, ...extras });
      } else if (item.type === 'circle') {
        if (!number(item.r, 1, Math.min(item.x, w - item.x, item.y, h - item.y))) return null;
        shapes.push({ type: 'circle', x: item.x, y: item.y, r: item.r, ...extras });
      } else if (item.type === 'text' && text(item.text, 180)) shapes.push({ type: 'text', x: item.x, y: item.y, text: item.text });
      else return null;
    }
  }
  return { type: 'figure', title: value.title as string, ...(value.description === undefined ? {} : { description: value.description as string }), width: w, height: h, shapes };
}

/** Accepts data only and returns a normalized object with no event handlers, URLs or unknown fields. */
export function parseTeachingVisual(content: string): TeachingVisual | null {
  if (content.length > 32768) return null;
  try {
    const value: unknown = JSON.parse(content);
    if (!record(value) || !text(value.title) || !optionalText(value.description, 1200)) return null;
    if (value.type === 'plot') return plot(value);
    if (value.type === 'diagram') return diagram(value);
    if (value.type === 'figure') return figure(value);
    if (value.type === 'quiz' && text(value.question, 2000) && list(value.options, 2, 6) && value.options.every((option) => text(option, 500)) && number(value.answer, 0, value.options.length - 1) && Number.isInteger(value.answer) && text(value.explanation, 3000) && optionalText(value.hint, 1000)) {
      return { type: 'quiz', title: value.title, question: value.question, options: [...value.options] as string[], answer: value.answer, explanation: value.explanation, ...(value.hint === undefined ? {} : { hint: value.hint as string }) };
    }
  } catch { /* Malformed model output stays non-executable. */ }
  return null;
}
