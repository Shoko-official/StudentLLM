import { describe, expect, it } from 'vitest';
import { estimateContextTokens } from '../lib/chat-context';
import { parseTeachingVisual } from '../lib/teaching-visuals';
import { checkVisualAgainstBrief } from '../lib/visual-checks';
import { parseVisualBrief, VISUAL_TYPES } from '../lib/visual-brief';
import { TUTOR_PROMPT, TUTOR_SYSTEM_PROMPT, VISUAL_MODULES, VISUAL_ROUTING_PROMPT } from './index';

const examples = (prompt: string): string[] => prompt.match(/<example>[\s\S]*?<\/example>/g) ?? [];
const fences = (prompt: string, language: string) => Array.from(prompt.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g')), (match) => match[1]);
const goodOutput = (example: string) => /<good_output>([\s\S]*?)<\/good_output>/.exec(example)![1].trim();
const BENCHMARK_TOPICS = /taylor|loi binomiale|binomial distribution|half-life|demi-vie|sinusoid|rms voltage|peak-to-peak/i;

describe('prompt standard: tutor prompts', () => {
  const all = { tutor: TUTOR_PROMPT, routing: VISUAL_ROUTING_PROMPT, ...VISUAL_MODULES };

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
    expect(estimateContextTokens(TUTOR_SYSTEM_PROMPT)).toBeLessThanOrEqual(6000);
    for (const type of VISUAL_TYPES) expect(estimateContextTokens(VISUAL_MODULES[type])).toBeLessThanOrEqual(6000);
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

  it('routes explicit requests to see or practise before the text-only rule', () => {
    const positions = ['asked to see', 'wants to be tested', 'Text alone is complete', 'has behaviour'].map((phrase) => VISUAL_ROUTING_PROMPT.indexOf(phrase));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
