import type { WorkspaceSnapshot } from '../lib/workspace-storage';
import type { LessonWorkspace } from '../types';

export const FIXTURE_LESSON_ID = 'fixture-attention';

// Explicit test data, independent of both empty defaults and legacy demo migration.
// Return fresh arrays so each test can freely edit its own workspace.
export function createFixtureWorkspace(): WorkspaceSnapshot & { version: 1 } {
  const active: LessonWorkspace = {
    resources: [
      { id: 'fixture-transcript', name: 'transcript.txt', meta: 'Text notes', kind: 'transcript' },
    ],
    transcript: [
      {
        id: 'fixture-segment-1', timestamp: '01:13:42', speaker: 'Professor',
        text: 'We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.',
        status: 'verified',
      },
      {
        id: 'fixture-segment-2', timestamp: '01:14:18', speaker: 'Professor',
        text: 'The square-root factor keeps the logits in a range where softmax remains sensitive.',
        status: 'verified',
      },
      {
        id: 'fixture-segment-3', timestamp: '01:15:02', speaker: 'Professor',
        text: 'Without this normalization, dot products grow with the key dimension.',
        status: 'review',
      },
    ],
    chat: [],
    artifacts: [],
  };

  return {
    version: 1,
    activeLessonId: FIXTURE_LESSON_ID,
    lessons: [
      {
        id: FIXTURE_LESSON_ID, subject: 'Machine Learning', chapter: 'Transformers',
        title: 'Attention & Scaled Dot-Product', teacher: 'Fixture lecturer',
        duration: '01:32:47', date: '10 September 2026', progress: 72,
      },
      {
        id: 'fixture-context', subject: 'Machine Learning', chapter: 'Transformers',
        title: 'Self-attention and Context', teacher: 'Fixture lecturer',
        duration: '01:18:12', date: '09 September 2026', progress: 100,
      },
      {
        id: 'fixture-linear-algebra', subject: 'Mathematics', chapter: 'Linear Algebra',
        title: 'Matrices and Linear Maps', teacher: 'Dr. Camille Roux',
        duration: '00:54:08', date: '08 September 2026', progress: 36,
      },
    ],
    ...active,
    lessonWorkspaces: {
      [FIXTURE_LESSON_ID]: active,
      'fixture-context': { resources: [], transcript: [], chat: [], artifacts: [] },
      'fixture-linear-algebra': {
        resources: [], chat: [], artifacts: [],
        transcript: [{
          id: 'fixture-linear-segment', timestamp: '00:01:00', speaker: 'Dr. Camille Roux',
          text: 'A linear map preserves addition and scalar multiplication.', status: 'verified',
        }],
      },
    },
  };
}
