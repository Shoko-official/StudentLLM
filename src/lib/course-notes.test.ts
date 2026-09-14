import { describe, expect, it } from 'vitest';
import { buildCourseNote, courseNoteMarkdown, detectCourse, detectCourseWithProvider, formatCourseNoteWithProvider } from './course-notes';
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

  it('uses source-linked LM Studio annotations to add rich note blocks', async () => {
    const note = await formatCourseNoteWithProvider(lesson, [segment('Force leads to acceleration. F = ma. Force: 8 Mass: 2.')], {
      generate: async (_messages, options) => {
        expect(options?.responseFormat?.type).toBe('json_schema');
        return {
          model: 'openai/gpt-oss-20b',
          content: JSON.stringify({
            blocks: [
              { type: 'formula', sourceId: 'segment-1', latex: 'F = ma', caption: 'Newton\'s second law' },
              { type: 'chart', sourceId: 'segment-1', label: 'Values mentioned in the lecture', values: [{ label: 'Force', value: 8 }, { label: 'Mass', value: 2 }] },
              { type: 'schema', sourceId: 'segment-1', nodes: ['Force', 'Acceleration'], edges: [{ from: 'Force', to: 'Acceleration' }] },
            ],
          }),
        };
      },
    });

    expect(note.detection.method).toBe('LM Studio');
    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'formula', sourceId: 'segment-1', latex: 'F = ma' }),
      expect.objectContaining({ type: 'chart', sourceId: 'segment-1' }),
      expect.objectContaining({ type: 'schema', sourceId: 'segment-1' }),
    ]));
  });

  it('keeps the deterministic note when an AI annotation is not source-linked', async () => {
    const transcript = [segment('A short lecture passage.')];
    const fallback = buildCourseNote(lesson, transcript, () => '2026-01-01T00:00:00.000Z');
    const note = await formatCourseNoteWithProvider(lesson, transcript, {
      generate: async () => ({
        model: 'openai/gpt-oss-20b',
        content: JSON.stringify({ blocks: [{ type: 'formula', sourceId: 'missing-source', latex: 'x = 1' }] }),
      }),
    }, () => '2026-01-01T00:00:00.000Z');

    expect(note.blocks).toEqual(fallback.blocks);
    expect(note.detection).toEqual(fallback.detection);
  });

  it('joins AI blocks to a transcript segment when the paragraph uses its resource id', async () => {
    const transcript = [{ ...segment('The lecture states that force causes acceleration.'), sourceId: 'recording-1' }];
    const note = await formatCourseNoteWithProvider(lesson, transcript, {
      generate: async () => ({
        model: 'openai/gpt-oss-20b',
        content: JSON.stringify({ blocks: [{ type: 'formula', sourceId: transcript[0].id, latex: 'F = ma' }] }),
      }),
    });

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'formula', sourceId: transcript[0].id, latex: 'F = ma' }),
    ]));
  });
});
