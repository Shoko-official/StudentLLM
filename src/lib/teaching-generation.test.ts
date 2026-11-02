import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideVisual, decideVisuals, generateTutorProse, tutorNote, generateVisual, runVisualJobs } from './teaching-generation';
import type { LLMProvider, ProviderMessage } from './llm-provider';
import type { VisualJob } from './visual-brief';
import { CONVERSATION_MEMORY_INSTRUCTIONS, TUTOR_LENGTH_REMINDER, TUTOR_VISUAL_REQUEST_NOTE, VISUAL_DECISION_PROMPT, VISUAL_MODULES, visualTargetNote } from '../prompts';

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
    expect(provider.generate).toHaveBeenCalledWith([...messages, { role: 'user', content: TUTOR_LENGTH_REMINDER }], { maxTokens: 4096 });
    expect(result.jobs.map((item) => item.brief.id)).toEqual(['v1']);
    expect(result.model).toBe('fixture');
  });

  it('adds the visual request sentence to the note only when the latest message asks for a visual after a refusal, and never keeps it', async () => {
    const asked = async (history: ProviderMessage[]) => {
      const provider = replying('An answer.');
      const result = await generateTutorProse(provider, history, { maxTokens: 4096 });
      expect(JSON.stringify(result)).not.toContain('Note from StudentLLM');
      expect(JSON.stringify(result)).not.toContain(TUTOR_VISUAL_REQUEST_NOTE);
      return (provider.generate.mock.calls[0][0] as ProviderMessage[]).at(-1)!.content;
    };
    const system: ProviderMessage = { role: 'system', content: 'S' };
    const user = (content: string): ProviderMessage => ({ role: 'user', content });
    const reply: ProviderMessage = { role: 'assistant', content: 'Ok.' };
    const lifted = `${TUTOR_LENGTH_REMINDER} ${TUTOR_VISUAL_REQUEST_NOTE}`;
    expect(await asked([system, user('No diagrams please.'), reply, user('Actually, show me a diagram of it.')])).toBe(lifted);
    expect(await asked([system, user('Sans schéma, explique.'), reply, user('Finalement, montre-moi un schéma du cycle.')])).toBe(lifted);
    // Without a refusal in the conversation the call is what it always was.
    expect(await asked([system, user('Finalement, montre-moi un schéma du cycle.')])).toBe(TUTOR_LENGTH_REMINDER);
    expect(await asked([system, user('Why does it happen?'), reply, user('Show me a diagram of it.')])).toBe(TUTOR_LENGTH_REMINDER);
    // A refusal alone, an earlier request alone, or a message that holds both do not lift anything.
    expect(await asked([system, user('Sans schéma, explique.')])).toBe(TUTOR_LENGTH_REMINDER);
    expect(await asked([system, user('No diagrams please.'), reply, user('Why does it happen?')])).toBe(TUTOR_LENGTH_REMINDER);
    expect(await asked([system, user('No diagrams please.'), reply, user('Show a table, not a diagram.')])).toBe(TUTOR_LENGTH_REMINDER);
    expect(await asked([system, user('Show me a diagram.'), reply, user('No diagrams please.'), reply, user('And why?')])).toBe(TUTOR_LENGTH_REMINDER);
    // Neither is the conversation memory, which carries compacted assistant excerpts.
    const memory = user(CONVERSATION_MEMORY_INSTRUCTIONS + String.fromCharCode(10) + JSON.stringify({ kind: 'extractive_conversation_memory', records: [{ id: 'a1', role: 'assistant', excerpts: ['no diagram needed here'], shortened: false }] }));
    expect(await asked([system, memory, user('Show me a diagram of it.')])).toBe(TUTOR_LENGTH_REMINDER);
    // A real refusal still counts when a memory message sits in the same call.
    expect(await asked([system, memory, user('No diagrams please.'), reply, user('Show me a diagram of it.')])).toBe(lifted);
    // Course text sent as evidence is not the learner.
    const evidence = user('Evidence {"kind":"course_evidence","documents":[{"text":"drawn without a diagram"}]}');
    expect(await asked([system, evidence, user('Show me a diagram of it.')])).toBe(TUTOR_LENGTH_REMINDER);
  });

  it('sends the length reminder last, leaves the other messages as they were, and keeps it out of the result', async () => {
    const provider = replying('A short answer.');
    const messages: ProviderMessage[] = [{ role: 'system', content: 'S' }, { role: 'assistant', content: 'Earlier.' }, { role: 'user', content: 'Q' }];
    const copy = structuredClone(messages);
    const result = await generateTutorProse(provider, messages, { maxTokens: 4096 });
    const sent = provider.generate.mock.calls[0][0] as ProviderMessage[];
    expect(sent).toHaveLength(4);
    expect(sent.slice(0, 3)).toEqual(copy);
    expect(sent[3]).toEqual({ role: 'user', content: TUTOR_LENGTH_REMINDER });
    expect(messages).toEqual(copy);
    expect(JSON.stringify(result)).not.toContain('Note from StudentLLM');
    expect(result.markdown).toBe('A short answer.');
  });

  it.each(['', '   ', '```student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n```', '[Visual not generated: I]', '[Visual shown to the learner: quiz "T"]\n\n[Visual not generated: I]\n'])('rejects a reply with no readable text: %j', async (content) => {
    await expect(generateTutorProse(replying(content), [], { maxTokens: 4096 })).rejects.toThrow('The model returned no answer');
  });
});

describe('generateTutorProse streaming', () => {
  it('passes onText to the provider and still prepares the result from the complete text', async () => {
    const provider = replying('Prose.\n\n```student-visual-request\n{"id":"v1","type":"quiz","intent":"Check","content":"Ask"}\n```');
    const onText = vi.fn();
    const result = await generateTutorProse(provider, [], { maxTokens: 4096, onText });
    expect(provider.generate.mock.calls[0][1]).toMatchObject({ maxTokens: 4096, onText });
    expect(result.jobs).toHaveLength(1);
    expect(result.markdown).toContain('student-visual-request');
    expect(result.needsDecision).toBe(false);
  });

  it('leaves onText out when the caller has none', async () => {
    const provider = replying('Prose.');
    await generateTutorProse(provider, [], { maxTokens: 4096 });
    expect(provider.generate.mock.calls[0][1]?.onText).toBeUndefined();
  });
});

describe('generateTutorProse needsDecision', () => {
  const fence = '```';
  const request = `${fence}student-visual-request
{"id":"v1","type":"quiz","intent":"I","content":"C"}
${fence}`;
  const direct = `${fence}student-visual
${JSON.stringify(quiz)}
${fence}`;
  const prose = async (content: string) => (await generateTutorProse(replying(content), [], { maxTokens: 4096 })).needsDecision;

  it('is false when the answer holds a valid request or a valid direct fence', async () => {
    expect(await prose(`Text.\n\n${request}`)).toBe(false);
    expect(await prose(`Text.\n\n${direct}`)).toBe(false);
  });

  it('is true for plain prose and for a malformed request that was demoted', async () => {
    expect(await prose('Plain text only.')).toBe(true);
    expect(await prose(`Text.\n\n${fence}student-visual-request\n{"id":"v1"}\n${fence}`)).toBe(true);
  });

  it('stays true when the model wrote a note instead of asking for a visual, and the note is not saved', async () => {
    const result = await generateTutorProse(replying('Text.\n\n[Visual not generated: See the curve]'), [], { maxTokens: 4096 });
    expect(result).toMatchObject({ markdown: 'Text.', jobs: [], needsDecision: true });
  });
});

describe('decideVisual', () => {
  const input = { question: 'Why does it happen?', answer: 'Because of the formula y = 2*x.' };
  const request = { visual: true, type: 'plot', intent: 'See the line', content: 'y=2*x for x from 0 to 5.' };
  const decide = (provider: LLMProvider, extra: Parameters<typeof decideVisual>[1] = input, options: Parameters<typeof decideVisual>[2] = {}) => decideVisual(provider, extra, options);

  it('returns no brief and no error when the model declines', async () => {
    expect(await decide(replying('{"visual":false}'))).toEqual({ brief: null });
  });

  it('builds a request with the fixed id from a valid decision, keeping only non-empty optional fields', async () => {
    const result = await decide(replying(JSON.stringify({ ...request, parameters: ['a'], outputs: [], nodes: [], correctAnswer: '' })));
    expect(result).toEqual({ brief: { id: 'auto-1', type: 'plot', intent: request.intent, content: request.content, parameters: ['a'] } });
  });

  it('accepts a reply with prose or a fence around the object', async () => {
    expect((await decide(replying('Here: ' + JSON.stringify(request) + ' done'))).brief?.id).toBe('auto-1');
  });

  it('drops any checks field the model adds', async () => {
    const result = await decide(replying(JSON.stringify({ ...request, checks: [{ output: 'A', at: {}, expected: 1 }] })));
    expect(result.brief).not.toBeNull();
    expect(result.brief).not.toHaveProperty('checks');
  });

  it.each([
    ['a bad type', JSON.stringify({ ...request, type: 'mermaid' })],
    ['a missing intent', JSON.stringify({ visual: true, type: 'plot', content: 'C' })],
    ['an unparsable reply', '{"visual":'],
    ['a non-object reply', 'yes'],
    ['a missing visual field', JSON.stringify({ type: 'plot' })],
    ['an over-long content', JSON.stringify({ ...request, content: 'x'.repeat(1501) })],
  ])('returns an error and no brief for %s', async (_name, content) => {
    const result = await decide(replying(content));
    expect(result.brief).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('reports invalid decision when the visual field is not a boolean', async () => {
    expect(await decide(replying('{"visual":"yes"}'))).toEqual({ brief: null, error: 'invalid decision' });
  });

  it('sends the last three earlier learner messages, each cut and redacted, and nothing when there are none', async () => {
    const image = `![x](data:image/png;base64,${'AAAA'.repeat(500)})`;
    const provider = replying('{"visual":false}');
    await decide(provider, { ...input, earlierMessages: ['Oldest', 'No diagrams please.', `${image} Second`, 'W'.repeat(400)] });
    const sent = JSON.parse((provider.generate.mock.calls[0][0] as ProviderMessage[])[1].content);
    expect(sent.earlierLearnerMessages).toHaveLength(3);
    expect(sent.earlierLearnerMessages[0]).toBe('No diagrams please.');
    expect(sent.earlierLearnerMessages[1]).toContain('Second');
    expect(sent.earlierLearnerMessages[2]).toBe('W'.repeat(300));
    expect(JSON.stringify(sent)).not.toContain('AAAA');
  });

  it('drops the earlier learner messages only when this message asks for a visual and an earlier one refused, so a past refusal cannot match', async () => {
    const sentFor = async (question: string, earlier: string[]) => {
      const provider = replying('{"visual":false}');
      await decide(provider, { ...input, question, earlierMessages: earlier });
      return JSON.parse((provider.generate.mock.calls[0][0] as ProviderMessage[])[1].content).earlierLearnerMessages;
    };
    const refused = ['No diagrams, please.', 'And then?'];
    expect(await sentFor('Actually, show me a diagram of the cycle.', refused)).toEqual([]);
    expect(await sentFor('Finalement, montre-moi un schéma.', ['Sans schéma.', 'Et ensuite ?'])).toEqual([]);
    expect(await sentFor('Why does it happen?', refused)).toEqual(refused);
    expect(await sentFor('No diagram, but show me the numbers.', refused)).toEqual(refused);
    // No refusal before: what was sent before is sent still.
    expect(await sentFor('Show me a diagram of the cycle.', ['Why?', 'And then?'])).toEqual(['Why?', 'And then?']);
  });

  it('never carries the length reminder, which belongs to the tutor answer call only', async () => {
    const provider = replying('{"visual":false}');
    await decide(provider);
    expect(JSON.stringify(provider.generate.mock.calls[0][0])).not.toContain('Note from StudentLLM');
  });

  it('sends the decision prompt, a small budget and the learner message with the answer', async () => {
    const provider = replying('{"visual":false}');
    await decide(provider);
    const [messages, options] = provider.generate.mock.calls[0];
    expect(messages![0]).toEqual({ role: 'system', content: VISUAL_DECISION_PROMPT });
    expect(JSON.parse(messages![1].content)).toEqual({ learnerMessage: input.question, tutorAnswer: input.answer, earlierVisuals: [], earlierLearnerMessages: [] });
    expect(options?.maxTokens).toBe(4096);
    expect(options?.responseFormat?.json_schema?.name).toBe('teaching_visual_decision');
  });

  it('sends the descriptions of the visuals already shown, and redacts images in them', async () => {
    const earlierVisuals = ['diagram "Lock" with nodes: Gates closed, Chamber fills', `figure "Map": ![x](data:image/png;base64,${'AAAA'.repeat(500)})`];
    const provider = replying('{"visual":false}');
    await decide(provider, { ...input, earlierVisuals });
    const sent = JSON.parse((provider.generate.mock.calls[0][0] as ProviderMessage[])[1].content);
    expect(sent.earlierVisuals).toHaveLength(2);
    expect(sent.earlierVisuals[0]).toBe(earlierVisuals[0]);
    expect(JSON.stringify(sent)).not.toContain('AAAA');
  });

  it('omits the response format for a provider without structured outputs', async () => {
    const generate = vi.fn<LLMProvider['generate']>(async () => ({ content: '{"visual":false}', model: 'fixture' }));
    await decide({ generate });
    expect(generate.mock.calls[0][1]?.responseFormat).toBeUndefined();
  });

  it('cuts long inputs and redacts embedded images', async () => {
    const image = `![x](data:image/png;base64,${'AAAA'.repeat(1500)})`;
    const provider = replying('{"visual":false}');
    await decide(provider, { question: 'Q'.repeat(3000), answer: `${image} ${'Z'.repeat(7000)}` });
    const sent = JSON.parse((provider.generate.mock.calls[0][0] as ProviderMessage[])[1].content);
    expect(sent.learnerMessage).toHaveLength(2000);
    expect(sent.tutorAnswer.length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(sent)).not.toContain('AAAA');
    const imageQuestion = replying('{"visual":false}');
    await decide(imageQuestion, { question: image, answer: 'A' });
    expect(JSON.stringify(imageQuestion.generate.mock.calls[0][0])).not.toContain('AAAA');
  });

  it('never throws: a provider failure, a deadline and a stop all give an error and no brief', async () => {
    const failing: LLMProvider = { generate: async () => { throw new Error('Provider request failed (500)'); } };
    expect(await decide(failing)).toEqual({ brief: null, error: 'Provider request failed (500)' });

    const hanging: LLMProvider = { generate: (_messages, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }) };
    const late = await decide(hanging, input, { deadlineMs: 5 });
    expect(late.brief).toBeNull();
    expect(late.error).toMatch(/timed out/);

    const controller = new AbortController();
    const pending = decide(hanging, input, { signal: controller.signal });
    controller.abort();
    const stopped = await pending;
    expect(stopped.brief).toBeNull();
    expect(stopped.error).toBe('Visual generation was stopped.');
  });

  it('returns no brief when the stop arrives during the call, even if the reply is a valid decision', async () => {
    const controller = new AbortController();
    const generate = vi.fn<LLMProvider['generate']>(async () => { controller.abort(); return { content: JSON.stringify(request), model: 'fixture' }; });
    expect(await decide({ generate }, input, { signal: controller.signal })).toEqual({ brief: null, error: 'Visual generation was stopped.' });
  });

  it('makes no call when already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = replying('{"visual":false}');
    const result = await decide(provider, input, { signal: controller.signal });
    expect(result.brief).toBeNull();
    expect(provider.generate).not.toHaveBeenCalled();
  });
});

describe('decideVisual with a target', () => {
  const input = { question: 'Fais un quiz.', answer: 'Because of the formula y = 2*x.', target: 'quiz' as const };
  const request = { visual: true, type: 'quiz', intent: 'Check', content: 'Ask about y.' };

  it('sends the same data, then the note naming that type, and allows only that type', async () => {
    const provider = replying('{"visual":false}');
    await decideVisual(provider, input);
    const [messages, options] = provider.generate.mock.calls[0];
    expect(messages).toHaveLength(3);
    expect(messages![0]).toEqual({ role: 'system', content: VISUAL_DECISION_PROMPT });
    expect(Object.keys(JSON.parse(messages![1].content))).toEqual(['learnerMessage', 'tutorAnswer', 'earlierVisuals', 'earlierLearnerMessages']);
    expect(messages![2]).toEqual({ role: 'user', content: visualTargetNote('quiz') });
    const schema = options?.responseFormat?.json_schema?.schema as { properties: { type: { enum: string[] } } };
    expect(schema.properties.type.enum).toEqual(['quiz']);
  });

  it('leaves a call with no target as it was', async () => {
    const provider = replying('{"visual":false}');
    await decideVisual(provider, { question: input.question, answer: input.answer });
    const [messages, options] = provider.generate.mock.calls[0];
    expect(messages).toHaveLength(2);
    const schema = options?.responseFormat?.json_schema?.schema as { properties: { type: { enum: string[] } } };
    expect(schema.properties.type.enum).toEqual(['plot', 'diagram', 'figure', 'quiz']);
  });

  it('takes the reply of that type, with the id it was given', async () => {
    const { brief } = await decideVisual(replying(JSON.stringify(request)), input, { id: 'auto-3' });
    expect(brief).toMatchObject({ id: 'auto-3', type: 'quiz' });
  });

  it('treats a reply of another type as an invalid decision, and a decline as a decline', async () => {
    expect(await decideVisual(replying(JSON.stringify({ ...request, type: 'plot' })), input)).toEqual({ brief: null, error: 'invalid decision' });
    expect(await decideVisual(replying('{"visual":false}'), input)).toEqual({ brief: null });
  });

  it('drops an earlier refusal, because this message names the artefact even when asksForVisual does not read it', async () => {
    const provider = replying('{"visual":false}');
    await decideVisual(provider, { ...input, question: 'Il me faut un graphique.', target: 'plot', earlierMessages: ['Sans schéma.'] });
    expect(JSON.parse((provider.generate.mock.calls[0][0] as ProviderMessage[])[1].content).earlierLearnerMessages).toEqual([]);
  });
});

describe('decideVisuals', () => {
  const request = (type: string) => JSON.stringify({ visual: true, type, intent: 'See it', content: 'What the visual holds.' });
  const fence = (id: string, type: string) => '```student-visual-request\n' + JSON.stringify({ id, type, intent: 'I', content: 'C' }) + '\n```';
  const run = async (replies: string[], input: Parameters<typeof decideVisuals>[1], options: Partial<Parameters<typeof decideVisuals>[2]> = {}) => {
    const provider = replying(...replies);
    const jobs: VisualJob[] = [];
    const seen: string[] = [];
    const result = await decideVisuals(() => provider, input, { ...options, onRequest: (added, markdown) => { jobs.push(added); seen.push(markdown); } });
    const notes = provider.generate.mock.calls.map(([messages]) => (messages as ProviderMessage[])[2]?.content ?? 'general');
    const answers = provider.generate.mock.calls.map(([messages]) => JSON.parse((messages as ProviderMessage[])[1].content).tutorAnswer as string);
    return { result, jobs, seen, notes, answers, provider };
  };

  it('asks once for each named type with no request, in sequence, each call seeing what the previous ones added', async () => {
    const { result, jobs, notes, answers } = await run([request('plot'), request('diagram'), request('quiz')], { question: 'Fais un graphique, ajoute un arbre et termine par un quiz.', answer: 'Prose.' });
    expect(notes).toEqual([visualTargetNote('plot'), visualTargetNote('diagram'), visualTargetNote('quiz')]);
    expect(jobs.map((job) => [job.brief.id, job.brief.type])).toEqual([['auto-1', 'plot'], ['auto-2', 'diagram'], ['auto-3', 'quiz']]);
    expect(answers[0]).toBe('Prose.');
    expect(answers[1]).toContain('"id":"auto-1"');
    expect(answers[2]).toContain('"id":"auto-2"');
    expect(result).toMatchObject({ requested: 3, targets: ['plot', 'diagram', 'quiz'] });
    expect(result.markdown.match(/```student-visual-request/g)).toHaveLength(3);
  });

  it('runs one call at a time', async () => {
    let running = 0, most = 0;
    const generate = vi.fn<LLMProvider['generate']>(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return { content: '{"visual":false}', model: 'fixture' };
    });
    await decideVisuals(() => ({ generate, supportsStructuredOutputs: true }), { question: 'Ajoute un arbre et un quiz.', answer: 'Prose.' }, { onRequest: () => undefined });
    expect(most).toBe(1);
  });

  it('asks only for what the tutor did not request, and not again in general', async () => {
    const answer = `Prose.\n\n${fence('v1', 'plot')}`;
    const { jobs, notes, result } = await run(['{"visual":false}'], { question: 'Fais un seul graphique et un quiz.', answer });
    expect(notes).toEqual([visualTargetNote('quiz')]);
    expect(jobs).toEqual([]);
    expect(result).toMatchObject({ requested: 0, markdown: answer });
  });

  it('falls back to the general decision when every target declines and the answer still has no visual', async () => {
    const { notes, jobs } = await run(['{"visual":false}', request('plot')], { question: 'Explique, avec un schéma peut-être.', answer: 'Prose.' });
    expect(notes).toEqual([visualTargetNote('diagram'), 'general']);
    expect(jobs.map((job) => job.brief.type)).toEqual(['plot']);
  });

  it('makes the one general call when nothing is named', async () => {
    const { notes, result } = await run(['{"visual":false}'], { question: 'Why does it happen?', answer: 'Prose.' });
    expect(notes).toEqual(['general']);
    expect(result).toMatchObject({ requested: 0, targets: [] });
    expect(result.error).toBeUndefined();
  });

  it('stays inside the limit of automatic visuals', async () => {
    const answer = ['Prose.', ...[1, 2, 3].map((n) => fence(`v${n}`, 'plot'))].join('\n\n');
    const { notes } = await run([request('diagram')], { question: 'Ajoute un arbre et un quiz.', answer });
    expect(notes).toEqual([visualTargetNote('diagram')]);
  });

  it('gives an id the answer does not hold yet', async () => {
    const { jobs } = await run([request('quiz')], { question: 'Ajoute un quiz.', answer: `Prose.\n\n${fence('auto-1', 'plot')}` });
    expect(jobs[0].brief.id).toBe('auto-2');
  });

  it('removes the quiz written in the prose when a quiz block is added, and shows the model the answer with it', async () => {
    const answer = 'The explanation.\n\nQuiz : What is it? Choices: 1, 2.';
    const { result, answers, seen } = await run([request('quiz')], { question: 'Termine par un quiz.', answer });
    expect(answers[0]).toBe(answer);
    expect(result.markdown).not.toContain('Quiz :');
    expect(result.markdown).toContain('The explanation.');
    expect(seen).toEqual([result.markdown]);
  });

  it('goes on after an invalid decision, and stops at a failed call', async () => {
    const invalid = await run(['nonsense', request('quiz')], { question: 'Ajoute un arbre et un quiz.', answer: 'Prose.' });
    expect(invalid.notes).toEqual([visualTargetNote('diagram'), visualTargetNote('quiz')]);
    expect(invalid.result.error).toBe('invalid decision');
    const generate = vi.fn<LLMProvider['generate']>(async () => { throw new Error('The service is down.'); });
    const result = await decideVisuals(() => ({ generate, supportsStructuredOutputs: true }), { question: 'Ajoute un arbre et un quiz.', answer: 'Prose.' }, { onRequest: () => undefined });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('The service is down.');
  });

  it('stops when stopped, and reads the provider before each call', async () => {
    const controller = new AbortController();
    const generate = vi.fn<LLMProvider['generate']>(async () => { controller.abort(); return { content: '{"visual":false}', model: 'fixture' }; });
    await decideVisuals(() => ({ generate, supportsStructuredOutputs: true }), { question: 'Ajoute un arbre et un quiz.', answer: 'Prose.' }, { signal: controller.signal, onRequest: () => undefined });
    expect(generate).toHaveBeenCalledTimes(1);
    const first = replying('{"visual":false}');
    let provider: LLMProvider | null = first;
    const onRequest = vi.fn();
    first.generate.mockImplementationOnce(async () => { provider = null; return { content: '{"visual":false}', model: 'fixture' }; });
    await decideVisuals(() => provider, { question: 'Ajoute un arbre et un quiz.', answer: 'Prose.' }, { onRequest });
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(onRequest).not.toHaveBeenCalled();
  });
});

describe('generateTutorProse with a named artefact', () => {
  const plot = '```student-visual-request\n{"id":"v1","type":"plot","intent":"I","content":"C"}\n```';
  const asked = async (question: string, answer: string) => (await generateTutorProse(replying(answer), [{ role: 'user', content: question }], { maxTokens: 4096 })).needsDecision;

  it('needs a decision when a named type has no request, even beside another request', async () => {
    expect(await asked('Fais un graphique et un quiz.', `Prose.\n\n${plot}`)).toBe(true);
    expect(await asked('Fais un seul graphique.', `Prose.\n\n${plot}`)).toBe(false);
    expect(await asked('Why does it happen?', `Prose.\n\n${plot}`)).toBe(false);
    expect(await asked('Why does it happen?', 'Prose.')).toBe(true);
  });

  it('reads the learner, not the course evidence or the note', async () => {
    const provider = replying(`Prose.\n\n${plot}`);
    const evidence = { role: 'user' as const, content: 'Evidence {"kind":"course_evidence","documents":[{"text":"Ajoute un quiz."}]}' };
    const result = await generateTutorProse(provider, [evidence, { role: 'user', content: 'Why does it happen?' }], { maxTokens: 4096 });
    expect(result.needsDecision).toBe(false);
  });
});

describe('generateVisual', () => {
  it('never carries the length reminder', async () => {
    const provider = replying(JSON.stringify(quiz));
    await generateVisual(provider, job());
    expect(JSON.stringify(provider.generate.mock.calls[0][0])).not.toContain('Note from StudentLLM');
  });

  it('sends the type module, strict schema and only the brief with its section', async () => {
    const provider = replying(JSON.stringify(quiz));
    const result = await generateVisual(provider, job());
    expect(result).toEqual({ visual: quiz, attempts: 1, errors: [], unconfirmed: [] });
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
    expect(result).toEqual({ visual: null, attempts: 2, errors: ['the output is not valid JSON'], unconfirmed: [] });
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

  it('never sends image payloads, even when the section is long enough to be sliced', async () => {
    const image = `![x](data:image/png;base64,${'AAAA'.repeat(1500)})`;
    const fence = '```';
    const prose = `${image}\n\nBefore the visual.\n\n${fence}student-visual-request\n{"id":"v1","type":"quiz","intent":"I","content":"C"}\n${fence}\n\n${'Z'.repeat(300)} ${image}`;
    const { jobs } = await generateTutorProse(replying(prose), [], { maxTokens: 4096 });
    const provider = replying(JSON.stringify(quiz));
    await generateVisual(provider, jobs[0]);
    expect(JSON.stringify(provider.generate.mock.calls[0][0])).not.toContain('AAAA');
  });

  it.each([
    ['prose around the object', 'Here it is: ' + JSON.stringify(quiz) + '\nDone.'],
    ['a trailing remark', JSON.stringify(quiz) + '\nDone.'],
    ['three backticks inside strings', JSON.stringify({ ...quiz, options: ['A ```', 'B ```'] }, null, 2)],
    ['a fence with a trailing remark', '```json\n' + JSON.stringify(quiz) + '\n```\nDone.'],
  ])('parses a reply with %s', async (_name, content) => {
    const result = await generateVisual(replying(content), job());
    expect(result.visual).toMatchObject({ type: 'quiz' });
    expect(result.attempts).toBe(1);
  });

  it('truncates the invalid output echoed to the repair call', async () => {
    const provider = replying('x'.repeat(20000), JSON.stringify(quiz));
    await generateVisual(provider, job());
    expect(payload(provider, 1).invalidOutput).toHaveLength(16384);
  });

  it('returns instead of throwing when the repair call fails', async () => {
    let calls = 0;
    const generate = vi.fn<LLMProvider['generate']>(async () => {
      if (++calls === 1) return { content: '{"bad":', model: 'fixture' };
      throw new Error('Provider request failed (500)');
    });
    const result = await generateVisual({ generate }, job());
    expect(result).toEqual({ visual: null, attempts: 2, errors: ['Provider request failed (500)'], unconfirmed: [] });
  });

  describe('disagreeing checks', () => {
    const plot = (peak = 'v0^2/19.6') => ({
      type: 'plot', title: 'Height', x: { min: 0, max: 7 },
      parameters: [{ name: 'v0', label: 'Speed', min: 5, max: 30, step: 5, value: 20 }],
      series: [{ label: 'h', expression: 'v0*x-4.9*x^2' }],
      outputs: [{ label: 'Peak', expression: peak, unit: 'm' }],
    });
    const wrong = plot('v0^2/9.8');
    const plotJob = (more: Partial<VisualJob> = {}) => job({ type: 'plot', outputs: ['Peak'], checks: [{ output: 'Peak', at: { v0: 20 }, expected: 20.408, tolerance: 0.01 }] }, more);
    const disagreement = 'readout "Peak" at v0=20 gives 40.816326530612244, expected 20.408';

    it('returns a plot that agrees with its checks after one call', async () => {
      const provider = replying(JSON.stringify(plot()));
      expect(await generateVisual(provider, plotJob())).toEqual({ visual: plot(), attempts: 1, errors: [], unconfirmed: [] });
    });

    it('rechecks a disagreeing plot once and returns the corrected one', async () => {
      const provider = replying(JSON.stringify(wrong), JSON.stringify(plot()));
      const result = await generateVisual(provider, plotJob());
      expect(result).toEqual({ visual: plot(), attempts: 2, errors: [], unconfirmed: [] });
      const recheck = payload(provider, 1);
      expect(recheck.task).toBe('Recheck this visual against the request. The listed values disagree with values the tutor gave, and either side may be wrong. Correct the formula only if it is wrong, never bend a correct formula to match a value. Return the complete object.');
      expect(recheck.disagreements).toEqual([disagreement]);
      expect(recheck.previousOutput).toBe(JSON.stringify(wrong));
      expect(recheck).not.toHaveProperty('errors');
      expect(recheck).not.toHaveProperty('invalidOutput');
    });

    it('keeps the second plot with its own disagreements and makes no third call', async () => {
      const provider = replying(JSON.stringify(wrong), JSON.stringify(plot('v0^2/9.8')));
      const result = await generateVisual(provider, plotJob());
      expect(result.visual).toEqual(wrong);
      expect(result.unconfirmed).toEqual([disagreement]);
      expect(result.attempts).toBe(2);
      expect(provider.generate).toHaveBeenCalledTimes(2);
    });

    it('returns the first plot as unconfirmed when the recheck times out', async () => {
      vi.useFakeTimers();
      try {
        let calls = 0;
        const generate = vi.fn<LLMProvider['generate']>((_messages, options) => {
          if (++calls === 1) return Promise.resolve({ content: JSON.stringify(wrong), model: 'fixture' });
          return new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        });
        const pending = generateVisual({ generate }, plotJob(), { deadlineMs: 2000 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(await pending).toEqual({ visual: wrong, attempts: 2, errors: [], unconfirmed: [disagreement] });
      } finally { vi.useRealTimers(); }
    });

    it('returns the first plot as unconfirmed when the recheck is not valid or the call fails', async () => {
      expect(await generateVisual(replying(JSON.stringify(wrong), '{"bad":'), plotJob())).toEqual({ visual: wrong, attempts: 2, errors: [], unconfirmed: [disagreement] });
      let calls = 0;
      const generate = vi.fn<LLMProvider['generate']>(async () => { if (++calls === 1) return { content: JSON.stringify(wrong), model: 'fixture' }; throw new Error('Provider request failed (500)'); });
      expect(await generateVisual({ generate }, plotJob())).toMatchObject({ visual: wrong, unconfirmed: [disagreement] });
    });

    it('returns no visual when a stop arrives during the recheck', async () => {
      const controller = new AbortController();
      let calls = 0;
      const generate = vi.fn<LLMProvider['generate']>((_messages, options) => {
        if (++calls === 1) return Promise.resolve({ content: JSON.stringify(wrong), model: 'fixture' });
        const pending = new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        controller.abort();
        return pending;
      });
      expect(await generateVisual({ generate }, plotJob(), { signal: controller.signal })).toEqual({ visual: null, attempts: 2, errors: ['Visual generation was stopped.'], unconfirmed: [] });
    });

    it('returns no visual when a stop arrives before the recheck', async () => {
      const controller = new AbortController();
      const generate = vi.fn<LLMProvider['generate']>(async () => { controller.abort(); return { content: JSON.stringify(wrong), model: 'fixture' }; });
      expect(await generateVisual({ generate }, plotJob(), { signal: controller.signal })).toEqual({ visual: null, attempts: 1, errors: ['Visual generation was stopped.'], unconfirmed: [] });
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('returns no visual when the parent stops during the repair of an invalid first output', async () => {
      const controller = new AbortController();
      let calls = 0;
      const generate = vi.fn<LLMProvider['generate']>(async () => {
        if (++calls === 1) return { content: '{"bad":', model: 'fixture' };
        controller.abort();
        return { content: JSON.stringify(plot()), model: 'fixture' };
      });
      expect(await generateVisual({ generate }, plotJob(), { signal: controller.signal })).toEqual({ visual: null, attempts: 2, errors: ['Visual generation was stopped.'], unconfirmed: [] });
    });

    it('shows a repaired plot with unconfirmed disagreements after an invalid first output', async () => {
      const provider = replying('{"bad":', JSON.stringify(wrong));
      const result = await generateVisual(provider, plotJob());
      expect(result).toEqual({ visual: wrong, attempts: 2, errors: [], unconfirmed: [disagreement] });
      expect(provider.generate).toHaveBeenCalledTimes(2);
    });

    it('still rejects a plot that lacks a readout named in the outputs', async () => {
      const bare = { ...plot(), outputs: [{ label: 'Other', expression: '1' }] };
      const result = await generateVisual(replying(JSON.stringify(bare), JSON.stringify(bare)), plotJob());
      expect(result).toEqual({ visual: null, attempts: 2, errors: ['missing readout "Peak"'], unconfirmed: [] });
    });
  });

  describe('stop and deadline', () => {
    const stopped = 'Visual generation was stopped.';
    const abortedController = () => { const controller = new AbortController(); controller.abort(); return controller; };
    const rejectOnAbort = (options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    });

    afterEach(() => vi.useRealTimers());

    it('makes no call when already stopped', async () => {
      const provider = replying(JSON.stringify(quiz));
      const result = await generateVisual(provider, job(), { signal: abortedController().signal });
      expect(result).toEqual({ visual: null, attempts: 0, errors: [stopped], unconfirmed: [] });
      expect(provider.generate).not.toHaveBeenCalled();
    });

    it('makes no call when already stopped, even with an initial output', async () => {
      const provider = replying(JSON.stringify(quiz));
      const result = await generateVisual(provider, job({}, { initialOutput: '{"type":"quiz"}' }), { signal: abortedController().signal });
      expect(result).toEqual({ visual: null, attempts: 0, errors: [stopped], unconfirmed: [] });
      expect(provider.generate).not.toHaveBeenCalled();
    });

    it('does not repair after a stop that arrives during the first attempt', async () => {
      const controller = new AbortController();
      const generate = vi.fn<LLMProvider['generate']>(async () => { controller.abort(); return { content: '{"bad":', model: 'fixture' }; });
      const result = await generateVisual({ generate }, job(), { signal: controller.signal });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ visual: null, attempts: 1, errors: [stopped], unconfirmed: [] });
    });

    it('reports a stop, not the abort error, when the provider rejects on abort', async () => {
      const controller = new AbortController();
      const generate = vi.fn<LLMProvider['generate']>((_messages, options) => {
        const pending = rejectOnAbort(options);
        controller.abort();
        return pending;
      });
      const result = await generateVisual({ generate }, job(), { signal: controller.signal });
      expect(result).toEqual({ visual: null, attempts: 1, errors: [stopped], unconfirmed: [] });
    });

    it('reports the deadline, not the abort error, when an attempt times out', async () => {
      vi.useFakeTimers();
      const generate = vi.fn<LLMProvider['generate']>((_messages, options) => rejectOnAbort(options));
      const pending = generateVisual({ generate }, job(), { deadlineMs: 2000 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ visual: null, attempts: 1, errors: ['The visual request timed out after 2 s.'], unconfirmed: [] });
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('clears the timer and removes the parent listener after success and after failure', async () => {
      vi.useFakeTimers();
      const parent = new AbortController();
      const added = vi.spyOn(parent.signal, 'addEventListener');
      const removed = vi.spyOn(parent.signal, 'removeEventListener');
      await generateVisual(replying(JSON.stringify(quiz)), job(), { deadlineMs: 60_000, signal: parent.signal });
      expect(vi.getTimerCount()).toBe(0);
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledTimes(1);
      const failing: LLMProvider = { generate: async () => { throw new Error('Provider request failed (500)'); } };
      await generateVisual(failing, job(), { deadlineMs: 60_000, signal: parent.signal });
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
    });
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

  it('runs two jobs at a time by default', async () => {
    let running = 0, peak = 0;
    const generate = vi.fn<LLMProvider['generate']>(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { content: JSON.stringify(quiz), model: 'fixture' };
    });
    await runVisualJobs({ generate }, ['a', 'b', 'c', 'd', 'e'].map((id) => job({ id })), { onResult: vi.fn() });
    expect(peak).toBe(2);
  });

  it('forwards the deadline and the signal to every job', async () => {
    const hanging: LLMProvider = { generate: vi.fn<LLMProvider['generate']>((_messages, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    })) };
    const errors: string[][] = [];
    await runVisualJobs(hanging, [job()], { deadlineMs: 5, onResult: (_brief, result) => errors.push(result.errors) });
    expect(errors).toEqual([['The visual request timed out after 1 s.']]);
    const stopped = new AbortController();
    stopped.abort();
    const quick = replying(JSON.stringify(quiz));
    await runVisualJobs(quick, [job()], { signal: stopped.signal, onResult: (_brief, result) => errors.push(result.errors) });
    expect(errors[1]).toEqual(['Visual generation was stopped.']);
    expect(quick.generate).not.toHaveBeenCalled();
  });

  it('makes no call for queued jobs after a stop but still reports each one', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const provider = replying(JSON.stringify(quiz));
    const results: Array<[string, string[]]> = [];
    await runVisualJobs(provider, ['a', 'b', 'c', 'd'].map((id) => job({ id })), { signal: stopped.signal, onResult: (brief, result) => results.push([brief.id, result.errors]) });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(results).toHaveLength(4);
    expect(results.every(([, errors]) => errors[0] === 'Visual generation was stopped.')).toBe(true);
  });

  it('stops queued jobs when the stop arrives mid-run', async () => {
    const controller = new AbortController();
    const provider = replying(JSON.stringify(quiz));
    const seen: string[] = [];
    await runVisualJobs(provider, ['a', 'b', 'c', 'd'].map((id) => job({ id })), { concurrency: 1, signal: controller.signal, onResult: (brief) => { seen.push(brief.id); controller.abort(); } });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still runs every job and resolves when onResult throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const provider = replying(JSON.stringify(quiz), JSON.stringify(quiz), JSON.stringify(quiz));
      const seen: string[] = [];
      await runVisualJobs(provider, ['a', 'b', 'c'].map((id) => job({ id })), { concurrency: 1, onResult: (brief) => { seen.push(brief.id); if (brief.id === 'a') throw new Error('update failed'); } });
      expect(seen).toEqual(['a', 'b', 'c']);
      expect(provider.generate).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
});

describe('tutorNote', () => {
  it('is the plain reminder unless the question asks for a visual and an earlier message refused one', () => {
    const lifted = `${TUTOR_LENGTH_REMINDER} ${TUTOR_VISUAL_REQUEST_NOTE}`;
    expect(tutorNote('Show me a diagram of it.', ['No diagrams.'])).toBe(lifted);
    expect(tutorNote('Show me a diagram of it.', ['Why?'])).toBe(TUTOR_LENGTH_REMINDER);
    expect(tutorNote('Why?', ['No diagrams.'])).toBe(TUTOR_LENGTH_REMINDER);
    expect(tutorNote('Show me a diagram of it.', [])).toBe(TUTOR_LENGTH_REMINDER);
  });
});
