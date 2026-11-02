import { describe, expect, it } from 'vitest';
import { appendVisualRequest, asksForVisual, refusesVisual, compactVisualFences, describeEarlierVisuals, hasVisualFence, jobFromMarkdown, MAX_AUTOMATIC_VISUALS, missingArtefacts, namedArtefacts, parseVisualBrief, prepareTutorMarkdown, replaceVisualFence, streamingPreview, stripVisualNotes, visualFence } from './visual-brief';
import { parseTeachingVisual, type TeachingVisual } from './teaching-visuals';
import benchmark from '../../benchmarks/tutor/cases.json';

const brief = { id: 'v1', type: 'quiz', intent: 'Check the idea', content: 'Ask about pressure' };
const request = (value: unknown = brief) => '```student-visual-request\n' + JSON.stringify(value) + '\n```';
const quiz = { type: 'quiz', title: 'Check', question: 'Q?', options: ['A', 'B'], answer: 1, explanation: 'B follows.' };
const direct = (value: unknown) => '```student-visual\n' + JSON.stringify(value) + '\n```';
const notGenerated = '[Visual not generated: Compare the two curves]';
const shown = '[Visual shown to the learner: plot "Height", x from 0 to 7]';

describe('stripVisualNotes', () => {
  it.each([notGenerated, shown])('removes the whole line %s', (note) => {
    expect(stripVisualNotes(`Answer.\n\n${note}`)).toBe('Answer.');
    expect(stripVisualNotes(`${note}\n\nAnswer.`)).toBe('Answer.');
    expect(stripVisualNotes(`Answer.\n\n  ${note}\t\n`)).toBe('Answer.');
    expect(stripVisualNotes(note)).toBe('');
  });

  it('collapses the blank lines it leaves between paragraphs, and only those', () => {
    expect(stripVisualNotes(`One.\n\n${notGenerated}\n\nTwo.`)).toBe('One.\n\nTwo.');
    expect(stripVisualNotes(`One.\n\n${notGenerated}\n\n${shown}\n\n\nTwo.`)).toBe('One.\n\nTwo.');
    expect(stripVisualNotes(`One.\n${shown}\nTwo.`)).toBe('One.\nTwo.');
    expect(stripVisualNotes(`One.\n${shown}\n\nTwo.`)).toBe('One.\n\nTwo.');
    expect(stripVisualNotes(`One.\n\n\n\nTwo.\n\n${shown}\n\nThree.\n`)).toBe('One.\n\n\n\nTwo.\n\nThree.\n');
  });

  it('handles CRLF line ends', () => {
    expect(stripVisualNotes(`One.\r\n\r\n${notGenerated}\r\n\r\nTwo.`)).toBe('One.\r\n\r\nTwo.');
    expect(stripVisualNotes(`One.\r\n\r\n${shown}\r\n`)).toBe('One.');
  });

  it.each([
    ['a fence with a language', '```text\n[note]\n\n\n[note]\n```'],
    ['a fence with no language', '```\n[note]\n```'],
    ['a tilde fence', '~~~\n[note]\n~~~'],
    ['an unclosed fence', '```text\n[note]'],
    ['an indented code block', '    [note]'],
    ['a fence in a list', '- item\n\n  ```text\n  [note]\n  ```'],
  ])('keeps a note inside %s', (_name, sample) => {
    const code = sample.replaceAll('[note]', notGenerated);
    expect(stripVisualNotes(code)).toBe(code);
    expect(stripVisualNotes(`${shown}\n\n${code}`)).toBe(code);
  });

  it.each([
    `The tutor wrote ${notGenerated} earlier.`,
    `${notGenerated} and more text.`,
    `- ${shown}`,
    '[Visual not generated: never closed',
    'Visual not generated: no bracket]',
    '[Visual aid: a real link label]',
    '[Visual shown to someone: x]',
  ])('keeps a line that is not only a note: %s', (line) => {
    expect(stripVisualNotes(line)).toBe(line);
    expect(stripVisualNotes(`One.\n\n${line}\n\nTwo.`)).toBe(`One.\n\n${line}\n\nTwo.`);
  });

  it('returns text with no note unchanged', () => {
    for (const text of ['', 'Plain.\n\n\n', '\n\nA\r\n']) expect(stripVisualNotes(text)).toBe(text);
  });
});

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

describe('prepareTutorMarkdown and copied notes', () => {
  it('never saves a copied note, and a real request next to it still makes a job', () => {
    const { markdown, jobs } = prepareTutorMarkdown(`Text.\n\n${notGenerated}\n\n${request()}\n\n${shown}`);
    expect(markdown).toBe(`Text.\n\n${request()}`);
    expect(jobs.map((job) => job.brief.id)).toEqual(['v1']);
    expect(jobs[0].section).not.toContain('Visual not generated');
    expect(jobs[0].section).not.toContain('shown to the learner');
    expect(hasVisualFence(markdown)).toBe(true);
  });

  it('leaves no visual fence behind when only a note was written', () => {
    const { markdown, jobs } = prepareTutorMarkdown(`Text.\n\n${notGenerated}`);
    expect(markdown).toBe('Text.');
    expect(jobs).toEqual([]);
    expect(hasVisualFence(markdown)).toBe(false);
  });

  it('keeps a note the tutor quotes in a code sample', () => {
    const sample = '```text\n' + notGenerated + '\n```';
    expect(prepareTutorMarkdown(`Text.\n\n${sample}`).markdown).toBe(`Text.\n\n${sample}`);
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
    expect(compactVisualFences('Plain text.')).toBe('Plain text.');
  });

  it('removes a pending request with no replacement and collapses the gap', () => {
    expect(compactVisualFences(request())).toBe('');
    expect(compactVisualFences(`Before.\n\n${request()}`)).toBe('Before.');
    expect(compactVisualFences(`Before.\n\n${request()}\n\nAfter.`)).toBe('Before.\n\nAfter.');
    expect(compactVisualFences(`Before.\r\n\r\n${request()}\r\n\r\nAfter.`)).toBe('Before.\r\n\r\nAfter.');
    expect(compactVisualFences(`Before.\n\n${request()}\n\n    indented code`)).toBe('Before.\n\n    indented code');
    expect(compactVisualFences(`Before.\n\n${request()}`)).not.toContain('Visual not generated');
  });

  it('removes a pending request and keeps a real visual beside it', () => {
    const compact = compactVisualFences(`Before.\n\n${request()}\n\n${direct(quiz)}\n\nAfter.`);
    expect(compact).toMatch(/^Before\.\n\n\[Visual shown to the learner: quiz "Check": Q\? correct option: B\]\n\nAfter\.$/);
  });

  it('cleans notes saved in old answers, with and without a fence', () => {
    expect(compactVisualFences(`Old answer.\n\n${notGenerated}\n\n${shown}`)).toBe('Old answer.');
    expect(compactVisualFences(notGenerated)).toBe('');
    expect(compactVisualFences(`Old answer.\n\n${notGenerated}\n\n${direct(quiz)}`)).toBe('Old answer.\n\n[Visual shown to the learner: quiz "Check": Q? correct option: B]');
    expect(compactVisualFences(`Old answer.\n\n${shown}\n\n${request()}`)).toBe('Old answer.');
  });

  it('writes a note on one line, so a copy of it can always be removed', () => {
    const figure = parseTeachingVisual(JSON.stringify({ type: 'figure', title: 'T', description: 'First line.\nSecond line.', width: 400, height: 240, shapes: [{ type: 'text', x: 20, y: 40, text: 'a' }] }));
    expect(figure).not.toBeNull();
    const note = compactVisualFences(visualFence(figure!));
    expect(note.split('\n')).toHaveLength(1);
    expect(note).toContain('First line. Second line.');
    expect(stripVisualNotes(note)).toBe('');
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

  it('never shows a copied note at any prefix of an answer', () => {
    const notes = ['[Visual not generated:', '[Visual shown to the learner:'];
    const prefixes = notes.flatMap((note) => Array.from({ length: note.length - '[Visual'.length }, (_, i) => note.slice(0, '[Visual'.length + i + 1)));
    for (const answer of [
      `# Pressure\n\nForce over area.\n\n${notGenerated}\n\n${shown}`,
      `# Pressure\r\n\r\n  ${shown}  \r\n${notGenerated}\r\n`,
      `${notGenerated}\n\nAfter the note.\n\n${shown}\n\nThe end.`,
      `\`\`\`text\nquoted\n\`\`\`\n\n${shown}`,
    ]) for (let end = 0; end <= answer.length; end++) {
      const preview = streamingPreview(answer.slice(0, end));
      for (const prefix of prefixes) expect(preview, `${JSON.stringify(answer)} at ${end}`).not.toContain(prefix);
      expect(preview, `${JSON.stringify(answer)} at ${end}`).not.toContain('[Vis');
    }
  });

  it('shows the text after a closed note line', () => {
    expect(streamingPreview(`One.\n\n${notGenerated}\n\nTwo`)).toBe('One.\n\nTwo');
    expect(streamingPreview(`${shown}\nTwo`)).toBe('Two');
  });

  it('holds a last line only while it can still become a note', () => {
    expect(streamingPreview('One.\n\n[')).toBe('One.\n\n');
    expect(streamingPreview('One.\n\n  [Visual sh')).toBe('One.\n\n');
    expect(streamingPreview('One.\n\n[1')).toBe('One.\n\n[1');
    expect(streamingPreview('[link](url)')).toBe('[link](url)');
    expect(streamingPreview('[Visual a')).toBe('[Visual a');
    expect(streamingPreview('[Visual not generated: x] and')).toBe('');
    expect(streamingPreview('[Visual not generated: x] and\n')).toBe('[Visual not generated: x] and\n');
  });

  it('keeps a line that merely starts like a note inside a code block', () => {
    expect(streamingPreview('```text\n[Vis')).toBe('```text\n[Vis');
    expect(streamingPreview('```text\n' + notGenerated + '\n')).toBe('```text\n' + notGenerated + '\n');
  });
});

describe('describeEarlierVisuals', () => {
  const shownQuiz = (index: number) => direct({ ...quiz, title: `Check ${index}`, question: `Q${index}?` });

  it('describes the real visuals of each message in order, as compactVisualFences does', () => {
    const plot = { type: 'plot', title: 'Height', x: { min: 0, max: 7 }, parameters: [{ name: 'v0', label: 'Speed', min: 5, max: 30, step: 5, value: 20 }], series: [{ label: 'h', expression: 'v0*x' }] };
    const described = describeEarlierVisuals([`First.\n\n${direct(plot)}`, `Second.\n\n${shownQuiz(1)}`]);
    expect(described).toEqual(['plot "Height", x from 0 to 7. parameters: v0 from 5 to 30 step 5, initial 20. series: h = v0*x', 'quiz "Check 1": Q1? correct option: B']);
    expect(compactVisualFences(`${direct(plot)}`)).toContain(described[0]);
  });

  it('ignores requests that were never built, invalid fences, notes and fences quoted in code', () => {
    expect(describeEarlierVisuals([`Text.\n\n${request()}`, `${notGenerated}\n\n${shown}`, direct({ type: 'quiz' }), '````md\n' + shownQuiz(1) + '\n````'])).toEqual([]);
  });

  it('keeps the most recent entries when there are more than six', () => {
    const contents = [1, 2, 3, 4].map((index) => `${shownQuiz(index * 2 - 1)}\n\n${shownQuiz(index * 2)}`);
    const described = describeEarlierVisuals(contents);
    expect(described).toHaveLength(6);
    expect(described[0]).toContain('Check 3');
    expect(described[5]).toContain('Check 8');
  });

  it('cuts each description at 300 characters and writes it on one line', () => {
    const figure = { type: 'figure', title: 'T', description: 'First line.\n' + 'x'.repeat(400), width: 400, height: 240, shapes: [{ type: 'text', x: 20, y: 40, text: 'a' }] };
    const [described] = describeEarlierVisuals([direct(figure)]);
    expect(described).toHaveLength(300);
    expect(described).toContain('First line. xxx');
  });

  it('never splits a surrogate pair when it cuts', () => {
    const emoji = String.fromCodePoint(0x1F600);
    const figure = { type: 'figure', title: 'T', description: 'x'.repeat(287) + emoji + 'y'.repeat(50), width: 400, height: 240, shapes: [{ type: 'text', x: 20, y: 40, text: 'a' }] };
    const [described] = describeEarlierVisuals([direct(figure)]);
    expect([...described]).toHaveLength(300);
    expect(described.endsWith(emoji)).toBe(true);
    expect(described.charCodeAt(described.length - 1)).toBeGreaterThanOrEqual(0xDC00);
  });

  it('returns nothing without a visual fence', () => {
    expect(describeEarlierVisuals([])).toEqual([]);
    expect(describeEarlierVisuals(['Plain text.', ''])).toEqual([]);
  });
});

describe('asksForVisual', () => {
  it.each([
    'Finalement, montre-moi un schéma du cycle de réfrigération.',
    'Actually, show me a diagram of the refrigeration cycle.',
    'Dessine un diagramme de ce circuit.',
    'Peux-tu me montrer le graphique de la fonction ?',
    'Trace la courbe de y = x^2 entre 0 et 5.',
    'Fais un schéma de la cellule.',
    'Affiche une figure avec les forces.',
    'Can you draw a chart of the results?',
    'Please plot a graph of speed against time.',
    'Make a diagram for the water cycle.',
    'Give me a picture of the setup.',
    'Sketch a diagram of the circuit.',
    'MONTRE-MOI UN GRAPHIQUE',
    'Show me the curve for a larger k.',
    'Génère un diagramme de flux pour cet algorithme.',
    'Could you display a figure of the forces?',
    'Montre-moi un petit schéma du cycle.',
    // Diagrams of programs and code topics are real requests.
    'Show me a chart of the code flow.',
    'Montre-moi un schéma de ce script.',
    'Draw a diagram of the SQL join.',
    'Montre-moi un schéma du code.',
    'Show me a diagram of a React component.',
    'Fais-moi un schéma du protocole HTML.',
    'Show me a quick sketch of the forces.',
  ])('is true for %s', (text) => { expect(asksForVisual(text)).toBe(true); });

  it.each([
    'Sans schéma, explique le cycle.',
    'Pas de graphique, juste le texte.',
    'No diagram please, explain it.',
    'Explain it without a chart.',
    "Don't draw anything, just explain.",
    'Show me, but no diagram.',
    'Ne dessine pas de courbe.',
    "Qu'est-ce qu'un diagramme de Venn ?",
    'What does this graph mean?',
    'Explique ce schéma.',
    'Pourquoi la courbe monte-t-elle ?',
    'How does a binary search narrow down the answer?',
    'Montre-moi comment ça marche.',
    'Quelle est la différence entre un graphe et un arbre ?',
    'text only',
    '',
    'Why is the diagram in my textbook wrong?',
    // Everyday verbs followed by a noun that is not the thing to be shown.
    'Montre que la figure est un carré.',
    'Show that the curve is convex.',
    'Fais un résumé de la figure 3.',
    'Make sense of this chart.',
    'Include a figure of speech in my essay.',
    'Crée une liste des figures de style.',
    'Give me the definition of a graph.',
    'Donne-moi la différence entre un graphe et un arbre.',
    'Donne un exemple de graphe orienté.',
    'Generate a graph theory proof.',
    // A request for code, naming a language or a library.
    'Fais un graphique avec matplotlib.',
    'Build a bar chart in Python code.',
    'Make a chart with Excel.',
    // A contrast: the same message refuses a visual.
    'Fais un tableau, pas un graphique.',
    'Montre-moi la formule, pas le graphique.',
    "Montre-moi plutôt un tableau qu'un schéma.",
    "Fais-moi un résumé au lieu d'un schéma.",
    'Show a table, not a diagram.',
    'Show me a table instead of a diagram.',
    'Show me a table, I do not want a graph.',
    "Draw a table, I don't need a diagram.",
    'Show me the numbers, not a graph.',
    'Give me the answer rather than a diagram.',
    "Montre-moi le résultat, je ne veux pas de schéma.",
    "Dessine le tableau, pas besoin d'un graphique.",
  ])('is false for %j', (text) => { expect(asksForVisual(text)).toBe(false); });

  it('ignores a request written inside code or inside an image reference', () => {
    expect(asksForVisual('Voici mon code :\n```\n# show me a diagram\nshow_me_a_diagram()\n```')).toBe(false);
    expect(asksForVisual('Utilise `montre-moi un schéma` comme texte.')).toBe(false);
    expect(asksForVisual('![show me a diagram](https://example.com/a.png) Explain this.')).toBe(false);
    expect(asksForVisual('![x](a.png) Draw a diagram of it.')).toBe(true);
  });
});

describe('refusesVisual', () => {
  it.each([
    'Sans schéma, explique le cycle.',
    'Pas de graphique, juste le texte.',
    'No diagram please, explain it.',
    'Explain it without a chart.',
    "Don't draw anything, just explain.",
    'text only',
    "Don't use diagrams.",
    'never show a chart',
    'Ne me montre pas de schéma.',
    'Fais un tableau, pas un graphique.',
    'Montre-moi la formule, pas le graphique.',
    "Montre-moi plutôt un tableau qu'un schéma.",
    "Fais-moi un résumé au lieu d'un schéma.",
    'Show a table, not a diagram.',
    'Show me a table instead of a diagram.',
    'Show me a table, I do not want a graph.',
    "Draw a table, I don't need a diagram.",
    'Show me the numbers, not a graph.',
    'Give me the answer rather than a diagram.',
    "Je ne veux pas de schéma.",
    "Pas besoin d'un graphique.",
  ])('is true for %j', (text) => { expect(refusesVisual(text)).toBe(true); });

  it.each([
    'Montre-moi un schéma du cycle.',
    'Actually, show me a diagram of it.',
    'What does this graph mean?',
    "J'ai besoin d'un schéma.",
    'I need a diagram of the circuit.',
    "I don't understand the graph.",
    'Je ne comprends pas le graphique.',
    'This is not the time to draw.',
    // Style requests that name no visual are not a refusal of visuals.
    "Don't use jargon.",
    'Please do not make it long.',
    'never show your work',
    'Do not use the formula yet.',
    'ne me montre pas la solution',
    "don't make a fuss",
    "Don't make it too long.",
    "Je n'ai pas le temps de faire un point.",
    'Explique la différence entre un diagramme et un tableau.',
    '',
  ])('is false for %j', (text) => { expect(refusesVisual(text)).toBe(false); });

  it('ignores a refusal written inside code', () => {
    expect(refusesVisual(['Voici :', '```', 'sans schéma', '```'].join(String.fromCharCode(10)))).toBe(false);
  });
});

describe('namedArtefacts', () => {
  const types = (text: string) => namedArtefacts(text).map((item) => item.type);

  it.each<[string, string[]]>([
    ['Fais un seul graphique calculé de la quantité restante.', ['plot']],
    ['Il me faut un seul graphique interactif de G en fonction de N.', ['plot']],
    ['Il faut un graphique en barres interactif de P(X=k).', ['plot']],
    ['Fais un diagramme en barres des notes.', ['plot']],
    ['Fais un graphique de G avec r de 0,2 à 1.', ['plot']],
    ['Make a bar chart of the grades.', ['plot']],
    ["I'd like one interactive plot of R for x from 1 to 32.", ['plot']],
    ['Please plot a graph of speed against time.', ['plot']],
    ['Trace la courbe de y = x^2 entre 0 et 5.', ['plot']],
    ['Peux-tu me montrer le graphique de la fonction ?', ['plot']],
    ['Pour finir, un quiz interactif à une seule bonne réponse.', ['quiz']],
    ['Termine par un quiz interactif : combien reste-t-il ?', ['quiz']],
    ['Then finish with an interactive multiple-choice quiz with one right answer.', ['quiz']],
    ['Then a multiple-choice question on the first step.', ['quiz']],
    ['Quiz me on the French Revolution.', ['quiz']],
    ['Interroge-moi sur les fractions.', ['quiz']],
    ['Test me on what I just read.', ['quiz']],
    ['Ajoute un arbre des deux premiers essais.', ['diagram']],
    ["J'ai besoin d'un schéma du circuit.", ['diagram']],
    ['I need a flowchart of the process.', ['diagram']],
    ['Sketch a diagram of the circuit.', ['diagram']],
    ['Explain how a lever works, with a diagram.', ['diagram']],
    ['Comment fonctionne une écluse ? Fais un schéma.', ['diagram']],
    ['Explique comment ça marche et montre-moi un diagramme.', ['diagram']],
    ['How does a pump work, and can you draw a diagram of it?', ['diagram']],
    ['Could you display a figure of the forces?', ['figure']],
    ['Give me a picture of the setup.', ['figure']],
    ['Il faut un graphique interactif sur [-2,2], un curseur n, puis un quiz a choix multiples.', ['plot', 'quiz']],
    ['Fais une fiche sur le ressort avec un graphique de la force, un curseur et un quiz.', ['plot', 'quiz']],
    ['Donne-moi un résumé, un schéma et un QCM.', ['diagram', 'quiz']],
    ['Ajoute un dessin de la cellule, avec un QCM à la fin.', ['figure', 'quiz']],
  ])('reads %j as wanted', (text, expected) => { expect(types(text)).toEqual(expected); });

  it.each([
    'Montre que la figure est un carré.',
    "Don't use jargon.",
    "Qu'est-ce qu'un diagramme de Bode ?",
    'What is a quiz?',
    'How do I make a good quiz for my class?',
    'Comment tracer une courbe de niveau ?',
    "J'ai raté mon quiz.",
    'My quiz is tomorrow, explain fractions.',
    'Le graphique montre une courbe croissante, pourquoi ?',
    'The graphs show a curve, why?',
    'Regarde la figure 3.',
    'Montre la figure 3.',
    "Give me the graph's equation.",
    'Ne donne pas la réponse du quiz.',
    'Show me the answer to the quiz.',
    'Explain the meaning of a tree in this poem.',
    'Pourquoi le quiz est-il si dur ?',
    // A refusal in the same message silences everything, including a refused quiz.
    'Sans schéma, explique le cycle.',
    'Explique le cycle, sans quiz.',
    'Pas de quiz, juste un résumé.',
    'No quiz please, explain it.',
    'Fais un quiz, pas de graphique.',
    "Don't quiz me yet.",
  ])('does not read %j as wanted', (text) => { expect(namedArtefacts(text)).toEqual([]); });

  it.each([
    'Pas de graphique, juste le texte.',
    'No diagram please, explain it.',
    'Explain it without a chart.',
    "Don't draw anything, just explain.",
    'Show me, but no diagram.',
    'Ne dessine pas de courbe.',
    "Qu'est-ce qu'un diagramme de Venn ?",
    'What does this graph mean?',
    'Explique ce schéma.',
    'Pourquoi la courbe monte-t-elle ?',
    'Montre-moi comment ça marche.',
    'Quelle est la différence entre un graphe et un arbre ?',
    'text only',
    '',
    'Why is the diagram in my textbook wrong?',
    'Show that the curve is convex.',
    'Fais un résumé de la figure 3.',
    'Make sense of this chart.',
    'Include a figure of speech in my essay.',
    'Crée une liste des figures de style.',
    'Give me the definition of a graph.',
    'Donne-moi la différence entre un graphe et un arbre.',
    'Donne un exemple de graphe orienté.',
    'Generate a graph theory proof.',
    'Fais un graphique avec matplotlib.',
    'Build a bar chart in Python code.',
    'Make a chart with Excel.',
    'Fais un tableau, pas un graphique.',
    'Show me a table instead of a diagram.',
    'Give me the answer rather than a diagram.',
  ])('holds the narrowing of asksForVisual for %j', (text) => { expect(namedArtefacts(text)).toEqual([]); });

  it('ignores what is written in code or an image reference', () => {
    expect(namedArtefacts('Voici mon code :\n```\n# show me a diagram\nshow_me_a_diagram()\n```')).toEqual([]);
    expect(namedArtefacts('Utilise `montre-moi un schéma` comme texte.')).toEqual([]);
    expect(namedArtefacts('![show me a diagram](https://example.com/a.png) Explain this.')).toEqual([]);
    expect(types('![x](a.png) Draw a diagram of it.')).toEqual(['diagram']);
  });

  it('reads an explicit count, and one for a curve inside a plot', () => {
    expect(namedArtefacts('Fais un seul graphique de la force.')).toEqual([{ type: 'plot', count: 1 }]);
    expect(namedArtefacts('Fais deux graphiques de la force et un quiz.')).toEqual([{ type: 'plot', count: 2 }, { type: 'quiz', count: 1 }]);
    expect(namedArtefacts('Give me three quizzes on it.')).toEqual([{ type: 'quiz', count: 3 }]);
    expect(namedArtefacts('Fais un graphique avec deux courbes.')).toEqual([{ type: 'plot', count: 1 }]);
    expect(namedArtefacts('Fais un graphique, puis un autre graphique.')).toEqual([{ type: 'plot', count: 1 }]);
  });

  it('names every artefact of the committed benchmark prompts and nothing in its rate prompts', () => {
    for (const item of benchmark.quality) expect(types(item.prompt).sort()).toEqual(item.artefacts.map((artefact) => artefact.type).sort());
    expect(Object.values(benchmark.rate).flat().flatMap(types)).toEqual([]);
  });
});

describe('missingArtefacts', () => {
  const fence = (type: string, id = 'v1') => '```student-visual-request\n' + JSON.stringify({ id, type, intent: 'I', content: 'C' }) + '\n```';

  it('returns each named type with no request or visual, in the order of the message', () => {
    expect(missingArtefacts('Fais un graphique, ajoute un arbre et termine par un quiz.', 'Prose.')).toEqual(['plot', 'diagram', 'quiz']);
    expect(missingArtefacts('Fais un graphique et un quiz.', `Prose.\n\n${fence('plot')}`)).toEqual(['quiz']);
    expect(missingArtefacts('Fais un graphique et un quiz.', `Prose.\n\n${fence('plot')}\n\n${direct(quiz)}`)).toEqual([]);
  });

  it('counts what is there against an explicit count', () => {
    expect(missingArtefacts('Fais un seul graphique.', `Prose.\n\n${fence('plot')}`)).toEqual([]);
    expect(missingArtefacts('Fais deux graphiques.', `Prose.\n\n${fence('plot')}`)).toEqual(['plot']);
    expect(missingArtefacts('Fais deux graphiques.', 'Prose.')).toEqual(['plot', 'plot']);
  });

  it('stays within the limit of automatic visuals', () => {
    const three = [1, 2, 3].map((n) => fence('plot', `v${n}`)).join('\n\n');
    expect(missingArtefacts('Ajoute un arbre et un quiz.', `Prose.\n\n${three}`)).toEqual(['diagram']);
    const full = Array.from({ length: MAX_AUTOMATIC_VISUALS }, (_, n) => fence('plot', `v${n}`)).join('\n\n');
    expect(missingArtefacts('Ajoute un quiz.', `Prose.\n\n${full}`)).toEqual([]);
  });

  it('asks for nothing when no artefact is named, and does not count a quoted fence', () => {
    expect(missingArtefacts('Pourquoi la courbe monte-t-elle ?', 'Prose.')).toEqual([]);
    expect(missingArtefacts('Ajoute un quiz.', '> ' + fence('quiz').replace(/\n/g, '\n> '))).toEqual(['quiz']);
  });
});
