import { describe, expect, it } from 'vitest';
import { appendVisualRequest, compactVisualFences, hasVisualFence, jobFromMarkdown, parseVisualBrief, prepareTutorMarkdown, replaceVisualFence, streamingPreview, visualFence } from './visual-brief';
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

  it('removes image payloads from the section before slicing it', () => {
    const image = `![x](data:image/png;base64,${'AAAA'.repeat(1500)})`;
    const { jobs } = prepareTutorMarkdown(`${image}\n\nBefore text.\n\n${request()}\n\n${'Z'.repeat(300)} ${image}`);
    expect(jobs[0].section).toContain('Before text.');
    expect(jobs[0].section).not.toContain('AAAA');
  });

  it('demotes malformed requests, duplicate ids and nested fences to inert text', () => {
    const { markdown, jobs } = prepareTutorMarkdown(`${request()}\n\n${request()}\n\n> ${request({ ...brief, id: 'v3' }).replaceAll('\n', '\n> ')}\n\n` + '```student-visual-request\n{broken\n```');
    expect(jobs.map((job) => job.brief.id)).toEqual(['v1']);
    expect(markdown.match(/^```student-visual-request$/gm)).toHaveLength(1);
    expect(markdown).toContain('```text');
  });

  it.each([
    ['four backticks', '````'],
    ['tildes', '~~~'],
  ])('keeps a visual fence quoted inside a malformed %s outer fence inert', (_name, outer) => {
    const input = [`${outer}student-visual-request`, '{broken', '```', '```student-visual-request', '{"id":"v9","type":"quiz","intent":"I","content":"C"}', '```', outer].join('\n');
    const { markdown, jobs } = prepareTutorMarkdown(input);
    expect(jobs).toEqual([]);
    expect(prepareTutorMarkdown(markdown).jobs).toEqual([]);
    expect(compactVisualFences(markdown)).toBe(markdown);
  });

  it('generates an id that does not collide with one the model already used', () => {
    const taken = { ...brief, id: 'direct-2' };
    const { jobs } = prepareTutorMarkdown(`${request(taken)}\n\n${direct({ ...quiz, answer: 9 })}`);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.brief.id)).size).toBe(2);
    expect(jobs[0].brief.id).toBe('direct-2');
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

describe('hasVisualFence', () => {
  it('is true for a request or a direct fence', () => {
    expect(hasVisualFence('Text.\n\n' + request())).toBe(true);
    expect(hasVisualFence('Text.\n\n' + direct(quiz))).toBe(true);
  });

  it('is false for plain prose, other code fences and demoted fences', () => {
    expect(hasVisualFence('Plain prose.')).toBe(false);
    expect(hasVisualFence('```python\nprint(1)\n```')).toBe(false);
    expect(hasVisualFence('> ' + request().replace(/\n/g, '\n> '))).toBe(false);
    expect(hasVisualFence('- item\n\n  ' + request().replace(/\n/g, '\n  '))).toBe(false);
    expect(hasVisualFence('````text\n' + request() + '\n````')).toBe(false);
  });

  it('is false for a malformed request once the markdown is prepared', () => {
    const prepared = prepareTutorMarkdown('Text.\n\n```student-visual-request\n{"id":"v1"}\n```').markdown;
    expect(hasVisualFence(prepared)).toBe(false);
  });
});

describe('appendVisualRequest', () => {
  it('appends the request after the trimmed text and returns its job', () => {
    const result = appendVisualRequest('Answer.\n\n  ', parseVisualBrief(JSON.stringify(brief))!);
    expect(result.markdown).toBe('Answer.\n\n' + request());
    expect(result.job).toMatchObject({ brief });
    expect(result.job?.section).toContain('Answer.');
    expect(hasVisualFence(result.markdown)).toBe(true);
  });
});

describe('streamingPreview', () => {
  const json = JSON.stringify(brief);

  it('leaves plain text and an empty answer alone', () => {
    expect(streamingPreview('')).toBe('');
    expect(streamingPreview('Some **text**\n')).toBe('Some **text**\n');
  });

  it.each(['student-visual-request', 'student-visual'])('removes a closed %s fence and keeps the text after it', (language) => {
    const preview = streamingPreview('Before.\n\n```' + language + '\n' + json + '\n```\n\nAfter.');
    expect(preview).toContain('Before.');
    expect(preview).toContain('After.');
    expect(preview).not.toContain(language);
    expect(preview).not.toContain('Check the idea');
    expect(preview).not.toContain('```');
  });

  it('removes several fences', () => {
    const preview = streamingPreview(`One.\n\n${request()}\n\nTwo.\n\n${direct(quiz)}\n\nThree.`);
    expect(preview.replace(/\s+/g, ' ').trim()).toBe('One. Two. Three.');
  });

  it.each(['student-visual-request', 'student-visual'])('hides an unclosed %s fence from its opening line to the end', (language) => {
    expect(streamingPreview('Before.\n\n```' + language + '\n{"id":"v1"\nmore text\n\nand more').trim()).toBe('Before.');
    expect(streamingPreview('Before.\n\n```' + language + '\n').trim()).toBe('Before.');
    expect(streamingPreview('Before.\n\n```' + language).trim()).toBe('Before.');
  });

  it('accepts a longer or tilde fence, which closes only with a run at least as long', () => {
    expect(streamingPreview('A.\n\n````student-visual-request\n{"a":1}\n```\nstill hidden\n````\nB.').replace(/\s+/g, ' ').trim()).toBe('A. B.');
    expect(streamingPreview('A.\n\n````student-visual-request\n{"a":1}\n```\nstill hidden').trim()).toBe('A.');
    expect(streamingPreview('A.\n\n~~~student-visual\n{"a":1}\n```\nstill hidden\n~~~\nB.').replace(/\s+/g, ' ').trim()).toBe('A. B.');
    expect(streamingPreview('A.\n\n~~~~~student-visual\n{"a":1}\n~~~~\nstill hidden').trim()).toBe('A.');
  });

  it('accepts CRLF and an info string after the language', () => {
    expect(streamingPreview('A.\r\n\r\n```student-visual-request\r\n{"a":1}\r\n```\r\n\r\nB.').replace(/\s+/g, ' ').trim()).toBe('A. B.');
    expect(streamingPreview('A.\n\n```student-visual extra words\n{"a":1}').trim()).toBe('A.');
  });

  it.each(['```', '````', '~~~', '```s', '```student', '```student-', '```student-visual-req', '~~~student-v', '  ```stud', '```stud '])('hides a last line %j that could still become a visual fence', (line) => {
    expect(streamingPreview('Before.\n\n' + line).trim()).toBe('Before.');
    expect(streamingPreview(line).trim()).toBe('');
  });

  it.each(['```p', '```python', '~~~text', '``', '`', 'a ```', '```student_visual', '```Student', '```student-visual-requests'])('keeps a last line %j that cannot become a visual fence', (line) => {
    expect(streamingPreview('Before.\n\n' + line)).toContain(line.trim());
  });

  it('keeps a normal code block visible, closed or unclosed', () => {
    expect(streamingPreview('```python\nprint(1)\n```\n\nAfter.')).toBe('```python\nprint(1)\n```\n\nAfter.');
    expect(streamingPreview('```python\nprint(1)')).toBe('```python\nprint(1)');
    expect(streamingPreview('```\nplain\n')).toBe('```\nplain\n');
    expect(streamingPreview('```\nplain')).toBe('```\nplain');
  });

  it('keeps a visual fence quoted inside a normal code block', () => {
    const quoted = '````markdown\n```student-visual-request\n{"id":"v1"}\n```\n````';
    expect(streamingPreview(quoted)).toBe(quoted);
    expect(streamingPreview(quoted.slice(0, -5))).toBe(quoted.slice(0, -5));
    expect(streamingPreview('````markdown\n```student')).toBe('````markdown\n```student');
  });

  it('keeps the line that closes a normal code block visible while it arrives', () => {
    expect(streamingPreview('```python\nprint(1)\n```')).toBe('```python\nprint(1)\n```');
  });

  it('does not read an indented code line as a fence', () => {
    expect(streamingPreview('    ```student')).toBe('    ```student');
  });

  it('also hides a visual fence nested in a list or a quote', () => {
    expect(streamingPreview('1. Step\n\n   ```student-visual-request\n   {"id":"v1"}\n   ```\n\nAfter.')).not.toContain('v1');
    expect(streamingPreview('> ```student-visual\n> {"id":"v1"}')).not.toContain('v1');
  });

  it('never shows a request at any prefix of an answer', () => {
    const fence = '```student-visual-request\n' + JSON.stringify(brief, null, 2) + '\n```';
    const answer = `# Pressure\n\nPressure is force over area.\n\n\`\`\`python\nprint("kept")\n\`\`\`\n\n${fence}\n\nAfter the first visual.\n\n~~~~student-visual\n${JSON.stringify(quiz)}\n~~~~\n\nThe end.`;
    const raw = [/"id"/, /"intent"/, /Check the idea/, /Ask about pressure/, /"question"/, /B follows/, /student-/, /\{/];
    for (let end = 0; end <= answer.length; end++) {
      const preview = streamingPreview(answer.slice(0, end));
      for (const pattern of raw) expect(preview, `prefix of ${end} characters`).not.toMatch(pattern);
    }
    const complete = streamingPreview(answer);
    for (const kept of ['# Pressure', 'print("kept")', 'After the first visual.', 'The end.']) expect(complete).toContain(kept);
  });
});
