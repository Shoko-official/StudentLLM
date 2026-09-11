import type { QuickStartProposal } from './quick-start';
import { buildCourseNote } from './course-notes';
import type { Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';

const emptyWorkspace = (): LessonWorkspace => ({ resources: [], transcript: [], chat: [], artifacts: [] });

export const AUTO_ROUTE_MIN_CONFIDENCE = 0.65;

export interface RecordingPlacementInput {
  sourceLesson: Lesson;
  lessons: Lesson[];
  lessonWorkspaces: Record<string, LessonWorkspace>;
  proposal: QuickStartProposal;
  resource: Resource;
  segments: TranscriptSegment[];
  duration?: string;
  idFactory?: () => string;
  dateFactory?: () => string;
}

export interface RecordingPlacementResult {
  lessons: Lesson[];
  lessonWorkspaces: Record<string, LessonWorkspace>;
  targetLesson: Lesson;
}

export function canAutoRouteRecording(proposal: QuickStartProposal) {
  return proposal.confidence >= AUTO_ROUTE_MIN_CONFIDENCE
    && (proposal.placement === 'new' || Boolean(proposal.targetCourseId));
}

function uniqueResources(resources: Resource[]) {
  return resources.filter((resource, index, all) => all.findIndex((candidate) => candidate.id === resource.id) === index);
}

function uniqueSegments(segments: TranscriptSegment[]) {
  return segments.filter((segment, index, all) => all.findIndex((candidate) => candidate.id === segment.id) === index);
}

function noteForRoute(lesson: Lesson, transcript: TranscriptSegment[], proposal: QuickStartProposal) {
  const note = buildCourseNote(lesson, transcript);
  return {
    ...note,
    title: lesson.title,
    subject: lesson.subject,
    chapter: lesson.chapter,
    folderPath: ['Courses', lesson.subject, lesson.chapter, lesson.title],
    fileName: `${lesson.title.toLocaleLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'course'}-course-notes.md`,
    detection: {
      method: 'LM Studio' as const,
      confidence: proposal.confidence,
      basis: `LM Studio routed this recording: ${proposal.rationale}`,
    },
    blocks: note.blocks.map((block) => block.id === 'note-title' && block.type === 'heading'
      ? { ...block, text: lesson.title }
      : block),
  };
}

export function applyRecordingPlacement(input: RecordingPlacementInput): RecordingPlacementResult {
  const {
    sourceLesson,
    lessons,
    lessonWorkspaces,
    proposal,
    resource,
    segments,
    duration = sourceLesson.duration,
    idFactory = () => `lesson-${crypto.randomUUID()}`,
    dateFactory = () => new Date().toLocaleDateString('en-GB'),
  } = input;
  const existingTarget = proposal.placement === 'existing'
    ? lessons.find((lesson) => lesson.id === proposal.targetCourseId)
    : undefined;
  const targetLesson = existingTarget ?? {
    id: idFactory(),
    subject: proposal.subject.trim() || proposal.course.trim() || 'General',
    chapter: proposal.lesson.trim() || 'General notes',
    title: proposal.title.trim() || proposal.sublesson.trim() || proposal.lesson.trim() || proposal.course.trim() || 'Course notes',
    ...(proposal.sublesson.trim() ? { sublesson: proposal.sublesson.trim() } : {}),
    teacher: '',
    duration,
    date: dateFactory(),
    progress: 0,
  } satisfies Lesson;

  const targetWorkspaceId = targetLesson.id;
  const sourceWorkspace = lessonWorkspaces[sourceLesson.id] ?? emptyWorkspace();
  const targetWorkspace = lessonWorkspaces[targetWorkspaceId] ?? emptyWorkspace();
  const incomingIds = new Set(segments.map((segment) => segment.id));
  const sourceIsTarget = sourceLesson.id === targetWorkspaceId;
  const nextSourceWorkspace = sourceIsTarget
    ? sourceWorkspace
    : {
        ...sourceWorkspace,
        resources: sourceWorkspace.resources.filter((candidate) => candidate.id !== resource.id),
        transcript: sourceWorkspace.transcript.filter((segment) => segment.sourceId !== resource.id && !incomingIds.has(segment.id)),
      };
  const nextTargetResources = uniqueResources([
    ...targetWorkspace.resources,
    resource,
  ]);
  const nextTargetTranscript = uniqueSegments([
    ...targetWorkspace.transcript,
    ...segments,
  ]);
  const nextTargetWorkspace: LessonWorkspace = {
    ...targetWorkspace,
    resources: nextTargetResources,
    transcript: nextTargetTranscript,
    courseNote: noteForRoute(targetLesson, nextTargetTranscript, proposal),
  };
  const nextWorkspaces = {
    ...lessonWorkspaces,
    [sourceLesson.id]: sourceIsTarget ? nextTargetWorkspace : nextSourceWorkspace,
    [targetWorkspaceId]: nextTargetWorkspace,
  };

  return {
    lessons: existingTarget ? lessons : [targetLesson, ...lessons],
    lessonWorkspaces: nextWorkspaces,
    targetLesson,
  };
}
