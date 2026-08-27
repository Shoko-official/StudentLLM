import { Artifact, ChatMessage, Lesson, Resource, TranscriptSegment } from '../types';

export const WORKSPACE_STORAGE_KEY = 'studentllm.workspace.v1';

export interface WorkspaceSnapshot {
  activeLessonId: string;
  lessons: Lesson[];
  resources: Resource[];
  transcript: TranscriptSegment[];
  chat: ChatMessage[];
  artifacts: Artifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLesson(value: unknown): value is Lesson {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.subject === 'string'
    && typeof value.chapter === 'string'
    && typeof value.title === 'string'
    && typeof value.teacher === 'string'
    && typeof value.duration === 'string'
    && typeof value.date === 'string'
    && typeof value.progress === 'number';
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.speaker === 'string'
    && typeof value.text === 'string'
    && (value.status === undefined || value.status === 'verified' || value.status === 'review');
}

function isResource(value: unknown): value is Resource {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.meta === 'string'
    && (value.kind === 'audio' || value.kind === 'image' || value.kind === 'document' || value.kind === 'transcript')
    && (value.mimeType === undefined || typeof value.mimeType === 'string')
    && (value.sizeBytes === undefined || typeof value.sizeBytes === 'number')
    && (value.sha256 === undefined || typeof value.sha256 === 'string')
    && (value.lastModified === undefined || typeof value.lastModified === 'number');
}

function isArtifact(value: unknown): value is Artifact {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.kind === 'summary'
      || value.kind === 'guide'
      || value.kind === 'quiz'
      || value.kind === 'flashcards'
      || value.kind === 'mindmap'
      || value.kind === 'glossary')
    && typeof value.label === 'string'
    && typeof value.createdAt === 'string'
    && (value.content === undefined || typeof value.content === 'string')
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every((citation) => typeof citation === 'string')));
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.content === 'string'
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every((citation) => typeof citation === 'string')));
}

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage;
}

export function loadWorkspace(fallback: WorkspaceSnapshot, storage: Storage | undefined = getStorage()): WorkspaceSnapshot {
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return fallback;

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.lessons)) return fallback;

    const lessons = parsed.lessons.filter(isLesson);
    if (!lessons.length) return fallback;

    const activeLessonId = typeof parsed.activeLessonId === 'string' && lessons.some((lesson) => lesson.id === parsed.activeLessonId)
      ? parsed.activeLessonId
      : lessons[0].id;
    const resources = Array.isArray(parsed.resources) ? parsed.resources.filter(isResource) : fallback.resources;
    const transcript = Array.isArray(parsed.transcript) ? parsed.transcript.filter(isTranscriptSegment) : fallback.transcript;
    const chat = Array.isArray(parsed.chat) ? parsed.chat.filter(isChatMessage) : fallback.chat;
    const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isArtifact) : [];

    return { activeLessonId, lessons, resources, transcript, chat, artifacts };
  } catch {
    return fallback;
  }
}

export function saveWorkspace(snapshot: WorkspaceSnapshot, storage: Storage | undefined = getStorage()): boolean {
  if (!storage) return false;

  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 1, ...snapshot }));
    return true;
  } catch {
    return false;
  }
}
