export type ViewMode = 'course' | 'chat';
export type ResourceKind = 'audio' | 'image' | 'document' | 'transcript';
export type ArtifactKind = 'summary' | 'guide' | 'quiz' | 'flashcards' | 'mindmap' | 'glossary';

export interface Lesson {
  id: string;
  subject: string;
  chapter: string;
  title: string;
  teacher: string;
  duration: string;
  date: string;
  progress: number;
}

export interface Resource {
  id: string;
  name: string;
  meta: string;
  kind: ResourceKind;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  lastModified?: number;
}

export interface TranscriptSegment {
  id: string;
  sourceId?: string;
  provisional?: boolean;
  timestamp: string;
  speaker: string;
  text: string;
  status?: 'verified' | 'review';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  citationTargets?: string[];
}

export interface LessonWorkspace {
  resources: Resource[];
  transcript: TranscriptSegment[];
  chat: ChatMessage[];
  artifacts: Artifact[];
  courseNote?: CourseNote;
}

export type CourseNoteBlock =
  | { id: string; type: 'heading'; level: 1 | 2; text: string }
  | { id: string; type: 'paragraph'; text: string; timestamp?: string; speaker?: string; sourceId?: string }
  | { id: string; type: 'formula'; latex: string; caption?: string; sourceId?: string }
  | { id: string; type: 'code'; language: string; code: string; sourceId?: string }
  | { id: string; type: 'chart'; label: string; values: Array<{ label: string; value: number }>; sourceId?: string }
  | { id: string; type: 'schema'; nodes: string[]; edges: Array<{ from: string; to: string }>; sourceId?: string };

export interface CourseDetection {
  method: 'active course' | 'transcript signals' | 'LM Studio';
  confidence: number;
  basis: string;
}

export interface CourseNote {
  id: string;
  title: string;
  subject: string;
  chapter: string;
  folderPath: string[];
  fileName: string;
  updatedAt: string;
  detection: CourseDetection;
  blocks: CourseNoteBlock[];
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  label: string;
  createdAt: string;
  content?: string;
  citations?: string[];
  citationTargets?: string[];
}
