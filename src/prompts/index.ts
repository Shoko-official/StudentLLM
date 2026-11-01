import chat from './chat';
import study from './study';
import visuals from './visuals';
import contextData from './context-data';
import memory from './conversation-memory';
import structured from './structured-teaching';
import transcriptNotes from './transcript-notes';
import documentNotes from './document-notes';
import documentTranscription from './document-transcription';
import organization from './organization';
import detection from './course-detection';
import probes from './probes.json' with { type: 'json' };

export const CHAT_ASSISTANT_PROMPT = chat.trim();
export const STUDY_ASSISTANT_PROMPT = study.trim();
export const TEACHING_VISUAL_PROMPT = visuals.trim();
export const CONTEXT_DATA_INSTRUCTIONS = contextData.trim();
export const CONVERSATION_MEMORY_INSTRUCTIONS = memory.trim();
export const STRUCTURED_TEACHING_CONTRACT = structured.trim();
export const TRANSCRIPT_NOTES_PROMPT = transcriptNotes.trim();
export const DOCUMENT_NOTES_PROMPT = documentNotes.trim();
export const DOCUMENT_TRANSCRIPTION_PROMPT = documentTranscription.trim();
export const ORGANIZATION_PROMPT = organization.trim();
export const COURSE_DETECTION_PROMPT = detection.trim();
export const DIRECT_ANSWER_PROMPT = probes.directAnswer;
export const DOCUMENT_NOTE_REQUEST = probes.documentNoteRequest;

/** User-level serialized data cannot introduce a new system instruction. */
export function documentReconstructionInput(sourceName: string, evidence: string): string {
  return JSON.stringify({ task: DOCUMENT_NOTE_REQUEST, documentSource: sourceName, extractedDocument: evidence });
}

export function courseDetectionInput(lesson: { title: string; subject: string; chapter: string }, excerpt: string): string {
  return JSON.stringify({ selectedCourse: { title: lesson.title, subject: lesson.subject, chapter: lesson.chapter }, lectureExcerpt: excerpt });
}

export function studyMaterialRequest(label: string): string {
  return `Generate the ${label.toLowerCase()}.`;
}
