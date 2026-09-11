import { describe, expect, it } from 'vitest';
import type { Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';
import type { QuickStartProposal } from './quick-start';
import { applyRecordingPlacement, canAutoRouteRecording } from './recording-routing';

const recording: Resource = {
  id: 'recording-1',
  name: 'Lecture audio.webm',
  meta: 'Audio · 3 chunks',
  kind: 'audio',
  mimeType: 'audio/webm',
};

const segment: TranscriptSegment = {
  id: 'recording-1:0',
  sourceId: recording.id,
  timestamp: '00:00:03',
  speaker: 'Professor',
  text: 'Gradient descent updates the weights.',
  status: 'review',
};

const sourceLesson: Lesson = {
  id: 'source-lesson', subject: 'Temporary', chapter: 'General notes', title: 'Current session',
  teacher: '', duration: '00:02:00', date: '10/09/2026', progress: 0,
};

const targetLesson: Lesson = {
  id: 'target-lesson', subject: 'Mathematics', chapter: 'Optimization', title: 'Gradient methods',
  teacher: '', duration: '00:00:00', date: '10/09/2026', progress: 0,
};

const workspace = (resources: Resource[], transcript: TranscriptSegment[]): LessonWorkspace => ({
  resources,
  transcript,
  chat: [],
  artifacts: [],
});

const proposal = (overrides: Partial<QuickStartProposal>): QuickStartProposal => ({
  course: 'Mathematics',
  lesson: 'Optimization',
  sublesson: 'Gradient descent',
  subject: 'Mathematics',
  placement: 'existing',
  targetCourseId: targetLesson.id,
  confidence: 0.9,
  rationale: 'The transcript describes gradient updates.',
  ...overrides,
});

describe('recording placement', () => {
  it('does not auto-route a proposal when the model confidence is too low', () => {
    expect(canAutoRouteRecording(proposal({ confidence: 0.64 }))).toBe(false);
    expect(canAutoRouteRecording(proposal({ confidence: 0.65 }))).toBe(true);
  });

  it('moves a recording and its transcript into an existing course without losing unrelated source data', () => {
    const unrelated: Resource = { id: 'unrelated', name: 'slides.pdf', meta: 'PDF', kind: 'document' };
    const result = applyRecordingPlacement({
      sourceLesson,
      lessons: [sourceLesson, targetLesson],
      lessonWorkspaces: {
        [sourceLesson.id]: workspace([recording, unrelated], [segment]),
        [targetLesson.id]: workspace([], []),
      },
      proposal: proposal({ placement: 'existing' }),
      resource: recording,
      segments: [segment],
    });

    expect(result.targetLesson).toEqual(targetLesson);
    expect(result.lessonWorkspaces[sourceLesson.id].resources).toEqual([unrelated]);
    expect(result.lessonWorkspaces[sourceLesson.id].transcript).toEqual([]);
    expect(result.lessonWorkspaces[targetLesson.id].resources).toEqual([recording]);
    expect(result.lessonWorkspaces[targetLesson.id].transcript).toEqual([segment]);
    expect(result.lessonWorkspaces[targetLesson.id].courseNote?.folderPath).toEqual([
      'Courses', 'Mathematics', 'Optimization', 'Gradient methods',
    ]);
  });

  it('creates a structured course and keeps the same recording identifiers when no existing course matches', () => {
    const result = applyRecordingPlacement({
      sourceLesson,
      lessons: [sourceLesson],
      lessonWorkspaces: { [sourceLesson.id]: workspace([recording], [segment]) },
      proposal: proposal({ placement: 'new', targetCourseId: null }),
      resource: recording,
      segments: [segment],
      idFactory: () => 'created-lesson',
    });

    expect(result.targetLesson).toMatchObject({
      id: 'created-lesson',
      subject: 'Mathematics',
      chapter: 'Optimization',
      title: 'Gradient descent',
      sublesson: 'Gradient descent',
    });
    expect(result.lessons.map((lesson) => lesson.id)).toEqual(['created-lesson', sourceLesson.id]);
    expect(result.lessonWorkspaces[sourceLesson.id].resources).toEqual([]);
    expect(result.lessonWorkspaces['created-lesson'].resources).toEqual([recording]);
    expect(result.lessonWorkspaces['created-lesson'].transcript).toEqual([segment]);
  });
});
