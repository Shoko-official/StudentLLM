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
