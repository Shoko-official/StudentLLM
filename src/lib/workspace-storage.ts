import { invoke } from '@tauri-apps/api/core';
import { Artifact, ChatMessage, CourseNote, CourseNoteBlock, Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';
import { migrateLegacyDemoWorkspace } from './workspace-migration';
import { RECORDING_RECOVERY_STORAGE_KEY } from './recording-recovery';
import { isValidVisualBlock } from './visual-blocks';

export const WORKSPACE_STORAGE_KEY = 'studentllm.workspace.v1';
export const WORKSPACE_MIGRATION_BACKUP_KEY = 'studentllm.workspace.v1.legacy-demo-backup';
export const WORKSPACE_UNREADABLE_BACKUP_KEY = 'studentllm.workspace.v1.unreadable-backup';
export const MAX_WORKSPACE_SNAPSHOT_BYTES = 16 * 1024 * 1024;

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
  /** The stored workspace could not be read and was replaced by an empty one. */
  onUnreadable?: (issue: WorkspaceLoadIssue) => void;
}

type GlobalTauri = {
  core?: {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
};

let nativeSaveQueue: Promise<void> = Promise.resolve();

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
    && (value.sublesson === undefined || typeof value.sublesson === 'string')
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
    && (value.start === undefined || (typeof value.start === 'number' && Number.isFinite(value.start) && value.start >= 0))
    && (value.end === undefined || (typeof value.end === 'number' && Number.isFinite(value.end) && value.end >= (typeof value.start === 'number' ? value.start : 0)))
    && (value.words === undefined || (Array.isArray(value.words) && value.words.every(word => isRecord(word) && typeof word.word === 'string'
      && typeof word.start === 'number' && Number.isFinite(word.start) && word.start >= 0
      && typeof word.end === 'number' && Number.isFinite(word.end) && word.end >= word.start)))
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

function isArtifact(value: unknown, sourceIds = new Set<string>()): value is Artifact {
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
    && (value.visuals === undefined || (Array.isArray(value.visuals) && value.visuals.length <= 32 && value.visuals.every((visual) => isValidVisualBlock(visual, sourceIds))))
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every((citation) => typeof citation === 'string')))
    && (value.citationTargets === undefined || (Array.isArray(value.citationTargets) && value.citationTargets.every((target) => typeof target === 'string')));
}

function isCourseNoteBlock(value: unknown, sourceIds = new Set<string>()): value is CourseNoteBlock {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return false;
  if (value.type === 'heading') return (value.level === 1 || value.level === 2) && typeof value.text === 'string';
  if (value.type === 'markdown') return typeof value.markdown === 'string'
    && (value.transcriptIds === undefined || (Array.isArray(value.transcriptIds) && value.transcriptIds.every(id => typeof id === 'string')))
    && (value.sourceName === undefined || typeof value.sourceName === 'string')
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
  if (value.type === 'paragraph') return typeof value.text === 'string'
    && (value.timestamp === undefined || typeof value.timestamp === 'string')
    && (value.speaker === undefined || typeof value.speaker === 'string')
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
  if (value.type === 'formula') return typeof value.latex === 'string'
    && (value.caption === undefined || typeof value.caption === 'string')
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
  if (value.type === 'formula-image') return typeof value.alt === 'string' && typeof value.sourceName === 'string'
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(String(value.imageData))
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
  if (value.type === 'code') return typeof value.language === 'string' && typeof value.code === 'string'
    && (value.sourceId === undefined || typeof value.sourceId === 'string');
  if (value.type === 'chart') return typeof value.label === 'string' && Array.isArray(value.values)
    && value.values.every((item) => isRecord(item) && typeof item.label === 'string' && typeof item.value === 'number' && Number.isFinite(item.value));
  if (value.type === 'schema') return Array.isArray(value.nodes) && value.nodes.every((node) => typeof node === 'string')
    && Array.isArray(value.edges) && value.edges.every((edge) => isRecord(edge) && typeof edge.from === 'string' && typeof edge.to === 'string');
  if (value.type === 'visual') return isValidVisualBlock(value.visual, sourceIds)
    && (value.sourceId === undefined || value.sourceId === value.visual.sourceId);
  return false;
}

function isCourseNote(value: unknown, sourceIds = new Set<string>()): value is CourseNote {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.subject === 'string'
    && typeof value.chapter === 'string'
    && Array.isArray(value.folderPath) && value.folderPath.every((item) => typeof item === 'string')
    && typeof value.fileName === 'string'
    && typeof value.updatedAt === 'string'
    && (value.sublesson === undefined || typeof value.sublesson === 'string')
    && isRecord(value.detection)
    && (value.detection.method === 'active course' || value.detection.method === 'transcript signals' || value.detection.method === 'LM Studio')
    && typeof value.detection.confidence === 'number'
    && typeof value.detection.basis === 'string'
    && Array.isArray(value.blocks) && value.blocks.length <= 10_000 && value.blocks.every((block) => isCourseNoteBlock(block, sourceIds));
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.content === 'string'
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every((citation) => typeof citation === 'string')))
    && (value.citationTargets === undefined || (Array.isArray(value.citationTargets) && value.citationTargets.every((target) => typeof target === 'string')));
}

// Entries that failed validation while a snapshot was parsed. A snapshot that loses entries is not "fine": the next
// save would erase them for good, so the caller treats it like an unreadable one (copy aside, tell the student).
let droppedEntries = 0;

function keep<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value)) return [];
  const kept = value.filter(guard);
  droppedEntries += value.length - kept.length;
  return kept;
}

function parseLessonWorkspace(value: unknown): LessonWorkspace | undefined {
  if (!isRecord(value)) {
    if (value !== undefined) droppedEntries += 1;
    return undefined;
  }
  const { courseNote, ...fields } = value;
  const resources = keep(value.resources, isResource);
  const sourceIds = new Set(resources.map((resource) => resource.id));
  return {
    ...fields,
    resources,
    transcript: keep(value.transcript, isTranscriptSegment),
    chat: keep(value.chat, isChatMessage),
    artifacts: keep(value.artifacts, (artifact): artifact is Artifact => isArtifact(artifact, sourceIds)),
    ...(isCourseNote(courseNote, sourceIds) ? { courseNote } : {}),
  };
}

function parseLessonWorkspaces(value: unknown, lessons: Lesson[]): Record<string, LessonWorkspace> | undefined {
  if (!isRecord(value)) return undefined;
  const workspaces = Object.fromEntries(lessons.flatMap((lesson) => {
    const workspace = parseLessonWorkspace(value[lesson.id]);
    return workspace ? [[lesson.id, workspace]] : [];
  }));
  return Object.keys(workspaces).length || !lessons.length ? workspaces : undefined;
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

/** The empty snapshot the native shell seeds its database with; it is not user data and not damage. */
function isBootstrapSnapshot(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.bootstrap === true && !Array.isArray(parsed.lessons);
  } catch {
    return false;
  }
}

function parseWorkspaceDetailed(raw: string | null, fallback: WorkspaceSnapshot): { snapshot: WorkspaceSnapshot; dropped: number } {
  droppedEntries = 0;
  const snapshot = parseWorkspaceUncounted(raw, fallback);
  return { snapshot, dropped: snapshot === fallback ? 0 : droppedEntries };
}

function parseWorkspaceUncounted(raw: string | null, fallback: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!raw || raw.length > MAX_WORKSPACE_SNAPSHOT_BYTES) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.lessons)) return fallback;

    const lessons = keep(parsed.lessons, isLesson);
    if (parsed.lessons.length && !lessons.length) return fallback;

    const activeLessonId = typeof parsed.activeLessonId === 'string' && lessons.some((lesson) => lesson.id === parsed.activeLessonId)
      ? parsed.activeLessonId
      : lessons[0]?.id ?? '';
    const hasTopLevelLists = [parsed.resources, parsed.transcript, parsed.chat, parsed.artifacts].some(Array.isArray);
    const lessonWorkspaces = parseLessonWorkspaces(parsed.lessonWorkspaces, lessons);
    const activeCopy = lessonWorkspaces?.[activeLessonId];
    if (!hasTopLevelLists && activeCopy) {
      // Compact shape (see serializeWorkspaceSnapshot): the active course lives only in `lessonWorkspaces`. The in-memory
      // snapshot still exposes it as the top-level lists, exactly as the older shape did.
      return {
        activeLessonId, lessons, resources: activeCopy.resources, transcript: activeCopy.transcript, chat: activeCopy.chat, artifacts: activeCopy.artifacts,
        lessonWorkspaces,
      };
    }
    const resources = keep(parsed.resources, isResource);
    const transcript = keep(parsed.transcript, isTranscriptSegment);
    const chat = keep(parsed.chat, isChatMessage);
    const sourceIds = new Set(resources.map((resource) => resource.id));
    const artifacts = keep(parsed.artifacts, (artifact): artifact is Artifact => isArtifact(artifact, sourceIds));

    return { activeLessonId, lessons, resources, transcript, chat, artifacts, ...(lessonWorkspaces ? { lessonWorkspaces } : {}) };
  } catch {
    return fallback;
  }
}

function backUpBeforeMigration(raw: string, storage: Storage | undefined): boolean {
  if (!storage) return false;
  try {
    // Browser and native snapshots can differ. Keep every distinct original;
    // repeated loads reuse an identical backup without replacing earlier ones.
    for (let index = 0; index <= storage.length; index += 1) {
      const key = index === 0 ? WORKSPACE_MIGRATION_BACKUP_KEY : `${WORKSPACE_MIGRATION_BACKUP_KEY}.${index}`;
      const existing = storage.getItem(key);
      if (existing === raw) return true;
      if (existing === null) {
        storage.setItem(key, raw);
        return storage.getItem(key) === raw;
      }
    }
  } catch {
    // Return the unmodified workspace when storage is blocked or full.
  }
  return false;
}

function migrateWithBackup(raw: string | null, snapshot: WorkspaceSnapshot, storage: Storage | undefined): WorkspaceSnapshot {
  if (!raw || !storage) return snapshot;
  let pendingLessonIds: Set<string>;
  try {
    const recoveryRaw = storage.getItem(RECORDING_RECOVERY_STORAGE_KEY);
    const recovery: unknown = recoveryRaw ? JSON.parse(recoveryRaw) : { recordings: [] };
    if (!isRecord(recovery) || !Array.isArray(recovery.recordings)) return snapshot;
    pendingLessonIds = new Set();
    for (const recording of recovery.recordings) {
      if (!isRecord(recording) || typeof recording.lessonId !== 'string') return snapshot;
      pendingLessonIds.add(recording.lessonId);
    }
  } catch {
    // Unknown recovery state must not turn pending audio into an orphan.
    return snapshot;
  }
  const migrated = migrateLegacyDemoWorkspace(snapshot, pendingLessonIds);
  return migrated !== snapshot && backUpBeforeMigration(raw, storage) ? migrated : snapshot;
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

export interface WorkspaceLoadIssue {
  /**
   * `unreadable`: damaged or truncated data. `newer-version`: written by a newer version of the app.
   * `partial`: some entries could not be read and were left out.
   */
  kind: 'unreadable' | 'newer-version' | 'partial';
  /** Whether a copy of the stored value was kept before it can be replaced. */
  backedUp: boolean;
  /** Storage key holding that copy. */
  copyKey?: string;
  /**
   * True when the stored value must not be replaced: no copy could be kept, or a newer version owns the data.
   * The app then stops saving and leaves the original where it is.
   */
  protect: boolean;
  /** The stored value itself, only when no copy could be kept (it can still be offered for download). */
  raw?: string;
}

function classifyUnreadable(raw: string): 'unreadable' | 'newer-version' {
  if (raw.length > MAX_WORKSPACE_SNAPSHOT_BYTES) return 'unreadable';
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.version === 'number' && parsed.version > 1 ? 'newer-version' : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

// A stored value that cannot be read is replaced by an empty workspace at the next save. Keep the original first, so a
// damaged, truncated or newer-format workspace is never destroyed without a trace. Returns the key of the copy.
function keepUnreadableCopy(raw: string, storage: Storage): string | null {
  try {
    for (let index = 0; index <= storage.length; index += 1) {
      const key = index === 0 ? WORKSPACE_UNREADABLE_BACKUP_KEY : `${WORKSPACE_UNREADABLE_BACKUP_KEY}.${index}`;
      const existing = storage.getItem(key);
      if (existing === raw) return key;
      if (existing === null) {
        storage.setItem(key, raw);
        return storage.getItem(key) === raw ? key : null;
      }
    }
  } catch {
    // Storage is full or blocked: report that no copy could be kept.
  }
  return null;
}

function createLoadIssue(raw: string, kind: WorkspaceLoadIssue['kind'], storage: Storage | undefined): WorkspaceLoadIssue {
  const copyKey = storage ? keepUnreadableCopy(raw, storage) : null;
  const backedUp = copyKey !== null;
  return {
    kind,
    backedUp,
    ...(copyKey ? { copyKey } : { raw }),
    protect: !backedUp || kind === 'newer-version',
  };
}

/** The stored value an issue refers to, for a download. */
export function readWorkspaceCopy(issue: WorkspaceLoadIssue, storage: Storage | undefined = getStorage()): string | null {
  if (issue.raw !== undefined) return issue.raw;
  try {
    return issue.copyKey && storage ? storage.getItem(issue.copyKey) : null;
  } catch {
    return null;
  }
}

export function loadWorkspaceWithStatus(
  fallback: WorkspaceSnapshot,
  storage: Storage | undefined = getStorage(),
): { snapshot: WorkspaceSnapshot; issue: WorkspaceLoadIssue | null } {
  if (!storage) return { snapshot: fallback, issue: null };
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
    const { snapshot, dropped } = parseWorkspaceDetailed(raw, fallback);
    if (snapshot === fallback) {
      // `raw` is empty on a first launch; anything else that failed to parse is data the user had.
      const issue = raw && !isBootstrapSnapshot(raw) ? createLoadIssue(raw, classifyUnreadable(raw), storage) : null;
      return { snapshot, issue };
    }
    const issue = dropped > 0 && raw ? createLoadIssue(raw, 'partial', storage) : null;
    const migrated = migrateWithBackup(raw, snapshot, storage);
    if (migrated !== snapshot && !issue?.protect) saveWorkspace(migrated, storage);
    return { snapshot: migrated, issue };
  } catch {
    return { snapshot: fallback, issue: null };
  }
}

export function loadWorkspace(fallback: WorkspaceSnapshot, storage: Storage | undefined = getStorage()): WorkspaceSnapshot {
  return loadWorkspaceWithStatus(fallback, storage).snapshot;
}

/**
 * The browser stores the workspace in this shape. The active course used to be written twice, as the top-level
 * `resources`, `transcript`, `chat` and `artifacts` and again inside `lessonWorkspaces[activeLessonId]`, which about
 * doubled the size of a large course. When `lessonWorkspaces` is present the top-level copies are left out; the loader
 * rebuilds them, and still reads the older shape. Without `lessonWorkspaces` (the very old flat shape) nothing is left out.
 * The native shell keeps writing the full shape: SQLite has no such quota.
 */
export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): string {
  if (!snapshot.lessonWorkspaces) return JSON.stringify({ version: 1, ...snapshot });
  const { resources: _resources, transcript: _transcript, chat: _chat, artifacts: _artifacts, ...compact } = snapshot;
  return JSON.stringify({ version: 1, ...compact });
}

export function saveWorkspace(snapshot: WorkspaceSnapshot, storage: Storage | undefined = getStorage()): boolean {
  if (!storage) return false;

  try {
    const serialized = serializeWorkspaceSnapshot(snapshot);
    if (serialized.length > MAX_WORKSPACE_SNAPSHOT_BYTES) return false;
    storage.setItem(WORKSPACE_STORAGE_KEY, serialized);
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
    const { snapshot: parsed, dropped } = parseWorkspaceDetailed(raw, fallback);
    // The native database starts with a bootstrap row that holds no user data.
    const issue = raw && !isBootstrapSnapshot(raw) && (parsed === fallback || dropped > 0)
      ? createLoadIssue(raw, parsed === fallback ? classifyUnreadable(raw) : 'partial', storage)
      : null;
    if (issue) callbacks.onUnreadable?.(issue);
    const snapshot = parsed === fallback ? parsed : migrateWithBackup(raw, parsed, storage);
    // A protected original stays in the database untouched; the app stops saving instead of replacing it.
    if (!issue?.protect && (raw === null || snapshot === fallback || snapshot !== parsed)) {
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

  const saveOperation = nativeSaveQueue.then(async () => {
    try {
      await invokeNative('save_workspace', { snapshot: JSON.stringify({ version: 1, ...snapshot }) });
      return true;
    } catch (error) {
      callbacks.onError?.({ operation: 'save', message: describeStorageError(error) });
      return saveWorkspace(snapshot, storage);
    }
  });
  nativeSaveQueue = saveOperation.then(() => undefined, () => undefined);
  return saveOperation;
}

export function runPackagedIpcSmoke() {
  return invokeNative<string>('smoke_frontend_ipc');
}
