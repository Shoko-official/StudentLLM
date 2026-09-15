import { describe, expect, it } from 'vitest';
import { parseStudyArtifactResponse } from './study-artifacts';

describe('study artifact response parser', () => {
  it('keeps Markdown and source-linked visuals from a structured response', () => {
    const parsed = parseStudyArtifactResponse(JSON.stringify({
      markdown: '# Review\n\nUse the pipeline below.',
      visuals: [{
        type: 'diagram',
        sourceId: 'notes:part-1',
        nodes: [{ id: 'input', label: 'Input' }, { id: 'output', label: 'Output' }],
        edges: [{ from: 'input', to: 'output' }],
      }],
    }), new Set(['notes:part-1']));

    expect(parsed).toEqual(expect.objectContaining({ markdown: '# Review\n\nUse the pipeline below.' }));
    expect(parsed?.visuals).toHaveLength(1);
    expect(parsed?.visuals[0]).toEqual(expect.objectContaining({ type: 'diagram', sourceId: 'notes:part-1' }));
  });

  it('keeps legacy Markdown-only provider responses compatible', () => {
    expect(parseStudyArtifactResponse('## Summary\n\n- One point', new Set())).toEqual({
      markdown: '## Summary\n\n- One point',
      visuals: [],
    });
  });

  it('rejects visuals that are not tied to retrieved evidence', () => {
    expect(parseStudyArtifactResponse(JSON.stringify({
      markdown: 'Summary',
      visuals: [{
        type: 'chart', chartType: 'bar', sourceId: 'unknown',
        values: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
      }],
    }), new Set(['notes:part-1']))).toBeNull();
  });
});
