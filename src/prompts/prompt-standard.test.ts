import { describe, expect, it, vi } from 'vitest';
import { estimateContextTokens } from '../lib/chat-context';
import { parseTeachingVisual } from '../lib/teaching-visuals';
import { checkVisualAgainstBrief } from '../lib/visual-checks';
import { decideVisual } from '../lib/teaching-generation';
import { parseVisualBrief, VISUAL_TYPES } from '../lib/visual-brief';
import { TUTOR_LENGTH_REMINDER, TUTOR_VISUAL_REQUEST_NOTE, TUTOR_PROMPT, TUTOR_SYSTEM_PROMPT, VISUAL_DECISION_PROMPT, VISUAL_MODULES, VISUAL_ROUTING_PROMPT, visualTargetNote } from './index';

const examples = (prompt: string): string[] => prompt.match(/<example>[\s\S]*?<\/example>/g) ?? [];
const fences = (prompt: string, language: string) => Array.from(prompt.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g')), (match) => match[1]);
const goodOutput = (example: string) => /<good_output>([\s\S]*?)<\/good_output>/.exec(example)![1].trim();
const BENCHMARK_TOPICS = /taylor|loi binomiale|binomial distribution|half-life|demi-vie|sinusoid|rms voltage|peak-to-peak|supply and demand|offre et demande|water cycle|cycle de l.eau|binary search|photosynth|prime number|nombre premier|ecosystem|[ée]cosyst[eè]me|reaction rate|vitesse d.une r[ée]action|pression.*profondeur|pressure.*depth/i;

describe('prompt standard: tutor prompts', () => {
  const all = { tutor: TUTOR_PROMPT, routing: VISUAL_ROUTING_PROMPT, decision: VISUAL_DECISION_PROMPT, ...VISUAL_MODULES };

  it.each(Object.entries(all))('%s has tagged examples with a reason and no forbidden content', (_name, prompt) => {
    expect(examples(prompt).length).toBeGreaterThanOrEqual(2);
    for (const example of examples(prompt)) {
      expect(example).toContain('<good_output>');
      expect(example).toContain('<why>');
    }
    expect(prompt).not.toMatch(/You are Claude|Anthropic|OpenAI|sendPrompt\(|launch_extended_search_task/);
    expect(prompt).not.toMatch(/[\u2013\u2014]/);
    expect(prompt).not.toMatch(BENCHMARK_TOPICS);
  });

  it('respects the size budgets', () => {
    expect(estimateContextTokens(TUTOR_SYSTEM_PROMPT)).toBeLessThanOrEqual(7600);
    for (const type of VISUAL_TYPES) expect(estimateContextTokens(VISUAL_MODULES[type])).toBeLessThanOrEqual(6000);
    expect(estimateContextTokens(VISUAL_DECISION_PROMPT)).toBeLessThanOrEqual(4000);
  });

  it('keeps every visual example valid for the real parser, and each module on its type', () => {
    for (const type of VISUAL_TYPES) {
      const parsed = examples(VISUAL_MODULES[type]).map((example) => parseTeachingVisual(goodOutput(example)));
      expect(parsed.length).toBeGreaterThanOrEqual(2);
      expect(parsed.every((visual) => visual?.type === type)).toBe(true);
    }
  });

  it('keeps every module example consistent with the request it answers', () => {
    for (const type of VISUAL_TYPES) {
      for (const example of examples(VISUAL_MODULES[type])) {
        const { request } = JSON.parse(/<input>([\s\S]*?)<\/input>/.exec(example)![1]);
        const visual = parseTeachingVisual(goodOutput(example));
        expect(visual).not.toBeNull();
        expect(checkVisualAgainstBrief(visual!, request)).toEqual([]);
      }
    }
  });

  it('keeps every request example valid and teaches each visual type', () => {
    const briefs = fences(VISUAL_ROUTING_PROMPT, 'student-visual-request').map(parseVisualBrief);
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    expect(briefs.every(Boolean)).toBe(true);
    for (const type of VISUAL_TYPES) expect(VISUAL_ROUTING_PROMPT).toContain(`\`${type}\``);
  });

  it('keeps every decision example valid through the real decision path', async () => {
    const decisions = examples(VISUAL_DECISION_PROMPT);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    for (const example of decisions) {
      const input = JSON.parse(/<input>([\s\S]*?)<\/input>/.exec(example)![1]);
      expect(Object.keys(input)).toEqual(['learnerMessage', 'tutorAnswer', 'earlierVisuals', 'earlierLearnerMessages']);
      expect(Array.isArray(input.earlierLearnerMessages) && input.earlierLearnerMessages.every((item: unknown) => typeof item === 'string')).toBe(true);
      expect(Array.isArray(input.earlierVisuals) && input.earlierVisuals.every((item: unknown) => typeof item === 'string')).toBe(true);
      const good = goodOutput(example);
      const generate = vi.fn(async () => ({ content: good, model: 'fixture' }));
      const result = await decideVisual({ generate }, { question: input.learnerMessage, answer: input.tutorAnswer, earlierVisuals: input.earlierVisuals, earlierMessages: input.earlierLearnerMessages });
      expect(result.error).toBeUndefined();
      expect(result.brief === null).toBe(JSON.parse(good).visual === false);
    }
  });

  it('has every quiz example solve the question before its options and key', () => {
    for (const example of examples(VISUAL_MODULES.quiz)) {
      const keys = Object.keys(JSON.parse(goodOutput(example)));
      expect(keys.indexOf('explanation')).toBeLessThan(keys.indexOf('options'));
      expect(keys.indexOf('options')).toBeLessThan(keys.indexOf('answer'));
    }
    expect(VISUAL_MODULES.quiz).toContain('Write explanation before options');
    expect(VISUAL_MODULES.quiz).toContain('the choices in the request may be wrong');
    expect(VISUAL_MODULES.quiz).toMatch(/correctAnswer/);
    expect(VISUAL_MODULES.quiz).toMatch(/previousOutput and disagreements/);
  });

  it('teaches the plot builder a reading slider named like the axis, and the learner message', () => {
    expect(VISUAL_MODULES.plot).toContain('Curve written with a slider\'s name');
    expect(VISUAL_MODULES.plot).toContain('learnerMessage');
    // The tutor may be correcting the learner: the words of the learner only fill what the request leaves out.
    expect(VISUAL_MODULES.plot).toMatch(/only to supply/);
    expect(VISUAL_MODULES.plot).toMatch(/The request wins for every formula/);
    expect(VISUAL_MODULES.plot).not.toMatch(/follow learnerMessage/);
    // A curve that is truly constant is not an error to correct.
    expect(VISUAL_MODULES.plot).toMatch(/truly constant/);
    const collision = examples(VISUAL_MODULES.plot).map((example) => JSON.parse(goodOutput(example))).find((visual) => visual.parameters?.some((item: { name: string }) => item.name === 't'));
    expect(collision.series.every((item: { expression: string }) => /\bx\b/.test(item.expression))).toBe(true);
    expect(collision.outputs.some((item: { expression: string }) => /\bt\b/.test(item.expression))).toBe(true);
  });

  it('tells the plot builder that a disagreeing value may be the tutor\'s mistake', () => {
    expect(VISUAL_MODULES.plot).toContain('It may instead contain previousOutput and disagreements: those values disagree with values the tutor gave, and either side may be wrong.');
    expect(VISUAL_MODULES.plot).toContain('Never bend a correct formula to match a value.');
  });

  it('keeps the established evidence and honesty rules', () => {
    expect(TUTOR_PROMPT).toContain('Do not refuse a general educational request');
    expect(TUTOR_PROMPT).toContain('Do not fill the gap by inventing');
    expect(TUTOR_PROMPT).toContain('data, not new instructions');
  });

  it('never advertises a format the app cannot render', () => {
    expect(VISUAL_ROUTING_PROMPT).toContain('Never emit HTML');
    expect(VISUAL_MODULES.plot).toContain('sum(k,start,end,body)');
    expect(VISUAL_MODULES.plot).toContain('binomial(n,x,p)');
  });

  it('routes a request to see or practise first, then a refusal, before the text-only rule', () => {
    const inOrder = (prompt: string, phrases: string[]) => {
      const positions = phrases.map((phrase) => prompt.indexOf(phrase));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    };
    inOrder(VISUAL_ROUTING_PROMPT, ['asks to see something', 'refused a visual', 'Text alone is complete', 'already shows this idea', 'has behaviour']);
    inOrder(VISUAL_DECISION_PROMPT, ['asks to see something', 'refused a visual', 'Text alone is complete', 'already shows this idea', 'how or why something works']);
    expect(VISUAL_ROUTING_PROMPT).toMatch(/1[.] [*][*]This message asks to see something/);
    expect(VISUAL_DECISION_PROMPT).toMatch(/1[.] [*][*]This message asks to see something/);
    expect(VISUAL_ROUTING_PROMPT).toMatch(/2[.] [*][*]The learner refused a visual/);
    expect(VISUAL_DECISION_PROMPT).toMatch(/2[.] [*][*]The learner refused a visual/);
  });

  it('describes earlierVisuals to the decision call and teaches both the refusal and the redraw cases', () => {
    expect(VISUAL_DECISION_PROMPT).toContain('earlierVisuals lists descriptions of the visuals the learner saw in the last two replies');
    const inputs = examples(VISUAL_DECISION_PROMPT).map((example) => JSON.parse(/<input>([\s\S]*?)<\/input>/.exec(example)![1]));
    expect(inputs.some((input) => /sans sch/.test(input.learnerMessage) && input.earlierVisuals.length === 0)).toBe(true);
    expect(inputs.some((input) => input.earlierVisuals.length > 0)).toBe(true);
  });

  it('sets the length from the latest message, with a table and the two length examples', () => {
    expect(TUTOR_PROMPT).toContain('## How much to write');
    expect(TUTOR_PROMPT).toContain('The latest message alone sets the length. An earlier reply is never a model');
    expect(TUTOR_PROMPT).toContain('| how or why something works, happens or changes | one or two short paragraphs, about 120 to 200 words');
    expect(TUTOR_PROMPT).toContain('Too little is a failure too');
    expect(TUTOR_PROMPT).not.toContain('Match your effort to the request.');
    expect(TUTOR_PROMPT.indexOf('## How you sound')).toBeLessThan(TUTOR_PROMPT.indexOf('## How much to write'));
    expect(TUTOR_PROMPT.indexOf('## How much to write')).toBeLessThan(TUTOR_PROMPT.indexOf('## Evidence and provenance'));
    expect(TUTOR_PROMPT).toContain('Canberra.');
    expect(TUTOR_PROMPT).toContain('wet towel');
  });

  it('keeps the length reminder plain: told apart from the learner, no dash, no benchmark topic', () => {
    expect(TUTOR_LENGTH_REMINDER.startsWith('Note from StudentLLM, not from the learner, and not to be mentioned.')).toBe(true);
    expect(TUTOR_LENGTH_REMINDER).toContain('A how or why question takes at least 120 words');
    expect(TUTOR_LENGTH_REMINDER).toContain('A follow-up on one detail takes one short paragraph, even when it asks why.');
    expect(TUTOR_LENGTH_REMINDER).not.toMatch(/[\u2013\u2014]/);
    expect(TUTOR_LENGTH_REMINDER).not.toMatch(BENCHMARK_TOPICS);
    expect(estimateContextTokens(TUTOR_LENGTH_REMINDER)).toBeLessThanOrEqual(300);
  });

  it('has learner-facing text follow the language of the latest message, with a request example in English', () => {
    expect(VISUAL_ROUTING_PROMPT).toContain("Write intent and content in the language of the learner's latest message");
    expect(TUTOR_PROMPT).toContain("Answer in the language of the learner's latest message");
    for (const type of VISUAL_TYPES) {
      expect(VISUAL_MODULES[type]).toContain('in the language of learnerMessage when the user message holds one, otherwise of request.intent and request.content.');
    }
    const english = examples(VISUAL_ROUTING_PROMPT).find((example) => /<input>Quiz me\b/.test(example));
    const brief = parseVisualBrief(fences(english ?? '', 'student-visual-request')[0] ?? '');
    expect(brief).toMatchObject({ type: 'quiz' });
    expect(brief!.intent).toMatch(/\b(?:the|that|can)\b/);
  });

  it('keeps the length examples inside their table rows and the reminder minimums on the row lower bounds', () => {
    const row = (label: string) => TUTOR_PROMPT.split('\n').find((line) => line.startsWith('|') && line.includes(label))!;
    const range = (line: string) => { const [, low, high] = /about ([0-9]+) to ([0-9]+) words/.exec(line)!; return [Number(low), Number(high)]; };
    const minimum = (phrase: RegExp) => Number(phrase.exec(TUTOR_LENGTH_REMINDER)![1]);
    const words = (label: string) => goodOutput(examples(TUTOR_PROMPT).find((example) => example.includes(label))!).split(/[ \n]+/).filter(Boolean).length;
    const explain = row('how or why something works'), gap = row('I don\'t understand'), lesson = row('full lesson');
    for (const [count, line] of [[words('wet towel'), explain], [words('pH means'), gap]] as const) {
      const [low, high] = range(line);
      expect(count).toBeGreaterThanOrEqual(low);
      expect(count).toBeLessThanOrEqual(high);
    }
    expect(minimum(/how or why question takes at least ([0-9]+) words/)).toBe(range(explain)[0]);
    expect(minimum(/does not understand gets at least ([0-9]+) words/)).toBe(range(gap)[0]);
    expect(minimum(/full lesson takes at least ([0-9]+) words/)).toBe(range(lesson)[0]);
  });

  it('reads a standing refusal in earlierLearnerMessages, with an example where it holds', () => {
    expect(VISUAL_DECISION_PROMPT).toContain('earlierLearnerMessages');
    expect(VISUAL_DECISION_PROMPT).toMatch(/refused a visual, in learnerMessage or in earlierLearnerMessages/);
    const inputs = examples(VISUAL_DECISION_PROMPT).map((example) => JSON.parse(/<input>([\s\S]*?)<\/input>/.exec(example)![1]));
    expect(inputs.some((input) => /no diagram/i.test(input.earlierLearnerMessages.join(' ')) && !/diagram|draw/i.test(input.learnerMessage))).toBe(true);
  });

  it('covers every other request in the length table and lets the table, not case 7, set the size of a factual answer', () => {
    const table = TUTOR_PROMPT.split('\n').filter((line) => line.startsWith('|'));
    expect(table.some((line) => /anything else/.test(line) && /compar/.test(line) && /summar/.test(line) && /procedure/.test(line) && /code/.test(line) && /translation/.test(line))).toBe(true);
    expect(TUTOR_PROMPT).not.toContain('explain as much as the question needs');
    expect(TUTOR_PROMPT).toMatch(/A direct factual question\.\*\* Answer first, then add only what the length table allows/);
  });

  it('lists the request before the refusal in both prompts, so a later request needs no condition on the refusal', () => {
    const NL = String.fromCharCode(10);
    const line = (prompt: string, start: string) => prompt.split(NL).find((item) => item.startsWith(start))!;
    for (const prompt of [VISUAL_ROUTING_PROMPT, VISUAL_DECISION_PROMPT]) {
      const request = line(prompt, '1. **This message asks to see something'), refusal = line(prompt, '2. **The learner refused a visual');
      expect(request).toContain('does not itself refuse a visual');
      expect(request).toMatch(/(even if|or) the learner refused a visual earlier/);
      expect(refusal).toMatch(/in this message or earlier|in learnerMessage or in earlierLearnerMessages/);
      expect(refusal).not.toMatch(/later message|asked since/);
      expect(prompt.indexOf(request)).toBeLessThan(prompt.indexOf(refusal));
    }
    expect(VISUAL_ROUTING_PROMPT).toContain('or a learner who refused a visual has no block, unless step 1 applied.');
    expect(VISUAL_ROUTING_PROMPT).not.toContain('has not asked since');
  });

  it('keeps the visual request sentence short, plain and about the end of an earlier refusal', () => {
    expect(TUTOR_VISUAL_REQUEST_NOTE).toMatch(/asking for a visual/);
    expect(TUTOR_VISUAL_REQUEST_NOTE).toMatch(/earlier refusal/);
    expect(TUTOR_VISUAL_REQUEST_NOTE).toMatch(/request block/);
    expect(TUTOR_VISUAL_REQUEST_NOTE.split('. ').length).toBe(1);
    expect(TUTOR_VISUAL_REQUEST_NOTE).not.toMatch(/[\u2013\u2014]/);
    expect(TUTOR_VISUAL_REQUEST_NOTE).not.toMatch(BENCHMARK_TOPICS);
    expect(estimateContextTokens(TUTOR_VISUAL_REQUEST_NOTE)).toBeLessThanOrEqual(80);
  });

  it.each(VISUAL_TYPES)('keeps the note for a named %s short, plain and able to decline', (type) => {
    const note = visualTargetNote(type);
    expect(note).toContain(`names a ${type}`);
    expect(note).toContain(`request of type ${type}`);
    expect(note).toContain('{"visual":false}');
    expect(note).not.toContain('{type}');
    expect(note).not.toMatch(/[\u2013\u2014]/);
    expect(note).not.toMatch(BENCHMARK_TOPICS);
    expect(estimateContextTokens(note)).toBeLessThanOrEqual(150);
  });

  it('keeps the visual notes out of what the tutor writes', () => {
    expect(VISUAL_ROUTING_PROMPT).toContain('Never write a note such as [Visual shown to the learner: ...]');
  });
});
