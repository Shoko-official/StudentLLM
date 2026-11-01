import { describe, expect, it } from 'vitest';
import { compactVisualFences, jobFromMarkdown, parseVisualBrief, prepareTutorMarkdown, replaceVisualFence, visualFence } from './visual-brief';
import { parseTeachingVisual, type TeachingVisual } from './teaching-visuals';

const brief = { id: 'v1', type: 'quiz', intent: 'Check the idea', content: 'Ask about pressure' };
const request = (value: unknown = brief) => '```student-visual-request\n' + JSON.stringify(value) + '\n```';
const quiz = { type: 'quiz', title: 'Check', question: 'Q?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' };
const direct = (value: unknown) => '```student-visual\n' + JSON.stringify(value) + '\n```';

describe('parseVisualBrief', () => {
  it('accepts a complete brief and keeps only known fields', () => {
    const parsed = parseVisualBrief(JSON.stringify({ ...brief, type: 'plot', parameters: ['n'], outputs: ['Error'], checks: [{ output: 'Error', at: { n: 2 }, expected: 0.04, tolerance: 0.001 }], extra: 'dropped' }));
    expect(parsed).toEqual({ ...brief, type: 'plot', parameters: ['n'], outputs: ['Error'], checks: [{ output: 'Error', at: { n: 2 }, expected: 0.04, tolerance: 0.001 }] });
  });

  it.each([
    ['not JSON', '{'],
    ['unknown type', JSON.stringify({ ...brief, type: 'mermaid' })],
    ['bad id', JSON.stringify({ ...brief, id: 'a b' })],
    ['long intent', JSON.stringify({ ...brief, intent: 'x'.repeat(301) })],
    ['long content', JSON.stringify({ ...brief, content: 'x'.repeat(1501) })],
    ['non-numeric check', JSON.stringify({ ...brief, checks: [{ output: 'E', at: { n: 'two' }, expected: 1 }] })],
  ])('rejects %s', (_name, raw) => expect(parseVisualBrief(raw)).toBeNull());
});

describe('prepareTutorMarkdown', () => {
  it('lists top-level requests in reading order with the prose around them', () => {
    const second = { ...brief, id: 'v2' };
    const { markdown, jobs } = prepareTutorMarkdown(`Before text.\n\n${request()}\n\nMiddle text.\n\n${request(second)}\n\nAfter text.`);
    expect(jobs.map((job) => job.brief.id)).toEqual(['v1', 'v2']);
    expect(jobs[0].section).toContain('Before text.');
    expect(jobs[0].section).toContain('Middle text.');
    expect(jobs[0].section).not.toContain('student-visual-request');
    expect(markdown).toContain('Middle text.');
  });

  it('demotes malformed requests, duplicate ids and nested fences to inert text', () => {
    const { markdown, jobs } = prepareTutorMarkdown(`${request()}\n\n${request()}\n\n> ${request({ ...brief, id: 'v3' }).replaceAll('\n', '\n> ')}\n\n` + '```student-visual-request\n{broken\n```');
    expect(jobs.map((job) => job.brief.id)).toEqual(['v1']);
    expect(markdown.match(/^```student-visual-request$/gm)).toHaveLength(1);
    expect(markdown).toContain('```text');
  });

  it('leaves ordinary code fences untouched, even when they mention a visual fence', () => {
    const code = '```python\ntext = "```student-visual"\n```';
    expect(prepareTutorMarkdown(`Intro.\n\n${code}`).markdown).toBe(`Intro.\n\n${code}`);
  });

  it('canonicalizes a valid direct visual without creating a job', () => {
    const { markdown, jobs } = prepareTutorMarkdown(`Text.\n\n${direct({ ...quiz, unknown: 1 })}`);
    expect(jobs).toEqual([]);
    expect(markdown).toContain(visualFence(parseTeachingVisual(JSON.stringify(quiz))!));
    expect(markdown).not.toContain('unknown');
  });

  it('turns an invalid direct visual of a known type into a job that carries its output', () => {
    const invalid = { ...quiz, answer: 9 };
    const { markdown, jobs } = prepareTutorMarkdown(`Text.\n\n${direct(invalid)}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].brief.type).toBe('quiz');
    expect(jobs[0].initialOutput).toBe(JSON.stringify(invalid));
    expect(markdown).toContain('```student-visual-request');
    expect(prepareTutorMarkdown(`Text.\n\n${direct({ type: 'mermaid', title: 'T' })}`).jobs).toEqual([]);
  });
});

describe('fence replacement', () => {
  it('replaces only the requested fence and keeps surrounding text', () => {
    const markdown = `A\n\n${request()}\n\nB\n\n${request({ ...brief, id: 'v2' })}`;
    const result = replaceVisualFence(markdown, 'v2', 'DONE');
    expect(result).toBe(`A\n\n${request()}\n\nB\n\nDONE`);
    expect(replaceVisualFence(markdown, 'missing', 'DONE')).toBe(markdown);
  });

  it('rebuilds a job for a retry', () => {
    expect(jobFromMarkdown(`A\n\n${request()}`, 'v1')?.brief.intent).toBe('Check the idea');
    expect(jobFromMarkdown(`A\n\n${request()}`, 'v9')).toBeNull();
  });
});

describe('compactVisualFences', () => {
  const plot: TeachingVisual = { type: 'plot', title: 'Height', x: { min: 0, max: 7 }, parameters: [{ name: 'v0', label: 'Speed', min: 5, max: 30, step: 5, value: 20 }], series: [{ label: 'h', expression: 'v0*x-4.9*x^2' }], outputs: [{ label: 'Peak', expression: 'v0^2/19.6', unit: 'm' }] };

  it('keeps what a follow-up needs without replaying the JSON', () => {
    const compact = compactVisualFences(`Text.\n\n${visualFence(plot)}`);
    expect(compact).toContain('Text.');
    expect(compact).toContain('Height');
    expect(compact).toContain('v0*x-4.9*x^2');
    expect(compact).toContain('v0 from 5 to 30');
    expect(compact).not.toContain('"series"');
  });

  it('compacts quizzes and pending requests, and returns other text unchanged', () => {
    expect(compactVisualFences(visualFence(parseTeachingVisual(JSON.stringify(quiz))!))).toContain('correct option: B');
    expect(compactVisualFences(request())).toBe('[Visual not generated: Check the idea]');
    expect(compactVisualFences('Plain text.')).toBe('Plain text.');
  });

  it('keeps an unreadable visual fence as it is', () => {
    const invalid = '```student-visual\n{"type":"plot","title":"Courbe"}\n```';
    expect(compactVisualFences(invalid)).toBe(invalid);
  });
});
