import { expect, it } from 'vitest';
import { visualDecisionResponseFormat, visualResponseFormat, visualTypeSchemas } from './teaching-schemas';
import { VISUAL_TYPES } from './visual-brief';

it('offers one strict schema per visual type, pinned to that type', () => {
  for (const type of VISUAL_TYPES) {
    const format = visualResponseFormat(type);
    expect(format.type).toBe('json_schema');
    expect(format.json_schema?.strict).toBe(true);
    expect(format.json_schema?.name).toBe(`teaching_${type}`);
    expect(format.json_schema?.schema).toBe(visualTypeSchemas[type]);
    expect((visualTypeSchemas[type].properties as { type: { const: string } }).type.const).toBe(type);
  }
});

it('offers a flat strict decision schema where only visual is required', () => {
  const format = visualDecisionResponseFormat();
  expect(format.json_schema).toMatchObject({ name: 'teaching_visual_decision', strict: true });
  const schema = format.json_schema!.schema as { properties: Record<string, { type?: string; enum?: string[]; maxLength?: number; maxItems?: number }>; required: string[]; additionalProperties: boolean };
  expect(schema.required).toEqual(['visual']);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties)).toEqual(['visual', 'type', 'intent', 'content', 'parameters', 'outputs', 'nodes', 'correctAnswer']);
  expect(schema.properties.visual.type).toBe('boolean');
  expect(schema.properties.type.enum).toEqual(['plot', 'diagram', 'figure', 'quiz']);
  expect([schema.properties.intent.maxLength, schema.properties.content.maxLength, schema.properties.correctAnswer.maxLength]).toEqual([300, 1500, 500]);
  expect(['parameters', 'outputs', 'nodes'].map((key) => schema.properties[key].maxItems)).toEqual([8, 8, 8]);
});
