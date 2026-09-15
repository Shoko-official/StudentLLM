import { describe, expect, it } from 'vitest';
import { loadWorkspace } from './workspace-storage';

describe('workspace visual persistence', () => {
  it('keeps validated course-note visuals after reload', () => {
    const fallback = { activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [] };
    const snapshot = {
      version: 1,
      activeLessonId: 'lesson-1',
      lessons: [{ id: 'lesson-1', subject: 'Math', chapter: 'Vectors', title: 'Gradient', teacher: '', duration: '00:00:00', date: '2026-09-15', progress: 0 }],
      resources: [{ id: 'source-1', name: 'notes.pdf', meta: 'Document', kind: 'document' }],
      transcript: [],
      chat: [],
      artifacts: [],
      lessonWorkspaces: {
        'lesson-1': {
          resources: [{ id: 'source-1', name: 'notes.pdf', meta: 'Document', kind: 'document' }],
          transcript: [],
          chat: [],
          artifacts: [],
          courseNote: {
            id: 'note-1', title: 'Gradient', subject: 'Math', chapter: 'Vectors', folderPath: ['Math', 'Vectors'], fileName: 'gradient.md', updatedAt: '2026-09-15',
            detection: { method: 'active course', confidence: 1, basis: 'selected course' },
            blocks: [{ id: 'visual-1', type: 'visual', sourceId: 'source-1', visual: { type: 'chart', chartType: 'bar', sourceId: 'source-1', sourcePage: 1, values: [{ label: 'x', value: 2 }, { label: 'y', value: 3 }] } }],
          },
        },
      },
    };
    localStorage.setItem('studentllm.workspace.v1', JSON.stringify(snapshot));

    const loaded = loadWorkspace(fallback);

    expect(loaded.lessonWorkspaces?.['lesson-1']?.courseNote?.blocks[0]).toMatchObject({ type: 'visual' });
  });
});
