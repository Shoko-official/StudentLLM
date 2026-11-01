import type { LLMProvider, ProviderMessage, ProviderResponse, ProviderResponseFormat } from './llm-provider';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseTeachingVisual } from './teaching-visuals';

type Schema = Record<string, unknown>;
const text = (maxLength: number, minLength = 1): Schema => ({ type: 'string', minLength, maxLength });
const numeric = (minimum = -1e9, maximum = 1e9): Schema => ({ type: 'number', minimum, maximum });
const array = (items: Schema, minItems: number, maxItems: number): Schema => ({ type: 'array', items, minItems, maxItems });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const expression = text(300);
const label = text(100);
const axisProperties = { min: numeric(), max: numeric(), label: text(80) };
const parameter = object({ name: { ...text(24), pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, label, min: numeric(), max: numeric(), step: numeric(1e-9), value: numeric() });
const output = object({ label, expression, unit: text(40) }, ['label', 'expression']);
const series = { anyOf: [
  object({ label, expression }),
  object({ label, points: array({ type: 'array', items: numeric(), minItems: 2, maxItems: 2 }, 2, 161) }),
] };
const common = { title: text(180), description: text(1200) };
const shapeCommon = { label, color: { type: 'string', enum: ['blue', 'orange', 'green', 'purple', 'red', 'neutral'] } };
const shape = (properties: Record<string, Schema>) => object({ ...properties, ...shapeCommon }, Object.keys(properties));

const visualSchema: Schema = { anyOf: [
  object({
    type: { const: 'plot' }, ...common,
    x: object({ ...axisProperties, step: numeric(1e-9) }, ['min', 'max']),
    y: object(axisProperties, ['min', 'max']),
    chartType: { type: 'string', enum: ['line', 'bar'] }, series: array(series, 1, 4),
    parameters: array(parameter, 0, 4), outputs: array(output, 0, 4),
  }, ['type', 'title', 'x', 'series']),
  object({
    type: { const: 'diagram' }, ...common,
    nodes: array(object({ id: text(64), label: text(160) }), 1, 24),
    edges: array(object({ from: text(64), to: text(64), label }, ['from', 'to']), 0, 48),
  }, ['type', 'title', 'nodes', 'edges']),
  object({
    type: { const: 'figure' }, ...common, width: numeric(240, 1200), height: numeric(120, 900),
    shapes: array({ anyOf: [
      shape({ type: { const: 'rect' }, x: numeric(0, 1200), y: numeric(0, 900), width: numeric(1, 1200), height: numeric(1, 900) }),
      shape({ type: { const: 'circle' }, x: numeric(0, 1200), y: numeric(0, 900), r: numeric(1, 450) }),
      shape({ type: { type: 'string', enum: ['line', 'arrow'] }, x1: numeric(0, 1200), y1: numeric(0, 900), x2: numeric(0, 1200), y2: numeric(0, 900) }),
      object({ type: { const: 'text' }, x: numeric(0, 1200), y: numeric(0, 900), text: text(180) }),
    ] }, 1, 64),
  }, ['type', 'title', 'width', 'height', 'shapes']),
  object({
    type: { const: 'quiz' }, title: text(180), question: text(2000), options: array(text(500), 2, 6),
    answer: { type: 'integer', minimum: 0, maximum: 5 }, explanation: text(3000), hint: text(1000),
  }, ['type', 'title', 'question', 'options', 'answer', 'explanation']),
  { type: 'null' },
] };

export const teachingAnswerSchema: Schema = object({
  sections: array(object({ markdown: text(12000, 0), visual: visualSchema }), 1, 16),
});

export const teachingAnswerResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'teaching_answer', strict: true, schema: teachingAnswerSchema },
};

const structuredContract = [
  'Return the answer as the supplied JSON schema: {"sections":[{"markdown":"...","visual":null}]} .',
  'Each section has both keys. Keep educational prose, headings, code examples and LaTeX in markdown.',
  'For a useful visualization, put the actual visualization object in visual, after the explanation in that section; otherwise use null.',
  'Use at most 16 sections and 8 visualizations. Preserve the logical teaching order. A concise answer can have one section and no visual.',
  'Do not put student-visual fences or JSON visualization specifications inside markdown. Do not emit XML wrappers, HTML, image Markdown or executable JavaScript.',
  'Use the exact schema field names and supported expression functions described in the preceding instructions. All diagram edges require from and to strings identifying existing nodes.',
  'This structured response contract replaces earlier instructions to return plain Markdown or student-visual fences.',
].join('\n');

const invalidAnswerMessage = 'The model returned an incomplete or invalid lesson response. Try again or choose another model in Settings.';
const visualFallback = '> This visualization could not be displayed. Ask for a simpler graph or diagram; the accompanying explanation is retained.';

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function sectionVisual(value: unknown) {
  try { return parseTeachingVisual(JSON.stringify(value)); } catch { return null; }
}
interface MarkdownNode { type: string; lang?: string | null; position?: { start: { offset?: number } }; children?: MarkdownNode[] }
function inertProseVisualFences(markdown: string) {
  // The actual Markdown AST identifies outer fences, including list/quote containers.
  // Never scan code bodies: a Python string containing a fence must stay verbatim.
  const pending: MarkdownNode[] = [fromMarkdown(markdown)];
  const edits: Array<{ start: number; end: number }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.children) pending.push(...node.children);
    const start = node.position?.start.offset;
    if (node.type !== 'code' || typeof node.lang !== 'string' || start === undefined) continue;
    const newline = markdown.indexOf('\n', start);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const opening = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)/.exec(markdown.slice(start, lineEnd));
    if (!opening) continue;
    const language = opening[3].trim().split(/\s+/, 1)[0];
    // Only plain language names are retained; escapes/entities cannot smuggle an interactive language.
    if (language !== 'student-visual' && /^[A-Za-z0-9_+.#-]+$/.test(language)) continue;
    edits.push({ start: start + opening[1].length + opening[2].length, end: start + opening[0].length });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + 'text' + markdown.slice(edit.end);
  return markdown;
}

function canonicalAnswer(content: string): string {
  if (content.length > 262144) throw new Error(invalidAnswerMessage);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(invalidAnswerMessage); }
  if (!record(parsed) || !exactKeys(parsed, ['sections']) || !Array.isArray(parsed.sections) || parsed.sections.length < 1 || parsed.sections.length > 16) throw new Error(invalidAnswerMessage);
  const rendered: string[] = [];
  let visuals = 0;
  for (const section of parsed.sections) {
    if (!record(section) || !exactKeys(section, ['markdown', 'visual']) || typeof section.markdown !== 'string' || section.markdown.length > 12000) throw new Error(invalidAnswerMessage);
    if (section.markdown.trim()) rendered.push(inertProseVisualFences(section.markdown.trim()));
    if (section.visual !== null) {
      const visual = visuals < 8 ? sectionVisual(section.visual) : null;
      if (visual) { visuals++; rendered.push('```student-visual\n' + JSON.stringify(visual) + '\n```'); }
      else rendered.push(visualFallback);
    }
  }
  if (!rendered.length) throw new Error(invalidAnswerMessage);
  return rendered.join('\n\n');
}

/** One generation with a constrained envelope when available; never retries or repairs malformed output. */
export async function generateTeachingAnswer(provider: LLMProvider, messages: ProviderMessage[], options: { maxTokens: number }): Promise<ProviderResponse> {
  if (!provider.supportsStructuredOutputs) return provider.generate(messages, options);
  const response = await provider.generate([...messages, { role: 'system', content: structuredContract }], { ...options, responseFormat: teachingAnswerResponseFormat });
  return { ...response, content: canonicalAnswer(response.content) };
}
