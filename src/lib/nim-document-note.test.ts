import { expect, it } from 'vitest';
import { buildDocumentCourseNote } from './course-notes';
import type { Lesson } from '../types';

it('keeps vision transcription Markdown and page provenance without flattening formulas or tables', () => {
  const lesson: Lesson = { id: 'fixture', subject: 'Math', chapter: 'Review', title: 'Synthetic notes', teacher: '', duration: '', date: '', progress: 0 };
  const text = '# Source\n\n$$x^2 + 1$$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSources → Notes';
  const note = buildDocumentCourseNote(lesson, [{ pageNumber: 3, text, blocks: [{ x: 0, y: 0, width: 0, height: 0, kind: 'markdown', text }] }], 'fixture.pdf');
  expect(note.blocks).toContainEqual(expect.objectContaining({ type: 'markdown', markdown: text, sourceName: 'fixture.pdf', sourceId: 'fixture.pdf:page-3' }));
});
