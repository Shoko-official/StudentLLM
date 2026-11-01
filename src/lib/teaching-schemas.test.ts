import { expect, it } from 'vitest';
import { visualResponseFormat, visualTypeSchemas } from './teaching-schemas';
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
