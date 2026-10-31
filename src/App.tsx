import { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, lazy, memo, ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  Archive,
  ArrowUpRight,
  BookA,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  FileAudio,
  FileImage,
  FileText,
  FolderOpen,
  Layers,
  ListChecks,
  Menu,
  Network,
  Plus,
  Search,
  Send,
  Settings2,
  Shuffle,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDialogFocus, useDismissibleMenu } from './lib/focus-management';
import { AnimatedIcon, EmptyStateIcon } from './lib/animated-icon';
import { LicensesDialog } from './lib/licenses-dialog';
import { folderNameOf, planBatchImport } from './lib/batch-import';
import { BrandGlyph } from './lib/brand-mark';
import { foldForSearch, textMatchesQuery } from './lib/snippet';
import { Snippet } from './lib/snippet-view';
import { describeMicrophoneError, requestRecorderSession, RecorderSession } from './lib/recorder';
import { isNativeRuntime, loadWorkspaceAsync, runPackagedIpcSmoke, saveWorkspaceAsync } from './lib/workspace-storage';
import type { WorkspaceLoadIssue, WorkspaceSnapshot } from './lib/workspace-storage';
import { openBrowserWorkspace, openLocalStorageWorkspace, shouldUseIndexedDb } from './lib/browser-workspace-store';
import type { BrowserBootstrap } from './lib/browser-workspace-store';
import { eraseCourseSources, eraseRemovedSource, isSafeToErase, sweepPendingErases } from './lib/source-erase';
import type { EraseOperations } from './lib/source-erase';
import { describeStorageUsage, readPersistentStorage, readStorageEstimate, requestPersistentStorage } from './lib/storage-estimate';
import type { PersistentStorageState, StorageEstimateInfo } from './lib/storage-estimate';
import type { WorkspaceStorageError } from './lib/workspace-storage';
import { createLocalLLMProvider } from './lib/llm-provider';
import { DEFAULT_NIM_MODEL, NIM_MODELS, NIM_PROXY_BASE_URL, nimChatTemplateKwargs, probeNimModel } from './lib/nvidia-nim';
import type { LLMProvider } from './lib/llm-provider';
import { classifyChatQuestion } from './lib/chat-intent';
import { createLocalSpeechEngine } from './lib/speech-engine';
import type { SpeechEngine } from './lib/speech-engine';
import { groupTranscript, mergeLiveWindow, speakerLabel } from './lib/live-transcript';
import { useLiveNotes } from './lib/use-live-notes';
import { createLocalDocumentEngine } from './lib/document-engine';
import type { DocumentPage } from './lib/document-engine';
import type { DocumentEngine } from './lib/document-engine';
import { readJsonResponse } from './lib/response-json';
import { isLoopbackServiceUrl, isRemoteServiceUrl, LOOPBACK_HINT, LOOPBACK_ONLY_DETAIL, normalizeServiceBaseUrl } from './lib/service-url';
import { probeSidecar, SidecarHealth } from './lib/sidecar-health';
import { getManagedSidecarStatus, ManagedSidecarStatus, startManagedSidecars, stopManagedSidecars } from './lib/sidecar-supervisor';
import { createSourceResource } from './lib/source-ingest';
import { createSourceBlobStore, type SourceBlobStore } from './lib/source-storage';
import { describeAiFailure, describeDocumentFailure, describeSpeechFailure } from './lib/service-errors';
import { mergeSegments } from './lib/transcript-merge';
import { AudioChunkStore, createRecordingChunkStore } from './lib/recording-storage';
import { hasSessionOnlyPendingRecordings, listPendingRecordings, removePendingRecording, savePendingRecording, type PendingRecording } from './lib/recording-recovery';
import { buildCourseExport, describeCourseImportFailure, exportSizeWarning, readCourseExport } from './lib/course-transfer';
import { chunkSourceText } from './lib/source-chunking';
import { RetrievalDocument, searchDocumentsHybrid } from './lib/local-retrieval';
import { RichText } from './lib/rich-text';
import { VisualBlockView } from './lib/visual-blocks-view';
import { parseStudyArtifactResponse, studyArtifactResponseFormat } from './lib/study-artifacts';
import { buildCourseNote, courseNoteMarkdown, DOCUMENT_NOTE_LAYOUT_VERSION, formatCourseNoteWithProvider, formatDocumentCourseNoteWithProvider } from './lib/course-notes';
import { analyzeQuickStart } from './lib/quick-start';
import { applyRecordingPlacement, canAutoRouteRecording } from './lib/recording-routing';
import type { QuickStartProposal } from './lib/quick-start';
import { Artifact, ArtifactKind, ChatMessage, CourseNoteBlock, Lesson, LessonWorkspace, Resource, TranscriptSegment } from './types';
import { chooseNoteOnUndo, restoreAtPositions, sameIdSet, SOURCE_REMOVAL_MAX_MS, SOURCE_REMOVAL_UNDO_MS, takeWithPositions, type RemovedEntry } from './lib/source-removal';
import { addPendingSourceErase, hasSessionOnlyPendingSourceErases, isStalePendingSourceErase, listPendingSourceErases, removePendingSourceErase } from './lib/pending-source-erase';

const PdfPreview = lazy(() => import('./lib/pdf-preview').then(({ PdfPreview: Preview }) => ({ default: Preview })));

const initialLessons: Lesson[] = [];
const emptyLesson: Lesson = { id: '', subject: 'General', chapter: 'General notes', title: '', teacher: '', duration: '00:00:00', date: '', progress: 0 };

type Tone = 'blue' | 'amber' | 'rose' | 'green' | 'violet' | 'cyan';

const artifactCatalog: { kind: ArtifactKind; label: string; description: string; icon: LucideIcon; tone: Tone }[] = [
  { kind: 'summary', label: 'Quick summary', description: 'The essential ideas on one page.', icon: AlignLeft, tone: 'blue' },
  { kind: 'guide', label: 'Study guide', description: 'A structured, source-linked synthesis.', icon: BookOpen, tone: 'violet' },
  { kind: 'quiz', label: 'Targeted quiz', description: 'Test the concepts that remain uncertain.', icon: CircleHelp, tone: 'rose' },
  { kind: 'flashcards', label: 'Flashcards', description: 'Prepare a review-ready card deck.', icon: Layers, tone: 'amber' },
  { kind: 'mindmap', label: 'Concept map', description: 'Connect concepts and their dependencies.', icon: Network, tone: 'green' },
  { kind: 'glossary', label: 'Glossary', description: 'Definitions for the course vocabulary.', icon: BookA, tone: 'cyan' },
];

type CourseTreeSubject = {
  subject: string;
  chapters: { chapter: string; lessons: Lesson[] }[];
};

const chapterGroupKey = (subject: string, chapter: string) => `${subject}\u0000${chapter}`;

function buildCourseTree(values: Lesson[]) {
  const subjectsOrder: string[] = [];
  const subjectChapters = new Map<string, Map<string, Lesson[]>>();
  const chapterOrder = new Map<string, string[]>();

  for (const lesson of values) {
    if (!subjectChapters.has(lesson.subject)) {
      subjectChapters.set(lesson.subject, new Map<string, Lesson[]>());
      subjectsOrder.push(lesson.subject);
      chapterOrder.set(lesson.subject, []);
    }

    const chaptersBySubject = subjectChapters.get(lesson.subject)!;
    const subjectChapterOrder = chapterOrder.get(lesson.subject)!;
    if (!chaptersBySubject.has(lesson.chapter)) {
      chaptersBySubject.set(lesson.chapter, []);
      subjectChapterOrder.push(lesson.chapter);
    }
    chaptersBySubject.get(lesson.chapter)!.push(lesson);
  }

  return subjectsOrder.map((subject) => ({
    subject,
    chapters: (chapterOrder.get(subject) ?? []).map((chapter) => ({
      chapter,
      lessons: subjectChapters.get(subject)?.get(chapter) ?? [],
    })),
  }));
}

function buildExpandedSubjectState(values: Lesson[]) {
  const next: Record<string, boolean> = {};
  for (const lesson of values) {
    if (next[lesson.subject] === undefined) next[lesson.subject] = true;
  }
  return next;
}

const emptyLessonWorkspace: LessonWorkspace = {
  resources: [],
  transcript: [],
  chat: [],
  artifacts: [],
};

const LARGE_BATCH_IMPORT = 60;
const sourceAccept = 'audio/*,image/*,.pdf,.txt,.md,.html,.htm,.rtf,.docx,.pptx';
const PREFERENCES_STORAGE_KEY = 'studentllm.preferences.v1';
type PendingSourceRemoval = {
  lessonId: string;
  resource: Resource;
  resourceEntry: RemovedEntry<Resource>;
  segmentEntries: RemovedEntry<TranscriptSegment>[];
  courseNote: LessonWorkspace['courseNote'];
  noteAfterRemoval: LessonWorkspace['courseNote'] | undefined;
  preRemovalIds: string[];
  timer: number;
  hardTimer: number;
  deadline: number;
  remaining: number;
  hover: boolean;
  focus: boolean;
};
const RECORDING_NOTICE_STORAGE_KEY = 'studentllm.recording-notice.v1';
const RECORDING_NOTICE_VERSION = 1;
const SERVICES_STORAGE_KEY = 'studentllm.services.v1';
type ServiceSettings = { llmProvider: string; llmUrl: string; model: string; nimModel: string; asrUrl: string; documentsUrl: string };
// NVIDIA NIM goes through the dev server's credential proxy, so it is only offered in development builds.
const USER_GUIDE_URL = 'https://github.com/Shoko-official/StudentLLM/blob/main/docs/user-guide.md';
const NIM_AVAILABLE = import.meta.env.DEV;
const usesNim = (settings: ServiceSettings) => NIM_AVAILABLE && settings.llmProvider === 'nvidia-nim';
const llmConnection = (settings: ServiceSettings) => usesNim(settings)
  ? { baseUrl: NIM_PROXY_BASE_URL, model: settings.nimModel || DEFAULT_NIM_MODEL }
  : { baseUrl: settings.llmUrl, model: settings.model };
function loadServiceSettings(): ServiceSettings {
  const defaults = {
    llmProvider: 'lm-studio',
    llmUrl: import.meta.env.VITE_LM_STUDIO_BASE_URL?.trim() || (import.meta.env.DEV ? '/lm-studio/v1' : 'http://127.0.0.1:1234/v1'),
    model: import.meta.env.VITE_LM_STUDIO_MODEL?.trim() || 'openai/gpt-oss-20b',
    nimModel: DEFAULT_NIM_MODEL,
    asrUrl: import.meta.env.VITE_LOCAL_ASR_BASE_URL?.trim() || 'http://127.0.0.1:8765',
    documentsUrl: import.meta.env.VITE_LOCAL_DOCUMENT_BASE_URL?.trim() || 'http://127.0.0.1:8766',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SERVICES_STORAGE_KEY) ?? '{}');
    for (const key of Object.keys(defaults) as (keyof ServiceSettings)[]) {
      if (typeof saved?.[key] === 'string' && saved[key].trim()) defaults[key] = saved[key].trim();
    }
  } catch { /* Use configured defaults if saved connection settings cannot be read. */ }
  if (defaults.llmProvider !== 'nvidia-nim' || !NIM_AVAILABLE) defaults.llmProvider = 'lm-studio';
  return defaults;
}
const packagedIpcSmokeRequested = import.meta.env.VITE_STUDENTLLM_PACKAGED_IPC_SMOKE === 'true';

function loadPreference(name: 'compactTranscript' | 'showVerifiedTranscript' | 'darkMode', fallback: boolean) {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return fallback;
    const preferences = JSON.parse(raw) as Record<string, unknown>;
    return typeof preferences[name] === 'boolean' ? preferences[name] : fallback;
  } catch {
    return fallback;
  }
}

function hasAcknowledgedRecordingNotice() {
  try {
    const raw = window.localStorage.getItem(RECORDING_NOTICE_STORAGE_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as { version?: unknown };
    return value.version === RECORDING_NOTICE_VERSION;
  } catch {
    return false;
  }
}

function saveRecordingNoticeAcknowledgement() {
  try {
    window.localStorage.setItem(RECORDING_NOTICE_STORAGE_KEY, JSON.stringify({
      version: RECORDING_NOTICE_VERSION,
      acknowledgedAt: new Date().toISOString(),
    }));
  } catch {
    // The acknowledgement remains valid for the current session if storage is unavailable.
  }
}

const initialWorkspace = {
  activeLessonId: '',
  lessons: initialLessons,
  resources: [] as Resource[],
  transcript: [] as TranscriptSegment[],
  chat: [] as ChatMessage[],
  artifacts: [],
};

function formatElapsed(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function randomQuickCourseTitle() {
  const prefixes = ['Untitled lecture', 'Study course', 'Quick course'];
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]} · ${suffix}`;
}

// A Markdown file imported as notes (or pasted in the organizer) keeps its headings, lists and tables instead of showing the raw syntax.
function isMarkdownImport(block: { timestamp?: string; speaker?: string }) {
  return (block.timestamp === 'Notes' || block.timestamp === 'Quick start') && /\.(?:md|markdown)$/i.test(block.speaker ?? '');
}

function resourceIcon(kind: Resource['kind']) {
  if (kind === 'audio') return <span className="icon-tile tone-violet" aria-hidden="true"><FileAudio size={18} /></span>;
  if (kind === 'image') return <span className="icon-tile tone-green" aria-hidden="true"><FileImage size={18} /></span>;
  if (kind === 'document') return <span className="icon-tile tone-rose" aria-hidden="true"><FileText size={18} /></span>;
  if (kind === 'transcript') return <span className="icon-tile tone-blue" aria-hidden="true"><FileText size={18} /></span>;
  return <span className="icon-tile" aria-hidden="true"><Archive size={18} /></span>;
}

function isTextResource(resource: Resource) {
  return resource.kind === 'transcript' || resource.mimeType?.startsWith('text/') === true;
}

function isPdfResource(resource: Resource) {
  return resource.kind === 'document' && (resource.mimeType === 'application/pdf' || /\.pdf$/i.test(resource.name));
}

function isExtractableDocument(resource: Resource) {
  if (resource.kind === 'image') return true;
  if (resource.kind !== 'document') return false;
  return [
    'application/pdf',
    'application/rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/html',
  ].includes(resource.mimeType ?? '') || /\.(pdf|rtf|html?|docx|pptx)$/i.test(resource.name);
}

function hasCurrentDocumentNote(workspace: LessonWorkspace) {
  return workspace.courseNote?.blocks.some((block) => block.id === 'document-source-title') === true
    && workspace.courseNote.detection.basis.includes(DOCUMENT_NOTE_LAYOUT_VERSION);
}

export interface AppProps {
  provider?: LLMProvider | null;
  recorderSessionFactory?: () => Promise<RecorderSession>;
  speechEngine?: SpeechEngine | null;
  documentEngine?: DocumentEngine | null;
  recordingChunkStore?: AudioChunkStore;
  sourceBlobStore?: SourceBlobStore;
  liveTranscriptionIntervalMs?: number;
}

interface ResourcePreview {
  resource: Resource;
  state: 'loading' | 'ready' | 'missing' | 'error';
  blob?: Blob;
  blobUrl?: string;
  page?: number;
  text?: string;
  truncated?: boolean;
  detail?: string;
}

type StorageNotice =
  | { kind: 'load-issue'; issue: WorkspaceLoadIssue }
  | { kind: 'save-failed'; tooLarge?: boolean }
  | { kind: 'changed-elsewhere' }
  /** The browser would not open IndexedDB; the workspace works from the smaller localStorage instead. */
  | { kind: 'indexeddb-unavailable' }
  /** IndexedDB holds the workspace but could not be opened now; saving is paused and nothing is overwritten. */
  | { kind: 'indexeddb-blocked' }
  /** IndexedDB did not answer in time; the workspace came from the smaller localStorage. */
  | { kind: 'indexeddb-timeout' };

function storageNoticeText(notice: StorageNotice) {
  if (notice.kind === 'indexeddb-timeout') return 'The storage for large courses did not answer in time, so StudentLLM is using the smaller fallback for now. Reload to try again. Export anything you want to keep first.';
  if (notice.kind === 'indexeddb-unavailable') return 'This browser does not let StudentLLM use the storage meant for large courses (a private window can do this), so it is using a smaller fallback. A large course may stop being saved; you would be warned. Use a normal window for long lectures.';
  if (notice.kind === 'indexeddb-blocked') return 'StudentLLM could not open the storage that holds your workspace, so it is showing the last copy kept before the upgrade. Saving is paused so nothing is overwritten. Close other StudentLLM tabs and reload; export anything you need first.';
  if (notice.kind === 'save-failed' && notice.tooLarge) return 'Your changes are not being saved: this course workspace is larger than the 16 MB limit StudentLLM can store (your browser still has room). Use More \u2192 Export course to keep a copy of what is on screen, then split the material into smaller courses or delete old ones.';
  if (notice.kind === 'save-failed') return "Your changes are not being saved: this browser's storage is full or blocked. Use More \u2192 Export course to keep a copy of what is on screen, then free up space or clear old courses.";
  if (notice.kind === 'changed-elsewhere') return 'StudentLLM was changed in another tab or window. Reload this page to see the latest version. Changes made here are not saved until you reload, so export anything you want to keep first.';
  const { kind, backedUp, protect } = notice.issue;
  if (kind === 'storage-reset') {
    if (!notice.issue.backedUp) return 'Your workspace storage was cleared (the browser may have removed it to free space) and no earlier copy was found, so StudentLLM started empty. Courses you exported can be imported again.';
    const when = notice.issue.since ? ` from ${new Date(notice.issue.since).toLocaleDateString()}` : '';
    return `Your workspace storage was reset. StudentLLM is showing the older copy${when}; changes made after it are lost. Download the copy to keep it.`;
  }
  if (kind === 'older-copy' && notice.issue.copyLimitReached) return 'StudentLLM already holds 8 recovery copies, so this different older workspace could not be copied again. The current workspace is shown and the older data is still in the fallback storage. Download the older copy now to keep it.';
  if (kind === 'older-copy') return 'A different copy of your workspace, saved by an older version of StudentLLM or while this browser could not use its large-course storage, was found and kept. The workspace shown is the current one. Download the older copy if it holds work you need.';
  const what = kind === 'partial'
    ? 'Some entries in your saved workspace could not be read and were left out.'
    : kind === 'newer-version'
      ? 'Your saved workspace was written by a newer version of StudentLLM that this version cannot read, so it started empty.'
      : 'Your saved workspace could not be read, so StudentLLM started empty.';
  const copy = backedUp
    ? 'A copy of the original data was kept in this browser.'
    : 'A copy of the original data could not be kept because browser storage is full.';
  if (notice.issue.restoredFromLegacy) return `${what} ${copy} The copy of your workspace from before the storage upgrade is shown instead; changes made since then may be missing. Download the saved copy to keep what could not be read.`;
  if (kind === 'newer-version') return `${what} The saved data was left untouched and saving is paused in this window, so nothing done here is kept. Open it with the newer version of the app, or download it to keep a copy.`;
  if (protect) return `${what} ${copy} To protect your data it was left untouched and saving is paused in this window, so nothing done here is kept. Download the saved data first.`;
  return `${what} ${copy} Download it to keep it elsewhere; courses you export are never affected.`;
}

// Module-level and memoized: a keystroke in the search field or the chat composer re-renders App, and without this every
// block of a long note (hundreds after an hour-long lecture) was rebuilt each time.
const CourseNoteBlockView = memo(function CourseNoteBlockView({ block }: { block: CourseNoteBlock }) {
  if (block.type === 'heading') {
    if (block.id === 'note-title') return null;
    const Heading = block.level === 1 ? 'h2' : 'h3';
    return <Heading key={block.id}>{block.text}</Heading>;
  }
  if (block.type === 'markdown') {
    return <section className="course-note-markdown" key={block.id}><RichText content={block.markdown} /></section>;
  }
  if (block.type === 'paragraph') {
    return <div className="course-note-paragraph" key={block.id}>{block.timestamp && <span className="course-note-meta">{block.timestamp}{speakerLabel(block.speaker) ? ` · ${speakerLabel(block.speaker)}` : ''}</span>}<RichText content={block.text} highlightExtractedMath={!isMarkdownImport(block)} /></div>;
  }
  if (block.type === 'formula') {
    return <div className="course-note-formula" key={block.id}><RichText content={block.latex} />{block.caption && <small>{block.caption}</small>}</div>;
  }
  if (block.type === 'formula-image') {
    return <figure className="course-note-formula-image" key={block.id}><img src={block.imageData} alt={`Formula from ${block.sourceName}: ${block.alt}`} /></figure>;
  }
  if (block.type === 'code') {
    return <pre className="course-note-code" key={block.id}><code><span className="course-note-code-language">{block.language}</span>{block.code}</code></pre>;
  }
  if (block.type === 'schema') {
    return <div className="course-note-schema" key={block.id} aria-label="Course concept schema">{block.edges.map((edge) => <span key={`${block.id}-${edge.from}-${edge.to}`}><b>{edge.from}</b><span aria-hidden="true"> → </span><b>{edge.to}</b></span>)}</div>;
  }
  if (block.type === 'visual') return <VisualBlockView key={block.id} visual={block.visual} />;
  const maximum = Math.max(...block.values.map((item) => Math.abs(item.value)), 1);
  return <figure className="course-note-chart" key={block.id}><figcaption>{block.label}</figcaption>{block.values.map((item, index) => <div className="course-note-chart-row" key={`${block.id}-${index}-${item.label}`}><span>{item.label}</span><i><em style={{ width: `${Math.max(4, Math.round(Math.abs(item.value) / maximum * 100))}%` }} /></i><strong>{item.value}</strong></div>)}</figure>;
});

const TranscriptItem = memo(function TranscriptItem({ segment, onToggleReview }: { segment: TranscriptSegment; onToggleReview: (segmentId: string) => void }) {
  return (
  <article className={`transcript-item ${segment.status === 'review' ? 'needs-review' : ''}`}>
    <div className="transcript-time">{segment.timestamp}</div>
    <div className="transcript-body"><div className="speaker-line">{speakerLabel(segment.speaker) && <strong>{speakerLabel(segment.speaker)}</strong>}{segment.provisional ? <span className="review-badge">Live preview</span> : segment.status === 'review' ? <span className="review-badge">Needs review</span> : <span className="verified-badge"><Check size={11} /> verified</span>}</div><div className="transcript-text"><RichText content={segment.text} /></div></div>
    {!segment.provisional && <button className="transcript-more" aria-label={segment.status === 'review' ? `Mark segment ${segment.timestamp} verified` : `Mark segment ${segment.timestamp} for review`} onClick={() => onToggleReview(segment.id)}>...</button>}
  </article>
  );
});

// Settings: how much of the browser's storage is used, and whether the browser promised to keep it.
function StorageUsagePanel() {
  const [estimate, setEstimate] = useState<StorageEstimateInfo | null | undefined>(undefined);
  const [persistence, setPersistence] = useState<PersistentStorageState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void readStorageEstimate().then((value) => { if (!cancelled) setEstimate(value); });
    void readPersistentStorage().then((value) => { if (!cancelled) setPersistence(value); });
    return () => { cancelled = true; };
  }, []);
  const askToKeep = async () => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { storage = undefined; }
    setPersistence(await requestPersistentStorage(undefined, { force: true, storage }));
  };
  return (
    <div className="storage-usage" role="group" aria-label="Browser storage">
      <strong>Browser storage</strong>
      <p className="empty-state">{estimate === undefined ? 'Checking...' : estimate ? describeStorageUsage(estimate) : 'This browser does not say how much storage is used.'}</p>
      {estimate?.nearLimit && <p className="action-error" role="alert">Browser storage is almost full. Export the courses you want to keep (More, then Export course), then delete old courses or free up space. When it is full, new work cannot be saved.</p>}
      {persistence === 'granted' && <p className="empty-state">The browser has promised to keep your data when it runs short of space.</p>}
      {persistence === 'not-granted' && <p className="empty-state">The browser may clear this site's data when it runs short of space. You can ask it to keep your data; some browsers (Firefox, for instance) then show their own prompt. <button type="button" className="text-action" onClick={() => void askToKeep()}>Ask the browser to keep my data</button></p>}
    </div>
  );
}

// The transcript list is only built while the section is open: a long recording has hundreds of segments, each typeset
// as Markdown, and most visits to a course never open it.
/**
 * A link to a web page. In a browser it opens in a new tab. The desktop webview refuses every new-window request (see
 * docs/desktop.md, "Navigation guard"), and the app ships no vetted way to open the system browser, so there the address is
 * shown as text that can be selected and copied.
 */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!isNativeRuntime()) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  return <span className="external-link-text">{children} (<span className="external-link-address">{href}</span>)</span>;
}

function TranscriptDisclosure({ summary, children }: { summary: string; children: [() => ReactNode, ReactNode] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="transcript-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      {open ? children[0]() : null}
      {children[1]}
    </details>
  );
}

// The browser keeps the workspace in IndexedDB, which opens asynchronously. Nothing of the app is mounted before it has
// loaded, so there is no flash of an empty workspace and no effect can save an empty state over the real one. Where
// IndexedDB does not exist (and in the desktop shell, which has its own storage) the workspace is read synchronously, as before.
function WorkspaceLoading() {
  // A file dropped while the workspace opens must not make the browser open it and leave the app.
  useEffect(() => {
    const keepFilesHere = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', keepFilesHere);
    window.addEventListener('drop', keepFilesHere);
    return () => {
      window.removeEventListener('dragover', keepFilesHere);
      window.removeEventListener('drop', keepFilesHere);
    };
  }, []);
  // The live region is on screen before it has any text, so that screen readers announce the text once it is added.
  const [message, setMessage] = useState('');
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setMessage('Opening your workspace...');
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="app-shell workspace-loading">
      <span className="brand-name"><span className="brand-mark" aria-hidden="true"><BrandGlyph size={24} /></span>StudentLLM</span>
      <p className="empty-state" role="status" aria-live="polite">{message}{slow ? ' This is taking longer than usual. Close other StudentLLM tabs, then reload.' : ''}</p>
      {slow && <button type="button" className="text-action" onClick={() => window.location.reload()}>Reload</button>}
    </div>
  );
}

function App(props: AppProps) {
  const [bootstrap, setBootstrap] = useState<BrowserBootstrap | null>(() => (isNativeRuntime() || !shouldUseIndexedDb() ? openLocalStorageWorkspace(initialWorkspace) : null));
  // One opening per page, even when React runs the effect twice in development.
  const openingRef = useRef<Promise<BrowserBootstrap> | null>(null);
  useEffect(() => {
    if (bootstrap) return undefined;
    let cancelled = false;
    openingRef.current ??= openBrowserWorkspace(initialWorkspace).catch(() => openLocalStorageWorkspace(initialWorkspace));
    void openingRef.current.then((opened) => {
      if (!cancelled) setBootstrap(opened);
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);
  return bootstrap ? <WorkspaceApp {...props} bootstrap={bootstrap} /> : <WorkspaceLoading />;
}

function WorkspaceApp({ bootstrap, provider, recorderSessionFactory = requestRecorderSession, speechEngine, documentEngine, recordingChunkStore: recordingChunkStoreOverride, sourceBlobStore: sourceBlobStoreOverride, liveTranscriptionIntervalMs = 3_000 }: AppProps & { bootstrap: BrowserBootstrap }) {
  const [{ snapshot: workspace, issue: workspaceLoadIssue, store: workspaceStore, unavailable: storageUnavailable }] = useState(() => bootstrap);
  // A banner for the problems that must not go unnoticed: the workspace could not be read, saved, or changed in another window.
  const [storageNotice, setStorageNotice] = useState<StorageNotice | null>(() => workspaceLoadIssue
    ? { kind: 'load-issue', issue: workspaceLoadIssue }
    : storageUnavailable ? { kind: storageUnavailable.reason } : null);
  // While paused nothing is written, so a stale tab or a protected original cannot be overwritten.
  const savingPausedRef = useRef(Boolean(workspaceLoadIssue?.protect || storageUnavailable?.protect));
  const saveFailedRef = useRef(false);
  // The save in progress, so a stored original is only erased after the workspace that stopped listing it is stored.
  const lastSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  // Whether the workspace was read cleanly at the start: when it was not, "not listed" means "not read".
  const workspaceTrustedRef = useRef(!storageUnavailable && (!workspaceLoadIssue || workspaceLoadIssue.kind === 'older-copy'));
  // A deliberate reload (from the stale-tab banner) must not ask a second time.
  const skipUnloadWarningRef = useRef(false);
  const [saveTick, setSaveTick] = useState(0);
  // Imports whose file is already being stored but not yet listed in a course ("lessonId|resourceId").
  const inFlightImportsRef = useRef(new Set<string>());
  const [nativeStorageReady, setNativeStorageReady] = useState(() => !isNativeRuntime());
  const [lessons, setLessons] = useState(workspace.lessons);
  const [activeLessonId, setActiveLessonId] = useState(workspace.activeLessonId);
  const [view, setView] = useState<'course' | 'chat' | 'sources' | 'study'>('course');
  const [showLeftSidebar, setShowLeftSidebar] = useState(() => typeof window === 'undefined' || window.innerWidth > 900);
  const [expandedSubjects, setExpandedSubjects] = useState<Record<string, boolean>>(() => buildExpandedSubjectState(initialLessons));
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllResources, setShowAllResources] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizingRecording, setIsFinalizingRecording] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptSegment[]>([]);
  const [liveRecordingLessonId, setLiveRecordingLessonId] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingError, setRecordingError] = useState('');
  const [lessonWorkspaces, setLessonWorkspaces] = useState<Record<string, LessonWorkspace>>(() => workspace.lessonWorkspaces ?? {
    [workspace.activeLessonId]: {
      resources: workspace.resources,
      transcript: workspace.transcript,
      chat: workspace.chat,
      artifacts: workspace.artifacts,
    },
  });
  const [composerValue, setComposerValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [generatingArtifact, setGeneratingArtifact] = useState<ArtifactKind | null>(null);
  const [actionError, setActionError] = useState('');
  const [chatError, setChatError] = useState<{ lessonId: string; message: string } | null>(null);
  const activeLessonIdRef = useRef(activeLessonId);
  activeLessonIdRef.current = activeLessonId;
  // Long-running work (transcription, extraction) must read the workspace as it is when it finishes, not as it was when it started.
  const lessonWorkspacesRef = useRef(lessonWorkspaces);
  lessonWorkspacesRef.current = lessonWorkspaces;
  const toggleRecordingRef = useRef<() => Promise<void>>(async () => undefined);
  const lessonsRef = useRef(lessons);
  lessonsRef.current = lessons;
  // An import is no longer "in flight" once its source is listed in the course, or the course is gone.
  useEffect(() => {
    for (const key of [...inFlightImportsRef.current]) {
      const [lessonId, resourceId] = key.split('|');
      const listed = lessonWorkspaces[lessonId]?.resources.some((resource) => resource.id === resourceId);
      if (listed || !lessons.some((lesson) => lesson.id === lessonId)) inFlightImportsRef.current.delete(key);
    }
  }, [lessonWorkspaces, lessons]);
  const [liveTranscriptionError, setLiveTranscriptionError] = useState('');
  const [liveSettledThrough, setLiveSettledThrough] = useState(0);
  const startingRecorderRef = useRef(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(workspace.lessonWorkspaces?.[workspace.activeLessonId]?.artifacts[0]?.id ?? workspace.artifacts[0]?.id ?? null);
  const [toast, setToast] = useState('');
  const [pendingSourceRemoval, setPendingSourceRemoval] = useState<PendingSourceRemoval | null>(null);
  const pendingSourceRemovalRef = useRef<PendingSourceRemoval | null>(null);
  const flushSourceRemovalRef = useRef<() => void>(() => undefined);
  const [focusRestoredSourceId, setFocusRestoredSourceId] = useState<string | null>(null);
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [showDeleteCourse, setShowDeleteCourse] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [globalSearchValue, setGlobalSearchValue] = useState('');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const licensesOpenRef = useRef(false);
  licensesOpenRef.current = showLicenses;
  const [showRecordingNotice, setShowRecordingNotice] = useState(false);
  const [recordingNoticeChecked, setRecordingNoticeChecked] = useState(false);
  const [recordingNoticeAcknowledged, setRecordingNoticeAcknowledged] = useState(hasAcknowledgedRecordingNotice);
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [showEditCourse, setShowEditCourse] = useState(false);
  const [courseEditDraft, setCourseEditDraft] = useState({ title: '', subject: '', chapter: '', sublesson: '' });
  const [courseActionsOpen, setCourseActionsOpen] = useState(false);
  const [quickStartInput, setQuickStartInput] = useState('');
  const [quickStartSourceName, setQuickStartSourceName] = useState('');
  const [quickStartProposal, setQuickStartProposal] = useState<QuickStartProposal | null>(null);
  const [quickStartPlacement, setQuickStartPlacement] = useState('new');
  const [isAnalyzingQuickStart, setIsAnalyzingQuickStart] = useState(false);
  const [isSuggestingCourseDetails, setIsSuggestingCourseDetails] = useState(false);
  const [quickStartError, setQuickStartError] = useState('');
  const [compactTranscript, setCompactTranscript] = useState(() => loadPreference('compactTranscript', false));
  const [showVerifiedTranscript, setShowVerifiedTranscript] = useState(() => loadPreference('showVerifiedTranscript', true));
  const [darkMode, setDarkMode] = useState(() => {
    const initial = loadPreference('darkMode', false);
    document.documentElement.dataset.theme = initial ? 'dark' : 'light';
    return initial;
  });
  const [serviceSettings, setServiceSettings] = useState(loadServiceSettings);
  const [connectionsEnabled, setConnectionsEnabled] = useState(() => {
    try { return localStorage.getItem(SERVICES_STORAGE_KEY) !== null; } catch { return false; }
  });
  const [serviceDraft, setServiceDraft] = useState(serviceSettings);
  const aiFailure = (error: unknown, fallback?: string) => describeAiFailure(error, fallback, { cloud: usesNim(serviceSettings) });
  const [llmHealth, setLlmHealth] = useState('Not checked.');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sidecarHealth, setSidecarHealth] = useState<{ asr: SidecarHealth; documents: SidecarHealth } | null>(null);
  const [managedSidecars, setManagedSidecars] = useState<ManagedSidecarStatus[]>([]);
  const [isCheckingSidecars, setIsCheckingSidecars] = useState(false);
  const healthCheckRef = useRef<AbortController | null>(null);
  useEffect(() => () => { healthCheckRef.current?.abort(); }, []);
  const [transcribingResourceIds, setTranscribingResourceIds] = useState<Set<string>>(() => new Set());
  const [resourcePreview, setResourcePreview] = useState<ResourcePreview | null>(null);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseSubject, setNewCourseSubject] = useState('General');
  const [newCourseChapter, setNewCourseChapter] = useState('General notes');
  const recorderRef = useRef<RecorderSession | null>(null);
  const liveTranscriptFeedRef = useRef<HTMLDivElement | null>(null);
  const storageIssueRef = useRef<WorkspaceStorageError['operation'] | null>(null);
  const resourcePreviewRequest = useRef(0);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // A folder import creates each course when its file starts importing, not all up front: a reload or crash in the middle
  // then leaves no empty courses for the files that were never reached.
  const [importQueue, setImportQueue] = useState<Array<{ file: File; lesson: Lesson }>>([]);
  const batchLessonIdsRef = useRef(new Set<string>());
  const activateNextBatchLessonRef = useRef(false);
  const [importTotals, setImportTotals] = useState<{ done: number; total: number } | null>(null);
  const importRunningRef = useRef(false);
  const courseActionsRef = useRef<HTMLDetailsElement | null>(null);
  const courseActionsSummaryRef = useRef<HTMLElement | null>(null);
  const startedImportRef = useRef<{ file: File; lesson: Lesson } | null>(null);
  const rebuiltDocumentSourceIds = useRef(new Set<string>());
  // Pages already extracted at import, so the AI rewrite does not OCR the same scan again.
  const extractedDocumentPages = useRef(new Map<string, DocumentPage[]>());
  const semanticReviewAttemptedIds = useRef(new Set<string>());
  const semanticReviewRunning = useRef(false);
  const [semanticReviewTick, setSemanticReviewTick] = useState(0);
  const localProvider = useMemo(() => {
    if (provider !== undefined) return provider;
    const connection = llmConnection(serviceSettings);
    if (!connection.baseUrl) return null;
    const created = createLocalLLMProvider({ MODE: import.meta.env.MODE, VITE_LM_STUDIO_AUTO_CONNECT: connectionsEnabled ? 'true' : import.meta.env.VITE_LM_STUDIO_AUTO_CONNECT, VITE_LM_STUDIO_BASE_URL: connection.baseUrl, VITE_LM_STUDIO_MODEL: connection.model }, usesNim(serviceSettings) ? { chatTemplateKwargs: nimChatTemplateKwargs(connection.model) } : {});
    // The NIM proxy exposes no embeddings route, so retrieval keeps its lexical ranking instead of a doomed request.
    if (created && usesNim(serviceSettings)) return { generate: created.generate.bind(created), supportsStructuredOutputs: created.supportsStructuredOutputs };
    return created;
  }, [provider, serviceSettings, connectionsEnabled]);
  const localSpeechEngine = useMemo(() => speechEngine === undefined ? createLocalSpeechEngine({ VITE_LOCAL_ASR_BASE_URL: serviceSettings.asrUrl, VITE_LOCAL_ASR_LANGUAGE: import.meta.env.VITE_LOCAL_ASR_LANGUAGE }) : speechEngine, [speechEngine, serviceSettings]);
  const localDocumentEngine = useMemo(() => documentEngine === undefined ? createLocalDocumentEngine({ VITE_LOCAL_DOCUMENT_BASE_URL: serviceSettings.documentsUrl }) : documentEngine, [documentEngine, serviceSettings]);
  const sourceBlobStore = useMemo(() => sourceBlobStoreOverride ?? createSourceBlobStore(), [sourceBlobStoreOverride]);
  const recordingChunkStore = useMemo(() => recordingChunkStoreOverride ?? createRecordingChunkStore(), [recordingChunkStoreOverride]);
  const hasOpenDialog = Boolean(resourcePreview || showNewCourse || showDeleteCourse || showGlobalSearch || showReviewPanel || showTranscriptPanel || showSettingsPanel || showLicenses || showQuickStart || showEditCourse);

  const reportStorageError = (error: WorkspaceStorageError) => {
    console.warn(`[workspace-storage:${error.operation}] ${error.message}`);
    if (storageIssueRef.current === error.operation) return;
    storageIssueRef.current = error.operation;
    setToast(error.operation === 'load'
      ? 'Native workspace storage unavailable. Using local fallback.'
      : 'Native workspace save failed. Changes remain in local fallback.');
  };

  // Stores the workspace and keeps the alerts honest: a full or blocked store used to lose everything since the last good save.
  const persistWorkspace = (snapshot: WorkspaceSnapshot): Promise<boolean> => {
    const saving = (isNativeRuntime()
      ? saveWorkspaceAsync(snapshot, undefined, { onError: reportStorageError })
      : workspaceStore.save(snapshot)
    ).then((saved) => {
      saveFailedRef.current = !saved;
      setStorageNotice((current) => saved
        ? (current?.kind === 'save-failed' ? null : current)
        : (current?.kind === 'changed-elsewhere' ? current : { kind: 'save-failed', ...(!isNativeRuntime() && workspaceStore.lastFailure === 'too-large' ? { tooLarge: true } : {}) }));
      return saved;
    });
    lastSaveRef.current = saving;
    return saving;
  };

  const eraseOperations: EraseOperations = {
    removeBlob: (sourceId) => sourceBlobStore.remove(sourceId),
    clearChunks: (recordingId) => recordingChunkStore.clear(recordingId),
    forget: removePendingSourceErase,
    remember: addPendingSourceErase,
  };

  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0] ?? emptyLesson;
  const hasCourse = Boolean(activeLesson.id);
  const activeWorkspace = lessonWorkspaces[activeLessonId] ?? emptyLessonWorkspace;
  const { resources, transcript, chat, artifacts } = activeWorkspace;
  const hasStudyMaterial = transcript.length > 0 || resources.some(isTextResource);

  const updateLessonWorkspace = (lessonId: string, update: (current: LessonWorkspace) => LessonWorkspace) => {
    setLessonWorkspaces((current) => {
      const lesson = lessonsRef.current.find((item) => item.id === lessonId);
      // A course deleted while an import or transcription was still running must not be brought back as an orphan workspace.
      if (!current[lessonId] && !lesson) return current;
      const previous = current[lessonId] ?? emptyLessonWorkspace;
      const next = update(previous);
      const hasDocumentNote = next.courseNote?.blocks?.some((block) => block.id === 'document-source-title');
      // Rebuild the deterministic note when it is not AI-written or the set of segments changed; status-only edits (review toggles) keep an AI note.
      const segmentIds = (items: TranscriptSegment[]) => items.map((segment) => segment.id).join('\u0000');
      const needsRebuild = next.courseNote?.detection.method !== 'LM Studio' || segmentIds(next.transcript) !== segmentIds(previous.transcript);
      return {
        ...current,
        [lessonId]: lesson && next.transcript !== previous.transcript && needsRebuild && !hasDocumentNote
          ? { ...next, courseNote: buildCourseNote(lesson, next.transcript) }
          : next,
      };
    });
  };

  const updateActiveWorkspace = (update: (current: LessonWorkspace) => LessonWorkspace) => updateLessonWorkspace(activeLessonId, update);

  async function formatPlacedCourseNote<T extends { targetLesson: Lesson; lessonWorkspaces: Record<string, LessonWorkspace> }>(placement: T): Promise<T> {
    if (!localProvider) return placement;
    const workspace = placement.lessonWorkspaces[placement.targetLesson.id] ?? emptyLessonWorkspace;
    const formatted = await formatCourseNoteWithProvider(placement.targetLesson, workspace.transcript, localProvider);
    if (formatted.detection.method !== 'LM Studio') return placement;
    return {
      ...placement,
      lessonWorkspaces: {
        ...placement.lessonWorkspaces,
        [placement.targetLesson.id]: { ...workspace, courseNote: formatted },
      },
    };
  }

  const commitPlacedCourse = (
    placement: { targetLesson: Lesson; lessonWorkspaces: Record<string, LessonWorkspace> },
    sourceLessonId: string,
    resource: Resource,
    segments: TranscriptSegment[],
  ) => {
    const targetLessonId = placement.targetLesson.id;
    const incomingIds = new Set(segments.map((segment) => segment.id));
    setLessons((current) => {
      if (!current.some((lesson) => lesson.id === sourceLessonId)) return current;
      if (current.some((lesson) => lesson.id === targetLessonId)) return current;
      return [placement.targetLesson, ...current];
    });
    setLessonWorkspaces((current) => {
      if (!current[sourceLessonId]) return current;
      const sourceWorkspace = current[sourceLessonId] ?? emptyLessonWorkspace;
      const targetWorkspace = current[targetLessonId] ?? emptyLessonWorkspace;
      const sourceIsTarget = sourceLessonId === targetLessonId;
      const targetTranscript = Array.from(new Map([...targetWorkspace.transcript, ...segments].map((segment) => [segment.id, segment])).values());
      const snapshotTargetWorkspace = placement.lessonWorkspaces[targetLessonId];
      const snapshotTargetIds = new Set(snapshotTargetWorkspace?.transcript.map((segment) => segment.id) ?? []);
      const targetChangedWhilePending = targetWorkspace.transcript.some((segment) => !snapshotTargetIds.has(segment.id));
      const formattedCourseNote = snapshotTargetWorkspace?.courseNote;
      const nextTargetWorkspace: LessonWorkspace = {
        ...targetWorkspace,
        resources: Array.from(new Map([...targetWorkspace.resources, resource].map((item) => [item.id, item])).values()),
        transcript: targetTranscript,
        // Keep only a real AI or document note from the snapshot; otherwise rebuild the deterministic note so imported text shows even when the provider failed.
        courseNote: !targetChangedWhilePending && formattedCourseNote
          && (formattedCourseNote.detection.method === 'LM Studio' || formattedCourseNote.blocks.some((block) => block.id === 'document-source-title'))
          ? formattedCourseNote
          : buildCourseNote(placement.targetLesson, targetTranscript),
      };
      if (sourceIsTarget) return { ...current, [targetLessonId]: nextTargetWorkspace };
      return {
        ...current,
        [sourceLessonId]: {
          ...sourceWorkspace,
          resources: sourceWorkspace.resources.filter((candidate) => candidate.id !== resource.id),
          transcript: sourceWorkspace.transcript.filter((segment) => segment.sourceId !== resource.id && !incomingIds.has(segment.id)),
          courseNote: buildCourseNote(
            lessons.find((lesson) => lesson.id === sourceLessonId) ?? placement.targetLesson,
            sourceWorkspace.transcript.filter((segment) => segment.sourceId !== resource.id && !incomingIds.has(segment.id)),
          ),
        },
        [targetLessonId]: nextTargetWorkspace,
      };
    });
  };

  const formatExistingCourseNote = (lessonId: string, candidateTranscript: TranscriptSegment[]) => {
    if (!localProvider || !candidateTranscript.length) return;
    const lesson = lessons.find((item) => item.id === lessonId);
    if (!lesson) return;
    void formatCourseNoteWithProvider(lesson, candidateTranscript, localProvider).then((formatted) => {
      if (formatted.detection.method !== 'LM Studio') return;
      setLessonWorkspaces((current) => {
        const workspace = current[lessonId] ?? emptyLessonWorkspace;
        const currentIds = JSON.stringify(workspace.transcript);
        const candidateIds = JSON.stringify(candidateTranscript);
        if (currentIds !== candidateIds) return current;
        return { ...current, [lessonId]: { ...workspace, courseNote: formatted } };
      });
    }).catch(() => undefined);
  };

  const visibleLessons = useMemo(() => {
    const normalizedQuery = foldForSearch(searchQuery.trim());
    if (!normalizedQuery) return lessons;
    return lessons.filter((lesson) => foldForSearch(`${lesson.subject} ${lesson.chapter} ${lesson.title}`).includes(normalizedQuery));
  }, [lessons, searchQuery]);

  const courseTree = useMemo<CourseTreeSubject[]>(() => buildCourseTree(visibleLessons), [visibleLessons]);
  const subjectOptions = useMemo(
    () => Array.from(new Set(lessons.map((lesson) => lesson.subject))).sort((left, right) => left.localeCompare(right)),
    [lessons],
  );

  const activeResources = useMemo(() => {
    return showAllResources ? resources : resources.slice(0, 3);
  }, [activeLesson.id, resources, showAllResources]);

  const reviewItems = useMemo(() => lessons.flatMap((lesson) =>
    (lessonWorkspaces[lesson.id]?.transcript ?? [])
      .filter((segment) => segment.status === 'review')
      .map((segment) => ({ lesson, segment }))), [lessons, lessonWorkspaces]);

  const globalSearchResults = useMemo(() => {
    const query = foldForSearch(globalSearchValue.trim());
    if (!query) return [];
    return lessons.flatMap((lesson) => {
      const lessonWorkspace = lessonWorkspaces[lesson.id] ?? emptyLessonWorkspace;
      const results: { id: string; lessonId: string; title: string; detail: string }[] = [];
      if (foldForSearch(`${lesson.title} ${lesson.subject} ${lesson.chapter}`).includes(query)) {
        results.push({ id: lesson.id, lessonId: lesson.id, title: lesson.title, detail: `${lesson.subject} · ${lesson.chapter}` });
      }
      lessonWorkspace.transcript.forEach((segment) => {
        if (foldForSearch(`${segment.speaker} ${segment.timestamp}`).includes(query) || textMatchesQuery(segment.text, query)) {
          results.push({ id: segment.id, lessonId: lesson.id, title: segment.text, detail: `${lesson.title} · ${segment.timestamp}` });
        }
      });
      lessonWorkspace.resources.forEach((resource) => {
        if (foldForSearch(`${resource.name} ${resource.meta}`).includes(query)) {
          results.push({ id: resource.id, lessonId: lesson.id, title: resource.name, detail: `${lesson.title} · ${resource.meta}` });
        }
      });
      return results;
    }).slice(0, 20);
  }, [globalSearchValue, lessons, lessonWorkspaces]);

  useEffect(() => {
    setExpandedSubjects((current) => {
      const next = { ...current };
      let changed = false;
      for (const lesson of lessons) {
        if (next[lesson.subject] === undefined) {
          next[lesson.subject] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [lessons]);

  useEffect(() => {
    if (!isRecording) return undefined;
    const interval = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording || !localSpeechEngine) {
      if (!isRecording) setLiveTranscript([]);
      return undefined;
    }
    const session = recorderRef.current;
    if (!session?.stream || session.durability !== 'durable') return undefined;
    let cancelled = false;
    let inFlight = false;
    let fromSeconds = 0;
    let lastAudioEnd = -1;
    let lastChunkCount = -1;
    let previewSegments: TranscriptSegment[] = [];
    const controller = new AbortController();
    const transcribeLatestAudio = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const window = session.readPreviewWindow?.(fromSeconds);
        let audio: Blob;
        if (session.readPreviewWindow) {
          if (!window || window.end <= lastAudioEnd) return;
          audio = window.audio;
        } else {
          // Compatibility for browsers without AudioWorklet. Never grow live uploads indefinitely.
          const chunks = await session.readChunks();
          if (cancelled || !chunks.length || chunks.length === lastChunkCount) return;
          if (chunks.length > 60) {
            setLiveTranscriptionError('This browser cannot stream bounded audio previews. Audio is saved; full transcription runs after stopping. Use a browser with AudioWorklet support for live notes.');
            return;
          }
          lastChunkCount = chunks.length;
          audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
        }
        const transcription = await localSpeechEngine.transcribe(audio, { ...(window ? { mode: 'preview' as const } : {}), signal: controller.signal });
        if (cancelled) return;
        if (window) {
          const merged = mergeLiveWindow(previewSegments, transcription.segments, window, session.recordingId);
          previewSegments = merged.segments;
          setLiveTranscript(previewSegments);
          setLiveTranscriptionError(window.start > fromSeconds + 1 ? 'Live transcription fell behind. The complete audio is saved for final transcription.' : '');
          fromSeconds = merged.nextStart;
          setLiveSettledThrough(merged.nextStart);
          lastAudioEnd = window.end;
        } else {
          setLiveTranscript(transcription.segments.map((segment, index) => ({
            ...segment,
            id: `${session.recordingId}:live:${segment.id || index}`,
            sourceId: session.recordingId,
            provisional: true,
            status: 'review' as const,
          })));
          setLiveTranscriptionError('');
        }
      } catch {
        lastChunkCount = -1;
        if (!cancelled) setLiveTranscriptionError('Live transcription is unavailable. Audio is still recording. Check the speech service in Settings.');
      } finally {
        inFlight = false;
      }
    };
    void transcribeLatestAudio();
    const interval = window.setInterval(() => void transcribeLatestAudio(), Math.max(liveTranscriptionIntervalMs, 250));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      setLiveTranscript([]);
      setLiveSettledThrough(0);
    };
  }, [isRecording, liveTranscriptionIntervalMs, localSpeechEngine]);

  const [narrowViewport, setNarrowViewport] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900);
  useEffect(() => {
    const onResize = () => setNarrowViewport(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const drawerOpen = showLeftSidebar && narrowViewport;
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerFocusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const drawer = drawerRef.current;
    const first = drawer?.querySelector<HTMLElement>(drawerFocusableSelector);
    first?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        window.setTimeout(() => menuButtonRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
      // Choosing a course unmounts the focused button; keep focus on a stable control.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) menuButtonRef.current?.focus();
      }, 0);
    };
  }, [drawerOpen]);
  const trapDrawerTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!drawerOpen || event.key !== 'Tab') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(drawerFocusableSelector)).filter((item) => !item.hidden && !item.closest('[hidden]') && !(item as HTMLInputElement).disabled);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const viewTabIds = ['course', 'sources', 'chat', 'study'] as const;
  const onViewTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = viewTabIds.indexOf(view as typeof viewTabIds[number]);
    const next = event.key === 'ArrowRight' ? (current + 1) % viewTabIds.length
      : event.key === 'ArrowLeft' ? (current - 1 + viewTabIds.length) % viewTabIds.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? viewTabIds.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setCourseActionsOpen(false);
    setView(viewTabIds[next]);
    setActionError('');
    document.getElementById(`view-tab-${viewTabIds[next]}`)?.focus();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setShowNewCourse(true);
      }
      if (event.key === 'Escape') {
        // A licences dialog stacked on Settings closes alone; a second Escape closes Settings.
        if (licensesOpenRef.current) {
          setShowLicenses(false);
          return;
        }
        setShowNewCourse(false);
        setShowDeleteCourse(false);
        setShowGlobalSearch(false);
        setShowReviewPanel(false);
        setShowTranscriptPanel(false);
        setShowSettingsPanel(false);
        setShowLicenses(false);
        setShowQuickStart(false);
        setShowEditCourse(false);
        setResourcePreview(null);
        if (window.innerWidth <= 900) setShowLeftSidebar(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useDialogFocus(hasOpenDialog, showLicenses ? 'licenses' : 'main');
  useDismissibleMenu(courseActionsOpen, courseActionsRef, () => setCourseActionsOpen(false), courseActionsSummaryRef, hasOpenDialog);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  // Erase originals of sources removed in an earlier session whose undo window never closed (reload, crash, closed tab).
  useEffect(() => {
    if (!nativeStorageReady) return;
    // Entries younger than the undo window plus margin may belong to another tab that can still undo; a later start sweeps them.
    const stale = listPendingSourceErases().filter((entry) => isStalePendingSourceErase(entry) && entry.id !== pendingSourceRemovalRef.current?.resource.id);
    if (!stale.length) return;
    const referenced = new Set(Object.values(lessonWorkspaces).flatMap((item) => item.resources.map((resource) => resource.id)));
    // A workspace that was not read cleanly lists nothing it did not manage to read: erase nothing, keep every entry.
    void sweepPendingErases(stale, { referencedIds: referenced, workspaceTrusted: workspaceTrustedRef.current && !savingPausedRef.current }, eraseOperations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeStorageReady, sourceBlobStore, recordingChunkStore]);

  // Finalize a removal that is still in its undo window when the page is hidden or the app unmounts.
  useEffect(() => {
    const onPageHide = () => flushSourceRemovalRef.current();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushSourceRemovalRef.current();
    };
  }, []);

  // Remember the note as it stands right after the removal, so Undo can tell whether it was changed during the window.
  useEffect(() => {
    const pending = pendingSourceRemovalRef.current;
    if (pending && pending.noteAfterRemoval === undefined) pending.noteAfterRemoval = lessonWorkspaces[pending.lessonId]?.courseNote;
  }, [lessonWorkspaces, pendingSourceRemoval]);

  // After Undo, hand keyboard focus back to the restored source (or the Sources tab when it is not on screen).
  useEffect(() => {
    if (!focusRestoredSourceId) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>('[data-resource-id]')).find((element) => element.dataset.resourceId === focusRestoredSourceId)
      ?? document.getElementById('view-tab-sources');
    target?.focus();
    setFocusRestoredSourceId(null);
  }, [focusRestoredSourceId, resources, view]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ compactTranscript, showVerifiedTranscript, darkMode }));
    } catch {
      // Preferences remain session-scoped when browser storage is unavailable.
    }
  }, [compactTranscript, showVerifiedTranscript, darkMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
  }, [darkMode]);

  // Slide the active-tab pill to the selected course view.
  const viewTabsRef = useRef<HTMLDivElement>(null);
  const placeTabIndicator = () => {
    const list = viewTabsRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !active) return;
    list.style.setProperty('--tab-x', `${active.offsetLeft}px`);
    list.style.setProperty('--tab-w', `${active.offsetWidth}px`);
    if (!list.dataset.ready) requestAnimationFrame(() => { list.dataset.ready = 'true'; });
  };
  useLayoutEffect(() => {
    const list = viewTabsRef.current;
    if (!list) return;
    placeTabIndicator();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(placeTabIndicator);
    observer.observe(list);
    list.querySelectorAll('[role="tab"]').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [view, hasCourse]);

  useEffect(() => {
    if (showSettingsPanel) void checkSidecars();
  }, [showSettingsPanel]);

  useEffect(() => {
    if (!isNativeRuntime()) return undefined;

    let cancelled = false;
    void loadWorkspaceAsync(initialWorkspace, undefined, {
      onError: reportStorageError,
      onUnreadable: (issue) => {
        if (issue.protect) savingPausedRef.current = true;
        setStorageNotice({ kind: 'load-issue', issue });
      },
    }).then((loaded) => {
      if (cancelled) return;
      const loadedWorkspaces = loaded.lessonWorkspaces ?? {
        [loaded.activeLessonId]: {
          resources: loaded.resources,
          transcript: loaded.transcript,
          chat: loaded.chat,
          artifacts: loaded.artifacts,
        },
      };
      setLessons(loaded.lessons);
      setActiveLessonId(loaded.activeLessonId);
      setLessonWorkspaces(loadedWorkspaces);
      setSelectedArtifactId(loadedWorkspaces[loaded.activeLessonId]?.artifacts[0]?.id ?? loaded.artifacts[0]?.id ?? null);
      setNativeStorageReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!localDocumentEngine || semanticReviewRunning.current || importQueue.length) return undefined;
    const attemptKey = (resourceId: string) => `${resourceId}:${localProvider ? 'model' : 'layout'}`;
    const candidate = lessons.flatMap((lesson) => {
      const workspace = lessonWorkspaces[lesson.id] ?? emptyLessonWorkspace;
      const noteNeedsSemanticReview = Boolean(localProvider
        && hasCurrentDocumentNote(workspace)
        && workspace.courseNote?.detection.method !== 'LM Studio'
        && !workspace.courseNote?.blocks.some((block) => block.type === 'markdown'));
      if (hasCurrentDocumentNote(workspace) && !noteNeedsSemanticReview) return [];
      return workspace.resources.flatMap((resource) => {
        const isExtractable = isExtractableDocument(resource);
        const pending = noteNeedsSemanticReview || !rebuiltDocumentSourceIds.current.has(resource.id);
        return isExtractable && pending && !semanticReviewAttemptedIds.current.has(attemptKey(resource.id)) ? [{ lesson, resource }] : [];
      });
    })[0];
    if (!candidate) return undefined;

    rebuiltDocumentSourceIds.current.add(candidate.resource.id);
    semanticReviewAttemptedIds.current.add(attemptKey(candidate.resource.id));
    semanticReviewRunning.current = true;
    void (async () => {
      try {
        let pages = extractedDocumentPages.current.get(candidate.resource.id);
        if (!pages) {
          const source = await sourceBlobStore.load(candidate.resource.id);
          if (!source) {
            rebuiltDocumentSourceIds.current.delete(candidate.resource.id);
            return;
          }
          pages = (await localDocumentEngine.extract(source)).pages;
        }
        if (!pages.some((page) => page.text.trim())) {
          rebuiltDocumentSourceIds.current.delete(candidate.resource.id);
          return;
        }
        const formattedNote = await formatDocumentCourseNoteWithProvider(candidate.lesson, pages, candidate.resource.name, localProvider);
        setLessonWorkspaces((current) => {
          const workspace = current[candidate.lesson.id] ?? emptyLessonWorkspace;
          const hasLayoutNote = hasCurrentDocumentNote(workspace);
          const hasResource = workspace.resources.some((resource) => resource.id === candidate.resource.id);
          if ((hasLayoutNote && formattedNote.detection.method !== 'LM Studio') || !hasResource) return current;
          return {
            ...current,
            [candidate.lesson.id]: {
              ...workspace,
              courseNote: formattedNote,
            },
          };
        });
      } catch {
        rebuiltDocumentSourceIds.current.delete(candidate.resource.id);
      } finally {
        extractedDocumentPages.current.delete(candidate.resource.id);
        semanticReviewRunning.current = false;
        setSemanticReviewTick((tick) => tick + 1);
      }
    })();
  }, [lessonWorkspaces, lessons, localDocumentEngine, localProvider, sourceBlobStore, semanticReviewTick, importQueue.length]);

  useEffect(() => {
    if (!nativeStorageReady || savingPausedRef.current) return;
    void persistWorkspace({ activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeStorageReady, activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces, saveTick]);

  // Another tab or window wrote the workspace (or the browser data was cleared). Saving from this stale copy would
  // overwrite that work, so stop saving here and ask for a reload. Where the workspace is in IndexedDB the store tells
  // the tabs through a BroadcastChannel and refuses a stale save itself; on the localStorage path it is the `storage` event.
  useEffect(() => {
    if (isNativeRuntime()) return undefined;
    return workspaceStore.onChangedElsewhere(() => {
      savingPausedRef.current = true;
      setStorageNotice({ kind: 'changed-elsewhere' });
    });
  }, [workspaceStore]);

  // The last state is handed to the store when the page is hidden or closed: the write is asynchronous, so this closes the
  // window between a change and its effect. It is a best effort; a state that was already stored is not written again.
  const latestSnapshotRef = useRef<WorkspaceSnapshot>({ activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces });
  latestSnapshotRef.current = { activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces };
  const persistWorkspaceRef = useRef(persistWorkspace);
  persistWorkspaceRef.current = persistWorkspace;
  useEffect(() => {
    if (isNativeRuntime()) return undefined;
    const flush = () => {
      if (nativeStorageReady && !savingPausedRef.current) void persistWorkspaceRef.current(latestSnapshotRef.current);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [nativeStorageReady]);

  // Closing the tab during an import, a transcription or a recording is the one way to lose work in progress.
  // The same goes for changes that are not being saved: a stale tab, a full store, or a protected original.
  const changesAtRisk = storageNotice?.kind === 'save-failed' || storageNotice?.kind === 'changed-elsewhere' || storageNotice?.kind === 'indexeddb-blocked'
    || (storageNotice?.kind === 'load-issue' && storageNotice.issue.protect && lessons.length > 0);
  const workInProgress = importQueue.length > 0 || transcribingResourceIds.size > 0 || isRecording || isFinalizingRecording || changesAtRisk;
  useEffect(() => {
    if (!workInProgress) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      if (skipUnloadWarningRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [workInProgress]);

  useEffect(() => {
    if (!packagedIpcSmokeRequested || !nativeStorageReady) return;

    void (async () => {
      try {
        await saveWorkspaceAsync(
          { activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces },
          undefined,
          { onError: reportStorageError },
        );
        await runPackagedIpcSmoke();
      } catch (error) {
        console.error(`[packaged-ipc-smoke] ${error instanceof Error ? error.message : error}`);
      }
    })();
  }, [nativeStorageReady]);

  useEffect(() => {
    // While saving is paused or failing, this tab's workspace is not the saved one: a manifest whose course "does not exist"
    // here may belong to a workspace that could not be loaded, and a recovered source would not be written down.
    if (!nativeStorageReady || savingPausedRef.current || saveFailedRef.current) return undefined;
    // While the workspace has a load problem (unreadable, partly read, copy kept) a course "that does not exist" may only
    // be one that was not read. The manifests wait until the student has decided what to do.
    if (storageNotice?.kind === 'load-issue') return undefined;

    let cancelled = false;
    const pendingRecordings = listPendingRecordings();
    if (!pendingRecordings.length) return undefined;

    void (async () => {
      for (const pending of pendingRecordings) {
        const lesson = lessons.find((item) => item.id === pending.lessonId);
        if (!lesson) {
          // The course is not in this workspace. That is normal for a deleted course, but also for a workspace that was
          // replaced by an empty one (an unreadable copy kept, "Start empty anyway"). A manifest is only forgotten when no
          // audio is left to recover, so the recording can still be found from the saved copy.
          try {
            if (await recordingChunkStore.count(pending.recordingId) === 0) removePendingRecording(pending.recordingId);
          } catch {
            // Keep the manifest.
          }
          continue;
        }

        try {
          const chunks = await recordingChunkStore.list(pending.recordingId);
          if (cancelled) return;
          if (!chunks.length) {
            removePendingRecording(pending.recordingId);
            continue;
          }

          setLessonWorkspaces((current) => {
            const lessonWorkspace = current[pending.lessonId] ?? emptyLessonWorkspace;
            if (lessonWorkspace.resources.some((resource) => resource.id === pending.recordingId)) return current;
            return {
              ...current,
              [pending.lessonId]: {
                ...lessonWorkspace,
                resources: [{
                  id: pending.recordingId,
                  name: `${lesson.title} audio.webm`,
                  meta: `Recovered audio · ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`,
                  kind: 'audio',
                  mimeType: chunks[0].blob.type || 'audio/webm',
                  sizeBytes: chunks.reduce((total, chunk) => total + chunk.blob.size, 0),
                }, ...lessonWorkspace.resources],
              },
            };
          });
          removePendingRecording(pending.recordingId);
          setToast(`${chunks.length} audio chunk${chunks.length === 1 ? '' : 's'} recovered from an interrupted session.`);
        } catch {
          // Keep the manifest so a later launch can retry recovery.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lessons, nativeStorageReady, recordingChunkStore, storageNotice?.kind === 'load-issue']);

  useEffect(() => () => {
    void recorderRef.current?.stop();
  }, []);

  const notify = (message: string) => setToast(message);

  const resetQuickStart = () => {
    setQuickStartInput('');
    setQuickStartSourceName('');
    setQuickStartProposal(null);
    setQuickStartPlacement('new');
    setQuickStartError('');
    setIsAnalyzingQuickStart(false);
  };

  const openAiOrganizer = () => {
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      notify('Stop and save the recording before using Quick Start.');
      return;
    }
    resetQuickStart();
    setShowQuickStart(true);
  };

  const analyzeQuickStartInput = async (event: FormEvent) => {
    event.preventDefault();
    if (isAnalyzingQuickStart) return;
    setQuickStartError('');
    setIsAnalyzingQuickStart(true);
    try {
      const proposal = await analyzeQuickStart(quickStartInput, lessons, localProvider);
      setQuickStartProposal(proposal);
      setQuickStartPlacement(proposal.targetCourseId ?? 'new');
    } catch (error) {
      setQuickStartError(aiFailure(error, 'Quick Start could not analyze this material.'));
    } finally {
      setIsAnalyzingQuickStart(false);
    }
  };

  const applyQuickStart = async () => {
    if (!quickStartProposal || !quickStartInput.trim() || isRecording || isFinalizingRecording || isStartingRecording) return;
    const proposal = quickStartProposal;
    const targetExisting = quickStartPlacement === 'new' ? undefined : lessons.find((lesson) => lesson.id === quickStartPlacement);
    const targetLesson: Lesson = targetExisting ?? {
      id: `lesson-${crypto.randomUUID()}`,
      subject: proposal.subject.trim() || proposal.course.trim() || 'General',
      chapter: proposal.lesson.trim() || 'General notes',
      title: proposal.title.trim() || proposal.sublesson.trim() || proposal.lesson.trim() || proposal.course.trim() || 'Course notes',
      ...(proposal.sublesson.trim() ? { sublesson: proposal.sublesson.trim() } : {}),
      teacher: '',
      duration: '00:00:00',
      date: new Date().toLocaleDateString('en-GB'),
      progress: 0,
    };
    const sourceName = quickStartSourceName.trim() || `${targetLesson.title || 'quick-start-notes'}.md`;
    const resource: Resource = {
      id: `quick-start-${crypto.randomUUID()}`,
      name: sourceName.toLowerCase().endsWith('.md') ? sourceName : `${sourceName}.md`,
      meta: 'Quick Start notes · text source',
      kind: 'transcript',
      mimeType: 'text/markdown',
      sizeBytes: new Blob([quickStartInput.trim()]).size,
    };
    const segment: TranscriptSegment = {
      id: `${resource.id}:text`,
      sourceId: resource.id,
      timestamp: 'Quick start',
      speaker: resource.name,
      text: quickStartInput.trim(),
      status: 'review',
    };
    try {
      await sourceBlobStore.save(resource.id, new Blob([segment.text], { type: 'text/markdown;charset=utf-8' }));
      const previous = lessonWorkspacesRef.current[targetLesson.id] ?? emptyLessonWorkspace;
      const nextTranscript = mergeSegments(previous.transcript, [segment]);
      const baseNote = buildCourseNote(targetLesson, nextTranscript);
      const routedNote = {
        ...baseNote,
        subject: targetLesson.subject,
        chapter: targetLesson.chapter,
        folderPath: ['Courses', targetLesson.subject, targetLesson.chapter, targetLesson.title],
        detection: {
          method: 'LM Studio' as const,
          confidence: proposal.confidence,
          basis: `Quick Start classified this material: ${proposal.rationale}`,
        },
      };
      const aiNote = await formatCourseNoteWithProvider(targetLesson, nextTranscript, localProvider);
      const courseNote = aiNote.detection.method === 'LM Studio' ? aiNote : routedNote;
      // The model call above can take minutes: merge into the course as it is now, not as it was before the call.
      setLessonWorkspaces((current) => {
        if (targetExisting && !current[targetLesson.id]) return current;
        const base = current[targetLesson.id] ?? emptyLessonWorkspace;
        const transcriptNow = mergeSegments(base.transcript, [segment]);
        const unchangedMeanwhile = base.transcript.length === previous.transcript.length && base.transcript.every((item, index) => item.id === previous.transcript[index]?.id);
        return {
          ...current,
          [targetLesson.id]: {
            ...base,
            resources: base.resources.some((item) => item.id === resource.id) ? base.resources : [resource, ...base.resources],
            transcript: transcriptNow,
            courseNote: unchangedMeanwhile ? courseNote : buildCourseNote(targetLesson, transcriptNow),
          },
        };
      });
      if (!targetExisting) {
        setExpandedSubjects((expanded) => ({ ...expanded, [targetLesson.subject]: true }));
        setLessons((current) => [targetLesson, ...current]);
      }
      setActiveLessonId(targetLesson.id);
      setSelectedArtifactId(previous.artifacts[0]?.id ?? null);
      setView('course');
      setShowAllResources(false);
      setShowQuickStart(false);
      resetQuickStart();
      setActionError('');
      if (window.innerWidth <= 900) setShowLeftSidebar(false);
      notify(targetExisting ? `Quick Start added to ${targetLesson.title}.` : `Quick Start created ${targetLesson.title}.`);
    } catch (error) {
      setQuickStartError(error instanceof Error ? error.message : 'Quick Start could not save this source.');
    }
  };

  const selectLesson = (lessonId: string) => {
    if (isRecording || isFinalizingRecording || isStartingRecording) { notify('Stop and save the recording before switching courses.'); return; }
    setActionError('');
    if (window.innerWidth <= 900) setShowLeftSidebar(false);
    setActiveLessonId(lessonId);
    setView('course');
    setShowAllResources(false);
    setSelectedArtifactId(lessonWorkspaces[lessonId]?.artifacts[0]?.id ?? null);
  };

  const openSearchResult = (lessonId: string) => {
    selectLesson(lessonId);
    setShowGlobalSearch(false);
    setGlobalSearchValue('');
  };

  const visibleTranscript = showVerifiedTranscript
    ? transcript
    : transcript.filter((segment) => segment.status === 'review');
  const visibleLiveTranscript = liveRecordingLessonId === activeLessonId
    ? liveTranscript
    : [];
  const courseTranscript = [...visibleTranscript, ...visibleLiveTranscript];
  const noteTranscript = [...visibleTranscript, ...visibleLiveTranscript];
  const liveDraft = useLiveNotes(isRecording ? recorderRef.current?.recordingId : undefined, lessons.find(lesson => lesson.id === liveRecordingLessonId) ?? activeLesson, liveTranscript, localProvider, liveSettledThrough);
  const activeCourseNote = useMemo(() => {
    const note = activeWorkspace.courseNote ?? buildCourseNote(activeLesson, transcript);
    if (isRecording && liveRecordingLessonId === activeLessonId && localProvider) {
      return { ...note, blocks: [...note.blocks, ...liveDraft.blocks] };
    }
    if ((isRecording && liveRecordingLessonId === activeLessonId) || visibleTranscript.length !== transcript.length || visibleLiveTranscript.length) {
      return buildCourseNote(activeLesson, noteTranscript);
    }
    return note;
  }, [activeLesson, activeWorkspace.courseNote, isRecording, noteTranscript, transcript, visibleLiveTranscript, visibleTranscript.length, liveDraft, liveRecordingLessonId, activeLessonId, localProvider]);

  useEffect(() => {
    setLessonWorkspaces((current) => {
      let changed = false;
      const next = { ...current };
      for (const lesson of lessons) {
        const lessonWorkspace = next[lesson.id] ?? emptyLessonWorkspace;
        if (!lessonWorkspace.courseNote) {
          next[lesson.id] = { ...lessonWorkspace, courseNote: buildCourseNote(lesson, lessonWorkspace.transcript) };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [lessons]);

  useEffect(() => {
    if (!isRecording || !liveTranscriptFeedRef.current) return;
    liveTranscriptFeedRef.current.scrollTop = liveTranscriptFeedRef.current.scrollHeight;
  }, [activeLessonId, isRecording, liveRecordingLessonId, liveTranscript]);


  const checkSidecars = async (settings = serviceSettings) => {
    healthCheckRef.current?.abort();
    const controller = new AbortController();
    healthCheckRef.current = controller;
    const isCurrent = () => healthCheckRef.current === controller && !controller.signal.aborted;
    setIsCheckingSidecars(true);
    const [asr, documents, managed] = await Promise.all([
      probeSidecar(settings.asrUrl, { loopbackOnly: isNativeRuntime() }),
      probeSidecar(settings.documentsUrl, { loopbackOnly: isNativeRuntime() }),
      getManagedSidecarStatus().catch(() => []),
    ]);
    if (!isCurrent()) return;
    setSidecarHealth({ asr, documents });
    setManagedSidecars(managed);
    if (usesNim(settings)) {
      await checkNim(settings, controller);
      if (isCurrent()) setIsCheckingSidecars(false);
      return;
    }
    try {
      if (!settings.llmUrl) throw new Error('Set an LM Studio address.');
      if (isNativeRuntime() && !isLoopbackServiceUrl(settings.llmUrl)) {
        setAvailableModels([]);
        setLlmHealth(`Unavailable. ${LOOPBACK_ONLY_DETAIL}`);
        setIsCheckingSidecars(false);
        return;
      }
      const response = await fetch(`${normalizeServiceBaseUrl(settings.llmUrl)}/models`, { signal: AbortSignal.timeout(3000) });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error('LM Studio is not responding.');
      const body = await readJsonResponse(response, 'LM Studio');
      if (!isCurrent()) return;
      const models = Array.isArray(body.data)
        ? body.data.map((model: { id?: unknown }) => typeof model?.id === 'string' ? model.id.trim() : '').filter(Boolean)
        : [];
      setAvailableModels(models);
      const detectedModel = models.find((model: string) => model === settings.model) ?? models[0];
      if (detectedModel && detectedModel !== settings.model) {
        // A late result must not overwrite a connection the user has switched since, in memory or on disk.
        const sameConnection = (current: ServiceSettings) => current.llmUrl === settings.llmUrl && current.llmProvider === settings.llmProvider;
        setServiceSettings((current) => {
          if (!sameConnection(current)) return current;
          const detectedSettings = { ...current, model: detectedModel };
          try { localStorage.setItem(SERVICES_STORAGE_KEY, JSON.stringify(detectedSettings)); } catch { /* Keep the detected model for this session. */ }
          return detectedSettings;
        });
        setServiceDraft((current) => sameConnection(current) ? { ...current, model: detectedModel } : current);
        setLlmHealth(`Connected. Detected and selected ${detectedModel}.`);
      } else if (detectedModel) {
        setLlmHealth('Connected. Selected model is available.');
      } else {
        setLlmHealth('Connected. No model is currently loaded.');
      }
    } catch {
      if (!isCurrent()) return;
      setAvailableModels([]);
      setLlmHealth('Unavailable. Start the LM Studio server and load a model.');
    }
    if (isCurrent()) setIsCheckingSidecars(false);
  };

  // Catalog membership does not prove that a model can answer. Never send course material for a connection test.
  const checkNim = async (settings: ServiceSettings, controller: AbortController) => {
    setAvailableModels([]);
    const model = llmConnection(settings).model;
    const isCurrent = () => healthCheckRef.current === controller && !controller.signal.aborted;
    const result = await probeNimModel(model, { signal: controller.signal });
    if (!isCurrent()) return;
    if (result.ok) {
      setLlmHealth(`Connected. ${model} answered the connection test.`);
      return;
    }
    if (result.kind === 'cancelled') return;
    if (!result.canFallback || model === DEFAULT_NIM_MODEL) { setLlmHealth(result.message); return; }

    const fallback = await probeNimModel(DEFAULT_NIM_MODEL, { signal: controller.signal });
    if (!isCurrent()) return;
    if (!fallback.ok) { setLlmHealth(`${result.message} The recommended model could not answer either. ${fallback.message}`); return; }
    const sameSelection = (current: ServiceSettings) => usesNim(current) && llmConnection(current).model === model;
    setServiceSettings((current) => {
      if (!sameSelection(current)) return current;
      const recovered = { ...current, nimModel: DEFAULT_NIM_MODEL };
      try { localStorage.setItem(SERVICES_STORAGE_KEY, JSON.stringify(recovered)); } catch { /* Keep it for this session. */ }
      return recovered;
    });
    setServiceDraft((current) => sameSelection(current) ? { ...current, nimModel: DEFAULT_NIM_MODEL } : current);
    const reason = result.kind === 'retired' ? 'was no longer available' : 'did not answer in time';
    setLlmHealth(`Connected. Switched from ${model}, which ${reason}, to ${DEFAULT_NIM_MODEL}, which answered the connection test.`);
    const label = NIM_MODELS.find((entry) => entry.id === DEFAULT_NIM_MODEL)?.label ?? DEFAULT_NIM_MODEL;
    notify(`NVIDIA NIM switched to ${label}. The previous model failed its connection test.`);
  };

  const saveServiceSettings = (event: FormEvent) => {
    event.preventDefault();
    if (isRecording || isFinalizingRecording || isStartingRecording) return;
    const settings = Object.fromEntries(Object.entries(serviceDraft).map(([key, value]) => [key, value.trim()])) as ServiceSettings;
    if (isNativeRuntime()) {
      // The packaged app's Content Security Policy only allows this computer; refuse a remote address at entry.
      const remote = [
        !usesNim(settings) && isRemoteServiceUrl(settings.llmUrl) ? 'LM Studio address' : '',
        isRemoteServiceUrl(settings.asrUrl) ? 'Speech service address' : '',
        isRemoteServiceUrl(settings.documentsUrl) ? 'Document service address' : '',
      ].filter(Boolean);
      if (remote.length > 0) {
        notify(`Not saved. ${remote.join(', ')}: ${LOOPBACK_ONLY_DETAIL}`);
        return;
      }
    }
    setServiceSettings(settings);
    setConnectionsEnabled(true);
    try {
      localStorage.setItem(SERVICES_STORAGE_KEY, JSON.stringify(settings));
      notify('Connection settings saved.');
    } catch { notify('Connections applied for this session. Browser storage is unavailable.'); }
    void checkSidecars(settings);
  };

  const startConfiguredSidecars = async () => {
    try {
      const statuses = await startManagedSidecars();
      setManagedSidecars(statuses);
      await checkSidecars();
      notify(statuses.some((sidecar) => sidecar.configured)
        ? 'Configured local services started.'
        : 'No local services are configured yet.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Configured local services could not be started.');
    }
  };

  const stopConfiguredSidecars = async () => {
    try {
      const statuses = await stopManagedSidecars();
      setManagedSidecars(statuses);
      await checkSidecars();
      notify(statuses.some((sidecar) => sidecar.running)
        ? 'Some managed local services are still running.'
        : 'Managed local services stopped.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Managed local services could not be stopped.');
    }
  };

  const openResource = async (resource: Resource, page?: number) => {
    const requestId = ++resourcePreviewRequest.current;
    setResourcePreview({ resource, state: 'loading' });

    try {
      let blob = await sourceBlobStore.load(resource.id);
      if (!blob && resource.kind === 'audio') {
        const chunks = await recordingChunkStore.list(resource.id);
        if (chunks.length) blob = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || resource.mimeType || 'audio/webm' });
      }
      if (requestId !== resourcePreviewRequest.current) return;
      if (!blob) {
        setResourcePreview({ resource, state: 'missing', detail: 'The original source is not stored in this browser.' });
        return;
      }

      if (isTextResource(resource) || blob.type.startsWith('text/')) {
        const text = await blob.text();
        if (requestId !== resourcePreviewRequest.current) return;
        const maxCharacters = 12_000;
        setResourcePreview({ resource, state: 'ready', text: text.slice(0, maxCharacters), truncated: text.length > maxCharacters });
        return;
      }

      if (isPdfResource(resource)) {
        setResourcePreview({ resource, state: 'ready', blob, page });
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      if (requestId !== resourcePreviewRequest.current) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      setResourcePreview({ resource, state: 'ready', blobUrl });
    } catch {
      if (requestId === resourcePreviewRequest.current) {
        setResourcePreview({ resource, state: 'error', detail: 'The original source could not be opened.' });
      }
    }
  };

  useEffect(() => () => {
    if (resourcePreview?.blobUrl) URL.revokeObjectURL(resourcePreview.blobUrl);
  }, [resourcePreview?.blobUrl]);

  const loadRetrievalDocuments = async () => {
    const resourceNames = new Map(resources.map((resource) => [resource.id, resource.name]));
    const retrievalDocuments: RetrievalDocument[] = transcript.map((segment) => ({
      id: segment.id,
      text: segment.text,
      metadata: {
        timestamp: segment.timestamp,
        speaker: segment.speaker,
        ...(segment.sourceId && resourceNames.has(segment.sourceId) ? { resourceName: resourceNames.get(segment.sourceId)! } : {}),
        ...(segment.sourceId ? { resourceId: segment.sourceId } : {}),
      },
    }));
    for (const resource of resources) {
      if (!resource.sha256 || !isTextResource(resource)) continue;
      try {
        const blob = await sourceBlobStore.load(resource.id);
        const text = await blob?.text();
        if (text?.trim()) {
          chunkSourceText(text).forEach((chunk) => retrievalDocuments.push({
            id: `${resource.id}:${chunk.index}`,
            text: chunk.text,
            metadata: { resourceName: resource.name, resourceId: resource.id, part: String(chunk.index + 1), startLine: String(chunk.startLine) },
          }));
        }
      } catch {
        // A missing source blob should not prevent transcript retrieval.
      }
    }
    return retrievalDocuments;
  };

  const formatRetrievalCitation = (document: RetrievalDocument) => {
    if (!document.metadata.resourceName) return `Transcript · ${document.metadata.timestamp}`;
    return document.metadata.part
      ? `Source · ${document.metadata.resourceName} · part ${document.metadata.part}`
      : `Source · ${document.metadata.resourceName} · ${document.metadata.timestamp}`;
  };

  const openCitation = (target: string) => {
    const transcriptSegment = transcript.find((segment) => segment.id === target);
    const resourceId = transcriptSegment?.sourceId;
    const resource = resources.find((item) => item.id === resourceId)
      ?? resources.find((item) => target === item.id || target.startsWith(`${item.id}:`));
    if (resource) {
      const page = Number(target.match(/(?:^|:)page-(\d+)$/)?.[1] ?? transcriptSegment?.timestamp.match(/^Page (\d+)$/)?.[1]);
      void openResource(resource, Number.isFinite(page) && page > 0 ? page : undefined);
      return;
    }
    notify('This citation source is no longer available.');
  };

  const startRecording = async () => {
    startingRecorderRef.current = true;
    setIsStartingRecording(true);
    try {
      const session = await recorderSessionFactory();
      if (!session.stream) throw new Error('Microphone recording is unavailable in this browser.');
      if (session.stream && session.durability === 'durable') {
        const recoverySaved = savePendingRecording({
          recordingId: session.recordingId,
          lessonId: activeLesson.id,
          lessonTitle: activeLesson.title,
          startedAt: Date.now(),
        });
        if (!recoverySaved) {
          await session.stop().catch(() => undefined);
          const message = 'Recording was not started because interrupted-session recovery is unavailable.';
          setRecordingError(message);
          notify(message);
          return;
        }
      }
      recorderRef.current = session;
      session.onProblem?.((problem) => {
        if (problem === 'storage') {
          setRecordingError('This browser can no longer store the audio (storage is full). Stop and save now: what was already captured is kept. Free up space before recording again.');
          return;
        }
        // The microphone went away (unplugged, or its permission was withdrawn). Finish the session so what was
        // captured is saved and the interface does not keep counting time over silence.
        if (recorderRef.current !== session) return;
        void toggleRecordingRef.current();
        setRecordingError('The microphone stopped working, so recording ended. What was captured before that has been saved.');
      });
      setLiveRecordingLessonId(activeLesson.id);
      setIsRecording(true);
      setRecordingSeconds(0);
      notify('Recording started.');
    } catch (error) {
      setRecordingError(describeMicrophoneError(error)
        ?? (error instanceof Error ? `Cannot start recording: ${error.message}` : 'The microphone is unavailable. Check permission and try again.'));
    } finally {
      startingRecorderRef.current = false;
      setIsStartingRecording(false);
    }
  };

  const toggleRecording = async () => {
    if (!hasCourse || startingRecorderRef.current) return;
    setRecordingError('');
    setLiveTranscriptionError('');
    if (isFinalizingRecording) {
      notify('Finish saving the current recording before starting another.');
      return;
    }
    if (isRecording) {
      const session = recorderRef.current;
      const recordingLessonId = liveRecordingLessonId ?? activeLesson.id;
      const recordingLessonTitle = activeLesson.title;
      recorderRef.current = null;
      setIsRecording(false);
      if (!session) {
        setLiveTranscript([]);
        setLiveRecordingLessonId(null);
        notify('Session stopped.');
        return;
      }
      void session.stop().then(async ({ chunksPersisted, persistenceError }) => {
        // A clean stop is no longer recoverable work. Clear the manifest before
        // state updates can re-run the recovery effect against persisted chunks.
        // Not while saving is paused or failing: the course would not list this recording, and without the manifest nothing
        // would ever bring it back.
        if (!savingPausedRef.current && !saveFailedRef.current) removePendingRecording(session.recordingId);
        const recordingResource: Resource = {
          id: session.recordingId,
          name: `${recordingLessonTitle} audio.webm`,
          meta: `Audio · ${chunksPersisted} chunk${chunksPersisted === 1 ? '' : 's'}`,
          kind: 'audio',
          mimeType: 'audio/webm',
        };
        const saveRecordingFallback = (segments: TranscriptSegment[] = []) => {
          const nextTranscript = mergeSegments((lessonWorkspacesRef.current[recordingLessonId] ?? emptyLessonWorkspace).transcript, segments);
          updateLessonWorkspace(recordingLessonId, (current) => ({
            ...current,
            resources: current.resources.some((resource) => resource.id === recordingResource.id)
              ? current.resources
              : [recordingResource, ...current.resources],
            transcript: mergeSegments(current.transcript, segments),
          }));
          formatExistingCourseNote(recordingLessonId, nextTranscript);
        };
        setLessons((current) => current.map((lesson) => lesson.id === recordingLessonId ? { ...lesson, duration: formatElapsed(recordingSeconds) } : lesson));
        if (persistenceError) {
          notify(`${chunksPersisted} audio chunks preserved; persistence needs review.`);
        } else if (session.durability === 'durable') {
          notify(`${chunksPersisted} audio chunks saved locally.`);
        } else {
          notify(`${chunksPersisted} audio chunks kept in memory only.`);
        }

        if (!localSpeechEngine || !session.stream || session.durability !== 'durable' || chunksPersisted === 0) {
          if (session.stream && session.durability === 'durable' && chunksPersisted > 0) saveRecordingFallback();
          return;
        }
        notify('Audio saved locally. Transcribing with the speech service...');
        try {
          const chunks = await session.readChunks();
          if (!chunks.length) throw new Error('No persisted audio chunks available.');
          const audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
          const transcription = await localSpeechEngine.transcribe(audio);
          if (!transcription.segments.length) {
            saveRecordingFallback();
            notify('Audio saved locally; no speech was detected.');
            return;
          }
          const segments = transcription.segments.map((segment, index) => ({
            ...segment,
            id: `${session.recordingId}:${segment.id || index}`,
            sourceId: session.recordingId,
          }));
          const lessonsForRouting = lessons.map((lesson) => lesson.id === recordingLessonId
            ? { ...lesson, duration: formatElapsed(recordingSeconds) }
            : lesson);
          const recordingLesson = lessonsForRouting.find((lesson) => lesson.id === recordingLessonId) ?? activeLesson;
          if (localProvider) {
            try {
              const proposal = await analyzeQuickStart(
                segments.map((segment) => `${segment.timestamp} ${segment.text}`).join('\n'),
                lessonsForRouting,
                localProvider,
              );
              if (!canAutoRouteRecording(proposal)) {
                saveRecordingFallback(segments);
                notify(`Local transcription added ${segments.length} segments. AI routing confidence was too low.`);
                return;
              }
              const routed = applyRecordingPlacement({
                sourceLesson: recordingLesson,
                lessons: lessonsForRouting,
                lessonWorkspaces,
                proposal,
                resource: recordingResource,
                segments,
                duration: formatElapsed(recordingSeconds),
              });
              const formatted = await formatPlacedCourseNote(routed);
              commitPlacedCourse(formatted, recordingLessonId, recordingResource, segments);
              setActiveLessonId(formatted.targetLesson.id);
              setSelectedArtifactId(formatted.lessonWorkspaces[formatted.targetLesson.id]?.artifacts[0]?.id ?? null);
              setView('course');
              notify(`Local transcription added and routed to ${formatted.targetLesson.title}.`);
              return;
            } catch {
              // Keep the recording in its selected course when the classifier is unavailable or uncertain.
            }
          }
          saveRecordingFallback(segments);
          notify(`Local transcription added ${segments.length} segments.`);
        } catch {
          saveRecordingFallback();
          notify('Audio saved locally; local transcription needs review.');
        }
      }).catch(() => setRecordingError('The audio session could not be finalized correctly.'))
        .finally(() => {
          setLiveTranscript([]);
          setLiveRecordingLessonId(null);
          setIsFinalizingRecording(false);
        });
      setIsFinalizingRecording(true);
      return;
    }

    if (!recordingNoticeAcknowledged) {
      setRecordingNoticeChecked(false);
      setShowRecordingNotice(true);
      return;
    }
    await startRecording();
  };

  toggleRecordingRef.current = toggleRecording;

  const acceptRecordingNotice = () => {
    if (!recordingNoticeChecked) return;
    saveRecordingNoticeAcknowledgement();
    setRecordingNoticeAcknowledged(true);
    setShowRecordingNotice(false);
    void startRecording();
  };

  const addBookmark = () => {
    const nextSegment: TranscriptSegment = {
      id: `bookmark-${Date.now()}`,
      timestamp: formatElapsed(recordingSeconds),
      speaker: 'Bookmark',
      text: 'Student bookmark: review this point in the course.',
      status: 'review',
    };
    updateActiveWorkspace((current) => ({ ...current, transcript: [...current.transcript, nextSegment] }));
    notify(`Bookmark added at ${nextSegment.timestamp}.`);
  };

  const toggleTranscriptReview = (segmentId: string) => {
    const segment = transcript.find((item) => item.id === segmentId);
    if (!segment) return;
    const nextStatus: TranscriptSegment['status'] = segment.status === 'review' ? 'verified' : 'review';
    updateActiveWorkspace((current) => ({
      ...current,
      transcript: current.transcript.map((item) => item.id === segmentId ? { ...item, status: nextStatus } : item),
    }));
    notify(nextStatus === 'verified' ? 'Transcript segment verified.' : 'Transcript segment marked for review.');
  };

  // The segment list is memoized, so it needs a callback whose identity never changes.
  const toggleTranscriptReviewRef = useRef(toggleTranscriptReview);
  toggleTranscriptReviewRef.current = toggleTranscriptReview;
  const onToggleReview = useCallback((segmentId: string) => toggleTranscriptReviewRef.current(segmentId), []);

  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    const message = composerValue.trim();
    if (!message || isSending || !hasCourse) return;
    setView('chat');
    setChatError(null);
    const chatLessonId = activeLessonId;
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now() + 1}`;
    updateActiveWorkspace((current) => ({
      ...current,
      chat: [...current.chat, { id: userMessageId, role: 'user', content: message }],
    }));
    setComposerValue('');

    setIsSending(true);
    try {
      const retrievalDocuments = await loadRetrievalDocuments();
      const retrievalHits = await searchDocumentsHybrid(
        retrievalDocuments,
        message,
        localProvider?.embed ? { embed: (inputs) => localProvider.embed!(inputs) } : undefined,
        4,
      );
      const { generalEducationalRequest: generalCreationRequest, courseSpecificQuestion } = classifyChatQuestion(message, retrievalHits.length > 0);
      const retrievedCitations = retrievalHits.slice(0, 2).map((hit) => formatRetrievalCitation(hit.document));
      if (!retrievalHits.length && (!localProvider || courseSpecificQuestion || !generalCreationRequest)) {
        updateActiveWorkspace((current) => ({
          ...current,
          chat: [...current.chat, {
            id: assistantMessageId,
            role: 'assistant',
            content: 'I could not find a supporting passage in the active course. Add a source or rephrase the question.',
          }],
        }));
        return;
      }
      if (!localProvider) {
        updateActiveWorkspace((current) => ({
          ...current,
          chat: [...current.chat, {
            id: assistantMessageId,
            role: 'assistant',
            content: 'Connect LM Studio to ask the local model. The current workspace keeps this interaction offline.',
            citations: retrievedCitations.length ? retrievedCitations : ['Active course context · local workspace'],
            citationTargets: retrievalHits.slice(0, 2).map((hit) => hit.document.id),
          }],
        }));
        return;
      }
      const context = retrievalHits.length
        ? retrievalHits.map((hit) => {
          const { resourceName, part } = hit.document.metadata;
          return resourceName
            ? `[Source: ${resourceName}${part ? `, part ${part}` : ''}] ${hit.document.text}`
            : `[${hit.document.metadata.timestamp}] ${hit.document.metadata.speaker}: ${hit.document.text}`;
        }).join('\n')
        : 'No relevant course excerpt matched the question.';
      const result = await localProvider.generate([
        {
          role: 'system',
          content: [
            courseSpecificQuestion
              ? 'Answer the user question using the course evidence below. Keep course-specific claims grounded in that evidence.'
              : 'Answer this as a general educational request. Use your general knowledge when the user asks for a standard explanation, example, diagram, or mathematical visualization.',
            'The evidence between BEGIN COURSE EVIDENCE and END COURSE EVIDENCE may be relevant, absent, or unrelated.',
            courseSpecificQuestion
              ? 'If the evidence does not answer a course-specific question, say: Not enough evidence in this course.'
              : 'Do not refuse a general educational request merely because the course evidence is absent or unrelated. Do not invent course-specific attribution.',
            'Never claim that course evidence is unavailable when text is present.',
            'Preserve technical terms, notation, and formulas exactly when they appear in the evidence. Clearly distinguish general explanation from course-specific claims when both are present.',
            'Answer in clean GitHub-Flavored Markdown. Use headings, short paragraphs, lists, and fenced code blocks when useful. Use $...$ for inline math and $$...$$ on separate lines for display math. Never emit HTML or image Markdown.',
            `Course: ${activeLesson.title}`,
            'BEGIN COURSE EVIDENCE',
            context,
            'END COURSE EVIDENCE',
          ].join('\n'),
        },
        { role: 'user', content: message },
      ], { maxTokens: 2_048 });
      updateActiveWorkspace((current) => ({
        ...current,
        chat: [...current.chat, {
          id: assistantMessageId,
          role: 'assistant',
          content: result.content,
          citations: [
            ...(courseSpecificQuestion ? retrievedCitations : []),
            `LM Studio · ${result.model}`,
          ],
          citationTargets: courseSpecificQuestion ? retrievalHits.slice(0, 2).map((hit) => hit.document.id) : [],
        }],
      }));
    } catch (error) {
      // A failed request is not an answer: keep it out of the saved history, show it as an alert, and hand
      // the question back to the composer so it can be sent again with one key press.
      // The alert belongs to the course the question was asked in. If the student is still there, the question goes back to
      // the composer; if not, it stays in that course's history and the alert is waiting there.
      setChatError({ lessonId: chatLessonId, message: aiFailure(error, 'The local provider could not answer this question.') });
      if (activeLessonIdRef.current === chatLessonId) {
        updateLessonWorkspace(chatLessonId, (current) => ({
          ...current,
          chat: current.chat.filter((item) => item.id !== userMessageId),
        }));
        setComposerValue((current) => current || message);
      }
    } finally {
      setIsSending(false);
    }
  };

  const createArtifact = async (kind: ArtifactKind) => {
    const definition = artifactCatalog.find((artifact) => artifact.kind === kind);
    if (!definition || generatingArtifact || !hasCourse) return;
    setActionError('');
    if (!localProvider) {
      setActionError('Connect LM Studio in Settings to generate study material.');
      return;
    }
    setGeneratingArtifact(kind);
    const lessonId = activeLesson.id;
    try {
      const documents = await loadRetrievalDocuments();
      const candidateDocuments = documents.slice(0, 12);
      if (!candidateDocuments.length) throw new Error('Import notes or transcribe a recording before generating study material.');
      const evidenceParts: string[] = [];
      const evidenceDocuments: RetrievalDocument[] = [];
      let evidenceCharacters = 0;
      for (const document of candidateDocuments) {
        const { resourceName, part, speaker, timestamp } = document.metadata;
        const label = resourceName
          ? `[Source: ${resourceName}${part ? `, part ${part}` : ''}]`
          : `[${timestamp}] ${speaker}:`;
        const evidence = `${label} ${document.text} [sourceId: ${document.id}]`;
        const remainingCharacters = 24_000 - evidenceCharacters;
        if (remainingCharacters <= 0) break;
        evidenceDocuments.push(document);
        evidenceParts.push(evidence.slice(0, remainingCharacters));
        evidenceCharacters += Math.min(evidence.length, remainingCharacters);
        if (evidence.length > remainingCharacters) break;
      }
      const context = [
        'BEGIN COURSE EVIDENCE',
        evidenceParts.join('\n\n'),
        'END COURSE EVIDENCE',
      ].join('\n');
      const result = await localProvider.generate([
        {
          role: 'system',
          content: [
            `Create a ${definition.label.toLowerCase()} for ${activeLesson.title} using only the course evidence below.`,
            'The evidence between BEGIN COURSE EVIDENCE and END COURSE EVIDENCE is present and authoritative.',
            'If the evidence does not support a claim, omit it or say: Not enough evidence in this course.',
            'Do not add facts from outside the evidence. Preserve technical terms, notation, and formulas exactly when they appear.',
            'Return JSON with a markdown string and an optional visuals array. The markdown must be clean GitHub-Flavored Markdown with headings, lists, tables, fenced code blocks, and valid LaTeX ($...$ or $$...$$) when the source supports them. Use a visual only for a clearly supported chart, table, or diagram and cite the exact sourceId from the evidence. Never emit HTML or image Markdown, and never invent values or relationships.',
            context,
          ].join('\n'),
        },
        { role: 'user', content: `Generate the ${definition.label.toLowerCase()}.` },
      ], {
        maxTokens: 4_096,
        ...(localProvider.supportsStructuredOutputs ? { responseFormat: studyArtifactResponseFormat } : {}),
      });
      if (!result.content.trim()) throw new Error('The model returned no study material. Try again.');
      const parsed = parseStudyArtifactResponse(result.content, new Set(evidenceDocuments.map((document) => document.id)));
      if (!parsed) throw new Error('The model returned an invalid study material response. Try again.');
      const artifact: Artifact = {
        id: `${kind}-${crypto.randomUUID()}`, kind, label: definition.label,
        createdAt: new Date().toLocaleString('en-GB'), content: parsed.markdown,
        ...(parsed.visuals.length ? { visuals: parsed.visuals } : {}),
        citations: evidenceDocuments.slice(0, 3).map(formatRetrievalCitation),
        citationTargets: evidenceDocuments.slice(0, 3).map((document) => document.id),
      };
      updateLessonWorkspace(lessonId, (current) => ({ ...current, artifacts: [artifact, ...current.artifacts] }));
      setSelectedArtifactId(artifact.id);
      notify(`${definition.label} saved.`);
    } catch (error) {
      setActionError(aiFailure(error, 'Generation failed. Check the AI connection in Settings and try again.'));
    } finally {
      setGeneratingArtifact(null);
    }
  };

  const routeImportedMaterial = async (
    sourceLesson: Lesson,
    resource: Resource,
    segments: TranscriptSegment[],
    documentPages?: DocumentPage[],
  ) => {
    if (!localProvider || !segments.length) return false;
    try {
      const proposal = await analyzeQuickStart(
        segments.map((segment) => `${segment.timestamp} ${segment.text}`).join('\n'),
        lessons,
        localProvider,
      );
      if (!canAutoRouteRecording(proposal)) return false;
      const sourceWorkspace = lessonWorkspaces[sourceLesson.id] ?? emptyLessonWorkspace;
      const routingWorkspaces = {
        ...lessonWorkspaces,
        [sourceLesson.id]: {
          ...sourceWorkspace,
          resources: sourceWorkspace.resources.some((candidate) => candidate.id === resource.id)
            ? sourceWorkspace.resources
            : [...sourceWorkspace.resources, resource],
          transcript: [
            ...sourceWorkspace.transcript.filter((segment) => segment.sourceId !== resource.id),
            ...segments,
          ],
        },
      };
      const routed = applyRecordingPlacement({
        sourceLesson,
        lessons,
        lessonWorkspaces: routingWorkspaces,
        proposal,
        resource,
        segments,
        sourceType: 'material',
      });
      const formatted = documentPages
        ? {
            ...routed,
            lessonWorkspaces: {
              ...routed.lessonWorkspaces,
              [routed.targetLesson.id]: {
                ...routed.lessonWorkspaces[routed.targetLesson.id],
                courseNote: await formatDocumentCourseNoteWithProvider(routed.targetLesson, documentPages, resource.name, localProvider),
              },
            },
          }
        : await formatPlacedCourseNote(routed);
      commitPlacedCourse(formatted, sourceLesson.id, resource, segments);
      setActiveLessonId(formatted.targetLesson.id);
      setSelectedArtifactId(formatted.lessonWorkspaces[formatted.targetLesson.id]?.artifacts[0]?.id ?? null);
      setView('course');
      setShowAllResources(false);
      notify(`Imported material routed to ${formatted.targetLesson.title}.`);
      return true;
    } catch {
      // Keep imported material in the selected course when classification is unavailable or uncertain.
      return false;
    }
  };

  const importFiles = (files: File[]) => {
    if (files.length > 1) {
      enqueueBatchImport(files);
      return;
    }
    if (!files[0] || !hasCourse) return;
    void importSourceFile(files[0], activeLesson);
  };

  const importSource = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    event.target.accept = sourceAccept;
    importFiles(files);
  };

  // Without this, a file dropped anywhere on the page makes the browser open it and leave the app, which would also
  // cut a running recording or import. Dropped files are imported into the open course instead.
  const importDroppedFilesRef = useRef<(files: File[]) => void>(() => undefined);
  importDroppedFilesRef.current = (files) => {
    if (!hasCourse) {
      notify('Create a course first, then drop the files onto it.');
      return;
    }
    if (hasOpenDialog) {
      notify('Close the open window, then drop the files again.');
      return;
    }
    importFiles(files);
  };
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      importDroppedFilesRef.current(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const importSourceFile = async (file: File, targetLesson: Lesson, routeMaterial = true) => {
    setActionError('');
    const lessonId = targetLesson.id;
    if (file.size === 0) {
      setActionError(`${file.name} is empty, so nothing was imported.`);
      return;
    }
    let inFlightKey: string | null = null;
    try {
      const resource = await createSourceResource(file);
      const existing = (lessonWorkspacesRef.current[lessonId] ?? emptyLessonWorkspace).resources.find((candidate) => candidate.id === resource.id);
      const importKey = `${lessonId}|${resource.id}`;
      if (existing || inFlightImportsRef.current.has(importKey)) {
        // The same bytes are already in this course: a second copy would only duplicate its notes and share one stored original.
        setActionError(!existing
          ? `${file.name} is already being imported into this course.`
          : existing.name === file.name ? `${file.name} is already in this course.` : `${file.name} has the same content as ${existing.name}, which is already in this course.`);
        return;
      }
      inFlightKey = importKey;
      inFlightImportsRef.current.add(importKey);
      await sourceBlobStore.save(resource.id, file);
      const isExtractable = isExtractableDocument(resource);
      if (localDocumentEngine && isExtractable) rebuiltDocumentSourceIds.current.add(resource.id);
      updateLessonWorkspace(lessonId, (current) => ({ ...current, resources: [resource, ...current.resources] }));
      notify(`${resource.name} added to course sources${sourceBlobStore.durability === 'durable' ? ' and saved locally.' : ' in memory only.'}`);
      if (isTextResource(resource)) {
        const text = (await file.text()).trim();
        if (text) {
          const segment: TranscriptSegment = {
            id: `${resource.id}:text`, sourceId: resource.id, timestamp: 'Notes', speaker: resource.name, text, status: 'review',
          };
          if (routeMaterial && await routeImportedMaterial(targetLesson, resource, [segment])) return;
          const nextTranscript = mergeSegments((lessonWorkspacesRef.current[lessonId] ?? emptyLessonWorkspace).transcript, [segment]);
          updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: mergeSegments(current.transcript, [segment]) }));
          formatExistingCourseNote(lessonId, nextTranscript);
        }
      }
      if (resource.kind === 'audio' && !localSpeechEngine) setActionError('Audio imported. Connect a speech service in Settings to transcribe it.');
      if (resource.kind === 'audio' && localSpeechEngine) {
        setTranscribingResourceIds((current) => new Set(current).add(resource.id));
        notify(`${resource.name} saved locally. Transcribing with the speech service...`);
        try {
          const transcription = await localSpeechEngine.transcribe(file);
          const segments = transcription.segments.map((segment, index) => ({
            ...segment,
            id: `${resource.id}:${segment.id || index}`,
            sourceId: resource.id,
          }));
          if (segments.length && localProvider && routeMaterial) {
            try {
              const proposal = await analyzeQuickStart(
                segments.map((segment) => `${segment.timestamp} ${segment.text}`).join('\n'),
                lessons,
                localProvider,
              );
              if (canAutoRouteRecording(proposal)) {
                const sourceWorkspace = lessonWorkspaces[lessonId] ?? emptyLessonWorkspace;
                const routingWorkspaces = {
                  ...lessonWorkspaces,
                  [lessonId]: {
                    ...sourceWorkspace,
                    resources: [...sourceWorkspace.resources, resource],
                    transcript: [...sourceWorkspace.transcript, ...segments],
                  },
                };
                const routed = applyRecordingPlacement({
                  sourceLesson: targetLesson,
                  lessons,
                  lessonWorkspaces: routingWorkspaces,
                  proposal,
                  resource,
                  segments,
                });
                const formatted = await formatPlacedCourseNote(routed);
                commitPlacedCourse(formatted, lessonId, resource, segments);
                setActiveLessonId(formatted.targetLesson.id);
                setSelectedArtifactId(formatted.lessonWorkspaces[formatted.targetLesson.id]?.artifacts[0]?.id ?? null);
                setView('course');
                setShowAllResources(false);
                notify(`Local transcription added and routed to ${formatted.targetLesson.title}.`);
                return;
              }
            } catch {
              // Keep imported audio in the selected course when classification is unavailable or uncertain.
            }
          }
          const nextTranscript = mergeSegments((lessonWorkspacesRef.current[lessonId] ?? emptyLessonWorkspace).transcript, segments);
          updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: mergeSegments(current.transcript, segments) }));
          formatExistingCourseNote(lessonId, nextTranscript);
          notify(segments.length
            ? `Local transcription added ${segments.length} segments from ${resource.name}.`
            : `${resource.name} contains no detected speech.`);
        } catch (error) {
          setActionError(`${resource.name} is saved. ${describeSpeechFailure(error)}`);
        } finally {
          setTranscribingResourceIds((current) => {
            const next = new Set(current);
            next.delete(resource.id);
            return next;
          });
        }
      }
      const extractableResource = isExtractableDocument(resource);
      if (resource.kind === 'document' && !extractableResource) {
        setActionError(`${resource.name} was saved as an original in Sources, but StudentLLM cannot read this type of file. Use PDF, Word, PowerPoint, text, Markdown, image or audio files to get notes from it.`);
      }
      if (!localDocumentEngine && extractableResource) {
        setActionError(`${resource.name} is saved. Connect the document service in Settings to extract its text.`);
      }
      if (localDocumentEngine && extractableResource) {
        try {
          const extraction = await localDocumentEngine.extract(file);
          const pageSegments = extraction.pages
            .filter((page) => page.text.trim())
            .map((page) => ({
              id: `${resource.id}:page-${page.pageNumber}`,
              sourceId: resource.id,
              timestamp: `Page ${page.pageNumber}`,
              speaker: resource.name,
              text: page.text.trim(),
              status: 'review' as const,
            }));
          if (routeMaterial && pageSegments.length && await routeImportedMaterial(targetLesson, resource, pageSegments, extraction.pages)) return;
          extractedDocumentPages.current.set(resource.id, extraction.pages);
          // Show the extracted note right away; the background review rewrites it with the model.
          const documentCourseNote = await formatDocumentCourseNoteWithProvider(targetLesson, extraction.pages, resource.name, null);
          updateLessonWorkspace(lessonId, (current) => ({
            ...current,
            transcript: mergeSegments(current.transcript, pageSegments),
            courseNote: documentCourseNote,
          }));
          notify(pageSegments.length > 0
            ? `${resource.name} indexed ${pageSegments.length} page${pageSegments.length === 1 ? '' : 's'} locally.`
            : `${resource.name} contains no extractable text.`);
        } catch (error) {
          rebuiltDocumentSourceIds.current.delete(resource.id);
          setActionError(`${resource.name} is saved. ${describeDocumentFailure(error)}`);
        }
      }
    } catch (error) {
      if (inFlightKey) inFlightImportsRef.current.delete(inFlightKey);
      setActionError(error instanceof Error ? error.message : 'The file could not be stored. Please try importing it again.');
    }
  };

  const enqueueBatchImport = (files: File[]) => {
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      notify('Stop and save the recording before importing several files.');
      return;
    }
    const plan = planBatchImport(files);
    if (!plan.length) {
      setActionError('None of these files can be imported. Use PDF, Word, PowerPoint, text, image or audio files.');
      return;
    }
    if (plan.length > LARGE_BATCH_IMPORT && !window.confirm(`Import ${plan.length} files as ${plan.length} lessons?`)) return;
    const subject = folderNameOf(files) || (hasCourse ? activeLesson.subject : '') || 'Imported course';
    const date = new Date().toLocaleDateString('en-GB');
    const planned = plan.map(({ file, title, chapter }) => ({
      file,
      lesson: { id: `lesson-${crypto.randomUUID()}`, subject, chapter, title, teacher: '', duration: '00:00:00', date, progress: 0 } satisfies Lesson,
    }));
    setExpandedSubjects((expanded) => ({ ...expanded, [subject]: true }));
    activateNextBatchLessonRef.current = true;
    setView('course');
    setActionError('');
    setImportQueue((current) => [...current, ...planned]);
    setImportTotals((current) => ({ done: current?.done ?? 0, total: (current?.total ?? 0) + planned.length }));
    const skipped = files.length - plan.length;
    notify(`Importing ${planned.length} file${planned.length === 1 ? '' : 's'} into ${subject}, one lesson each${skipped ? `, ${skipped} unsupported file${skipped === 1 ? '' : 's'} skipped` : ''}.`);
  };

  const stopBatchImport = () => {
    // Courses are only created when their file starts, so the files that are still waiting have nothing to clean up.
    const dropped = Math.max(0, importQueue.length - 1);
    setImportQueue((current) => current.slice(0, 1));
    setImportTotals((current) => current && { ...current, total: current.done + 1 });
    notify(`Import stopped. ${dropped} remaining file${dropped === 1 ? ' was' : 's were'} not added.`);
  };

  const importFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) enqueueBatchImport(files);
  };

  // Batch imports run one file at a time, each from a fresh render, so a file never
  // overwrites what the previous one added and the local services are not flooded.
  useEffect(() => {
    if (importRunningRef.current) return;
    if (!importQueue.length) {
      // The next folder starts afresh: its courses go to the top and its first course is the one shown.
      batchLessonIdsRef.current.clear();
      activateNextBatchLessonRef.current = false;
      if (importTotals) {
        notify(`${importTotals.total} source${importTotals.total === 1 ? '' : 's'} imported.`);
        setImportTotals(null);
      }
      return;
    }
    const [next] = importQueue;
    // A passive effect from a render that predates the finished file can still run after
    // `finally` resets the running flag; it sees the old queue head and must not restart it.
    if (startedImportRef.current === next) return;
    const lesson = lessons.find((candidate) => candidate.id === next.lesson.id);
    if (!lesson && !batchLessonIdsRef.current.has(next.lesson.id)) {
      // This file's turn has come: create its course now and start the import on the next render, when it exists.
      batchLessonIdsRef.current.add(next.lesson.id);
      const planned = next.lesson;
      setLessons((current) => {
        // Keep the courses of a folder in the order of the folder: each one goes after the ones created before it.
        let at = 0;
        current.forEach((item, index) => { if (batchLessonIdsRef.current.has(item.id)) at = index + 1; });
        return [...current.slice(0, at), planned, ...current.slice(at)];
      });
      setLessonWorkspaces((current) => ({ ...current, [planned.id]: emptyLessonWorkspace }));
      if (activateNextBatchLessonRef.current) {
        activateNextBatchLessonRef.current = false;
        setActiveLessonId(planned.id);
        setSelectedArtifactId(null);
      }
      return;
    }
    startedImportRef.current = next;
    importRunningRef.current = true;
    void (lesson ? importSourceFile(next.file, lesson, false) : Promise.resolve()).finally(() => {
      importRunningRef.current = false;
      setImportTotals((current) => current && { ...current, done: current.done + 1 });
      setImportQueue((current) => current.slice(1));
    });
  });

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  const transcribeSource = async (resource: Resource) => {
    if (transcribingResourceIds.has(resource.id)) return;
    if (!localSpeechEngine) {
      setActionError('Add the speech service address in Settings to transcribe audio.');
      setShowSettingsPanel(true);
      return;
    }
    const lessonId = activeLesson.id;
    setActionError('');
    setTranscribingResourceIds((current) => new Set(current).add(resource.id));
    try {
      let audio = await sourceBlobStore.load(resource.id);
      if (!audio) {
        const chunks = await recordingChunkStore.list(resource.id);
        if (chunks.length) audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
      }
      if (!audio) throw new Error('This recording could not be found on this device.');
      const result = await localSpeechEngine.transcribe(audio);
      if (!result.segments.length) throw new Error('No speech was detected in this recording.');
      const segments = result.segments.map((segment, index) => ({ ...segment, id: `${resource.id}:${segment.id || index}`, sourceId: resource.id }));
      if (localProvider) {
        try {
          const proposal = await analyzeQuickStart(
            segments.map((segment) => `${segment.timestamp} ${segment.text}`).join('\n'),
            lessons,
            localProvider,
          );
          if (canAutoRouteRecording(proposal)) {
            const sourceWorkspace = lessonWorkspaces[lessonId] ?? emptyLessonWorkspace;
            const routingWorkspaces = {
              ...lessonWorkspaces,
              [lessonId]: {
                ...sourceWorkspace,
                resources: sourceWorkspace.resources.some((candidate) => candidate.id === resource.id)
                  ? sourceWorkspace.resources
                  : [...sourceWorkspace.resources, resource],
                transcript: [...sourceWorkspace.transcript.filter((segment) => segment.sourceId !== resource.id), ...segments],
              },
            };
            const routed = applyRecordingPlacement({
              sourceLesson: activeLesson,
              lessons,
              lessonWorkspaces: routingWorkspaces,
              proposal,
              resource,
              segments,
            });
            const formatted = await formatPlacedCourseNote(routed);
            commitPlacedCourse(formatted, lessonId, resource, segments);
            setActiveLessonId(formatted.targetLesson.id);
            setSelectedArtifactId(formatted.lessonWorkspaces[formatted.targetLesson.id]?.artifacts[0]?.id ?? null);
            setView('course');
            setShowAllResources(false);
            notify(`Transcription added and routed to ${formatted.targetLesson.title}.`);
            return;
          }
        } catch {
          // Keep the source in its current course when classification is unavailable or uncertain.
        }
      }
      const nextTranscript = mergeSegments((lessonWorkspacesRef.current[lessonId] ?? emptyLessonWorkspace).transcript, segments, { replaceSourceId: resource.id });
      updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: mergeSegments(current.transcript, segments, { replaceSourceId: resource.id }) }));
      formatExistingCourseNote(lessonId, nextTranscript);
      notify('Transcription added to your course notes.');
    } catch (error) {
      setActionError(describeSpeechFailure(error));
    } finally {
      setTranscribingResourceIds((current) => { const ids = new Set(current); ids.delete(resource.id); return ids; });
    }
  };

  const openSourcePicker = (accept: string) => {
    if (!sourceInputRef.current) return;
    sourceInputRef.current.accept = accept;
    sourceInputRef.current.click();
  };

  // Files are stored under a fingerprint of their content, so the same file imported into two courses shares one stored
  // original. It may only be erased when no course refers to it any more.
  const isSourceUsedElsewhere = (resourceId: string, exceptLessonId?: string) => Object.entries(lessonWorkspacesRef.current)
    .some(([id, workspace]) => id !== exceptLessonId && workspace.resources.some((resource) => resource.id === resourceId))
    // A course that is importing the same file right now stores the original before it lists the source.
    || [...inFlightImportsRef.current].some((key) => key.endsWith(`|${resourceId}`) && key.split('|')[0] !== exceptLessonId);

  const commitSourceRemoval = async (pending: PendingSourceRemoval) => {
    try {
      // The original is only erased once the workspace that no longer lists it is stored. While saving is paused (another
      // tab, a protected original) or failing (a full store) the saved workspace may still list the source: the erase waits
      // in the pending-erase ledger, and the startup sweep, which checks references, finishes it later.
      await lastSaveRef.current;
      await eraseRemovedSource(pending.resource, {
        safety: { savingPaused: savingPausedRef.current, saveFailed: saveFailedRef.current },
        usedElsewhere: isSourceUsedElsewhere(pending.resource.id),
      }, eraseOperations);
    } catch {
      // The ledger entry stays, so the erase is retried the next time the app starts.
      notify(`${pending.resource.name} could not be fully removed.`);
    }
  };

  // Finalizes the removal that is still waiting in the undo window, if any.
  const flushPendingSourceRemoval = () => {
    const pending = pendingSourceRemovalRef.current;
    if (!pending) return;
    pendingSourceRemovalRef.current = null;
    window.clearTimeout(pending.timer);
    window.clearTimeout(pending.hardTimer);
    setPendingSourceRemoval(null);
    void commitSourceRemoval(pending);
  };
  flushSourceRemovalRef.current = flushPendingSourceRemoval;

  const armUndoTimer = (pending: PendingSourceRemoval, ms: number) => {
    pending.remaining = ms;
    pending.deadline = Date.now() + ms;
    pending.timer = window.setTimeout(() => flushSourceRemovalRef.current(), ms);
  };

  // The undo window stops counting down while the toast is hovered or holds keyboard focus.
  const setUndoToastEngaged = (kind: 'hover' | 'focus', engaged: boolean) => {
    const pending = pendingSourceRemovalRef.current;
    if (!pending) return;
    pending[kind] = engaged;
    const paused = pending.hover || pending.focus;
    if (paused && pending.timer) {
      window.clearTimeout(pending.timer);
      pending.timer = 0;
      pending.remaining = Math.max(0, pending.deadline - Date.now());
    } else if (!paused && !pending.timer) {
      armUndoTimer(pending, pending.remaining);
    }
  };

  const undoSourceRemoval = () => {
    const pending = pendingSourceRemovalRef.current;
    if (!pending) return;
    pendingSourceRemovalRef.current = null;
    window.clearTimeout(pending.timer);
    window.clearTimeout(pending.hardTimer);
    setPendingSourceRemoval(null);
    // Small window: the ledger entry is cleared before the restored workspace is saved. If the page dies in between,
    // the source is absent from the saved workspace while its blob stays on disk: a possible leak, never a loss.
    removePendingSourceErase(pending.resource.id);
    const before = lessonWorkspaces[pending.lessonId] ?? emptyLessonWorkspace;
    const restoredTranscript = restoreAtPositions(before.transcript, pending.segmentEntries);
    const noteChoice = chooseNoteOnUndo({
      hasSnapshot: Boolean(pending.courseNote),
      sameSegments: sameIdSet(restoredTranscript.map((segment) => segment.id), pending.preRemovalIds),
      currentNote: before.courseNote,
      noteAfterRemoval: pending.noteAfterRemoval,
    });
    const restoreInto = (workspace: LessonWorkspace): LessonWorkspace => ({
      ...workspace,
      resources: restoreAtPositions(workspace.resources, [pending.resourceEntry]),
      transcript: restoreAtPositions(workspace.transcript, pending.segmentEntries),
    });
    if (noteChoice === 'rebuild') {
      updateLessonWorkspace(pending.lessonId, restoreInto);
      formatExistingCourseNote(pending.lessonId, restoredTranscript);
    } else {
      // 'snapshot': the same segments are back, so the pre-removal note (possibly AI-written) is still right.
      // 'keep': the note changed during the window; do not overwrite it, but ask the provider to refresh it.
      setLessonWorkspaces((current) => {
        const workspace = restoreInto(current[pending.lessonId] ?? emptyLessonWorkspace);
        return { ...current, [pending.lessonId]: noteChoice === 'snapshot' ? { ...workspace, courseNote: pending.courseNote } : workspace };
      });
      if (noteChoice === 'keep') formatExistingCourseNote(pending.lessonId, restoredTranscript);
    }
    setFocusRestoredSourceId(pending.resource.id);
    notify(`${pending.resource.name} restored.`);
  };

  // The source leaves the course right away, but its stored original is only erased once the undo window closes.
  const removeSource = (resource: Resource) => {
    flushPendingSourceRemoval();
    const belongsToSource = (segment: TranscriptSegment) => segment.sourceId === resource.id || segment.id.startsWith(`${resource.id}:`);
    const lessonId = activeLessonId;
    const pending: PendingSourceRemoval = {
      lessonId,
      resource,
      resourceEntry: { index: 0, item: resource },
      segmentEntries: [],
      courseNote: undefined,
      noteAfterRemoval: undefined,
      preRemovalIds: [],
      timer: 0,
      hardTimer: 0,
      deadline: 0,
      remaining: SOURCE_REMOVAL_UNDO_MS,
      hover: false,
      focus: false,
    };
    addPendingSourceErase({ id: resource.id, kind: resource.kind });
    // Read the freshest state inside the updater so segments that arrived late are still captured for Undo.
    updateActiveWorkspace((current) => {
      const resourceSplit = takeWithPositions(current.resources, (item) => item.id === resource.id);
      const segmentSplit = takeWithPositions(current.transcript, belongsToSource);
      pending.resourceEntry = resourceSplit.removed[0] ?? pending.resourceEntry;
      pending.segmentEntries = segmentSplit.removed;
      pending.courseNote = current.courseNote;
      pending.preRemovalIds = current.transcript.map((segment) => segment.id);
      return { ...current, resources: resourceSplit.kept, transcript: segmentSplit.kept };
    });
    // The note was rebuilt without the removed source; let a reachable provider rewrite it again.
    formatExistingCourseNote(lessonId, transcript.filter((segment) => !belongsToSource(segment)));
    armUndoTimer(pending, SOURCE_REMOVAL_UNDO_MS);
    // Hovering or focusing the toast pauses the countdown, but never past this hard cap.
    pending.hardTimer = window.setTimeout(() => flushSourceRemovalRef.current(), SOURCE_REMOVAL_MAX_MS);
    pendingSourceRemovalRef.current = pending;
    setPendingSourceRemoval(pending);
  };

  const deleteActiveCourse = async () => {
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      notify('Stop the recording before deleting this course.');
      setShowDeleteCourse(false);
      return;
    }
    if (savingPausedRef.current) {
      // Nothing done in this window is stored, so the course would be back after a reload. Do not pretend otherwise.
      notify('Saving is paused in this window, so the course was not deleted. Reload the page, then delete it.');
      setShowDeleteCourse(false);
      return;
    }

    flushPendingSourceRemoval();
    const lessonId = activeLesson.id;
    const lessonTitle = activeLesson.title;
    const deletedResources = resources;
    // Read before the course leaves the screen: once it is gone, the recovery effect no longer finds its lesson.
    const interruptedRecordings = listPendingRecordings().filter((entry) => entry.lessonId === lessonId);
    const nextLessons = lessons.filter((lesson) => lesson.id !== lessonId);
    const nextLesson = nextLessons[0];
    const nextWorkspaces = Object.fromEntries(Object.entries(lessonWorkspacesRef.current).filter(([id]) => id !== lessonId));
    const nextActive = nextWorkspaces[nextLesson?.id ?? ''] ?? emptyLessonWorkspace;
    // Remembered before anything else happens: if the page dies from here on, the startup sweep (which checks references,
    // so it keeps whatever the saved workspace still lists) finishes the job.
    for (const resource of deletedResources) if (!isSourceUsedElsewhere(resource.id, lessonId)) eraseOperations.remember(resource);
    // Functional updates: an import for another course that was queued a moment ago must not be undone.
    setLessons((current) => current.filter((lesson) => lesson.id !== lessonId));
    setLessonWorkspaces((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== lessonId)));
    setActiveLessonId(nextLesson?.id ?? '');
    setSelectedArtifactId(nextLesson ? lessonWorkspaces[nextLesson.id]?.artifacts[0]?.id ?? null : null);
    setView('course');
    setShowAllResources(false);
    setShowDeleteCourse(false);
    try {
      // The deletion is stored first; only then are the originals erased. If saving fails, the saved workspace may still
      // list this course, so its files stay.
      const stored = await persistWorkspace({
        activeLessonId: nextLesson?.id ?? '', lessons: nextLessons, ...nextActive, lessonWorkspaces: nextWorkspaces,
      });
      const safety = { savingPaused: savingPausedRef.current, saveFailed: !stored };
      await eraseCourseSources(deletedResources, { safety, usedElsewhere: (resourceId) => isSourceUsedElsewhere(resourceId, lessonId) }, eraseOperations);
      if (isSafeToErase(safety)) {
        for (const pending of interruptedRecordings) {
          await recordingChunkStore.clear(pending.recordingId);
          if (!removePendingRecording(pending.recordingId)) throw new Error('Unable to remove interrupted recording state.');
        }
      }
      notify(isSafeToErase(safety) ? `${lessonTitle} deleted.` : `${lessonTitle} was removed here, but the change could not be saved, so it comes back after a reload. Its files are kept.`);
    } catch {
      notify(`${lessonTitle} was deleted, but some of its files could not be removed yet. They are removed the next time StudentLLM starts.`);
    }
  };

  // A missing course is only meaningful in a trusted, current workspace. Recent manifests may belong to another live tab.
  const [orphanTick, setOrphanTick] = useState(0);
  const canDiscardRecording = (entry: PendingRecording) => nativeStorageReady && workspaceTrustedRef.current
    && !savingPausedRef.current && !saveFailedRef.current
    && Date.now() - entry.startedAt >= 24 * 60 * 60 * 1000
    && !lessons.some((lesson) => lesson.id === entry.lessonId)
    && !Object.values(lessonWorkspaces).some((workspace) => workspace.resources.some((resource) => resource.id === entry.recordingId));
  const orphanRecordings = showSettingsPanel ? listPendingRecordings().filter(canDiscardRecording) : [];
  const sessionOnlyRecovery = hasSessionOnlyPendingRecordings() || hasSessionOnlyPendingSourceErases();
  void orphanTick;
  const discardUnrecoveredRecording = async (entry: PendingRecording) => {
    if (!canDiscardRecording(entry)) return;
    if (!window.confirm(`Permanently erase the recording from "${entry.lessonTitle}" and its recovery information? First check that no other StudentLLM tab or window is still recording or needs this audio. This cannot be undone.`)) return;
    const current = listPendingRecordings().find((item) => item.recordingId === entry.recordingId);
    if (!current || !canDiscardRecording(current) || current.startedAt !== entry.startedAt || current.lessonId !== entry.lessonId) return;
    try {
      await recordingChunkStore.clear(entry.recordingId);
      if (!removePendingRecording(entry.recordingId)) throw new Error('Unable to remove recovery information.');
    } catch {
      notify('The recording could not be removed.');
    }
    setOrphanTick((tick) => tick + 1);
  };

  // The raw saved workspace is not a course export (it cannot be imported); it is a copy to keep and to restore from.
  const downloadSavedCopy = async (issue: WorkspaceLoadIssue) => {
    try {
      const raw = await workspaceStore.readCopy(issue);
      if (!raw) {
        notify('The saved copy could not be read from this browser.');
        return;
      }
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = 'studentllm-workspace-saved-copy.json';
      link.click();
      URL.revokeObjectURL(url);
      notify('Saved copy downloaded. Keep the file somewhere safe.');
    } catch {
      notify('The saved copy could not be downloaded.');
    }
  };

  const startEmptyAnyway = () => {
    if (!window.confirm('Start with an empty workspace? The saved data will be replaced by what you do from now on. Download it first if you want to keep it.')) return;
    savingPausedRef.current = false;
    workspaceStore.setProtected(false);
    setStorageNotice(null);
    setSaveTick((tick) => tick + 1);
  };

  const exportCourse = async () => {
    try {
      const exportBlob = await buildCourseExport(activeLesson, activeWorkspace, {
        loadSourceBlob: (resourceId) => sourceBlobStore.load(resourceId),
        listAudioChunks: (recordingId) => recordingChunkStore.list(recordingId),
      });
      if (typeof URL.createObjectURL !== 'function') throw new Error('Downloads are unavailable in this browser.');
      const url = URL.createObjectURL(exportBlob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${activeLesson.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'course'}.studentllm.json`;
      link.click();
      URL.revokeObjectURL(url);
      const sizeWarning = exportSizeWarning(exportBlob.size);
      if (sizeWarning) setActionError(sizeWarning);
      notify(`${activeLesson.title} exported.`);
    } catch {
      notify('The course export could not be created.');
    }
  };

  const exportCourseNote = () => {
    try {
      const noteBlob = new Blob([courseNoteMarkdown(activeCourseNote)], { type: 'text/markdown;charset=utf-8' });
      if (typeof URL.createObjectURL !== 'function') throw new Error('Downloads are unavailable in this browser.');
      const url = URL.createObjectURL(noteBlob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = activeCourseNote.fileName;
      link.click();
      URL.revokeObjectURL(url);
      notify(`Course notes saved as ${activeCourseNote.fileName}.`);
    } catch {
      notify('The course notes could not be saved.');
    }
  };

  const importCourse = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      input.value = '';
      notify('Stop and save the recording before importing another course.');
      return;
    }
    const savedSourceIds: string[] = [];
    const savedAudioIds: string[] = [];
    try {
      const imported = await readCourseExport(file);
      try {
        for (const asset of imported.assets) {
          if (asset.storage === 'source') {
            const blob = new Blob(asset.chunks.map((chunk) => chunk.blob), { type: asset.chunks[0].blob.type || 'application/octet-stream' });
            await sourceBlobStore.save(asset.resourceId, blob);
            savedSourceIds.push(asset.resourceId);
          } else {
            for (const [sequence, chunk] of asset.chunks.entries()) {
              await recordingChunkStore.append({ recordingId: asset.resourceId, sequence, blob: chunk.blob, recordedAt: chunk.recordedAt });
            }
            savedAudioIds.push(asset.resourceId);
          }
        }
      } catch {
        await Promise.all(savedSourceIds.map((resourceId) => sourceBlobStore.remove(resourceId)));
        await Promise.all(savedAudioIds.map((resourceId) => recordingChunkStore.clear(resourceId)));
        throw new Error('Unable to restore course assets.');
      }
      setLessons((current) => [...current, imported.lesson]);
      setLessonWorkspaces((current) => ({ ...current, [imported.lesson.id]: imported.workspace }));
      setActiveLessonId(imported.lesson.id);
      setSelectedArtifactId(imported.workspace.artifacts[0]?.id ?? null);
      setView('course');
      setActionError('');
      setShowAllResources(false);
      notify(`${imported.lesson.title} imported.`);
    } catch (error) {
      setActionError(`${file.name} could not be imported. ${describeCourseImportFailure(error)} Nothing was changed.`);
    } finally {
      input.value = '';
    }
  };

  const createCourseRecord = (title: string, subject: string, chapter: string, message: string) => {
    const id = `lesson-${crypto.randomUUID()}`;
    const lesson: Lesson = {
      id,
      subject,
      chapter,
      title,
      teacher: '',
      duration: '00:00:00',
      date: new Date().toLocaleDateString('en-GB'),
      progress: 0,
    };
    setExpandedSubjects((expanded) => ({ ...expanded, [subject]: true }));
    setLessons((current) => [lesson, ...current]);
    setLessonWorkspaces((current) => ({ ...current, [id]: emptyLessonWorkspace }));
    setActiveLessonId(id);
    setSelectedArtifactId(null);
    setNewCourseTitle('');
    setNewCourseSubject('General');
    setNewCourseChapter('General notes');
    setShowNewCourse(false);
    setView('course');
    setActionError('');
    if (window.innerWidth <= 900) setShowLeftSidebar(false);
    notify(message);
  };

  const startQuickCourse = () => {
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      notify('Stop and save the recording before using Quick Start.');
      return;
    }
    createCourseRecord(randomQuickCourseTitle(), 'General', 'General notes', 'Quick Start created a blank course. Ready to record or import.');
  };

  const createCourse = (event: FormEvent) => {
    event.preventDefault();
    const title = newCourseTitle.trim();
    if (!title || isRecording || isFinalizingRecording || isStartingRecording) return;
    createCourseRecord(
      title,
      newCourseSubject.trim() || 'General',
      newCourseChapter.trim() || 'General notes',
      'New course created. Ready to record.',
    );
    setNewCourseTitle('');
    setNewCourseSubject('General');
    setNewCourseChapter('General notes');
    setShowNewCourse(false);
  };

  const openEditCourse = () => {
    if (!hasCourse || isRecording || isFinalizingRecording || isStartingRecording) return;
    setCourseEditDraft({
      title: activeLesson.title,
      subject: activeLesson.subject,
      chapter: activeLesson.chapter,
      sublesson: activeLesson.sublesson ?? '',
    });
    setActionError('');
    setCourseActionsOpen(false);
    setShowEditCourse(true);
  };

  const suggestCourseDetails = async () => {
    if (!hasCourse || isSuggestingCourseDetails) return;
    const workspace = lessonWorkspaces[activeLesson.id] ?? emptyLessonWorkspace;
    const material = [
      ...workspace.transcript.slice(-16).map((segment) => segment.text),
      ...workspace.resources.map((resource) => `Source: ${resource.name}`),
    ].join('\n').trim();
    if (!material) {
      setActionError('Add a recording or source before asking AI to name this course.');
      return;
    }
    if (!localProvider) {
      setActionError('Connect a local model in Settings before asking AI to name this course.');
      return;
    }
    setIsSuggestingCourseDetails(true);
    setActionError('');
    try {
      const proposal = await analyzeQuickStart(material, [activeLesson], localProvider);
      setCourseEditDraft((current) => ({
        ...current,
        title: proposal.title.trim() || current.title,
        subject: proposal.subject.trim() || current.subject,
        chapter: proposal.lesson.trim() || current.chapter,
        sublesson: proposal.sublesson.trim(),
      }));
      notify('AI suggested a course title and structure. Review before saving.');
    } catch (error) {
      setActionError(aiFailure(error, 'AI could not suggest course details.'));
    } finally {
      setIsSuggestingCourseDetails(false);
    }
  };

  const updateCourse = (event: FormEvent) => {
    event.preventDefault();
    if (!hasCourse || isRecording || isFinalizingRecording || isStartingRecording) return;
    const title = courseEditDraft.title.trim();
    if (!title) return;
    const updatedLesson: Lesson = {
      ...activeLesson,
      title,
      subject: courseEditDraft.subject.trim() || 'General',
      chapter: courseEditDraft.chapter.trim() || 'General notes',
      ...(courseEditDraft.sublesson.trim() ? { sublesson: courseEditDraft.sublesson.trim() } : {}),
    };
    setLessons((current) => current.map((lesson) => lesson.id === updatedLesson.id ? updatedLesson : lesson));
    setExpandedSubjects((current) => ({ ...current, [updatedLesson.subject]: true }));
    setLessonWorkspaces((current) => {
      const workspace = current[updatedLesson.id] ?? emptyLessonWorkspace;
      return {
        ...current,
        [updatedLesson.id]: {
          ...workspace,
          courseNote: buildCourseNote(updatedLesson, workspace.transcript),
        },
      };
    });
    setCourseEditDraft({ title: '', subject: '', chapter: '', sublesson: '' });
    setShowEditCourse(false);
    notify('Course details saved.');
  };

  const renderTranscriptSegment = (segment: TranscriptSegment) => <TranscriptItem key={segment.id} segment={segment} onToggleReview={onToggleReview} />;

  const renderCourseNoteBlock = (block: CourseNoteBlock) => <CourseNoteBlockView key={block.id} block={block} />;

  return (
    <div className="app-shell">
      <input ref={sourceInputRef} hidden tabIndex={-1} type="file" multiple aria-label="Select course source" accept={sourceAccept} onChange={importSource} />
      <input ref={folderInputRef} hidden tabIndex={-1} type="file" multiple aria-label="Select course folder" onChange={importFolder} />
      <header className="topbar">
        <div className="topbar-leading">
          <button ref={menuButtonRef} className="icon-button" aria-label="Show or hide navigation" aria-expanded={showLeftSidebar} onClick={() => setShowLeftSidebar((value) => !value)}><Menu size={20} /></button>
          <span className="brand-name"><span className="brand-mark" aria-hidden="true"><BrandGlyph size={24} /></span>StudentLLM</span>
        </div>
        <button className="icon-button" aria-label="Settings" onClick={() => setShowSettingsPanel(true)}><Settings2 size={19} /></button>
      </header>

      {sessionOnlyRecovery && <div className="action-error storage-banner" role="status"><p>Recovery information is saved only for this browser session because local storage is full or blocked. Finish and save any recording before closing this tab or browser. Interrupted audio may otherwise be hard to find, and pending file cleanup information may be lost.</p></div>}
      {storageNotice && <div className="action-error storage-banner" role="alert"><p>{storageNoticeText(storageNotice)}</p><span className="storage-banner-actions">
        {(storageNotice.kind === 'changed-elsewhere' || storageNotice.kind === 'indexeddb-blocked' || storageNotice.kind === 'indexeddb-timeout') && <button className="text-action" onClick={() => { skipUnloadWarningRef.current = true; window.location.reload(); }}>Reload</button>}
        {(storageNotice.kind === 'changed-elsewhere' || storageNotice.kind === 'save-failed' || storageNotice.kind === 'indexeddb-blocked' || storageNotice.kind === 'indexeddb-timeout') && hasCourse && <button className="text-action" onClick={() => void exportCourse()}>Export this course</button>}
        {storageNotice.kind === 'load-issue' && (storageNotice.issue.copyKey !== undefined || storageNotice.issue.raw !== undefined) && <button className="text-action" onClick={() => void downloadSavedCopy(storageNotice.issue)}>{storageNotice.issue.kind === 'older-copy' ? 'Download older copy' : storageNotice.issue.protect ? 'Download saved data' : 'Download saved copy'}</button>}
        {(storageNotice.kind === 'indexeddb-unavailable' || storageNotice.kind === 'indexeddb-timeout') && <button className="text-action" onClick={() => setStorageNotice(null)}>Dismiss</button>}
        {storageNotice.kind === 'load-issue' && storageNotice.issue.protect && storageNotice.issue.kind !== 'newer-version' && <button className="text-action" onClick={startEmptyAnyway}>Start empty anyway</button>}
        {storageNotice.kind === 'load-issue' && !storageNotice.issue.protect && <button className="text-action" onClick={() => setStorageNotice(null)}>Dismiss</button>}
      </span></div>}
      <div className={`workspace-grid ${showLeftSidebar ? 'with-navigation' : ''}`}>
        {showLeftSidebar && <>
          <button className="navigation-scrim" tabIndex={-1} aria-label="Close navigation" onClick={() => setShowLeftSidebar(false)} />
          <aside ref={drawerRef} className="left-sidebar workspace-sidebar" aria-label="Course navigation" onKeyDown={trapDrawerTab}>
            <div className="sidebar-start-actions">
              <button className="sidebar-row sidebar-row-primary" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={startQuickCourse}><Shuffle size={16} /><span>Quick start</span></button>
              <button className="sidebar-row" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={() => setShowNewCourse(true)}><Plus size={16} /><span>New course</span></button>
              <button className="sidebar-row" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={() => folderInputRef.current?.click()}><FolderOpen size={16} /><span>Import folder</span></button>
            </div>
            {lessons.length > 0 && <label className="search-field"><Search size={16} /><input aria-label="Search courses" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Find a course" /></label>}
            <div className="sidebar-section-header"><span>Courses</span><span>{lessons.length}</span></div>
            <nav className="course-tree">
              {courseTree.map(({ subject, chapters }) => (
                <div className="tree-group" key={subject}>
                  <button className="tree-subject" aria-expanded={Boolean(expandedSubjects[subject])} onClick={() => setExpandedSubjects((current) => ({ ...current, [subject]: !current[subject] }))}>
                    <span>{subject}</span>{expandedSubjects[subject] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  {expandedSubjects[subject] && chapters.map(({ chapter, lessons: chapterLessons }) => (
                    <div className="tree-children" key={chapterGroupKey(subject, chapter)}>
                      {chapter !== 'General notes' && <span className="tree-chapter">{chapter}</span>}
                      {chapterLessons.map((lesson) => <button key={lesson.id} className={`tree-lesson ${activeLesson.id === lesson.id ? 'active' : ''}`} aria-current={activeLesson.id === lesson.id ? 'page' : undefined} aria-label={lesson.title} onClick={() => selectLesson(lesson.id)}><FileText size={15} /><span>{lesson.title}</span></button>)}
                    </div>
                  ))}
                </div>
              ))}
              {!courseTree.length && <p className="empty-state">{lessons.length ? 'No matching courses.' : 'Your courses will appear here.'}</p>}
            </nav>
            <div className="sidebar-footer">
              {lessons.length > 0 && <button className="ghost-row sidebar-row" onClick={() => setShowGlobalSearch(true)}><AnimatedIcon name="magnifier" size={18} /><span>Global search</span></button>}
              <label className="ghost-row sidebar-row file-label"><Upload size={16} /><span>Import course</span><input className="visually-hidden" type="file" accept="application/json,.json" aria-label="Import course export" onChange={(event) => void importCourse(event)} /></label>
            </div>
          </aside>
        </>}

        <main className="main-panel" inert={drawerOpen}>
          {importTotals && <div className="import-progress">
            <span className="import-progress-label" role="status">Importing {Math.min(importTotals.done + 1, importTotals.total)} of {importTotals.total}{importQueue[0] ? ` · ${importQueue[0].file.name}` : ''}</span>
            <span className="import-progress-track" aria-hidden="true"><span style={{ width: `${(importTotals.done / importTotals.total) * 100}%` }} /></span>
            {importQueue.length > 1 && <button type="button" className="text-action" onClick={stopBatchImport}>Stop after this file</button>}
          </div>}
          {!nativeStorageReady ? <p role="status">Opening your library...</p> : !hasCourse ? (
            <section className="welcome">
              <EmptyStateIcon name="file-text" />
              <h1>A place for your courses.</h1>
              <p>Create a course, then record a lecture or import your notes.<br />Your material stays together here.</p>
              <button className="primary-action" onClick={startQuickCourse}><Shuffle size={17} /> Quick start</button>
              <button className="text-action" onClick={openAiOrganizer}><Sparkles size={16} /> Organize material with AI</button>
              <button className="text-action" onClick={() => setShowNewCourse(true)}><Plus size={16} /> Create your first course</button>
              <button className="text-action" onClick={() => folderInputRef.current?.click()}><FolderOpen size={16} /> Import a course folder</button>
            </section>
          ) : <>
            <div className="main-header">
              <div className="main-heading" key={activeLesson.id}><p>{activeLesson.subject}{activeLesson.chapter !== 'General notes' ? ` / ${activeLesson.chapter}` : ''}</p><h1>{activeLesson.title}</h1></div>
              <details className="course-actions" ref={courseActionsRef} open={courseActionsOpen} onToggle={(event) => setCourseActionsOpen(event.currentTarget.open)}>
                <summary aria-label="Course actions" ref={courseActionsSummaryRef}>More <ChevronDown size={15} /></summary>
                <div className="course-actions-menu" onClick={() => setCourseActionsOpen(false)}>
                  <button onClick={openEditCourse}><AnimatedIcon name="pencil" size={17} /> Edit course</button>
                  <button onClick={openAiOrganizer}><Sparkles size={15} /> Organize material with AI</button>
                  <button onClick={exportCourseNote}><Download size={15} /> Save note</button>
                  <button onClick={() => void exportCourse()}><Download size={15} /> Export course</button>
                  <button onClick={() => setShowTranscriptPanel(true)}><FileText size={15} /> Full transcript</button>
                  <button onClick={() => setShowReviewPanel(true)}><ListChecks size={15} /> Needs review ({reviewItems.length})</button>
                  <button className="danger-link" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={() => setShowDeleteCourse(true)}><Trash2 size={15} /> Delete course</button>
                </div>
              </details>
            </div>
            <div className="view-tabs" ref={viewTabsRef} role="tablist" aria-label="Course view">
              {viewTabIds.map((tab) => <button key={tab} id={`view-tab-${tab}`} role="tab" aria-selected={view === tab} aria-controls={`view-panel-${tab}`} tabIndex={view === tab ? 0 : -1} className={view === tab ? 'active' : ''} onKeyDown={onViewTabKeyDown} onClick={() => { setCourseActionsOpen(false); setView(tab); setActionError(''); }}>{tab === 'course' ? 'Notes' : tab === 'sources' ? `Sources${resources.length ? ` (${resources.length})` : ''}` : tab === 'chat' ? 'Chat' : 'Study'}</button>)}
            </div>
            {actionError && <div className="action-error" role="alert"><p>{actionError}</p><button className="text-action" onClick={() => setShowSettingsPanel(true)}>Open Settings</button></div>}
            {isRecording && view !== 'course' && <section className="recording-bar recording" aria-label="Course recording"><div className="recording-actions"><button className="primary-action stop" aria-label="Stop recording" onClick={toggleRecording}><Square size={16} /> Stop recording</button><span className="recording-time">{formatElapsed(recordingSeconds)}</span></div></section>}
            {view === 'course' && <div className="course-view" id="view-panel-course" role="tabpanel" aria-labelledby="view-tab-course">
              <section className={`recording-bar ${isRecording ? 'recording' : ''}`} aria-label="Course recording">
                <div className="recording-actions">
                  <button className={`primary-action ${isRecording ? 'stop' : ''}`} onClick={toggleRecording} disabled={isFinalizingRecording || isStartingRecording} aria-label={isRecording ? 'Stop recording' : isFinalizingRecording ? 'Finishing recording' : isStartingRecording ? 'Starting recording' : 'Start recording'}>
                    {isRecording ? <Square size={16} /> : <AnimatedIcon name="microphone" size={19} />}{isRecording ? 'Stop recording' : isFinalizingRecording ? 'Saving recording' : isStartingRecording ? 'Starting...' : 'Record'}
                  </button>
                  {!isRecording && <button className="secondary-action" onClick={() => openSourcePicker(sourceAccept)}><Upload size={16} /> Import file</button>}
                  {isRecording && <><span className="recording-time">{formatElapsed(recordingSeconds)}</span><button className="text-action" onClick={addBookmark} aria-label="Bookmark this passage"><Plus size={16} /> Mark passage</button></>}
                </div>
                <p className="recording-hint">{isFinalizingRecording ? 'Saving audio and preparing transcript...' : isRecording ? localSpeechEngine ? 'Recording. Transcription will appear as audio is processed.' : 'Recording audio. Connect a speech service in Settings for live transcription.' : 'Audio, PDF, images or text notes'}</p>
              </section>
              {recordingError && <p className="action-error" role="alert">{recordingError}</p>}
              {liveTranscriptionError && <p className="action-error" role="alert">{liveTranscriptionError}</p>}
              <section className="course-note-document" aria-label="Course notes document">
                <div className="course-note-toolbar"><span>Course notes</span><div className="course-note-toolbar-actions">{isRecording && <span className="course-note-status" role="status" aria-label="Live transcription status">{localSpeechEngine ? visibleLiveTranscript.length ? 'Live transcription' : 'Waiting for transcription' : 'Audio recording'}</span>}{(transcript.length > 0 || visibleLiveTranscript.length > 0) && <button className="text-action" onClick={exportCourseNote}><Download size={15} /> Save note</button>}</div></div>
                <div className="course-note-content" aria-live={isRecording ? 'polite' : 'off'}>
                  {isRecording && <p className="course-note-meta" role="status">{localProvider ? !recorderRef.current?.readPreviewWindow ? 'This browser cannot draft live notes. The transcript is shown below; notes are written after recording stops.' : liveDraft.status || 'Waiting for a complete passage to write notes. The verbatim transcript appears below.' : 'Verbatim transcript. Connect a language model in Settings for structured notes.'}</p>}
                  {transcript.length || visibleLiveTranscript.length ? activeCourseNote.blocks.map(renderCourseNoteBlock) : <div className="note-empty"><EmptyStateIcon name="microphone" /><h2>Your notes start here.</h2><p>Record your lecture or import a file above.</p><p>Text notes appear directly. Audio transcription and PDF extraction need a connected service.</p><button className="text-action" onClick={() => setShowSettingsPanel(true)}>Set up transcription</button></div>}
                </div>
              </section>
              {isRecording && localSpeechEngine && <section className="live-transcript-panel" aria-label="Live course transcription">
                <div className="live-transcript-header"><strong>Live transcript</strong><span>Original speech, separate from the notes. The latest words may change. Speaker identification is not enabled by the local speech service.</span></div>
                <div ref={liveTranscriptFeedRef} aria-live="polite">{visibleLiveTranscript.length ? groupTranscript(visibleLiveTranscript).map(renderTranscriptSegment) : <p className="empty-state">Waiting for the first transcribed passage.</p>}</div>
              </section>}
              {(transcript.length > 0 || isRecording) && <TranscriptDisclosure key={activeLesson.id} summary={`Transcript ${isRecording ? '(recording)' : `(${transcript.length})`}`}>
                {() => <div className={`transcript-list ${compactTranscript ? 'compact' : ''}`} role="region" aria-label="Transcript preview">{courseTranscript.map(renderTranscriptSegment)}</div>}
                <button className="text-action" onClick={() => setShowTranscriptPanel(true)}>View all <ArrowUpRight size={13} /></button>
              </TranscriptDisclosure>}
            </div>}
            {view === 'sources' && <section className="sources-view" id="view-panel-sources" role="tabpanel" aria-labelledby="view-tab-sources">
              <div className="section-toolbar"><h2>Sources</h2><button className="secondary-action" onClick={() => openSourcePicker(sourceAccept)}><Plus size={16} /> Import file</button></div>
              {!resources.length && <div className="empty-panel"><EmptyStateIcon name="folder" /><p className="empty-state">Add audio, a PDF, an image or text notes to this course.</p></div>}
              <div className="resource-list">{activeResources.map((resource) => <div className="resource-item" key={resource.id}>
                <button className="resource-open" data-resource-id={resource.id} onClick={() => void openResource(resource)}>{resourceIcon(resource.kind)}<span><strong>{resource.name}</strong><small>{transcribingResourceIds.has(resource.id) ? 'Transcribing...' : resource.meta}</small></span><ChevronRight size={16} /></button>
                {resource.kind === 'audio' && <button className="text-action" aria-label={`Transcribe ${resource.name}`} disabled={transcribingResourceIds.has(resource.id)} onClick={() => void transcribeSource(resource)}>{transcribingResourceIds.has(resource.id) ? 'Transcribing...' : 'Transcribe'}</button>}
                <button className="icon-button" aria-label={`Remove source ${resource.name}`} disabled={transcribingResourceIds.has(resource.id)} onClick={() => removeSource(resource)}><X size={16} /></button>
              </div>)}</div>
              {resources.length > 3 && <button className="text-action" onClick={() => setShowAllResources((value) => !value)}>{showAllResources ? 'Show fewer' : `Show ${resources.length - 3} more sources`}</button>}
            </section>}
            {view === 'chat' && <section className="chat-view" id="view-panel-chat" role="tabpanel" aria-labelledby="view-tab-chat">
              <div className="chat-intro">{!chat.length && <EmptyStateIcon name="magnifier" />}<h2>Ask about this course</h2><p>{localProvider ? 'Answers use your notes and sources. LM Studio must be running with a loaded model.' : 'Connect LM Studio in Settings to generate answers. You can still search and open your sources.'}</p></div>
              {!resources.length && !transcript.length && <p className="empty-state">Import material or record a lecture before asking a question.</p>}
               <div className="chat-list" aria-live="polite">{chat.map((message) => <article className={`chat-message ${message.role}`} data-role={message.role} aria-label={message.role === 'user' ? 'Your message' : 'Course assistant response'} key={message.id}><header className="message-header"><span className="message-role">{message.role === 'user' ? 'You' : 'Course assistant'}</span></header><div className="message-content"><RichText content={message.content} className="chat-markdown" /></div>{message.citations && <div className="citation-list" aria-label="Response sources">{message.citations.map((citation, index) => message.citationTargets?.[index] ? <button type="button" className="citation-chip" title="Open original source" key={citation} onClick={() => openCitation(message.citationTargets![index])}><FileText size={13} /><span>{citation}</span></button> : <span className={citation.startsWith('LM Studio') ? 'citation-model' : 'citation-context'} key={citation}>{citation}</span>)}</div>}</article>)}</div>
              {isSending && <div className="chat-typing" aria-hidden="true"><span /><span /><span /></div>}
              {chatError && chatError.lessonId === activeLessonId && <div className="action-error chat-error" role="alert"><p>{chatError.message}</p><button type="button" className="text-action" onClick={() => setShowSettingsPanel(true)}>Open Settings</button></div>}<form className="chat-composer" onSubmit={submitComposer}><input aria-label="Ask the course chat" value={composerValue} onChange={(event) => { setComposerValue(event.target.value); if (chatError) setChatError(null); }} placeholder="Ask a question about your course" disabled={isSending} /><button className="primary-action" type="submit" aria-label="Send" disabled={isSending || !composerValue.trim()}>{isSending ? 'Thinking...' : <Send size={17} />}</button></form>
            </section>}
            {view === 'study' && <section className="study-view" id="view-panel-study" role="tabpanel" aria-labelledby="view-tab-study">
              <h2>Study materials</h2><p className="muted">Choose a format and build it from the material saved in this course.</p>
              {!hasStudyMaterial && <p className="study-empty-hint"><AnimatedIcon name="star" size={22} intro className="hint-icon" />Import notes or finish a transcription to enable study material generation.</p>}
              <div className="artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className={`artifact-button${generatingArtifact === artifact.kind ? ' is-generating' : ''}`} disabled={generatingArtifact !== null || !hasStudyMaterial} onClick={() => void createArtifact(artifact.kind)}><span className={`icon-tile tone-${artifact.tone}`} aria-hidden="true"><artifact.icon size={18} /></span><strong>{generatingArtifact === artifact.kind ? 'Generating...' : artifact.label}</strong><small>{artifact.description}</small></button>)}</div>
              {artifacts.length > 0 && <section className="recent-section"><h3>Saved materials</h3>{artifacts.map((artifact) => <button className="recent-artifact" key={artifact.id} aria-label={`Open artifact ${artifact.label}`} onClick={() => setSelectedArtifactId(artifact.id)}>{artifact.label}</button>)}
              {(() => { const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId); return selected && <article className="artifact-preview"><h3>{selected.label}</h3><RichText content={selected.content ?? ''} className="study-markdown" />{selected.visuals?.map((visual, index) => <VisualBlockView key={`${selected.id}-visual-${index}`} visual={visual} />)}{selected.citations && <div className="citation-list" aria-label="Study material sources">{selected.citations.map((citation, index) => selected.citationTargets?.[index] ? <button type="button" className="citation-chip" key={citation} title="Open original source" onClick={() => openCitation(selected.citationTargets![index])}><FileText size={13} /><span>{citation}</span></button> : <span className="citation-context" key={citation}>{citation}</span>)}</div>}</article>; })()}</section>}
            </section>}
          </>}
        </main>
      </div>

      {resourcePreview && <div className="modal-backdrop" role="presentation" onMouseDown={() => setResourcePreview(null)}><section className="modal resource-preview-modal" role="dialog" aria-modal="true" aria-labelledby="resource-preview-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Original source</span><h2 id="resource-preview-title">{resourcePreview.resource.name}</h2></div><button className="icon-button" aria-label="Close source preview" onClick={() => setResourcePreview(null)}><X size={17} /></button></div><p className="modal-description">{resourcePreview.resource.meta}{resourcePreview.resource.sha256 ? ` · SHA-256 ${resourcePreview.resource.sha256.slice(0, 12)}…` : ''}</p>{resourcePreview.state === 'loading' && <p className="empty-state">Opening the locally stored source…</p>}{resourcePreview.state === 'missing' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'error' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'ready' && resourcePreview.text !== undefined && <div className="source-text-preview"><pre>{resourcePreview.text}</pre>{resourcePreview.truncated && <small>Preview truncated to 12,000 characters. The original source remains unchanged.</small>}</div>}{resourcePreview.state === 'ready' && resourcePreview.blob && isPdfResource(resourcePreview.resource) && <Suspense fallback={<p className="source-preview-loading">Loading PDF renderer…</p>}><PdfPreview blob={resourcePreview.blob} initialPage={resourcePreview.page} /></Suspense>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'image' && <img className="source-image-preview" src={resourcePreview.blobUrl} alt={`Preview of ${resourcePreview.resource.name}`} />}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'audio' && <audio className="source-audio-preview" controls src={resourcePreview.blobUrl}>Your browser cannot play this audio source.</audio>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'document' && !isPdfResource(resourcePreview.resource) && <iframe className="source-document-preview" title={`Preview of ${resourcePreview.resource.name}`} src={resourcePreview.blobUrl} />}</section></div>}
      {showRecordingNotice && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowRecordingNotice(false)}><section className="modal recording-notice-modal" role="dialog" aria-modal="true" aria-labelledby="recording-notice-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Recording notice</span><h2 id="recording-notice-title">Before you record</h2></div><button className="icon-button" aria-label="Close recording notice" onClick={() => setShowRecordingNotice(false)}><X size={17} /></button></div><p className="modal-description">Only record people who have been clearly informed and have given any consent required by applicable law.</p><div className="recording-notice-copy"><p><strong>Do not record private or confidential speech without consent.</strong></p><p>You are responsible for using this feature lawfully, including informing participants, obtaining consent, respecting their rights, and deleting recordings when required. StudentLLM does not verify consent, and this acknowledgement does not make unlawful recording lawful.</p><p>Audio and transcripts remain in this workspace unless you configure another local or compatible processing service. Review your service settings before recording sensitive material.</p><p className="recording-notice-links"><ExternalLink href="https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000049312755/2024-06-26">French Penal Code, Article 226-1</ExternalLink><ExternalLink href="https://www.cnil.fr/fr/les-bases-legales/consentement">CNIL consent guidance</ExternalLink></p></div><label className="consent-checkbox"><input type="checkbox" checked={recordingNoticeChecked} onChange={(event) => setRecordingNoticeChecked(event.target.checked)} /><span>I will only record lawfully and will inform participants before recording.</span></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowRecordingNotice(false)}>Cancel</button><button type="button" className="primary-submit" disabled={!recordingNoticeChecked} onClick={acceptRecordingNotice}>I understand and agree</button></div></section></div>}
      {showQuickStart && <div className="modal-backdrop" role="presentation" onMouseDown={() => { setShowQuickStart(false); resetQuickStart(); }}><section className="modal quick-start-modal" role="dialog" aria-modal="true" aria-labelledby="quick-start-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">AI course organizer</span><h2 id="quick-start-title">Organize material with AI</h2></div><button className="icon-button" aria-label="Close AI organizer" onClick={() => { setShowQuickStart(false); resetQuickStart(); }}><X size={17} /></button></div><p className="modal-description">Paste a lecture excerpt or course description. AI proposes the hierarchy and destination; review it before saving.</p>{!quickStartProposal ? <form onSubmit={analyzeQuickStartInput}><label>Lecture excerpt or course description<textarea autoFocus rows={8} value={quickStartInput} onChange={(event) => setQuickStartInput(event.target.value)} placeholder="Paste what you are studying, or a few paragraphs from the lecture..." /></label><label>Source name <span className="muted">optional</span><input value={quickStartSourceName} onChange={(event) => setQuickStartSourceName(event.target.value)} placeholder="e.g. week-04-notes" /></label>{!localProvider && <p className="quick-start-note">Connect LM Studio in Settings to analyze and organize this material.</p>}{quickStartError && <p className="action-error" role="alert">{quickStartError}</p>}<div className="modal-footer"><button type="button" className="secondary-action" onClick={() => { setShowQuickStart(false); resetQuickStart(); }}>Cancel</button><button className="primary-submit" type="submit" disabled={!quickStartInput.trim() || isAnalyzingQuickStart}><Sparkles size={15} /> {isAnalyzingQuickStart ? 'Analyzing...' : 'Analyze structure'}</button></div></form> : <div className="quick-start-review"><div className="quick-start-fields"><label>Course group<input value={quickStartProposal.course} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, course: event.target.value } : current)} /></label><label>Subject<input value={quickStartProposal.subject} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, subject: event.target.value } : current)} /></label><label>Lesson<input value={quickStartProposal.lesson} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, lesson: event.target.value } : current)} /></label><label>Title<input value={quickStartProposal.title} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, title: event.target.value } : current)} /></label><label>Sublesson <span className="muted">optional</span><input value={quickStartProposal.sublesson} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, sublesson: event.target.value } : current)} placeholder="No sublesson detected" /></label></div><label>Place this material in<select aria-label="Place this material in" value={quickStartPlacement} onChange={(event) => setQuickStartPlacement(event.target.value)}><option value="new">Create a new course</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.subject} / {lesson.chapter} / {lesson.title}</option>)}</select></label><div className="quick-start-summary"><strong>{Math.round(quickStartProposal.confidence * 100)}% confidence</strong><span>{quickStartProposal.rationale}</span><small>{quickStartPlacement === 'new' ? `Creates ${quickStartProposal.course} / ${quickStartProposal.lesson} / ${quickStartProposal.title}` : 'Adds the source to the selected existing course.'}</small></div>{quickStartError && <p className="action-error" role="alert">{quickStartError}</p>}<div className="modal-footer"><button type="button" className="text-action" onClick={() => { setQuickStartProposal(null); setQuickStartError(''); }}>Edit material</button><button type="button" className="primary-submit" onClick={() => void applyQuickStart()}><Check size={15} /> Apply structure</button></div></div>}</section></div>}
      {showNewCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">New course</span><h2 id="new-course-title">Start a course</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowNewCourse(false)}><X size={17} /></button></div><p className="modal-description">Give your course a name. You can add recordings and files next.</p><form onSubmit={createCourse}><label>Course title<input autoFocus value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} placeholder="e.g. Introduction to probability" /></label><label>Subject<input list="course-subject-suggestions" value={newCourseSubject} onChange={(event) => setNewCourseSubject(event.target.value)} placeholder="e.g. Machine Learning" /></label><datalist id="course-subject-suggestions">{subjectOptions.map((subjectOption) => <option key={subjectOption} value={subjectOption} />)}</datalist><label>Chapter<input value={newCourseChapter} onChange={(event) => setNewCourseChapter(event.target.value)} placeholder="e.g. Transformers" /></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowNewCourse(false)}>Cancel</button><button className="primary-submit" type="submit" disabled={!newCourseTitle.trim()}><Plus size={15} /> Create course</button></div></form></section></div>}
      {showEditCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowEditCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Course structure</span><h2 id="edit-course-title">Edit course</h2></div><button className="icon-button" aria-label="Close edit course" onClick={() => setShowEditCourse(false)}><X size={17} /></button></div><p className="modal-description">Update the names used in the course tree and saved note location.</p><div className="edit-course-tools"><button type="button" className="secondary-action" onClick={() => void suggestCourseDetails()} disabled={isSuggestingCourseDetails || !localProvider || !transcript.length && !resources.length}><Sparkles size={15} /> {isSuggestingCourseDetails ? 'Suggesting...' : 'Suggest with AI'}</button><small>{transcript.length || resources.length ? 'Use the saved material to propose a title and hierarchy.' : 'Record or import material first.'}</small></div>{actionError && <p className="action-error" role="alert">{actionError}</p>}<form onSubmit={updateCourse}><label>Course title<input autoFocus value={courseEditDraft.title} onChange={(event) => setCourseEditDraft((current) => ({ ...current, title: event.target.value }))} /></label><label>Subject<input list="course-subject-suggestions" value={courseEditDraft.subject} onChange={(event) => setCourseEditDraft((current) => ({ ...current, subject: event.target.value }))} /></label><label>Chapter<input value={courseEditDraft.chapter} onChange={(event) => setCourseEditDraft((current) => ({ ...current, chapter: event.target.value }))} /></label><label>Sublesson <span className="muted">optional</span><input value={courseEditDraft.sublesson} onChange={(event) => setCourseEditDraft((current) => ({ ...current, sublesson: event.target.value }))} placeholder="No sublesson" /></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowEditCourse(false)}>Cancel</button><button className="primary-submit" type="submit" disabled={!courseEditDraft.title.trim()}><Check size={15} /> Save course changes</button></div></form></section></div>}
      {showDeleteCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowDeleteCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Delete course</span><h2 id="delete-course-title">Delete {activeLesson.title}?</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowDeleteCourse(false)}><X size={17} /></button></div><p className="modal-description">This removes the course workspace and its locally stored source and recording data. This action cannot be undone from the app.</p><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowDeleteCourse(false)}>Cancel</button><button className="danger-submit" type="button" onClick={() => void deleteActiveCourse()}><Trash2 size={14} /> Delete course permanently</button></div></section></div>}
      {showGlobalSearch && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowGlobalSearch(false)}><section className="modal search-modal" role="dialog" aria-modal="true" aria-labelledby="global-search-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace index</span><h2 id="global-search-title">Search all course content</h2></div><button className="icon-button" aria-label="Close search" onClick={() => setShowGlobalSearch(false)}><X size={17} /></button></div><label className="modal-search"><Search size={15} /><input autoFocus aria-label="Search all course content" value={globalSearchValue} onChange={(event) => setGlobalSearchValue(event.target.value)} placeholder="Search courses, transcripts, and sources" /></label>{globalSearchValue.trim() && <div className="search-results" aria-live="polite">{globalSearchResults.length ? globalSearchResults.map((result) => <button className="search-result" key={`${result.lessonId}:${result.id}`} onClick={() => openSearchResult(result.lessonId)}><strong><Snippet text={result.title} query={globalSearchValue} /></strong><small>{result.detail}</small></button>) : <p className="empty-state">No matching course content.</p>}</div>}</section></div>}
      {showReviewPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReviewPanel(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="review-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Review queue</span><h2 id="review-panel-title">Needs review <span className="modal-count">{reviewItems.length}</span></h2></div><button className="icon-button" aria-label="Close review queue" onClick={() => setShowReviewPanel(false)}><X size={17} /></button></div><p className="modal-description">Transcript segments and imported pages that still need a quick human check.</p><div className="review-results">{reviewItems.length ? reviewItems.map(({ lesson, segment }) => <button className="review-result" key={`${lesson.id}:${segment.id}`} onClick={() => { selectLesson(lesson.id); setShowReviewPanel(false); }}><strong><Snippet text={segment.text} /></strong><small>{lesson.title} · {segment.timestamp}</small></button>) : <p className="empty-state">Nothing needs review.</p>}</div></section></div>}
      {showTranscriptPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowTranscriptPanel(false)}><section className="modal transcript-modal" role="dialog" aria-modal="true" aria-labelledby="transcript-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Transcript archive</span><h2 id="transcript-panel-title">Full transcript <span className="modal-count">{transcript.length}</span></h2>{visibleLiveTranscript.length > 0 && <span className="review-badge">Live preview</span>}</div><button className="icon-button" aria-label="Close full transcript" onClick={() => setShowTranscriptPanel(false)}><X size={17} /></button></div><p className="modal-description">Review every indexed segment from {activeLesson.title}. Changes are saved to this course workspace.</p><div className={`transcript-list modal-transcript-list ${compactTranscript ? 'compact' : ''}`}>{transcript.length || visibleLiveTranscript.length ? [...transcript, ...visibleLiveTranscript].map(renderTranscriptSegment) : <p className="empty-state">This course has no transcript segments yet.</p>}</div></section></div>}
      {showSettingsPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettingsPanel(false)}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace preferences</span><h2 id="settings-panel-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setShowSettingsPanel(false)}><X size={17} /></button></div><p className="modal-description">Connect your local services. Recording and text import work without an AI model. <ExternalLink href={USER_GUIDE_URL}>Read the user guide</ExternalLink> for setup help.</p>
        <form className="connection-settings" onSubmit={saveServiceSettings}>
          {NIM_AVAILABLE && <label>AI provider<select value={serviceDraft.llmProvider} onChange={(event) => setServiceDraft((current) => ({ ...current, llmProvider: event.target.value }))}><option value="lm-studio">LM Studio (local)</option><option value="nvidia-nim">NVIDIA NIM (cloud)</option></select></label>}
          {usesNim(serviceDraft) ? <>
            <p className="connection-notice" role="note">While NVIDIA NIM is selected, lecture transcripts, imported document text, notes and your questions are sent to NVIDIA automatically to format notes, answer chat and build study material. The dev server reads the key from NVIDIA_API_KEY on this computer; it never reaches this page.</p>
            <label>NVIDIA model<input list="nim-models" value={serviceDraft.nimModel} onChange={(event) => setServiceDraft((current) => ({ ...current, nimModel: event.target.value }))} placeholder={DEFAULT_NIM_MODEL} /></label>
            <datalist id="nim-models">{NIM_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
            <p className="empty-state">Suggested: {NIM_MODELS.map((model) => model.label).join(', ')}. You can enter another model ID. Connection checks send only a short test phrase.</p>
          </> : <>
            <div className="connection-field"><label htmlFor="local-llm-url">LM Studio address</label><input id="local-llm-url" value={serviceDraft.llmUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, llmUrl: event.target.value }))} placeholder="/lm-studio/v1" /><small>Works with LM Studio, Bionic, and any OpenAI-compatible local server.{isNativeRuntime() && ` ${LOOPBACK_HINT}`}</small></div>
            <label>Model<input value={serviceDraft.model} onChange={(event) => setServiceDraft((current) => ({ ...current, model: event.target.value }))} placeholder="Model identifier in LM Studio" /></label>
          </>}
          <div className="connection-field"><label htmlFor="local-asr-url">Speech service address</label><input id="local-asr-url" value={serviceDraft.asrUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, asrUrl: event.target.value }))} placeholder="http://127.0.0.1:8765" />{isNativeRuntime() && <small>{LOOPBACK_HINT}</small>}</div>
          <div className="connection-field"><label htmlFor="local-documents-url">Document service address</label><input id="local-documents-url" value={serviceDraft.documentsUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, documentsUrl: event.target.value }))} placeholder="http://127.0.0.1:8766" />{isNativeRuntime() && <small>{LOOPBACK_HINT}</small>}</div>
          <button className="primary-submit" disabled={isRecording || isFinalizingRecording || isStartingRecording || isCheckingSidecars} type="submit">Save connections</button>
          <p className="empty-state" role="status">{usesNim(serviceSettings) ? 'NVIDIA NIM' : 'LM Studio / Bionic'}: {isCheckingSidecars ? 'Checking...' : llmHealth}</p>{availableModels.length > 0 && <p className="detected-models">Detected local models: {availableModels.join(', ')}</p>}
        </form>{!isNativeRuntime() && <StorageUsagePanel />}{orphanRecordings.length > 0 && <div className="storage-usage" role="group" aria-label="Unrecovered recordings"><strong>Unrecovered recordings</strong><p className="empty-state">These recordings were interrupted and their course is not in this workspace. The audio is kept in case the course comes back. Remove one only if you do not need it.</p>{orphanRecordings.map((entry) => <p className="empty-state" key={entry.recordingId}>{entry.lessonTitle || 'Untitled course'} <button type="button" className="text-action" onClick={() => void discardUnrecoveredRecording(entry)}>Remove recording</button></p>)}</div>}<div className="settings-list"><label className="setting-row"><span><strong>Dark mode</strong><small>Use a low-light workspace palette.</small></span><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /></label><label className="setting-row"><span><strong>Show verified transcript segments</strong><small>Keep completed segments visible in the course view.</small></span><input type="checkbox" checked={showVerifiedTranscript} onChange={(event) => setShowVerifiedTranscript(event.target.checked)} /></label><label className="setting-row"><span><strong>Compact transcript spacing</strong><small>Fit more indexed content on screen.</small></span><input type="checkbox" checked={compactTranscript} onChange={(event) => setCompactTranscript(event.target.checked)} /></label><div className="setting-info"><span className={`sidecar-status-dot ${sidecarHealth?.asr.available || sidecarHealth?.documents.available ? 'ready' : ''}`} /><span><strong>Local processing</strong><small>These optional helpers run on this computer. Recordings and imported files are always saved first; a helper that is not running only postpones transcription or text extraction.</small></span></div><div className="sidecar-status-list" aria-live="polite"><div><strong>Speech service (transcription)</strong><span className={sidecarHealth?.asr.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.asr.model ? `${sidecarHealth.asr.model} · ready` : sidecarHealth?.asr.detail ?? 'Not checked.'}</span></div><div><strong>Document service (PDF, images, Office)</strong><span className={sidecarHealth?.documents.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.documents.model ? `${sidecarHealth.documents.model} · ready` : sidecarHealth?.documents.detail ?? 'Not checked.'}</span></div></div><button type="button" className="secondary-action refresh-sidecars" onClick={() => void checkSidecars()} disabled={isCheckingSidecars}>{isCheckingSidecars ? 'Checking local services…' : 'Refresh local services'}</button><p className="credits">Icons by Lucide (ISC). <button type="button" className="link-button" onClick={() => setShowLicenses(true)}>Open-source licences</button></p></div><div className="modal-footer"><button type="button" className="primary-submit" onClick={() => setShowSettingsPanel(false)}>Done</button></div></section></div>}
      {showLicenses && <LicensesDialog onClose={() => setShowLicenses(false)} />}
      {isNativeRuntime() && <div className="managed-sidecar-tray" aria-label="Managed local services"><span>Managed services</span><span aria-live="polite">{managedSidecars.filter((sidecar) => sidecar.running).length}/2 running</span><button type="button" onClick={() => void startConfiguredSidecars()}>Start</button><button type="button" onClick={() => void stopConfiguredSidecars()}>Stop</button></div>}
      <div className="toast-stack">
        <div className="toast-slot" role="status" aria-atomic="true">{toast && <div className="toast">{toast}</div>}</div>
        <div className="toast-slot" role="status" aria-atomic="true">{pendingSourceRemoval && <div className="toast toast-undo" onPointerEnter={(event) => { if (event.pointerType === 'mouse') setUndoToastEngaged('hover', true); }} onPointerLeave={(event) => { if (event.pointerType === 'mouse') setUndoToastEngaged('hover', false); }} onFocus={() => setUndoToastEngaged('focus', true)} onBlur={() => setUndoToastEngaged('focus', false)}><span>{pendingSourceRemoval.resource.name} removed from this course.</span><button type="button" className="text-action" onClick={undoSourceRemoval}>Undo</button></div>}</div>
      </div>
    </div>
  );
}

export default App;
