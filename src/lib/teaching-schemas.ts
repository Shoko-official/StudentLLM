import type { ProviderResponseFormat } from './llm-provider';
import type { VisualType } from './visual-brief';

export type Schema = Record<string, unknown>;
const text = (maxLength: number, minLength = 1): Schema => ({ type: 'string', minLength, maxLength });
const numeric = (minimum = -1e9, maximum = 1e9): Schema => ({ type: 'number', minimum, maximum });
const array = (items: Schema, minItems: number, maxItems: number): Schema => ({ type: 'array', items, minItems, maxItems });
export const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export const sectionText = text;
export const sectionArray = array;
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

export const visualTypeSchemas: Record<VisualType, Schema> = {
  plot: object({
    type: { const: 'plot' }, ...common,
    x: object({ ...axisProperties, step: numeric(1e-9) }, ['min', 'max']),
    y: object(axisProperties, ['min', 'max']),
    chartType: { type: 'string', enum: ['line', 'bar'] }, series: array(series, 1, 4),
    parameters: array(parameter, 0, 4), outputs: array(output, 0, 4),
  }, ['type', 'title', 'x', 'series']),
  diagram: object({
    type: { const: 'diagram' }, ...common,
    nodes: array(object({ id: text(64), label: text(160) }), 1, 24),
    edges: array(object({ from: text(64), to: text(64), label }, ['from', 'to']), 0, 48),
  }, ['type', 'title', 'nodes', 'edges']),
  figure: object({
    type: { const: 'figure' }, ...common, width: numeric(240, 1200), height: numeric(120, 900),
    shapes: array({ anyOf: [
      shape({ type: { const: 'rect' }, x: numeric(0, 1200), y: numeric(0, 900), width: numeric(1, 1200), height: numeric(1, 900) }),
      shape({ type: { const: 'circle' }, x: numeric(0, 1200), y: numeric(0, 900), r: numeric(1, 450) }),
      shape({ type: { type: 'string', enum: ['line', 'arrow'] }, x1: numeric(0, 1200), y1: numeric(0, 900), x2: numeric(0, 1200), y2: numeric(0, 900) }),
      object({ type: { const: 'text' }, x: numeric(0, 1200), y: numeric(0, 900), text: text(180) }),
    ] }, 1, 64),
  }, ['type', 'title', 'width', 'height', 'shapes']),
  quiz: object({
    type: { const: 'quiz' }, title: text(180), question: text(2000), options: array(text(500), 2, 6),
    answer: { type: 'integer', minimum: 0, maximum: 5 }, explanation: text(3000), hint: text(1000),
  }, ['type', 'title', 'question', 'options', 'answer', 'explanation']),
};

const decisionLabels = array(label, 0, 8);
const visualDecisionSchema = object({
  visual: { type: 'boolean' },
  type: { type: 'string', enum: ['plot', 'diagram', 'figure', 'quiz'] },
  intent: text(300), content: text(1500),
  parameters: decisionLabels, outputs: decisionLabels, nodes: decisionLabels,
  correctAnswer: text(500),
}, ['visual']);

export function visualDecisionResponseFormat(): ProviderResponseFormat {
  return { type: 'json_schema', json_schema: { name: 'teaching_visual_decision', strict: true, schema: visualDecisionSchema } };
}

export function visualResponseFormat(type: VisualType): ProviderResponseFormat {
  return { type: 'json_schema', json_schema: { name: `teaching_${type}`, strict: true, schema: visualTypeSchemas[type] } };
}
