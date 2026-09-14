import { describe, expect, it } from 'vitest';
import { buildCourseNote, buildDocumentCourseNote, courseNoteMarkdown, detectCourse, detectCourseWithProvider, formatCourseNoteWithProvider } from './course-notes';
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
    const markdown = courseNoteMarkdown(buildCourseNote(lesson, [segment('Use ```python\nprint(1)\n```')]));
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
              { type: 'formula', sourceId: 'segment-1', latex: 'F = ma', caption: "Newton's second law" },
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

  it('builds a readable layout-aware note from extracted PDF blocks', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: `Formulaire de Math\u00e9matiques
BAC+2 Informatique
1
D\u00e9riv\u00e9es partielles
D\u00e9\u001cnition
Pour f(x), on d\u00e9rive.`,
      blocks: [
        { x: 0, y: 5, width: 100, height: 10, text: `Formulaire de Math\u00e9matiques
BAC+2 Informatique` },
        { x: 0, y: 190, width: 100, height: 10, text: `1
D\u00e9riv\u00e9es partielles` },
        { x: 0, y: 220, width: 100, height: 20, text: `D\u00e9\u001cnition
Pour f(x), on d\u00e9rive.` },
      ],
    }], 'Formulaire_Maths_BAC2.pdf', () => '2026-09-14T00:00:00.000Z');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'heading', text: '1 D\u00e9riv\u00e9es partielles' }),
      expect.objectContaining({ type: 'heading', text: 'D\u00e9finition' }),
      expect.objectContaining({ type: 'paragraph', text: 'Pour f(x), on d\u00e9rive.' }),
    ]));
    expect(JSON.stringify(note)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('does not promote incomplete PDF equation fragments to LaTeX', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: 'Divergence\n∂x + ∂Fy',
      blocks: [
        { x: 99, y: 486, width: 153, height: 16, text: 'Divergence' },
        { x: 240, y: 486, width: 42, height: 21, text: '∂x + ∂Fy' },
      ],
    }], 'Formulaire_Maths_BAC2.pdf');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'paragraph', text: '∂x + ∂Fy' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'formula')).toBe(false);
  });

  it('keeps numbered table fragments as text instead of document headings', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: '2 (impaire ↗)\n1 √\n1 + x2',
      blocks: [{ x: 300, y: 74, width: 100, height: 40, text: '2 (impaire ↗)\n1 √\n1 + x2' }],
    }], 'Formulaire_Maths_BAC2.pdf');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'paragraph', text: '2 (impaire ↗) 1 √ 1 + x2' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'heading' && block.id.startsWith('document-heading') && /^(?:2 \(|1 √|1 \+)/.test(block.text))).toBe(false);
  });

  it('keeps lower-case mathematical expressions out of numbered headings', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: '2 x < 0\n1 ln x dx',
      blocks: [{ x: 300, y: 218, width: 100, height: 40, text: '2 x < 0\n1 ln x dx' }],
    }], 'Formulaire_Maths_BAC2.pdf');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'paragraph', text: '2 x < 0 1 ln x dx' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'heading' && block.id.startsWith('document-heading'))).toBe(false);
  });

  it('keeps prose that starts with a section keyword in the paragraph flow', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: 'mémo. Objectif : réviser vite et savoir quand appliquer chaque outil.',
      blocks: [{ x: 49, y: 160, width: 480, height: 16, text: 'mémo. Objectif : réviser vite et savoir quand appliquer chaque outil.' }],
    }], 'Formulaire_Maths_BAC2.pdf');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'paragraph', text: 'mémo. Objectif : réviser vite et savoir quand appliquer chaque outil.' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'heading' && block.id.startsWith('document-heading'))).toBe(false);
  });

  it('trims incomplete mathematical suffixes from extracted section headings', () => {
    const note = buildDocumentCourseNote(lesson, [{
      pageNumber: 1,
      text: '1.2 Les 4 opérateurs (avec −→\n∇ = ∂/∂x',
      blocks: [
        { x: 48, y: 244, width: 230, height: 16, text: '1.2 Les 4 opérateurs (avec −→' },
        { x: 48, y: 266, width: 230, height: 16, text: '∇ = ∂/∂x' },
      ],
    }], 'Formulaire_Maths_BAC2.pdf');

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'heading', text: '1.2 Les 4 opérateurs' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'heading' && block.text.includes('(avec'))).toBe(false);
  });

  it('keeps indexed PDF pages as source text instead of inferring rich blocks', () => {
    const note = buildCourseNote(lesson, [{
      id: 'pdf-page-1',
      sourceId: 'document-1',
      timestamp: 'Page 1',
      speaker: 'Formulaire_Maths_BAC2.pdf',
      text: 'Divergence div F = ∇ F = ∂Fx ∂x + ∂Fy ∂y. x3 y4.',
      status: 'review',
    }]);

    expect(note.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'paragraph', text: 'Divergence div F = ∇ F = ∂Fx ∂x + ∂Fy ∂y. x3 y4.' }),
    ]));
    expect(note.blocks.some((block) => block.type === 'formula' || block.type === 'chart' || block.type === 'schema')).toBe(false);
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
