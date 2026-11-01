import { describe, expect, it, vi } from 'vitest';
import { generateTutorProse, generateVisual, runVisualJobs } from './teaching-generation';
import type { LLMProvider, ProviderMessage } from './llm-provider';
import type { VisualJob } from './visual-brief';
import { VISUAL_MODULES } from '../prompts';

const quiz = { type: 'quiz', title: 'Check', question: 'Q?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' };
const job = (extra: Partial<VisualJob['brief']> = {}, more: Partial<VisualJob> = {}): VisualJob => ({ brief: { id: 'v1', type: 'quiz', intent: 'Check', content: 'Ask', ...extra }, section: 'Around.', ...more });
const replying = (...contents: string[]) => {
  const generate = vi.fn<LLMProvider['generate']>(async () => ({ content: contents.shift() ?? '', model: 'fixture' }));
  return { generate, supportsStructuredOutputs: true } satisfies LLMProvider;
};
const payload = (provider: { generate: ReturnType<typeof vi.fn> }, call: number) => JSON.parse(((provider.generate.mock.calls[call][0]) as ProviderMessage[])[1].content);

describe('generateTutorProse', () => {
  it('asks for free Markdown and returns prepared prose with jobs', async () => {
    const provider = replying('Text.\n\n```student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n```');
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Q' }];
    const result = await generateTutorProse(provider, messages, { maxTokens: 4096 });
    expect(provider.generate).toHaveBeenCalledWith(messages, { maxTokens: 4096 });
    expect(result.jobs.map((item) => item.brief.id)).toEqual(['v1']);
    expect(result.model).toBe('fixture');
  });

  it.each(['', '   ', '```student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n```'])('rejects a reply with no readable text: %j', async (content) => {
    await expect(generateTutorProse(replying(content), [], { maxTokens: 4096 })).rejects.toThrow('The model returned no answer');
  });
});

describe('generateVisual', () => {
  it('sends the type module, strict schema and only the brief with its section', async () => {
    const provider = replying(JSON.stringify(quiz));
    const result = await generateVisual(provider, job());
    expect(result).toEqual({ visual: quiz, attempts: 1, errors: [] });
    const [messages, options] = provider.generate.mock.calls[0];
    expect(messages![0]).toEqual({ role: 'system', content: VISUAL_MODULES.quiz });
    expect(payload(provider, 0)).toEqual({ task: expect.any(String), request: job().brief, surroundingExplanation: 'Around.' });
    expect(options?.responseFormat?.json_schema?.name).toBe('teaching_quiz');
    expect(options?.maxTokens).toBe(4096);
  });

  it('accepts a fenced reply from a provider without structured outputs', async () => {
    const generate = vi.fn<LLMProvider['generate']>(async () => ({ content: 'Here it is:\n```json\n' + JSON.stringify(quiz) + '\n```', model: 'fixture' }));
    const result = await generateVisual({ generate }, job());
    expect(result.visual).toEqual(quiz);
    expect(generate.mock.calls[0][1]?.responseFormat).toBeUndefined();
  });

  it('repairs once with the exact errors and the invalid output', async () => {
    const invalid = JSON.stringify({ ...quiz, answer: 9 });
    const provider = replying(invalid, JSON.stringify(quiz));
    const result = await generateVisual(provider, job());
    expect(result.visual).toEqual(quiz);
    expect(result.attempts).toBe(2);
    const repair = payload(provider, 1);
    expect(repair.invalidOutput).toBe(invalid);
    expect(repair.errors.join(' ')).toContain('answer must be a zero-based index');
  });

  it('repairs when the visual contradicts the brief', async () => {
    const provider = replying(JSON.stringify(quiz), JSON.stringify({ ...quiz, answer: 0 }));
    const result = await generateVisual(provider, job({ correctAnswer: 'A' }));
    expect(result.attempts).toBe(2);
    expect(result.visual?.type).toBe('quiz');
    expect(payload(provider, 1).errors[0]).toContain('keyed option');
  });

  it('stops after one failed repair and keeps the errors', async () => {
    const provider = replying('{"bad":', '{"bad":');
    const result = await generateVisual(provider, job());
    expect(result).toEqual({ visual: null, attempts: 2, errors: ['the output is not valid JSON'] });
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it('does not attempt a repair when the provider call itself fails', async () => {
    const generate = vi.fn<LLMProvider['generate']>(async () => { throw new Error('Provider request failed (429)'); });
    const result = await generateVisual({ generate, supportsStructuredOutputs: true }, job());
    expect(result.visual).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('starts from an initial output without a first generation', async () => {
    const provider = replying(JSON.stringify(quiz));
    const result = await generateVisual(provider, job({}, { initialOutput: '{"type":"quiz"}' }));
    expect(result.visual).toEqual(quiz);
    expect(result.attempts).toBe(1);
    expect(payload(provider, 0).invalidOutput).toBe('{"type":"quiz"}');
  });

  it('accepts a valid initial output with no call', async () => {
    const provider = replying();
    expect((await generateVisual(provider, job({}, { initialOutput: JSON.stringify(quiz) }))).attempts).toBe(0);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('aborts an attempt at its deadline', async () => {
    const generate = vi.fn<LLMProvider['generate']>((_messages, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = await generateVisual({ generate, supportsStructuredOutputs: true }, job(), { deadlineMs: 5 });
    expect(result.visual).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('redacts embedded images from the section when the provider requires it', async () => {
    const provider = { ...replying(JSON.stringify(quiz)), redactEmbeddedImages: true };
    await generateVisual(provider, job({}, { section: 'See ![x](data:image/png;base64,AAAA) here.' }));
    expect(payload(provider, 0).surroundingExplanation).not.toContain('base64,AAAA');
  });
});

describe('runVisualJobs', () => {
  it('never exceeds the concurrency limit and reports every job', async () => {
    let running = 0, peak = 0;
    const generate = vi.fn<LLMProvider['generate']>(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { content: JSON.stringify(quiz), model: 'fixture' };
    });
    const onResult = vi.fn();
    const jobs = ['a', 'b', 'c', 'd'].map((id) => job({ id }));
    await runVisualJobs({ generate, supportsStructuredOutputs: true }, jobs, { concurrency: 2, onResult });
    expect(peak).toBe(2);
    expect(onResult.mock.calls.map(([brief]) => brief.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps going when one job fails', async () => {
    const provider = replying('{"bad":', '{"bad":', JSON.stringify(quiz));
    const results: Array<boolean> = [];
    await runVisualJobs(provider, [job({ id: 'a' }), job({ id: 'b' })], { concurrency: 1, onResult: (_brief, result) => results.push(Boolean(result.visual)) });
    expect(results).toEqual([false, true]);
  });
});
