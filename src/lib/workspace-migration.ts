import type { ChatMessage, CourseNote, Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';
import { buildCourseNote } from './course-notes';
import type { WorkspaceSnapshot } from './workspace-storage';

// Historical fingerprints only. Keep these independent of the application's empty defaults.
const legacyLessons: Lesson[] = [
  {
    id: 'transformers-06', subject: 'Machine Learning', chapter: 'Transformers',
    title: 'Attention & Scaled Dot-Product', teacher: 'Prof. Yann LeCun',
    duration: '01:32:47', date: '15 May 2025', progress: 72,
  },
  {
    id: 'transformers-05', subject: 'Machine Learning', chapter: 'Transformers',
    title: 'Self-attention and Context', teacher: 'Prof. Yann LeCun',
    duration: '01:18:12', date: '08 May 2025', progress: 100,
  },
  {
    id: 'linear-algebra-03', subject: 'Mathematics', chapter: 'Linear Algebra',
    title: 'Matrices and Linear Maps', teacher: 'Dr. Camille Roux',
    duration: '00:54:08', date: '02 May 2025', progress: 36,
  },
];

const legacyResources: Resource[] = [
  { id: 'r1', name: 'transcript.txt', meta: 'Text · 126 KB', kind: 'transcript' },
  { id: 'r2', name: 'lecture_audio.mp3', meta: 'HD audio · 98.3 MB', kind: 'audio' },
  { id: 'r3', name: 'board_photo_02.jpg', meta: 'Board · 3.4 MB', kind: 'image' },
  { id: 'r4', name: 'lecture_slides.pdf', meta: 'Slides · 5.6 MB', kind: 'document' },
  { id: 'r5', name: 'handwritten_notes.pdf', meta: 'Notes · 1.8 MB', kind: 'document' },
];

const legacyTranscript: TranscriptSegment[] = [
  {
    id: 't1', timestamp: '01:13:42', speaker: 'Professor',
    text: 'We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.',
    status: 'verified',
  },
  {
    id: 't2', timestamp: '01:14:18', speaker: 'Professor',
    text: 'The square-root factor keeps the logits in a range where softmax remains sensitive.',
    status: 'verified',
  },
  {
    id: 't3', timestamp: '01:15:02', speaker: 'Professor',
    text: 'Without this normalization, dot products grow with the key dimension.',
    status: 'review',
  },
];

const legacyChat: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'Why do we divide by √dₖ in scaled dot-product attention?' },
  {
    id: 'm2', role: 'assistant',
    content: 'We divide by √dₖ to keep variance stable as the key dimension grows. Without this factor, logits become too large, softmax saturates, and gradients become very small.',
    citations: ['Course audio · 01:14:18', 'Slides · page 31'],
    citationTargets: ['r2', 'r4'],
  },
];

// Compare every field, including added metadata, without depending on JSON key order.
function matchesExactly(value: unknown, legacy: unknown): boolean {
  if (value === legacy) return true;
  if (Array.isArray(value) || Array.isArray(legacy)) {
    return Array.isArray(value) && Array.isArray(legacy)
      && value.length === legacy.length
      && value.every((item, index) => matchesExactly(item, legacy[index]));
  }
  if (!value || !legacy || typeof value !== 'object' || typeof legacy !== 'object') return false;
  const actual = value as Record<string, unknown>;
  const expected = legacy as Record<string, unknown>;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length
    && keys.every((key) => Object.hasOwn(expected, key) && matchesExactly(actual[key], expected[key]));
}

function removeBundled<T>(records: T[], bundled: T[]): T[] {
  const remaining = records.filter((record) => !bundled.some((item) => matchesExactly(record, item)));
  return remaining.length === records.length ? records : remaining;
}

function generatedNote(lesson: Lesson, transcript: TranscriptSegment[], updatedAt: string): CourseNote {
  // Persisted notes omit undefined sourceIds. Match the same serialized shape.
  return JSON.parse(JSON.stringify(buildCourseNote(lesson, transcript, () => updatedAt))) as CourseNote;
}

function noteMatchesTranscript(note: CourseNote, lesson: Lesson, transcript: TranscriptSegment[]): boolean {
  return matchesExactly(note, generatedNote(lesson, transcript, note.updatedAt));
}

function isGeneratedNote(note: CourseNote, lesson: Lesson, transcript: TranscriptSegment[]): boolean {
  if ([transcript, legacyTranscript, []].some((segments) => noteMatchesTranscript(note, lesson, segments))) return true;

  // An earlier cleanup may have removed demo transcript rows but left their
  // generated note behind. Reconstruct only from known, exactly matching source
  // paragraphs, then verify the entire note (including detection and rich blocks).
  const candidates = new Map<string, TranscriptSegment[]>();
  for (const segment of [...transcript, ...legacyTranscript]) {
    const key = `paragraph-${segment.id}`;
    const sameId = candidates.get(key) ?? [];
    sameId.push(segment);
    candidates.set(key, sameId);
  }
  const originalTranscript = note.blocks.flatMap((block) => {
    const segment = candidates.get(block.id)?.find((candidate) =>
      matchesExactly(block, generatedNote(lesson, [candidate], note.updatedAt).blocks[2]));
    return segment ? [segment] : [];
  });
  return noteMatchesTranscript(note, lesson, originalTranscript);
}

function cleanWorkspace(workspace: LessonWorkspace, lesson: Lesson): LessonWorkspace {
  const resources = removeBundled(workspace.resources, legacyResources);
  const transcript = removeBundled(workspace.transcript, legacyTranscript);
  const chat = removeBundled(workspace.chat, legacyChat);
  const courseNote = workspace.courseNote && isGeneratedNote(workspace.courseNote, lesson, workspace.transcript)
    && !noteMatchesTranscript(workspace.courseNote, lesson, transcript)
    ? generatedNote(lesson, transcript, workspace.courseNote.updatedAt) : workspace.courseNote;
  return resources === workspace.resources && transcript === workspace.transcript && chat === workspace.chat && courseNote === workspace.courseNote
    ? workspace
    : { ...workspace, resources, transcript, chat, ...(courseNote ? { courseNote } : {}) };
}

function hasContent(workspace: LessonWorkspace | undefined, lesson: Lesson): boolean {
  return !!workspace && (workspace.resources.length > 0 || workspace.transcript.length > 0
    || workspace.chat.length > 0 || workspace.artifacts.length > 0
    || (!!workspace.courseNote && !noteMatchesTranscript(workspace.courseNote, lesson, workspace.transcript))
    || Object.keys(workspace).some((key) => !['resources', 'transcript', 'chat', 'artifacts', 'courseNote'].includes(key)));
}

function mergeRecords<T>(primary: T[], other: T[]): T[] {
  return [...primary, ...other.filter((record) => !primary.some((item) => matchesExactly(record, item)))];
}

/** Pure cleanup; callers must back up the original raw snapshot before using this result. */
export function migrateLegacyDemoWorkspace(snapshot: WorkspaceSnapshot, pendingLessonIds: ReadonlySet<string> = new Set()): WorkspaceSnapshot {
  let activeWorkspace: LessonWorkspace = {
    resources: snapshot.resources, transcript: snapshot.transcript,
    chat: snapshot.chat, artifacts: snapshot.artifacts,
  };
  const lessonWorkspaces = snapshot.lessonWorkspaces ? { ...snapshot.lessonWorkspaces } : undefined;
  let changed = false;
  const lessons = snapshot.lessons.filter((lesson) => {
    // A reused ID or edited lesson is not sufficient evidence of bundled content.
    if (!legacyLessons.some((legacy) => matchesExactly(lesson, legacy))) return true;

    if (lesson.id === snapshot.activeLessonId) {
      const cleaned = cleanWorkspace(activeWorkspace, lesson);
      changed ||= cleaned !== activeWorkspace;
      activeWorkspace = cleaned;
    }
    const workspace = lessonWorkspaces?.[lesson.id];
    const cleaned = workspace ? cleanWorkspace(workspace, lesson) : undefined;
    if (lessonWorkspaces && cleaned) {
      changed ||= cleaned !== workspace;
      lessonWorkspaces[lesson.id] = cleaned;
    }
    if (pendingLessonIds.has(lesson.id) || hasContent(cleaned, lesson)
      || (lesson.id === snapshot.activeLessonId && hasContent(activeWorkspace, lesson))) return true;

    if (lessonWorkspaces) delete lessonWorkspaces[lesson.id];
    changed = true;
    return false;
  });

  if (!changed) return snapshot;

  const activeLessonId = lessons.some((lesson) => lesson.id === snapshot.activeLessonId)
    ? snapshot.activeLessonId : lessons[0]?.id ?? '';
  if (activeLessonId !== snapshot.activeLessonId) {
    activeWorkspace = lessonWorkspaces?.[activeLessonId] ?? { resources: [], transcript: [], chat: [], artifacts: [] };
  } else if (lessonWorkspaces) {
    // App prefers the per-lesson copy. Preserve custom records from either copy,
    // including records with the same ID but different contents.
    const workspace = lessonWorkspaces[activeLessonId];
    activeWorkspace = workspace ? {
      ...workspace,
      resources: mergeRecords(workspace.resources, activeWorkspace.resources),
      transcript: mergeRecords(workspace.transcript, activeWorkspace.transcript),
      chat: mergeRecords(workspace.chat, activeWorkspace.chat),
      artifacts: mergeRecords(workspace.artifacts, activeWorkspace.artifacts),
    } : activeWorkspace;
    const lesson = lessons.find((item) => item.id === activeLessonId)!;
    if (workspace?.courseNote && noteMatchesTranscript(workspace.courseNote, lesson, workspace.transcript)
      && !noteMatchesTranscript(workspace.courseNote, lesson, activeWorkspace.transcript)) {
      activeWorkspace.courseNote = generatedNote(lesson, activeWorkspace.transcript, workspace.courseNote.updatedAt);
    }
    lessonWorkspaces[activeLessonId] = activeWorkspace;
  }

  return {
    ...snapshot, activeLessonId, lessons,
    resources: activeWorkspace.resources, transcript: activeWorkspace.transcript,
    chat: activeWorkspace.chat, artifacts: activeWorkspace.artifacts,
    ...(lessonWorkspaces ? { lessonWorkspaces } : {}),
  };
}
