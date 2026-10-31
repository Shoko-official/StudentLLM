import { buildCourseNote } from '../lib/course-notes';
import type { WorkspaceSnapshot } from '../lib/workspace-storage';
import type { ChatMessage, Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';

// Synthetic, deterministic course data for size, latency and persistence tests. It contains no real person or lecture.
const WORDS = ('attention gradient matrix vector softmax kernel entropy variance estimator posterior prior likelihood theorem lemma proof '
  + 'integral derivative eigenvalue basis dimension rank orthogonal projection residual regression classifier margin boundary '
  + 'convolution pooling recurrent encoder decoder token embedding layer normalization dropout momentum schedule batch epoch '
  + 'the of and a to in is that for we then so because therefore consider suppose assume define notice recall').split(' ');

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sentence(next: () => number, words: number) {
  const text = Array.from({ length: words }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function clock(seconds: number) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export interface SyntheticWorkspaceOptions {
  /** Number of courses. The last one created is the active one. */
  lessons?: number;
  /** Transcript segments in each course (about 45 words each; 80 segments is roughly 10 minutes of speech). */
  segmentsPerLesson?: number;
  /** Segments in the active course, when it should differ from the others. */
  activeSegments?: number;
  seed?: number;
}

/** A realistic workspace: transcripts, a course note that repeats the transcript, sources and chat history. */
export function createSyntheticWorkspace(options: SyntheticWorkspaceOptions = {}): WorkspaceSnapshot {
  const { lessons: lessonCount = 6, segmentsPerLesson = 400, seed = 7 } = options;
  const activeSegments = options.activeSegments ?? segmentsPerLesson;
  const next = random(seed);
  const lessons: Lesson[] = [];
  const lessonWorkspaces: Record<string, LessonWorkspace> = {};

  for (let index = 0; index < lessonCount; index += 1) {
    const lesson: Lesson = {
      id: `synthetic-lesson-${index}`, subject: `Subject ${index % 3}`, chapter: `Chapter ${Math.floor(index / 3) + 1}`,
      title: `Synthetic lecture ${index + 1}`, teacher: 'Synthetic lecturer', duration: '01:00:00', date: '01 January 2026', progress: 0,
    };
    lessons.push(lesson);
    const isActive = index === lessonCount - 1;
    const count = isActive ? activeSegments : segmentsPerLesson;
    const recordingId = `synthetic-recording-${index}`;
    const transcript: TranscriptSegment[] = Array.from({ length: count }, (_, position) => ({
      id: `${recordingId}:${position}`, sourceId: recordingId, timestamp: clock(position * 9), speaker: 'Lecturer',
      text: `${sentence(next, 22)} ${sentence(next, 22)}`, status: position % 17 === 0 ? 'review' as const : 'verified' as const,
    }));
    const resources: Resource[] = [
      { id: recordingId, name: `${lesson.title} audio.webm`, meta: 'Audio · 3600 chunks', kind: 'audio', mimeType: 'audio/webm', sizeBytes: 48_000_000 },
      { id: `synthetic-slides-${index}`, name: `slides-${index + 1}.pdf`, meta: 'PDF · 42 pages', kind: 'document', mimeType: 'application/pdf', sizeBytes: 6_400_000, sha256: `${index}`.padStart(64, 'a') },
    ];
    const chat: ChatMessage[] = Array.from({ length: 12 }, (_, position) => (position % 2 === 0
      ? { id: `chat-${index}-${position}`, role: 'user' as const, content: sentence(next, 10) }
      : { id: `chat-${index}-${position}`, role: 'assistant' as const, content: `${sentence(next, 40)} ${sentence(next, 40)}`, citations: ['Lecture · 00:10:00'], citationTargets: [recordingId] }));
    lessonWorkspaces[lesson.id] = { resources, transcript, chat, artifacts: [], courseNote: buildCourseNote(lesson, transcript, () => '2026-01-01T00:00:00.000Z') };
  }

  const active = lessons[lessons.length - 1];
  const activeWorkspace = lessonWorkspaces[active?.id ?? ''] ?? { resources: [], transcript: [], chat: [], artifacts: [] };
  return {
    activeLessonId: active?.id ?? '',
    lessons,
    resources: activeWorkspace.resources,
    transcript: activeWorkspace.transcript,
    chat: activeWorkspace.chat,
    artifacts: activeWorkspace.artifacts,
    lessonWorkspaces,
  };
}

/** Grows a synthetic workspace until its compact serialization reaches `bytes`. */
export function createSyntheticWorkspaceOfSize(bytes: number, seed = 7): WorkspaceSnapshot {
  // One segment with its share of the course note is about 1.6 KB in the compact shape; measure instead of guessing.
  let segments = Math.max(50, Math.ceil(bytes / 1700));
  for (;;) {
    const snapshot = createSyntheticWorkspace({ lessons: 4, segmentsPerLesson: Math.floor(segments / 8), activeSegments: segments, seed });
    const size = JSON.stringify({ version: 1, activeLessonId: snapshot.activeLessonId, lessons: snapshot.lessons, lessonWorkspaces: snapshot.lessonWorkspaces }).length;
    if (size >= bytes) return snapshot;
    segments = Math.ceil(segments * Math.max(1.05, bytes / size));
  }
}
