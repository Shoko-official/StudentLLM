import type { AudioChunkRecord } from './recording-storage';
import type { Artifact, ChatMessage, Lesson, LessonWorkspace, Resource, TranscriptSegment } from '../types';

const EXPORT_FORMAT = 'studentllm-course';
const EXPORT_VERSION = 1;

export interface CourseExportChunk {
  data: string;
  recordedAt: number;
}

export interface CourseExportAsset {
  resourceId: string;
  storage: 'source' | 'audio';
  mimeType: string;
  chunks: CourseExportChunk[];
}

export interface CourseExportPayload {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  lesson: Lesson;
  workspace: LessonWorkspace;
  assets: CourseExportAsset[];
}

export interface ImportedCourseAsset {
  resourceId: string;
  storage: CourseExportAsset['storage'];
  chunks: Array<{ blob: Blob; recordedAt: number }>;
}

export interface ImportedCourse {
  lesson: Lesson;
  workspace: LessonWorkspace;
  assets: ImportedCourseAsset[];
}

export type CourseIdFactory = (prefix: string) => string;

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function encodeBlob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const blockSize = 0x8000;
  for (let index = 0; index < bytes.length; index += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + blockSize));
  }
  return btoa(binary);
}

function decodeBlob(data: string, mimeType: string) {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

export interface CourseExportLoaders {
  loadSourceBlob: (resourceId: string) => Promise<Blob | null>;
  listAudioChunks: (recordingId: string) => Promise<AudioChunkRecord[]>;
}

export async function buildCourseExport(
  lesson: Lesson,
  workspace: LessonWorkspace,
  loaders: CourseExportLoaders,
  now: () => string = () => new Date().toISOString(),
) {
  const assets: CourseExportAsset[] = [];
  for (const resource of workspace.resources) {
    if (resource.kind === 'audio') {
      const audioChunks = await loaders.listAudioChunks(resource.id);
      if (audioChunks.length) {
        assets.push({
          resourceId: resource.id,
          storage: 'audio',
          mimeType: audioChunks[0].blob.type || resource.mimeType || 'audio/webm',
          chunks: await Promise.all(audioChunks.map(async (chunk) => ({ data: await encodeBlob(chunk.blob), recordedAt: chunk.recordedAt }))),
        });
        continue;
      }
    }
    const sourceBlob = await loaders.loadSourceBlob(resource.id);
    if (!sourceBlob) continue;
    assets.push({
      resourceId: resource.id,
      storage: 'source',
      mimeType: sourceBlob.type || resource.mimeType || 'application/octet-stream',
      chunks: [{ data: await encodeBlob(sourceBlob), recordedAt: resource.lastModified ?? 0 }],
    });
  }

  const payload: CourseExportPayload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now(),
    lesson,
    workspace,
    assets,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLesson(value: unknown): value is Lesson {
  if (!isRecord(value)) return false;
  return ['id', 'subject', 'chapter', 'title', 'teacher', 'duration', 'date'].every((key) => isString(value[key]))
    && typeof value.progress === 'number' && Number.isFinite(value.progress);
}

function isResource(value: unknown): value is Resource {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.meta) || !isString(value.kind)) return false;
  return ['audio', 'image', 'document', 'transcript'].includes(value.kind)
    && (value.mimeType === undefined || isString(value.mimeType))
    && (value.sizeBytes === undefined || typeof value.sizeBytes === 'number')
    && (value.sha256 === undefined || isString(value.sha256))
    && (value.lastModified === undefined || typeof value.lastModified === 'number');
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.timestamp) && isString(value.speaker) && isString(value.text)
    && (value.sourceId === undefined || isString(value.sourceId))
    && (value.provisional === undefined || typeof value.provisional === 'boolean')
    && (value.status === undefined || value.status === 'verified' || value.status === 'review');
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return isString(value.id) && (value.role === 'user' || value.role === 'assistant') && isString(value.content)
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every(isString)));
}

function isArtifact(value: unknown): value is Artifact {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.kind) && ['summary', 'guide', 'quiz', 'flashcards', 'mindmap', 'glossary'].includes(value.kind)
    && isString(value.label) && isString(value.createdAt)
    && (value.content === undefined || isString(value.content))
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.every(isString)));
}

function isWorkspace(value: unknown): value is LessonWorkspace {
  if (!isRecord(value)) return false;
  return Array.isArray(value.resources) && value.resources.every(isResource)
    && Array.isArray(value.transcript) && value.transcript.every(isTranscriptSegment)
    && Array.isArray(value.chat) && value.chat.every(isChatMessage)
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifact);
}

function isExportAsset(value: unknown): value is CourseExportAsset {
  if (!isRecord(value) || !isString(value.resourceId) || (value.storage !== 'source' && value.storage !== 'audio') || !isString(value.mimeType)) return false;
  return Array.isArray(value.chunks) && value.chunks.length > 0 && value.chunks.every((chunk) => (
    isRecord(chunk) && isString(chunk.data) && typeof chunk.recordedAt === 'number' && Number.isFinite(chunk.recordedAt)
  ));
}

function parsePayload(value: unknown): value is CourseExportPayload {
  return isRecord(value)
    && value.format === EXPORT_FORMAT
    && value.version === EXPORT_VERSION
    && isString(value.exportedAt)
    && isLesson(value.lesson)
    && isWorkspace(value.workspace)
    && Array.isArray(value.assets)
    && value.assets.every(isExportAsset);
}

export async function readCourseExport(input: Blob | string, idFactory: CourseIdFactory = createId): Promise<ImportedCourse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === 'string' ? input : await input.text());
  } catch {
    throw new Error('The course export is not valid JSON.');
  }
  if (!parsePayload(parsed)) throw new Error('The course export format is not supported.');

  const lesson = { ...parsed.lesson, id: idFactory('lesson') };
  const resourceIds = new Map<string, string>();
  const resources = parsed.workspace.resources.map((resource) => {
    const id = idFactory('resource');
    resourceIds.set(resource.id, id);
    return { ...resource, id };
  });
  const assets: ImportedCourseAsset[] = parsed.assets.map((asset) => {
    const resourceId = resourceIds.get(asset.resourceId);
    if (!resourceId) throw new Error('The course export references an unknown resource.');
    return {
      resourceId,
      storage: asset.storage,
      chunks: asset.chunks.map((chunk) => ({ blob: decodeBlob(chunk.data, asset.mimeType), recordedAt: chunk.recordedAt })),
    };
  });

  return {
    lesson,
    workspace: {
      ...parsed.workspace,
      resources,
      transcript: parsed.workspace.transcript.map((segment) => ({
        ...segment,
        ...(segment.sourceId ? { sourceId: resourceIds.get(segment.sourceId) ?? segment.sourceId } : {}),
      })),
    },
    assets,
  };
}
