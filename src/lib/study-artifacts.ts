import type { ProviderResponseFormat } from './llm-provider';
import { parseVisualEnvelope, type VisualBlock } from './visual-blocks';

export const studyArtifactResponseFormat: ProviderResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'study_artifact',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: { type: 'string' },
        visuals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['chart', 'diagram', 'table'] },
              sourceId: { type: 'string' },
              sourcePage: { type: 'integer', minimum: 1 },
              sourceLabel: { type: 'string' },
              title: { type: 'string' },
              chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
              values: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
              nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
              edges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] } },
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
            required: ['type', 'sourceId'],
          },
        },
      },
      required: ['markdown'],
    },
  },
};

export interface ParsedStudyArtifactResponse {
  markdown: string;
  visuals: VisualBlock[];
}

export function parseStudyArtifactResponse(content: string, sourceIds: Set<string>): ParsedStudyArtifactResponse | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? '',
    trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed.markdown !== 'string' || !parsed.markdown.trim()) continue;
      const visuals = parsed.visuals === undefined
        ? []
        : parseVisualEnvelope(JSON.stringify({ visuals: parsed.visuals }), sourceIds);
      if (visuals === null) return null;
      return { markdown: parsed.markdown.trim(), visuals };
    } catch {
      // A normal Markdown response remains supported below.
    }
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { markdown: trimmed, visuals: [] };
  return null;
}
