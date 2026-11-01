import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, ProviderMessage, ProviderResponse } from './llm-provider';
import { generateTeachingAnswer, teachingAnswerResponseFormat, teachingAnswerSchema } from './teaching-answer';

const messages: ProviderMessage[] = [{ role: 'system', content: 'Teach accurately.' }, { role: 'user', content: 'Explain a visual concept.' }];
const quiz = { type: 'quiz', title: 'Check', question: 'Which?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' };
const diagram = { type: 'diagram', title: 'Flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'then' }] };
const options = { maxTokens: 4096 };
const providerFor = (content: string) => ({ supportsStructuredOutputs: true, generate: vi.fn(async () => ({ content, model: 'fixture-model' })) });

describe('structured teaching generation', () => {
  it('requests the strict schema once and preserves ordered prose and actual visualization objects', async () => {
    const provider = providerFor(JSON.stringify({ sections: [
      { markdown: '# Principle\n\nA connects to B.', visual: diagram },
      { markdown: '## Check your understanding\n\n$x+1$', visual: quiz },
      { markdown: 'Final explanation.', visual: null },
    ] }));
    const result = await generateTeachingAnswer(provider, messages, options);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.generate).toHaveBeenCalledWith([...messages, expect.objectContaining({ role: 'system', content: expect.stringContaining('Do not put student-visual fences') })], { maxTokens: 4096, responseFormat: teachingAnswerResponseFormat });
    expect(result.model).toBe('fixture-model');
    expect(result.content).toBe('# Principle\n\nA connects to B.\n\n```student-visual\n' + JSON.stringify(diagram) + '\n```\n\n## Check your understanding\n\n$x+1$\n\n```student-visual\n' + JSON.stringify(quiz) + '\n```\n\nFinal explanation.');
    expect(messages).toHaveLength(2);
  });

  it('keeps an ordinary concise answer without inventing a visual', async () => {
    const provider = providerFor(JSON.stringify({ sections: [{ markdown: 'The answer is **42**.', visual: null }] }));
    expect((await generateTeachingAnswer(provider, messages, options)).content).toBe('The answer is **42**.');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('passes legacy providers through unchanged without a schema, parsing or another request', async () => {
    const response: ProviderResponse = { content: 'Plain answer with an existing code block.\n```python\nprint(1)\n```', model: 'legacy' };
    const provider: LLMProvider = { generate: vi.fn(async () => response) };
    expect(await generateTeachingAnswer(provider, messages, options)).toBe(response);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(provider.generate).toHaveBeenCalledWith(messages, options);
  });

  it('retains prose and emits a safe visible fallback for an invalid visual without repair generation', async () => {
    const provider = providerFor(JSON.stringify({ sections: [{ markdown: 'Important explanation.', visual: { ...diagram, edges: [{ from: 'a', to: 'missing' }], payload: '<script>secret</script>' } }] }));
    const result = await generateTeachingAnswer(provider, messages, options);
    expect(result.content).toContain('Important explanation.');
    expect(result.content).toContain('This visualization could not be displayed.');
    expect(result.content).not.toContain('secret');
    expect(result.content).not.toContain('student-visual');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('renders at most eight validated visualizations while preserving subsequent section explanations', async () => {
    const provider = providerFor(JSON.stringify({ sections: Array.from({ length: 9 }, (_, i) => ({ markdown: `Explanation ${i}`, visual: quiz })) }));
    const result = await generateTeachingAnswer(provider, messages, options);
    expect(result.content.match(/```student-visual/g)).toHaveLength(8);
    expect(result.content).toContain('Explanation 8');
    expect(result.content).toContain('This visualization could not be displayed.');
  });

  it('keeps malformed deeply nested visual data inside the same safe fallback', async () => {
    const provider = providerFor('{"sections":[{"markdown":"Explanation retained","visual":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}]}');
    const result = await generateTeachingAnswer(provider, messages, options);
    expect(result.content).toContain('Explanation retained');
    expect(result.content).toContain('This visualization could not be displayed.');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete, wrapped or malformed envelopes with a recoverable error and no retry', async () => {
    for (const content of [
      '{"sections":[', '<answer>{"sections":[]}</answer>', '```json\n{"sections":[]}\n```', 'null',
      JSON.stringify({ sections: [] }), JSON.stringify({ sections: [{ markdown: 'Missing visual' }] }),
      JSON.stringify({ sections: [{ markdown: 42, visual: null }] }), JSON.stringify({ sections: [{ markdown: 'x', visual: null, unknown: true }] }),
      JSON.stringify({ sections: [{ markdown: 'x', visual: null }], unexpected: true }),
      JSON.stringify({ sections: [{ markdown: '', visual: null }] }),
      JSON.stringify({ sections: [{ markdown: 'x'.repeat(12001), visual: null }] }),
      JSON.stringify({ sections: Array(17).fill({ markdown: 'x', visual: null }) }),
      ' '.repeat(262145),
    ]) {
      const provider = providerFor(content);
      await expect(generateTeachingAnswer(provider, messages, options)).rejects.toThrow('incomplete or invalid lesson response');
      expect(provider.generate).toHaveBeenCalledTimes(1);
    }
  });

  it('does not let visual fences inside prose bypass the structured visual field or count limit', async () => {
    for (const markdown of ['```student-visual\n{}\n```', '> ~~~student-visual\n{}\n> ~~~']) {
      const provider = providerFor(JSON.stringify({ sections: [{ markdown, visual: null }] }));
      await expect(generateTeachingAnswer(provider, messages, options)).rejects.toThrow('incomplete or invalid lesson response');
      expect(provider.generate).toHaveBeenCalledTimes(1);
    }
  });

  it('propagates provider failure without a second generation', async () => {
    const provider = { supportsStructuredOutputs: true, generate: vi.fn(async () => { throw new Error('Unavailable'); }) };
    await expect(generateTeachingAnswer(provider, messages, options)).rejects.toThrow('Unavailable');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('provides bounded schemas with closed objects for every nested visual type', () => {
    expect(teachingAnswerResponseFormat).toMatchObject({ type: 'json_schema', json_schema: { strict: true, name: 'teaching_answer' } });
    expect(teachingAnswerSchema).toMatchObject({ type: 'object', required: ['sections'], additionalProperties: false, properties: { sections: { minItems: 1, maxItems: 16, items: { required: ['markdown', 'visual'] } } } });
    let objects = 0;
    function check(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(check); return; }
      const node = value as Record<string, unknown>;
      if (node.type === 'object') { objects++; expect(node.additionalProperties).toBe(false); expect(Array.isArray(node.required)).toBe(true); }
      Object.values(node).forEach(check);
    }
    check(teachingAnswerSchema);
    expect(objects).toBeGreaterThan(10);
  });
});
