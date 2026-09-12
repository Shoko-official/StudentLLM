import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileAudio,
  FileImage,
  FileText,
  ListChecks,
  Menu,
  Mic,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { requestRecorderSession, RecorderSession } from './lib/recorder';
import { isNativeRuntime, loadWorkspace, loadWorkspaceAsync, runPackagedIpcSmoke, saveWorkspaceAsync } from './lib/workspace-storage';
import type { WorkspaceStorageError } from './lib/workspace-storage';
import { createLocalLLMProvider } from './lib/llm-provider';
import type { LLMProvider } from './lib/llm-provider';
import { createLocalSpeechEngine } from './lib/speech-engine';
import type { SpeechEngine } from './lib/speech-engine';
import { createLocalDocumentEngine } from './lib/document-engine';
import type { DocumentEngine } from './lib/document-engine';
import { probeSidecar, SidecarHealth } from './lib/sidecar-health';
import { getManagedSidecarStatus, ManagedSidecarStatus, startManagedSidecars, stopManagedSidecars } from './lib/sidecar-supervisor';
import { createSourceResource } from './lib/source-ingest';
import { createSourceBlobStore } from './lib/source-storage';
import { AudioChunkStore, createRecordingChunkStore } from './lib/recording-storage';
import { listPendingRecordings, removePendingRecording, savePendingRecording } from './lib/recording-recovery';
import { buildCourseExport, readCourseExport } from './lib/course-transfer';
import { chunkSourceText } from './lib/source-chunking';
import { RetrievalDocument, searchDocuments } from './lib/local-retrieval';
import { RichText } from './lib/rich-text';
import { buildCourseNote, courseNoteMarkdown } from './lib/course-notes';
import { analyzeQuickStart } from './lib/quick-start';
import { applyRecordingPlacement, canAutoRouteRecording } from './lib/recording-routing';
import type { QuickStartProposal } from './lib/quick-start';
import { Artifact, ArtifactKind, ChatMessage, CourseNoteBlock, Lesson, LessonWorkspace, Resource, TranscriptSegment } from './types';

const initialLessons: Lesson[] = [];
const emptyLesson: Lesson = { id: '', subject: 'General', chapter: 'General notes', title: '', teacher: '', duration: '00:00:00', date: '', progress: 0 };

const artifactCatalog: { kind: ArtifactKind; label: string; description: string }[] = [
  { kind: 'summary', label: 'Quick summary', description: 'The essential ideas on one page.' },
  { kind: 'guide', label: 'Study guide', description: 'A structured, source-linked synthesis.' },
  { kind: 'quiz', label: 'Targeted quiz', description: 'Test the concepts that remain uncertain.' },
  { kind: 'flashcards', label: 'Flashcards', description: 'Prepare a review-ready card deck.' },
  { kind: 'mindmap', label: 'Concept map', description: 'Connect concepts and their dependencies.' },
  { kind: 'glossary', label: 'Glossary', description: 'Definitions for the course vocabulary.' },
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

const sourceAccept = 'audio/*,image/*,.pdf,.txt,.md';
const PREFERENCES_STORAGE_KEY = 'studentllm.preferences.v1';
const SERVICES_STORAGE_KEY = 'studentllm.services.v1';
type ServiceSettings = { llmUrl: string; model: string; asrUrl: string; documentsUrl: string };
function loadServiceSettings(): ServiceSettings {
  const defaults = {
    llmUrl: import.meta.env.VITE_LM_STUDIO_BASE_URL?.trim() || (import.meta.env.DEV ? '/lm-studio/v1' : 'http://127.0.0.1:1234/v1'),
    model: import.meta.env.VITE_LM_STUDIO_MODEL?.trim() || 'openai/gpt-oss-20b',
    asrUrl: import.meta.env.VITE_LOCAL_ASR_BASE_URL?.trim() || '',
    documentsUrl: import.meta.env.VITE_LOCAL_DOCUMENT_BASE_URL?.trim() || '',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SERVICES_STORAGE_KEY) ?? '{}');
    for (const key of Object.keys(defaults) as (keyof ServiceSettings)[]) {
      if (typeof saved?.[key] === 'string') defaults[key] = saved[key];
    }
  } catch { /* Use configured defaults if saved connection settings cannot be read. */ }
  return defaults;
}
const packagedIpcSmokeRequested = import.meta.env.VITE_STUDENTLLM_PACKAGED_IPC_SMOKE === 'true';

function loadPreference(name: 'compactTranscript' | 'showVerifiedTranscript', fallback: boolean) {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return fallback;
    const preferences = JSON.parse(raw) as Record<string, unknown>;
    return typeof preferences[name] === 'boolean' ? preferences[name] : fallback;
  } catch {
    return fallback;
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

function resourceIcon(kind: Resource['kind']) {
  if (kind === 'audio') return <FileAudio size={15} />;
  if (kind === 'image') return <FileImage size={15} />;
  if (kind === 'document') return <FileText size={15} />;
  return <Archive size={15} />;
}

function isTextResource(resource: Resource) {
  return resource.kind === 'transcript' || resource.mimeType?.startsWith('text/') === true;
}

export interface AppProps {
  provider?: LLMProvider | null;
  recorderSessionFactory?: () => Promise<RecorderSession>;
  speechEngine?: SpeechEngine | null;
  documentEngine?: DocumentEngine | null;
  recordingChunkStore?: AudioChunkStore;
  liveTranscriptionIntervalMs?: number;
}

interface ResourcePreview {
  resource: Resource;
  state: 'loading' | 'ready' | 'missing' | 'error';
  blobUrl?: string;
  text?: string;
  truncated?: boolean;
  detail?: string;
}

function App({ provider, recorderSessionFactory = requestRecorderSession, speechEngine, documentEngine, recordingChunkStore: recordingChunkStoreOverride, liveTranscriptionIntervalMs = 3_000 }: AppProps) {
  const [workspace] = useState(() => loadWorkspace(initialWorkspace));
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
  const [liveTranscriptionError, setLiveTranscriptionError] = useState('');
  const startingRecorderRef = useRef(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(workspace.lessonWorkspaces?.[workspace.activeLessonId]?.artifacts[0]?.id ?? workspace.artifacts[0]?.id ?? null);
  const [toast, setToast] = useState('');
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [showDeleteCourse, setShowDeleteCourse] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [globalSearchValue, setGlobalSearchValue] = useState('');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [quickStartInput, setQuickStartInput] = useState('');
  const [quickStartSourceName, setQuickStartSourceName] = useState('');
  const [quickStartProposal, setQuickStartProposal] = useState<QuickStartProposal | null>(null);
  const [quickStartPlacement, setQuickStartPlacement] = useState('new');
  const [isAnalyzingQuickStart, setIsAnalyzingQuickStart] = useState(false);
  const [quickStartError, setQuickStartError] = useState('');
  const [compactTranscript, setCompactTranscript] = useState(() => loadPreference('compactTranscript', false));
  const [showVerifiedTranscript, setShowVerifiedTranscript] = useState(() => loadPreference('showVerifiedTranscript', true));
  const [serviceSettings, setServiceSettings] = useState(loadServiceSettings);
  const [connectionsEnabled, setConnectionsEnabled] = useState(() => {
    try { return localStorage.getItem(SERVICES_STORAGE_KEY) !== null; } catch { return false; }
  });
  const [serviceDraft, setServiceDraft] = useState(serviceSettings);
  const [llmHealth, setLlmHealth] = useState('Not checked.');
  const [sidecarHealth, setSidecarHealth] = useState<{ asr: SidecarHealth; documents: SidecarHealth } | null>(null);
  const [managedSidecars, setManagedSidecars] = useState<ManagedSidecarStatus[]>([]);
  const [isCheckingSidecars, setIsCheckingSidecars] = useState(false);
  const [transcribingResourceIds, setTranscribingResourceIds] = useState<Set<string>>(() => new Set());
  const [resourcePreview, setResourcePreview] = useState<ResourcePreview | null>(null);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseSubject, setNewCourseSubject] = useState('General');
  const [newCourseChapter, setNewCourseChapter] = useState('General notes');
  const recorderRef = useRef<RecorderSession | null>(null);
  const liveTranscriptionInFlight = useRef(false);
  const liveTranscriptFeedRef = useRef<HTMLDivElement | null>(null);
  const storageIssueRef = useRef<WorkspaceStorageError['operation'] | null>(null);
  const resourcePreviewRequest = useRef(0);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const localProvider = useMemo(() => provider === undefined ? (serviceSettings.llmUrl ? createLocalLLMProvider({ MODE: import.meta.env.MODE, VITE_LM_STUDIO_AUTO_CONNECT: connectionsEnabled ? 'true' : import.meta.env.VITE_LM_STUDIO_AUTO_CONNECT, VITE_LM_STUDIO_BASE_URL: serviceSettings.llmUrl, VITE_LM_STUDIO_MODEL: serviceSettings.model }) : null) : provider, [provider, serviceSettings, connectionsEnabled]);
  const localSpeechEngine = useMemo(() => speechEngine === undefined ? createLocalSpeechEngine({ VITE_LOCAL_ASR_BASE_URL: serviceSettings.asrUrl, VITE_LOCAL_ASR_LANGUAGE: import.meta.env.VITE_LOCAL_ASR_LANGUAGE }) : speechEngine, [speechEngine, serviceSettings]);
  const localDocumentEngine = useMemo(() => documentEngine === undefined ? createLocalDocumentEngine({ VITE_LOCAL_DOCUMENT_BASE_URL: serviceSettings.documentsUrl }) : documentEngine, [documentEngine, serviceSettings]);
  const sourceBlobStore = useMemo(() => createSourceBlobStore(), []);
  const recordingChunkStore = useMemo(() => recordingChunkStoreOverride ?? createRecordingChunkStore(), [recordingChunkStoreOverride]);
  const hasOpenDialog = Boolean(resourcePreview || showNewCourse || showDeleteCourse || showGlobalSearch || showReviewPanel || showTranscriptPanel || showSettingsPanel || showQuickStart);

  const reportStorageError = (error: WorkspaceStorageError) => {
    console.warn(`[workspace-storage:${error.operation}] ${error.message}`);
    if (storageIssueRef.current === error.operation) return;
    storageIssueRef.current = error.operation;
    setToast(error.operation === 'load'
      ? 'Native workspace storage unavailable. Using local fallback.'
      : 'Native workspace save failed. Changes remain in local fallback.');
  };

  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0] ?? emptyLesson;
  const hasCourse = Boolean(activeLesson.id);
  const activeWorkspace = lessonWorkspaces[activeLessonId] ?? emptyLessonWorkspace;
  const { resources, transcript, chat, artifacts } = activeWorkspace;

  const updateLessonWorkspace = (lessonId: string, update: (current: LessonWorkspace) => LessonWorkspace) => {
    setLessonWorkspaces((current) => ({
      ...current,
      [lessonId]: (() => {
        const previous = current[lessonId] ?? emptyLessonWorkspace;
        const next = update(previous);
        const lesson = lessons.find((item) => item.id === lessonId);
        return lesson && next.transcript !== previous.transcript
          ? { ...next, courseNote: buildCourseNote(lesson, next.transcript) }
          : next;
      })(),
    }));
  };

  const updateActiveWorkspace = (update: (current: LessonWorkspace) => LessonWorkspace) => updateLessonWorkspace(activeLessonId, update);

  const visibleLessons = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return lessons;
    return lessons.filter((lesson) => `${lesson.subject} ${lesson.chapter} ${lesson.title}`.toLocaleLowerCase().includes(normalizedQuery));
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
    const query = globalSearchValue.trim().toLocaleLowerCase();
    if (!query) return [];
    return lessons.flatMap((lesson) => {
      const lessonWorkspace = lessonWorkspaces[lesson.id] ?? emptyLessonWorkspace;
      const results: { id: string; lessonId: string; title: string; detail: string }[] = [];
      if (`${lesson.title} ${lesson.subject} ${lesson.chapter}`.toLocaleLowerCase().includes(query)) {
        results.push({ id: lesson.id, lessonId: lesson.id, title: lesson.title, detail: `${lesson.subject} · ${lesson.chapter}` });
      }
      lessonWorkspace.transcript.forEach((segment) => {
        if (`${segment.speaker} ${segment.text} ${segment.timestamp}`.toLocaleLowerCase().includes(query)) {
          results.push({ id: segment.id, lessonId: lesson.id, title: segment.text, detail: `${lesson.title} · ${segment.timestamp}` });
        }
      });
      lessonWorkspace.resources.forEach((resource) => {
        if (`${resource.name} ${resource.meta}`.toLocaleLowerCase().includes(query)) {
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
    const transcribeLatestAudio = async () => {
      if (cancelled || liveTranscriptionInFlight.current) return;
      liveTranscriptionInFlight.current = true;
      try {
        const chunks = await session.readChunks();
        if (cancelled || !chunks.length) return;
        const audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
        const transcription = await localSpeechEngine.transcribe(audio);
        if (cancelled) return;
        setLiveTranscript(transcription.segments.map((segment, index) => ({
          ...segment,
          id: `${session.recordingId}:live:${segment.id || index}`,
          sourceId: session.recordingId,
          provisional: true,
          status: 'review' as const,
        })));
        setLiveTranscriptionError('');
      } catch {
        setLiveTranscriptionError('Live transcription is unavailable. Audio is still recording. Check the speech service in Settings.');
      } finally {
        liveTranscriptionInFlight.current = false;
      }
    };
    void transcribeLatestAudio();
    const interval = window.setInterval(() => void transcribeLatestAudio(), Math.max(liveTranscriptionIntervalMs, 250));
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      setLiveTranscript([]);
    };
  }, [isRecording, liveTranscriptionIntervalMs, localSpeechEngine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setShowNewCourse(true);
      }
      if (event.key === 'Escape') {
        setShowNewCourse(false);
        setShowDeleteCourse(false);
        setShowGlobalSearch(false);
        setShowReviewPanel(false);
        setShowTranscriptPanel(false);
        setShowSettingsPanel(false);
        setShowQuickStart(false);
        setResourcePreview(null);
        if (window.innerWidth <= 900) setShowLeftSidebar(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!hasOpenDialog) return undefined;

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return undefined;
    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    const autofocusElement = dialog.querySelector<HTMLElement>('[autofocus]');
    (autofocusElement ?? focusableElements()[0])?.focus();
    const onDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onDialogKeyDown);

    return () => {
      dialog.removeEventListener('keydown', onDialogKeyDown);
      if (lastFocusedElementRef.current?.isConnected) lastFocusedElementRef.current.focus();
      lastFocusedElementRef.current = null;
    };
  }, [hasOpenDialog]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ compactTranscript, showVerifiedTranscript }));
    } catch {
      // Preferences remain session-scoped when browser storage is unavailable.
    }
  }, [compactTranscript, showVerifiedTranscript]);

  useEffect(() => {
    if (showSettingsPanel) void checkSidecars();
  }, [showSettingsPanel]);

  useEffect(() => {
    if (!isNativeRuntime()) return undefined;

    let cancelled = false;
    void loadWorkspaceAsync(initialWorkspace, undefined, { onError: reportStorageError }).then((loaded) => {
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
    if (!nativeStorageReady) return;
    void saveWorkspaceAsync(
      { activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces },
      undefined,
      { onError: reportStorageError },
    );
  }, [nativeStorageReady, activeLessonId, lessons, resources, transcript, chat, artifacts, lessonWorkspaces]);

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
    if (!nativeStorageReady) return undefined;

    let cancelled = false;
    const pendingRecordings = listPendingRecordings();
    if (!pendingRecordings.length) return undefined;

    void (async () => {
      for (const pending of pendingRecordings) {
        const lesson = lessons.find((item) => item.id === pending.lessonId);
        if (!lesson) {
          removePendingRecording(pending.recordingId);
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
  }, [lessons, nativeStorageReady, recordingChunkStore]);

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

  const openQuickStart = () => {
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
      setQuickStartError(error instanceof Error ? error.message : 'Quick Start could not analyze this material.');
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
      const previous = lessonWorkspaces[targetLesson.id] ?? emptyLessonWorkspace;
      const nextTranscript = [...previous.transcript, segment];
      const baseNote = buildCourseNote(targetLesson, nextTranscript);
      const courseNote = {
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
      setLessonWorkspaces((current) => ({
        ...current,
        [targetLesson.id]: { ...previous, resources: [resource, ...previous.resources], transcript: nextTranscript, courseNote },
      }));
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
  const courseTranscript = isRecording ? visibleTranscript : [...visibleTranscript, ...visibleLiveTranscript];
  const noteTranscript = [...visibleTranscript, ...visibleLiveTranscript];
  const activeCourseNote = useMemo(() => {
    const note = activeWorkspace.courseNote ?? buildCourseNote(activeLesson, transcript);
    if (isRecording || visibleTranscript.length !== transcript.length || visibleLiveTranscript.length) {
      return buildCourseNote(activeLesson, noteTranscript);
    }
    return note;
  }, [activeLesson, activeWorkspace.courseNote, isRecording, noteTranscript, transcript, visibleLiveTranscript.length, visibleTranscript.length]);

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
    setIsCheckingSidecars(true);
    const [asr, documents, managed] = await Promise.all([
      probeSidecar(settings.asrUrl),
      probeSidecar(settings.documentsUrl),
      getManagedSidecarStatus().catch(() => []),
    ]);
    setSidecarHealth({ asr, documents });
    setManagedSidecars(managed);
    try {
      if (!settings.llmUrl) throw new Error('Set an LM Studio address.');
      const response = await fetch(`${settings.llmUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('LM Studio is not responding.');
      const body = await response.json();
      const models = Array.isArray(body.data) ? body.data : [];
      setLlmHealth(models.some((model: { id: string }) => model.id === settings.model) ? 'Connected. Selected model is available.' : 'Connected. Choose a model listed in LM Studio.');
    } catch {
      setLlmHealth('Unavailable. Start the LM Studio server and load a model.');
    }
    setIsCheckingSidecars(false);
  };

  const saveServiceSettings = (event: FormEvent) => {
    event.preventDefault();
    if (isRecording || isFinalizingRecording || isStartingRecording) return;
    const settings = Object.fromEntries(Object.entries(serviceDraft).map(([key, value]) => [key, value.trim()])) as ServiceSettings;
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

  const openResource = async (resource: Resource) => {
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
    const resourceId = transcriptSegment?.sourceId ?? target.split(':', 1)[0];
    const resource = resources.find((item) => item.id === resourceId);
    if (resource) {
      void openResource(resource);
      return;
    }
    notify('This citation source is no longer available.');
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
      setLiveTranscript([]);
      setLiveRecordingLessonId(null);
      if (!session) {
        notify('Session stopped.');
        return;
      }
      void session.stop().then(async ({ chunksPersisted, persistenceError }) => {
        const recordingResource: Resource = {
          id: session.recordingId,
          name: `${recordingLessonTitle} audio.webm`,
          meta: `Audio · ${chunksPersisted} chunk${chunksPersisted === 1 ? '' : 's'}`,
          kind: 'audio',
          mimeType: 'audio/webm',
        };
        const saveRecordingFallback = (segments: TranscriptSegment[] = []) => {
          updateLessonWorkspace(recordingLessonId, (current) => ({
            ...current,
            resources: current.resources.some((resource) => resource.id === recordingResource.id)
              ? current.resources
              : [recordingResource, ...current.resources],
            transcript: segments.length
              ? [...current.transcript, ...segments.filter((segment) => !current.transcript.some((existing) => existing.id === segment.id))]
              : current.transcript,
          }));
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
        notify('Audio saved locally. Transcribing with local ASR...');
        try {
          const chunks = await session.readChunks();
          if (!chunks.length) throw new Error('No persisted audio chunks available.');
          const audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
          const transcription = await localSpeechEngine.transcribe(audio);
          if (!transcription.segments.length) {
            saveRecordingFallback();
            notify('Audio saved locally; local ASR returned no speech.');
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
              setLessons(routed.lessons);
              setLessonWorkspaces(routed.lessonWorkspaces);
              setActiveLessonId(routed.targetLesson.id);
              setSelectedArtifactId(routed.lessonWorkspaces[routed.targetLesson.id]?.artifacts[0]?.id ?? null);
              setView('course');
              notify(`Local transcription added and routed to ${routed.targetLesson.title}.`);
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
        .finally(() => setIsFinalizingRecording(false));
      setIsFinalizingRecording(true);
      return;
    }

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
      setLiveRecordingLessonId(activeLesson.id);
      setIsRecording(true);
      setRecordingSeconds(0);
      notify('Recording started.');
    } catch (error) {
      setRecordingError(error instanceof Error ? `Cannot start recording: ${error.message}` : 'The microphone is unavailable. Check permission and try again.');
    } finally {
      startingRecorderRef.current = false;
      setIsStartingRecording(false);
    }
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

  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    const message = composerValue.trim();
    if (!message || isSending || !hasCourse) return;
    setView('chat');
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
      const retrievalHits = searchDocuments(retrievalDocuments, message, 4);
      const retrievedCitations = retrievalHits.slice(0, 2).map((hit) => formatRetrievalCitation(hit.document));
      if (!retrievalHits.length) {
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
        ? retrievalHits.map((hit) => hit.document.metadata.resourceName
          ? `[Source: ${hit.document.metadata.resourceName}, part ${hit.document.metadata.part}] ${hit.document.text}`
          : `[${hit.document.metadata.timestamp}] ${hit.document.metadata.speaker}: ${hit.document.text}`).join('\n')
        : 'No course excerpt matched the question.';
      const result = await localProvider.generate([
        {
          role: 'system',
          content: `Answer using only the retrieved excerpts from the active course. If they are insufficient, say so. Course: ${activeLesson.title}.\n${context}`,
        },
        { role: 'user', content: message },
      ]);
      updateActiveWorkspace((current) => ({
        ...current,
        chat: [...current.chat, {
          id: assistantMessageId,
          role: 'assistant',
          content: result.content,
          citations: [
            ...retrievedCitations,
            `LM Studio · ${result.model}`,
          ],
          citationTargets: retrievalHits.slice(0, 2).map((hit) => hit.document.id),
        }],
      }));
    } catch (error) {
      updateActiveWorkspace((current) => ({
        ...current,
        chat: [...current.chat, {
          id: assistantMessageId,
          role: 'assistant',
          content: error instanceof Error ? error.message : 'The local provider could not answer this question.',
        }],
      }));
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
      const contextDocuments = documents.slice(0, 12);
      if (!contextDocuments.length) throw new Error('Import notes or transcribe a recording before generating study material.');
      const context = contextDocuments.map((document) => document.text).join('\n\n').slice(0, 24000);
      const result = await localProvider.generate([
        { role: 'system', content: `Create a ${definition.label.toLowerCase()} for ${activeLesson.title} using only these excerpts. Do not invent facts.\n${context}` },
        { role: 'user', content: `Generate the ${definition.label.toLowerCase()}.` },
      ]);
      if (!result.content.trim()) throw new Error('The model returned no study material. Try again.');
      const artifact: Artifact = {
        id: `${kind}-${crypto.randomUUID()}`, kind, label: definition.label,
        createdAt: new Date().toLocaleString('en-GB'), content: result.content,
        citations: contextDocuments.slice(0, 3).map(formatRetrievalCitation),
        citationTargets: contextDocuments.slice(0, 3).map((document) => document.id),
      };
      updateLessonWorkspace(lessonId, (current) => ({ ...current, artifacts: [artifact, ...current.artifacts] }));
      setSelectedArtifactId(artifact.id);
      notify(`${definition.label} saved.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Generation failed. Check LM Studio in Settings and try again.');
    } finally {
      setGeneratingArtifact(null);
    }
  };

  const importSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    event.target.accept = sourceAccept;
    if (!file || !hasCourse) return;
    setActionError('');
    const lessonId = activeLesson.id;
    try {
      const resource = await createSourceResource(file);
      await sourceBlobStore.save(resource.id, file);
      updateLessonWorkspace(lessonId, (current) => ({ ...current, resources: [resource, ...current.resources] }));
      notify(`${resource.name} added to course sources${sourceBlobStore.durability === 'durable' ? ' and saved locally.' : ' in memory only.'}`);
      if (isTextResource(resource)) {
        const text = (await file.text()).trim();
        if (text) updateLessonWorkspace(lessonId, (current) => ({
          ...current, transcript: [...current.transcript, { id: `${resource.id}:text`, sourceId: resource.id, timestamp: 'Notes', speaker: resource.name, text, status: 'review' }],
        }));
      }
      if (resource.kind === 'audio' && !localSpeechEngine) setActionError('Audio imported. Connect a speech service in Settings to transcribe it.');
      if (resource.kind === 'audio' && localSpeechEngine) {
        setTranscribingResourceIds((current) => new Set(current).add(resource.id));
        notify(`${resource.name} saved locally. Transcribing with local ASR...`);
        try {
          const transcription = await localSpeechEngine.transcribe(file);
          const segments = transcription.segments.map((segment, index) => ({
            ...segment,
            id: `${resource.id}:${segment.id || index}`,
            sourceId: resource.id,
          }));
          updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: [...current.transcript, ...segments] }));
          notify(segments.length
            ? `Local transcription added ${segments.length} segments from ${resource.name}.`
            : `${resource.name} contains no detected speech.`);
        } catch {
          setActionError(`${resource.name} is saved. Transcription failed; check the speech service in Settings.`);
        } finally {
          setTranscribingResourceIds((current) => {
            const next = new Set(current);
            next.delete(resource.id);
            return next;
          });
        }
      }
      const isPdf = resource.kind === 'document' && (resource.mimeType === 'application/pdf' || /\.pdf$/i.test(resource.name));
      if (!localDocumentEngine && (isPdf || resource.kind === 'image')) setActionError('File imported. Connect a document service in Settings to extract its text.');
      if (localDocumentEngine && (isPdf || resource.kind === 'image')) {
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
          updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: [...current.transcript, ...pageSegments] }));
          notify(pageSegments.length > 0
            ? `${resource.name} indexed ${pageSegments.length} page${pageSegments.length === 1 ? '' : 's'} locally.`
            : `${resource.name} contains no extractable text.`);
        } catch {
          setActionError(`${resource.name} is saved. Text extraction is unavailable; check the document service in Settings.`);
        }
      }
    } catch {
      setActionError('The file could not be stored. Please try importing it again.');
    }
  };

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
      updateLessonWorkspace(lessonId, (current) => ({ ...current, transcript: [...current.transcript.filter((segment) => segment.sourceId !== resource.id), ...segments] }));
      notify('Transcription added to your course notes.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Transcription failed. Check the speech service and try again.');
    } finally {
      setTranscribingResourceIds((current) => { const ids = new Set(current); ids.delete(resource.id); return ids; });
    }
  };

  const openSourcePicker = (accept: string) => {
    if (!sourceInputRef.current) return;
    sourceInputRef.current.accept = accept;
    sourceInputRef.current.click();
  };

  const removeSource = async (resource: Resource) => {
    try {
      await sourceBlobStore.remove(resource.id);
      if (resource.kind === 'audio') await recordingChunkStore.clear(resource.id);
      updateActiveWorkspace((current) => ({
        ...current,
        resources: current.resources.filter((item) => item.id !== resource.id),
        transcript: current.transcript.filter((segment) => segment.sourceId !== resource.id && !segment.id.startsWith(`${resource.id}:`)),
      }));
      notify(`${resource.name} removed from this course.`);
    } catch {
      notify(`${resource.name} could not be removed.`);
    }
  };

  const deleteActiveCourse = async () => {
    if (isRecording || isFinalizingRecording || isStartingRecording) {
      notify('Stop the recording before deleting this course.');
      setShowDeleteCourse(false);
      return;
    }

    const lessonId = activeLesson.id;
    const lessonTitle = activeLesson.title;
    try {
      const pendingRecordings = listPendingRecordings().filter((pending) => pending.lessonId === lessonId);
      for (const resource of resources) {
        await sourceBlobStore.remove(resource.id);
        await recordingChunkStore.clear(resource.id);
      }
      for (const pending of pendingRecordings) {
        await recordingChunkStore.clear(pending.recordingId);
        if (!removePendingRecording(pending.recordingId)) throw new Error('Unable to remove interrupted recording state.');
      }
      const nextLessons = lessons.filter((lesson) => lesson.id !== lessonId);
      const nextLesson = nextLessons[0];
      setLessons(nextLessons);
      setLessonWorkspaces((current) => {
        const next = { ...current };
        delete next[lessonId];
        return next;
      });
      setActiveLessonId(nextLesson?.id ?? '');
      setSelectedArtifactId(nextLesson ? lessonWorkspaces[nextLesson.id]?.artifacts[0]?.id ?? null : null);
      setView('course');
      setShowAllResources(false);
      setShowDeleteCourse(false);
      notify(`${lessonTitle} deleted.`);
    } catch {
      notify(`${lessonTitle} could not be deleted.`);
    }
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
      setShowAllResources(false);
      notify(`${imported.lesson.title} imported.`);
    } catch {
      notify('The course import could not be completed.');
    } finally {
      input.value = '';
    }
  };

  const createCourse = (event: FormEvent) => {
    event.preventDefault();
    const title = newCourseTitle.trim();
    if (!title || isRecording || isFinalizingRecording || isStartingRecording) return;
    const subject = newCourseSubject.trim() || 'General';
    const chapter = newCourseChapter.trim() || 'General notes';
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
    notify('New course created. Ready to record.');
  };

  const renderTranscriptSegment = (segment: TranscriptSegment) => (
    <article className={`transcript-item ${segment.status === 'review' ? 'needs-review' : ''}`} key={segment.id}>
      <div className="transcript-time">{segment.timestamp}</div>
      <div className="transcript-body"><div className="speaker-line"><strong>{segment.speaker}</strong>{segment.provisional ? <span className="review-badge">Live preview</span> : segment.status === 'review' ? <span className="review-badge">Needs review</span> : <span className="verified-badge"><Check size={11} /> verified</span>}</div><p><RichText content={segment.text} /></p></div>
      {!segment.provisional && <button className="transcript-more" aria-label={segment.status === 'review' ? `Mark segment ${segment.timestamp} verified` : `Mark segment ${segment.timestamp} for review`} onClick={() => toggleTranscriptReview(segment.id)}>...</button>}
    </article>
  );

  const renderCourseNoteBlock = (block: CourseNoteBlock) => {
    if (block.type === 'heading') {
      if (block.id === 'note-title') return null;
      const Heading = block.level === 1 ? 'h2' : 'h3';
      return <Heading key={block.id}>{block.text}</Heading>;
    }
    if (block.type === 'paragraph') {
      return <p className="course-note-paragraph" key={block.id}>{block.timestamp && <span className="course-note-meta">{block.timestamp} · {block.speaker ?? 'Lecture'}</span>}<RichText content={block.text} /></p>;
    }
    if (block.type === 'formula') {
      return <div className="course-note-formula" key={block.id}><RichText content={block.latex} />{block.caption && <small>{block.caption}</small>}</div>;
    }
    if (block.type === 'code') {
      return <pre className="course-note-code" key={block.id}><code><span className="course-note-code-language">{block.language}</span>{block.code}</code></pre>;
    }
    if (block.type === 'schema') {
      return <div className="course-note-schema" key={block.id} aria-label="Course concept schema">{block.edges.map((edge) => <span key={`${block.id}-${edge.from}-${edge.to}`}><b>{edge.from}</b><span aria-hidden="true"> → </span><b>{edge.to}</b></span>)}</div>;
    }
    const maximum = Math.max(...block.values.map((item) => Math.abs(item.value)), 1);
    return <figure className="course-note-chart" key={block.id}><figcaption>{block.label}</figcaption>{block.values.map((item) => <div className="course-note-chart-row" key={`${block.id}-${item.label}`}><span>{item.label}</span><i><em style={{ width: `${Math.max(4, Math.round(Math.abs(item.value) / maximum * 100))}%` }} /></i><strong>{item.value}</strong></div>)}</figure>;
  };

  return (
    <div className="app-shell">
      <input ref={sourceInputRef} className="visually-hidden" type="file" aria-label="Select course source" accept={sourceAccept} onChange={importSource} />
      <header className="topbar">
        <div className="topbar-leading">
          <button className="icon-button" aria-label="Show or hide navigation" aria-expanded={showLeftSidebar} onClick={() => setShowLeftSidebar((value) => !value)}><Menu size={20} /></button>
          <span className="brand-name">StudentLLM</span>
        </div>
        <button className="icon-button" aria-label="Settings" onClick={() => setShowSettingsPanel(true)}><Settings2 size={19} /></button>
      </header>

      <div className={`workspace-grid ${showLeftSidebar ? 'with-navigation' : ''}`}>
        {showLeftSidebar && <>
          <button className="navigation-scrim" aria-label="Close navigation" onClick={() => setShowLeftSidebar(false)} />
          <aside className="left-sidebar workspace-sidebar" aria-label="Course navigation">
            <div className="sidebar-header">
              <div className="sidebar-brand"><div><strong>StudentLLM</strong><ChevronDown size={13} aria-hidden="true" /></div><span>Workspace</span></div>
            </div>
            <div className="sidebar-start-actions">
              <button className="sidebar-row sidebar-row-primary" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={openQuickStart}><Sparkles size={16} /><span>Quick start</span></button>
              <button className="sidebar-row" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={() => setShowNewCourse(true)}><Plus size={16} /><span>New course</span></button>
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
              {lessons.length > 0 && <button className="ghost-row sidebar-row" onClick={() => setShowGlobalSearch(true)}><Search size={16} /><span>Global search</span></button>}
              <label className="ghost-row sidebar-row file-label"><Upload size={16} /><span>Import course</span><input className="visually-hidden" type="file" accept="application/json,.json" aria-label="Import course export" onChange={(event) => void importCourse(event)} /></label>
            </div>
          </aside>
        </>}

        <main className="main-panel">
          {!nativeStorageReady ? <p role="status">Opening your library...</p> : !hasCourse ? (
            <section className="welcome">
              <BookOpen size={32} strokeWidth={1.3} aria-hidden="true" />
              <h1>A place for your courses.</h1>
              <p>Create a course, then record a lecture or import your notes.<br />Your material stays together here.</p>
              <button className="primary-action" onClick={openQuickStart}><Sparkles size={17} /> Quick start with AI</button>
              <button className="text-action" onClick={() => setShowNewCourse(true)}><Plus size={16} /> Create your first course</button>
            </section>
          ) : <>
            <div className="main-header">
              <div className="main-heading"><p>{activeLesson.subject}{activeLesson.chapter !== 'General notes' ? ` / ${activeLesson.chapter}` : ''}</p><h1>{activeLesson.title}</h1></div>
              <details className="course-actions">
                <summary aria-label="Course actions">More <ChevronDown size={15} /></summary>
                <div className="course-actions-menu">
                  <button onClick={exportCourseNote}><Download size={15} /> Save note</button>
                  <button onClick={() => void exportCourse()}><Download size={15} /> Export course</button>
                  <button onClick={() => setShowTranscriptPanel(true)}><FileText size={15} /> Full transcript</button>
                  <button onClick={() => setShowReviewPanel(true)}><ListChecks size={15} /> Needs review ({reviewItems.length})</button>
                  <button className="danger-link" disabled={isRecording || isFinalizingRecording || isStartingRecording} onClick={() => setShowDeleteCourse(true)}><Trash2 size={15} /> Delete course</button>
                </div>
              </details>
            </div>
            <div className="view-tabs" role="tablist" aria-label="Course view">
              {(['course', 'sources', 'chat', 'study'] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} className={view === tab ? 'active' : ''} onClick={() => { setView(tab); setActionError(''); }}>{tab === 'course' ? 'Notes' : tab === 'sources' ? `Sources${resources.length ? ` (${resources.length})` : ''}` : tab === 'chat' ? 'Chat' : 'Study'}</button>)}
            </div>
            {actionError && <div className="action-error" role="alert"><p>{actionError}</p><button className="text-action" onClick={() => setShowSettingsPanel(true)}>Open Settings</button></div>}
            {isRecording && view !== 'course' && <section className="recording-bar recording" aria-label="Course recording"><div className="recording-actions"><button className="primary-action stop" aria-label="Stop recording" onClick={toggleRecording}><Square size={16} /> Stop recording</button><span className="recording-time">{formatElapsed(recordingSeconds)}</span></div></section>}
            {view === 'course' && <div className="course-view">
              <section className={`recording-bar ${isRecording ? 'recording' : ''}`} aria-label="Course recording">
                <div className="recording-actions">
                  <button className={`primary-action ${isRecording ? 'stop' : ''}`} onClick={toggleRecording} disabled={isFinalizingRecording || isStartingRecording} aria-label={isRecording ? 'Stop recording' : isFinalizingRecording ? 'Finishing recording' : isStartingRecording ? 'Starting recording' : 'Start recording'}>
                    {isRecording ? <Square size={16} /> : <Mic size={17} />}{isRecording ? 'Stop recording' : isFinalizingRecording ? 'Saving recording' : isStartingRecording ? 'Starting...' : 'Record'}
                  </button>
                  {!isRecording && <button className="secondary-action" onClick={() => openSourcePicker(sourceAccept)}><Upload size={16} /> Import file</button>}
                  {isRecording && <><span className="recording-time">{formatElapsed(recordingSeconds)}</span><button className="text-action" onClick={addBookmark} aria-label="Bookmark this passage"><Plus size={16} /> Mark passage</button></>}
                </div>
                <p className="recording-hint">{isFinalizingRecording ? 'Saving audio and preparing transcript...' : isRecording ? localSpeechEngine ? 'Recording. Transcription will appear as audio is processed.' : 'Recording audio. Connect a speech service in Settings for live transcription.' : 'Audio, PDF, images or text notes'}</p>
              </section>
              {recordingError && <p className="action-error" role="alert">{recordingError}</p>}
              {liveTranscriptionError && <p className="action-error" role="alert">{liveTranscriptionError}</p>}
              <section className="course-note-document" aria-label="Course notes document">
                <div className="course-note-toolbar"><span>Course notes</span>{(transcript.length > 0 || visibleLiveTranscript.length > 0) && <button className="text-action" onClick={exportCourseNote}><Download size={15} /> Save note</button>}</div>
                <div className="course-note-content" aria-live={isRecording ? 'polite' : 'off'}>
                  {transcript.length || visibleLiveTranscript.length ? activeCourseNote.blocks.map(renderCourseNoteBlock) : <div className="note-empty"><h2>Your notes start here.</h2><p>Record your lecture or import a file above.</p><p>Text notes appear directly. Audio transcription and PDF extraction need a connected service.</p><button className="text-action" onClick={() => setShowSettingsPanel(true)}>Set up transcription</button></div>}
                </div>
              </section>
              {(transcript.length > 0 || isRecording) && <details className="transcript-disclosure">
                <summary>Transcript {isRecording ? '(recording)' : `(${transcript.length})`}</summary>
                {isRecording && localSpeechEngine && <section className="live-transcript-panel" aria-label="Live course transcription"><div ref={liveTranscriptFeedRef} aria-live="polite">{visibleLiveTranscript.length ? visibleLiveTranscript.map(renderTranscriptSegment) : <p className="empty-state">Waiting for the first transcribed passage.</p>}</div></section>}
                <div className={`transcript-list ${compactTranscript ? 'compact' : ''}`} role="region" aria-label="Transcript preview">{courseTranscript.map(renderTranscriptSegment)}</div>
                <button className="text-action" onClick={() => setShowTranscriptPanel(true)}>View all <ArrowUpRight size={13} /></button>
              </details>}
            </div>}
            {view === 'sources' && <section className="sources-view" aria-label="Course sources">
              <div className="section-toolbar"><h2>Sources</h2><button className="secondary-action" onClick={() => openSourcePicker(sourceAccept)}><Plus size={16} /> Import file</button></div>
              {!resources.length && <p className="empty-state">Add audio, a PDF, an image or text notes to this course.</p>}
              <div className="resource-list">{activeResources.map((resource) => <div className="resource-item" key={resource.id}>
                <button className="resource-open" onClick={() => void openResource(resource)}>{resourceIcon(resource.kind)}<span><strong>{resource.name}</strong><small>{transcribingResourceIds.has(resource.id) ? 'Transcribing...' : resource.meta}</small></span><ChevronRight size={16} /></button>
                {resource.kind === 'audio' && <button className="text-action" aria-label={`Transcribe ${resource.name}`} disabled={transcribingResourceIds.has(resource.id)} onClick={() => void transcribeSource(resource)}>{transcribingResourceIds.has(resource.id) ? 'Transcribing...' : 'Transcribe'}</button>}
                <button className="icon-button" aria-label={`Remove source ${resource.name}`} disabled={transcribingResourceIds.has(resource.id)} onClick={() => void removeSource(resource)}><X size={16} /></button>
              </div>)}</div>
              {resources.length > 3 && <button className="text-action" onClick={() => setShowAllResources((value) => !value)}>{showAllResources ? 'Show fewer' : `Show ${resources.length - 3} more sources`}</button>}
            </section>}
            {view === 'chat' && <section className="chat-view">
              <div className="chat-intro"><h2>Ask about this course</h2><p>{localProvider ? 'Answers use your notes and sources. LM Studio must be running with a loaded model.' : 'Connect LM Studio in Settings to generate answers. You can still search and open your sources.'}</p></div>
              {!resources.length && !transcript.length && <p className="empty-state">Import material or record a lecture before asking a question.</p>}
              <div className="chat-list" aria-live="polite">{chat.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><span className="message-role">{message.role === 'user' ? 'You' : 'Course assistant'}</span><div className="message-content"><RichText content={message.content} /></div>{message.citations && <div className="citation-list">{message.citations.map((citation, index) => message.citationTargets?.[index] ? <button key={citation} onClick={() => openCitation(message.citationTargets![index])}>{citation}</button> : <span key={citation}>{citation}</span>)}</div>}</article>)}</div>
              <form className="chat-composer" onSubmit={submitComposer}><input aria-label="Ask the course chat" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Ask a question about your course" disabled={isSending} /><button className="primary-action" type="submit" aria-label="Send" disabled={isSending || !composerValue.trim()}>{isSending ? 'Thinking...' : <Send size={17} />}</button></form>
            </section>}
            {view === 'study' && <section className="study-view">
              <h2>Study materials</h2><p className="muted">Choose what to create from this course's sources.</p>
              <div className="artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className="artifact-button" disabled={generatingArtifact !== null} onClick={() => void createArtifact(artifact.kind)}><strong>{generatingArtifact === artifact.kind ? 'Generating...' : artifact.label}</strong><small>{artifact.description}</small></button>)}</div>
              {artifacts.length > 0 && <section className="recent-section"><h3>Saved materials</h3>{artifacts.map((artifact) => <button className="recent-artifact" key={artifact.id} aria-label={`Open artifact ${artifact.label}`} onClick={() => setSelectedArtifactId(artifact.id)}>{artifact.label}</button>)}
              {(() => { const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId); return selected && <article className="artifact-preview"><h3>{selected.label}</h3><RichText content={selected.content ?? ''} />{selected.citations && <div className="citation-list">{selected.citations.map((citation, index) => selected.citationTargets?.[index] ? <button key={citation} onClick={() => openCitation(selected.citationTargets![index])}>{citation}</button> : <span key={citation}>{citation}</span>)}</div>}</article>; })()}</section>}
            </section>}
          </>}
        </main>
      </div>

      {resourcePreview && <div className="modal-backdrop" role="presentation" onMouseDown={() => setResourcePreview(null)}><section className="modal resource-preview-modal" role="dialog" aria-modal="true" aria-labelledby="resource-preview-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Original source</span><h2 id="resource-preview-title">{resourcePreview.resource.name}</h2></div><button className="icon-button" aria-label="Close source preview" onClick={() => setResourcePreview(null)}><X size={17} /></button></div><p className="modal-description">{resourcePreview.resource.meta}{resourcePreview.resource.sha256 ? ` · SHA-256 ${resourcePreview.resource.sha256.slice(0, 12)}…` : ''}</p>{resourcePreview.state === 'loading' && <p className="empty-state">Opening the locally stored source…</p>}{resourcePreview.state === 'missing' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'error' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'ready' && resourcePreview.text !== undefined && <div className="source-text-preview"><pre>{resourcePreview.text}</pre>{resourcePreview.truncated && <small>Preview truncated to 12,000 characters. The original source remains unchanged.</small>}</div>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'image' && <img className="source-image-preview" src={resourcePreview.blobUrl} alt={`Preview of ${resourcePreview.resource.name}`} />}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'audio' && <audio className="source-audio-preview" controls src={resourcePreview.blobUrl}>Your browser cannot play this audio source.</audio>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'document' && <iframe className="source-document-preview" title={`Preview of ${resourcePreview.resource.name}`} src={resourcePreview.blobUrl} />}</section></div>}
      {showQuickStart && <div className="modal-backdrop" role="presentation" onMouseDown={() => { setShowQuickStart(false); resetQuickStart(); }}><section className="modal quick-start-modal" role="dialog" aria-modal="true" aria-labelledby="quick-start-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">AI course organizer</span><h2 id="quick-start-title">Quick start</h2></div><button className="icon-button" aria-label="Close Quick Start" onClick={() => { setShowQuickStart(false); resetQuickStart(); }}><X size={17} /></button></div><p className="modal-description">Paste a lecture excerpt or course description. AI proposes the hierarchy and destination; review it before saving.</p>{!quickStartProposal ? <form onSubmit={analyzeQuickStartInput}><label>Lecture excerpt or course description<textarea autoFocus rows={8} value={quickStartInput} onChange={(event) => setQuickStartInput(event.target.value)} placeholder="Paste what you are studying, or a few paragraphs from the lecture..." /></label><label>Source name <span className="muted">optional</span><input value={quickStartSourceName} onChange={(event) => setQuickStartSourceName(event.target.value)} placeholder="e.g. week-04-notes" /></label>{!localProvider && <p className="quick-start-note">Connect LM Studio in Settings to analyze and organize this material.</p>}{quickStartError && <p className="action-error" role="alert">{quickStartError}</p>}<div className="modal-footer"><button type="button" className="secondary-action" onClick={() => { setShowQuickStart(false); resetQuickStart(); }}>Cancel</button><button className="primary-submit" type="submit" disabled={!quickStartInput.trim() || isAnalyzingQuickStart}><Sparkles size={15} /> {isAnalyzingQuickStart ? 'Analyzing...' : 'Analyze structure'}</button></div></form> : <div className="quick-start-review"><div className="quick-start-fields"><label>Course group<input value={quickStartProposal.course} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, course: event.target.value } : current)} /></label><label>Subject<input value={quickStartProposal.subject} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, subject: event.target.value } : current)} /></label><label>Lesson<input value={quickStartProposal.lesson} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, lesson: event.target.value } : current)} /></label><label>Title<input value={quickStartProposal.title} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, title: event.target.value } : current)} /></label><label>Sublesson <span className="muted">optional</span><input value={quickStartProposal.sublesson} onChange={(event) => setQuickStartProposal((current) => current ? { ...current, sublesson: event.target.value } : current)} placeholder="No sublesson detected" /></label></div><label>Place this material in<select aria-label="Place this material in" value={quickStartPlacement} onChange={(event) => setQuickStartPlacement(event.target.value)}><option value="new">Create a new course</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.subject} / {lesson.chapter} / {lesson.title}</option>)}</select></label><div className="quick-start-summary"><strong>{Math.round(quickStartProposal.confidence * 100)}% confidence</strong><span>{quickStartProposal.rationale}</span><small>{quickStartPlacement === 'new' ? `Creates ${quickStartProposal.course} / ${quickStartProposal.lesson} / ${quickStartProposal.title}` : 'Adds the source to the selected existing course.'}</small></div>{quickStartError && <p className="action-error" role="alert">{quickStartError}</p>}<div className="modal-footer"><button type="button" className="text-action" onClick={() => { setQuickStartProposal(null); setQuickStartError(''); }}>Edit material</button><button type="button" className="primary-submit" onClick={() => void applyQuickStart()}><Check size={15} /> Apply structure</button></div></div>}</section></div>}
      {showNewCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">New session</span><h2 id="new-course-title">Start a course</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowNewCourse(false)}><X size={17} /></button></div><p className="modal-description">Give your course a name. You can add recordings and files next.</p><form onSubmit={createCourse}><label>Course title<input autoFocus value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} placeholder="e.g. Introduction to probability" /></label><label>Subject<input list="course-subject-suggestions" value={newCourseSubject} onChange={(event) => setNewCourseSubject(event.target.value)} placeholder="e.g. Machine Learning" /></label><datalist id="course-subject-suggestions">{subjectOptions.map((subjectOption) => <option key={subjectOption} value={subjectOption} />)}</datalist><label>Chapter<input value={newCourseChapter} onChange={(event) => setNewCourseChapter(event.target.value)} placeholder="e.g. Transformers" /></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowNewCourse(false)}>Cancel</button><button className="primary-submit" type="submit" disabled={!newCourseTitle.trim()}><Mic size={15} /> Create course</button></div></form></section></div>}
      {showDeleteCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowDeleteCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Delete session</span><h2 id="delete-course-title">Delete {activeLesson.title}?</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowDeleteCourse(false)}><X size={17} /></button></div><p className="modal-description">This removes the course workspace and its locally stored source and recording data. This action cannot be undone from the app.</p><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowDeleteCourse(false)}>Cancel</button><button className="danger-submit" type="button" onClick={() => void deleteActiveCourse()}><Trash2 size={14} /> Delete course permanently</button></div></section></div>}
      {showGlobalSearch && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowGlobalSearch(false)}><section className="modal search-modal" role="dialog" aria-modal="true" aria-labelledby="global-search-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace index</span><h2 id="global-search-title">Search all course content</h2></div><button className="icon-button" aria-label="Close search" onClick={() => setShowGlobalSearch(false)}><X size={17} /></button></div><label className="modal-search"><Search size={15} /><input autoFocus aria-label="Search all course content" value={globalSearchValue} onChange={(event) => setGlobalSearchValue(event.target.value)} placeholder="Search courses, transcripts, and sources" /></label>{globalSearchValue.trim() && <div className="search-results" aria-live="polite">{globalSearchResults.length ? globalSearchResults.map((result) => <button className="search-result" key={`${result.lessonId}:${result.id}`} onClick={() => openSearchResult(result.lessonId)}><strong>{result.title}</strong><small>{result.detail}</small></button>) : <p className="empty-state">No matching course content.</p>}</div>}</section></div>}
      {showReviewPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReviewPanel(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="review-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Review queue</span><h2 id="review-panel-title">Needs review <span className="modal-count">{reviewItems.length}</span></h2></div><button className="icon-button" aria-label="Close review queue" onClick={() => setShowReviewPanel(false)}><X size={17} /></button></div><p className="modal-description">Transcript segments and imported pages that still need a quick human check.</p><div className="review-results">{reviewItems.length ? reviewItems.map(({ lesson, segment }) => <button className="review-result" key={`${lesson.id}:${segment.id}`} onClick={() => { selectLesson(lesson.id); setShowReviewPanel(false); }}><strong>{segment.text}</strong><small>{lesson.title} · {segment.timestamp}</small></button>) : <p className="empty-state">Nothing needs review.</p>}</div></section></div>}
      {showTranscriptPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowTranscriptPanel(false)}><section className="modal transcript-modal" role="dialog" aria-modal="true" aria-labelledby="transcript-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Transcript archive</span><h2 id="transcript-panel-title">Full transcript <span className="modal-count">{transcript.length}</span></h2>{visibleLiveTranscript.length > 0 && <span className="review-badge">Live preview</span>}</div><button className="icon-button" aria-label="Close full transcript" onClick={() => setShowTranscriptPanel(false)}><X size={17} /></button></div><p className="modal-description">Review every indexed segment from {activeLesson.title}. Changes are saved to this course workspace.</p><div className={`transcript-list modal-transcript-list ${compactTranscript ? 'compact' : ''}`}>{transcript.length || visibleLiveTranscript.length ? [...transcript, ...visibleLiveTranscript].map(renderTranscriptSegment) : <p className="empty-state">This course has no transcript segments yet.</p>}</div></section></div>}
      {showSettingsPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettingsPanel(false)}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace preferences</span><h2 id="settings-panel-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setShowSettingsPanel(false)}><X size={17} /></button></div><p className="modal-description">Connect your local services. Recording and text import work without an AI model.</p>
        <form className="connection-settings" onSubmit={saveServiceSettings}>
          <label>LM Studio address<input value={serviceDraft.llmUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, llmUrl: event.target.value }))} placeholder="/lm-studio/v1" /></label>
          <label>Model<input value={serviceDraft.model} onChange={(event) => setServiceDraft((current) => ({ ...current, model: event.target.value }))} placeholder="Model identifier in LM Studio" /></label>
          <label>Speech service address<input value={serviceDraft.asrUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, asrUrl: event.target.value }))} placeholder="http://127.0.0.1:8765" /></label>
          <label>Document service address<input value={serviceDraft.documentsUrl} onChange={(event) => setServiceDraft((current) => ({ ...current, documentsUrl: event.target.value }))} placeholder="http://127.0.0.1:8766" /></label>
          <button className="primary-submit" disabled={isRecording || isFinalizingRecording || isStartingRecording || isCheckingSidecars} type="submit">Save connections</button>
          <p className="empty-state" role="status">LM Studio: {isCheckingSidecars ? 'Checking...' : llmHealth}</p>
        </form><div className="settings-list"><label className="setting-row"><span><strong>Show verified transcript segments</strong><small>Keep completed segments visible in the course view.</small></span><input type="checkbox" checked={showVerifiedTranscript} onChange={(event) => setShowVerifiedTranscript(event.target.checked)} /></label><label className="setting-row"><span><strong>Compact transcript spacing</strong><small>Fit more indexed content on screen.</small></span><input type="checkbox" checked={compactTranscript} onChange={(event) => setCompactTranscript(event.target.checked)} /></label><div className="setting-info"><span className={`sidecar-status-dot ${sidecarHealth?.asr.available || sidecarHealth?.documents.available ? 'ready' : ''}`} /><span><strong>Local processing</strong><small>Audio and document sidecars are checked without interrupting any running local model.</small></span></div><div className="sidecar-status-list" aria-live="polite"><div><strong>ASR sidecar</strong><span className={sidecarHealth?.asr.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.asr.model ? `${sidecarHealth.asr.model} · ready` : sidecarHealth?.asr.detail ?? 'Not checked.'}</span></div><div><strong>Document sidecar</strong><span className={sidecarHealth?.documents.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.documents.model ? `${sidecarHealth.documents.model} · ready` : sidecarHealth?.documents.detail ?? 'Not checked.'}</span></div></div><button type="button" className="secondary-action refresh-sidecars" onClick={() => void checkSidecars()} disabled={isCheckingSidecars}>{isCheckingSidecars ? 'Checking local services…' : 'Refresh local services'}</button></div><div className="modal-footer"><button type="button" className="primary-submit" onClick={() => setShowSettingsPanel(false)}>Done</button></div></section></div>}
      {isNativeRuntime() && <div className="managed-sidecar-tray" aria-label="Managed local services"><span>Managed services</span><span aria-live="polite">{managedSidecars.filter((sidecar) => sidecar.running).length}/2 running</span><button type="button" onClick={() => void startConfiguredSidecars()}>Start</button><button type="button" onClick={() => void stopConfiguredSidecars()}>Stop</button></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export default App;
