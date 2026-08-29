import { invoke } from '@tauri-apps/api/core';
import { Artifact, ChatMessage, Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';

export const WORKSPACE_STORAGE_KEY = 'studentllm.workspace.v1';

export interface WorkspaceSnapshot {
  activeLessonId: string;
  lessons: Lesson[];
  resources: Resource[];
  transcript: TranscriptSegment[];
  chat: ChatMessage[];
  artifacts: Artifact[];
  lessonWorkspaces?: Record<string, LessonWorkspace>;
}

export type WorkspaceStorageOperation = 'load' | 'save';

export interface WorkspaceStorageError {
  operation: WorkspaceStorageOperation;
  message: string;
}

export interface WorkspaceStorageCallbacks {
  onError?: (error: WorkspaceStorageError) => void;
}

type GlobalTauri = {
  core?: {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
};

function describeStorageError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The native workspace storage operation failed.';
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

function parseLessonWorkspace(value: unknown): LessonWorkspace | undefined {
  if (!isRecord(value)) return undefined;
  return {
    resources: Array.isArray(value.resources) ? value.resources.filter(isResource) : [],
    transcript: Array.isArray(value.transcript) ? value.transcript.filter(isTranscriptSegment) : [],
    chat: Array.isArray(value.chat) ? value.chat.filter(isChatMessage) : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter(isArtifact) : [],
  };
}

function parseLessonWorkspaces(value: unknown, lessons: Lesson[]): Record<string, LessonWorkspace> | undefined {
  if (!isRecord(value)) return undefined;
  const workspaces = Object.fromEntries(lessons.flatMap((lesson) => {
    const workspace = parseLessonWorkspace(value[lesson.id]);
    return workspace ? [[lesson.id, workspace]] : [];
  }));
  return Object.keys(workspaces).length ? workspaces : undefined;
}

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function invokeNative<T>(command: string, args?: Record<string, unknown>) {
  const globalTauri = typeof window === 'undefined'
    ? undefined
    : (window as Window & { __TAURI__?: GlobalTauri }).__TAURI__;
  if (globalTauri?.core?.invoke) {
    return args === undefined
      ? globalTauri.core.invoke<T>(command)
      : globalTauri.core.invoke<T>(command, args);
  }
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

function parseWorkspaceRaw(raw: string | null, fallback: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!raw) return fallback;
  try {
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
    const lessonWorkspaces = parseLessonWorkspaces(parsed.lessonWorkspaces, lessons);

    return { activeLessonId, lessons, resources, transcript, chat, artifacts, ...(lessonWorkspaces ? { lessonWorkspaces } : {}) };
  } catch {
    return fallback;
  }
}

export function isNativeRuntime() {
  if (typeof window === 'undefined') return false;
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    __TAURI__?: GlobalTauri;
    isTauri?: boolean;
  }).__TAURI_INTERNALS__;
  const globalTauri = (window as Window & { __TAURI__?: GlobalTauri }).__TAURI__;
  return typeof internals?.invoke === 'function'
    || typeof globalTauri?.core?.invoke === 'function'
    || (window as Window & { isTauri?: boolean }).isTauri === true
    || window.location.protocol === 'tauri:'
    || window.location.protocol === 'file:'
    || window.location.hostname === 'tauri.localhost'
    || (import.meta.env.PROD && window.location.hostname === 'localhost');
}

export function loadWorkspace(fallback: WorkspaceSnapshot, storage: Storage | undefined = getStorage()): WorkspaceSnapshot {
  if (!storage) return fallback;
  return parseWorkspaceRaw(storage.getItem(WORKSPACE_STORAGE_KEY), fallback);
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

export async function loadWorkspaceAsync(
  fallback: WorkspaceSnapshot,
  storage: Storage | undefined = getStorage(),
  callbacks: WorkspaceStorageCallbacks = {},
): Promise<WorkspaceSnapshot> {
  if (!isNativeRuntime()) return loadWorkspace(fallback, storage);

  try {
    const raw = await invokeNative<string | null>('load_workspace');
    const snapshot = parseWorkspaceRaw(raw, fallback);
    if (raw === null || snapshot === fallback) {
      try {
        await invokeNative('save_workspace', { snapshot: JSON.stringify({ version: 1, ...snapshot }) });
      } catch (error) {
        callbacks.onError?.({ operation: 'save', message: describeStorageError(error) });
      }
    }
    return snapshot;
  } catch (error) {
    callbacks.onError?.({ operation: 'load', message: describeStorageError(error) });
    return loadWorkspace(fallback, storage);
  }
}

export async function saveWorkspaceAsync(
  snapshot: WorkspaceSnapshot,
  storage: Storage | undefined = getStorage(),
  callbacks: WorkspaceStorageCallbacks = {},
): Promise<boolean> {
  if (!isNativeRuntime()) return saveWorkspace(snapshot, storage);

  try {
    await invokeNative('save_workspace', { snapshot: JSON.stringify({ version: 1, ...snapshot }) });
    return true;
  } catch (error) {
    callbacks.onError?.({ operation: 'save', message: describeStorageError(error) });
    return saveWorkspace(snapshot, storage);
  }
}

export function runPackagedIpcSmoke() {
  return invokeNative<string>('smoke_frontend_ipc');
}
