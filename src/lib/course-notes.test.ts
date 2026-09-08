import { describe, expect, it } from 'vitest';
import { buildCourseNote, courseNoteMarkdown, detectCourse, detectCourseWithProvider } from './course-notes';
import type { Lesson, TranscriptSegment } from '../types';

const lesson: Lesson = {
  id: 'lesson-1',
  subject: 'Machine Learning',
  chapter: 'Transformers',
  title: 'Attention',
  teacher: 'Professor',
  duration: '00:30:00',
  date: 'today',
  progress: 0,
};

const segment = (text: string): TranscriptSegment => ({ id: 'segment-1', timestamp: '00:01:00', speaker: 'Professor', text, status: 'review' });

describe('course notes', () => {
  it('builds a routed note with semantic blocks from transcript evidence', () => {
    const note = buildCourseNote(lesson, [segment('The force leads to acceleration. F = ma. accuracy: 0.8 loss: 0.2')]);
    expect(note.folderPath).toEqual(['Courses', 'Machine Learning', 'Transformers', 'Attention']);
    expect(note.blocks.some((block) => block.type === 'formula')).toBe(true);
    expect(note.blocks.some((block) => block.type === 'schema')).toBe(true);
    expect(note.blocks.some((block) => block.type === 'chart')).toBe(true);
  });

  it('uses transcript signals to identify a different subject without changing the selected lesson', () => {
    const detection = detectCourse(lesson, [segment('This philosophy argument compares Kant ethics with a thesis about knowledge.')]);
    expect(detection.method).toBe('transcript signals');
    expect(detection.basis).toContain('Philosophy');
    expect(detection.confidence).toBeGreaterThan(0.5);
  });

  it('exports the structured note as readable markdown', () => {
    const markdown = courseNoteMarkdown(buildCourseNote(lesson, [segment('Use ```python\nprint(1)\n```')], () => '2026-01-01T00:00:00.000Z'));
    expect(markdown).toContain('# Attention');
    expect(markdown).toContain('```python');
  });

  it('accepts a strict LM Studio routing response and updates the note path', async () => {
    const note = await detectCourseWithProvider(lesson, [segment('We compare categorical distributions.')], {
      generate: async () => ({ model: 'local-model', content: '{"title":"Probability basics","subject":"Mathematics","chapter":"Distributions","confidence":0.91}' }),
    });
    expect(note?.folderPath).toEqual(['Courses', 'Mathematics', 'Distributions', 'Probability basics']);
    expect(note?.detection.method).toBe('LM Studio');
    expect(note?.fileName).toBe('probability-basics-course-notes.md');
  });
});
