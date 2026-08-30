import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  FileAudio,
  FileImage,
  FileText,
  FolderOpen,
  GraduationCap,
  Headphones,
  Layers3,
  LayoutPanelLeft,
  PanelRight,
  Lightbulb,
  ListChecks,
  Menu,
  MessageCircle,
  Mic,
  Pause,
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
import { Artifact, ArtifactKind, ChatMessage, Lesson, LessonWorkspace, Resource, TranscriptSegment, ViewMode } from './types';

const initialLessons: Lesson[] = [
  {
    id: 'transformers-06',
    subject: 'Machine Learning',
    chapter: 'Transformers',
    title: 'Attention & Scaled Dot-Product',
    teacher: 'Prof. Yann LeCun',
    duration: '01:32:47',
    date: '15 May 2025',
    progress: 72,
  },
  {
    id: 'transformers-05',
    subject: 'Machine Learning',
    chapter: 'Transformers',
    title: 'Self-attention and Context',
    teacher: 'Prof. Yann LeCun',
    duration: '01:18:12',
    date: '08 May 2025',
    progress: 100,
  },
  {
    id: 'linear-algebra-03',
    subject: 'Mathematics',
    chapter: 'Linear Algebra',
    title: 'Matrices and Linear Maps',
    teacher: 'Dr. Camille Roux',
    duration: '00:54:08',
    date: '02 May 2025',
    progress: 36,
  },
];

const initialResources: Resource[] = [
  { id: 'r1', name: 'transcript.txt', meta: 'Text · 126 KB', kind: 'transcript' },
  { id: 'r2', name: 'lecture_audio.mp3', meta: 'HD audio · 98.3 MB', kind: 'audio' },
  { id: 'r3', name: 'board_photo_02.jpg', meta: 'Board · 3.4 MB', kind: 'image' },
  { id: 'r4', name: 'lecture_slides.pdf', meta: 'Slides · 5.6 MB', kind: 'document' },
  { id: 'r5', name: 'handwritten_notes.pdf', meta: 'Notes · 1.8 MB', kind: 'document' },
];

const initialTranscript: TranscriptSegment[] = [
  {
    id: 't1',
    timestamp: '01:13:42',
    speaker: 'Professor',
    text: 'We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.',
    status: 'verified',
  },
  {
    id: 't2',
    timestamp: '01:14:18',
    speaker: 'Professor',
    text: 'The square-root factor keeps the logits in a range where softmax remains sensitive.',
    status: 'verified',
  },
  {
    id: 't3',
    timestamp: '01:15:02',
    speaker: 'Professor',
    text: 'Without this normalization, dot products grow with the key dimension.',
    status: 'review',
  },
];

const initialChat: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'Why do we divide by √dₖ in scaled dot-product attention?',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'We divide by √dₖ to keep variance stable as the key dimension grows. Without this factor, logits become too large, softmax saturates, and gradients become very small.',
    citations: ['Course audio · 01:14:18', 'Slides · page 31'],
  },
];

const artifactCatalog: { kind: ArtifactKind; label: string; description: string }[] = [
  { kind: 'summary', label: 'Quick summary', description: 'The essential ideas on one page.' },
  { kind: 'guide', label: 'Study guide', description: 'A structured, source-linked synthesis.' },
  { kind: 'quiz', label: 'Targeted quiz', description: 'Test the concepts that remain uncertain.' },
  { kind: 'flashcards', label: 'Flashcards', description: 'Prepare a review-ready card deck.' },
  { kind: 'mindmap', label: 'Concept map', description: 'Connect concepts and their dependencies.' },
  { kind: 'glossary', label: 'Glossary', description: 'Definitions for the course vocabulary.' },
];

const emptyLessonWorkspace: LessonWorkspace = {
  resources: [],
  transcript: [],
  chat: [],
  artifacts: [],
};

const sourceAccept = 'audio/*,image/*,.pdf,.txt,.md';
const PREFERENCES_STORAGE_KEY = 'studentllm.preferences.v1';
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
  activeLessonId: initialLessons[0].id,
  lessons: initialLessons,
  resources: initialResources,
  transcript: initialTranscript,
  chat: initialChat,
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
  const [view, setView] = useState<ViewMode>('course');
  const [showLeftSidebar, setShowLeftSidebar] = useState(() => typeof window === 'undefined' || window.innerWidth > 680);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [expandedSubjects, setExpandedSubjects] = useState<Record<string, boolean>>({
    'Machine Learning': true,
    Mathematics: true,
  });
  const [expandedChapter, setExpandedChapter] = useState(true);
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
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(workspace.lessonWorkspaces?.[workspace.activeLessonId]?.artifacts[0]?.id ?? workspace.artifacts[0]?.id ?? null);
  const [toast, setToast] = useState('');
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [showDeleteCourse, setShowDeleteCourse] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [globalSearchValue, setGlobalSearchValue] = useState('');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [showTranscriptPanel, setShowTranscriptPanel] = useState(false);
  const [showStudioPanel, setShowStudioPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [compactTranscript, setCompactTranscript] = useState(() => loadPreference('compactTranscript', false));
  const [showVerifiedTranscript, setShowVerifiedTranscript] = useState(() => loadPreference('showVerifiedTranscript', true));
  const [sidecarHealth, setSidecarHealth] = useState<{ asr: SidecarHealth; documents: SidecarHealth } | null>(null);
  const [managedSidecars, setManagedSidecars] = useState<ManagedSidecarStatus[]>([]);
  const [isCheckingSidecars, setIsCheckingSidecars] = useState(false);
  const [transcribingResourceIds, setTranscribingResourceIds] = useState<Set<string>>(() => new Set());
  const [resourcePreview, setResourcePreview] = useState<ResourcePreview | null>(null);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseSubject, setNewCourseSubject] = useState('Machine Learning');
  const recorderRef = useRef<RecorderSession | null>(null);
  const liveTranscriptionInFlight = useRef(false);
  const storageIssueRef = useRef<WorkspaceStorageError['operation'] | null>(null);
  const resourcePreviewRequest = useRef(0);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const localProvider = useMemo(() => provider === undefined ? createLocalLLMProvider() : provider, [provider]);
  const localSpeechEngine = useMemo(() => speechEngine === undefined ? createLocalSpeechEngine() : speechEngine, [speechEngine]);
  const localDocumentEngine = useMemo(() => documentEngine === undefined ? createLocalDocumentEngine() : documentEngine, [documentEngine]);
  const sourceBlobStore = useMemo(() => createSourceBlobStore(), []);
  const recordingChunkStore = useMemo(() => recordingChunkStoreOverride ?? createRecordingChunkStore(), [recordingChunkStoreOverride]);
  const hasOpenDialog = Boolean(resourcePreview || showNewCourse || showDeleteCourse || showGlobalSearch || showReviewPanel || showTranscriptPanel || showStudioPanel || showSettingsPanel);

  const reportStorageError = (error: WorkspaceStorageError) => {
    console.warn(`[workspace-storage:${error.operation}] ${error.message}`);
    if (storageIssueRef.current === error.operation) return;
    storageIssueRef.current = error.operation;
    setToast(error.operation === 'load'
      ? 'Native workspace storage unavailable. Using local fallback.'
      : 'Native workspace save failed. Changes remain in local fallback.');
  };

  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0];
  const activeWorkspace = lessonWorkspaces[activeLessonId] ?? emptyLessonWorkspace;
  const { resources, transcript, chat, artifacts } = activeWorkspace;

  const updateLessonWorkspace = (lessonId: string, update: (current: LessonWorkspace) => LessonWorkspace) => {
    setLessonWorkspaces((current) => ({
      ...current,
      [lessonId]: update(current[lessonId] ?? emptyLessonWorkspace),
    }));
  };

  const updateActiveWorkspace = (update: (current: LessonWorkspace) => LessonWorkspace) => updateLessonWorkspace(activeLessonId, update);

  const visibleLessons = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return lessons;
    return lessons.filter((lesson) => `${lesson.subject} ${lesson.chapter} ${lesson.title}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [lessons, searchQuery]);

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
      } catch {
        // Final transcription remains the authoritative retry path after stop.
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
        setShowStudioPanel(false);
        setShowSettingsPanel(false);
        setResourcePreview(null);
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

    void runPackagedIpcSmoke().catch((error) => {
      console.error(`[packaged-ipc-smoke] ${error instanceof Error ? error.message : error}`);
    });
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

  const selectLesson = (lessonId: string) => {
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

  const shareCourse = async () => {
    const shareText = `${activeLesson.title}\n${activeLesson.subject} / ${activeLesson.chapter}\n${activeLesson.teacher}`;
    try {
      await navigator.clipboard.writeText(shareText);
      notify('Course details copied to the clipboard.');
    } catch {
      notify('Clipboard access is unavailable in this browser.');
    }
  };

  const checkSidecars = async () => {
    setIsCheckingSidecars(true);
    const [asr, documents, managed] = await Promise.all([
      probeSidecar(import.meta.env.VITE_LOCAL_ASR_BASE_URL),
      probeSidecar(import.meta.env.VITE_LOCAL_DOCUMENT_BASE_URL),
      getManagedSidecarStatus().catch(() => []),
    ]);
    setSidecarHealth({ asr, documents });
    setManagedSidecars(managed);
    setIsCheckingSidecars(false);
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
            metadata: { resourceName: resource.name, part: String(chunk.index + 1), startLine: String(chunk.startLine) },
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

  const toggleRecording = async () => {
    setRecordingError('');
    if (isFinalizingRecording) {
      notify('Finish saving the current recording before starting another.');
      return;
    }
    if (isRecording) {
      const session = recorderRef.current;
      const recordingLessonId = activeLesson.id;
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
        if (session.stream && session.durability === 'durable' && chunksPersisted > 0) {
          updateLessonWorkspace(recordingLessonId, (current) => ({
            ...current,
            resources: [{
              id: session.recordingId,
              name: `${recordingLessonTitle} audio.webm`,
              meta: `Audio · ${chunksPersisted} chunk${chunksPersisted === 1 ? '' : 's'}`,
              kind: 'audio',
              mimeType: 'audio/webm',
            }, ...current.resources],
          }));
        }
        if (!session.stream) {
          notify('Demo session ended.');
        } else if (persistenceError) {
          notify(`${chunksPersisted} audio chunks preserved; persistence needs review.`);
        } else if (session.durability === 'durable') {
          notify(`${chunksPersisted} audio chunks saved locally.`);
        } else {
          notify(`${chunksPersisted} audio chunks kept in memory only.`);
        }

        if (!localSpeechEngine || !session.stream || session.durability !== 'durable' || chunksPersisted === 0) return;
        notify('Audio saved locally. Transcribing with local ASR...');
        try {
          const chunks = await session.readChunks();
          if (!chunks.length) throw new Error('No persisted audio chunks available.');
          const audio = new Blob(chunks.map((chunk) => chunk.blob), { type: chunks[0].blob.type || 'audio/webm' });
          const transcription = await localSpeechEngine.transcribe(audio);
          if (!transcription.segments.length) {
            notify('Audio saved locally; local ASR returned no speech.');
            return;
          }
          updateLessonWorkspace(recordingLessonId, (current) => ({
            ...current,
            transcript: [...current.transcript, ...transcription.segments.map((segment, index) => ({
              ...segment,
              id: `${session.recordingId}:${segment.id || index}`,
              sourceId: session.recordingId,
            }))],
          }));
          notify(`Local transcription added ${transcription.segments.length} segments.`);
        } catch {
          notify('Audio saved locally; local transcription needs review.');
        }
      }).catch(() => setRecordingError('The audio session could not be finalized correctly.'))
        .finally(() => setIsFinalizingRecording(false));
      setIsFinalizingRecording(true);
      return;
    }

    try {
      const session = await recorderSessionFactory();
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
      notify(recorderRef.current.stream
        ? localSpeechEngine ? 'Microphone active, local transcription ready.' : 'Microphone active, audio autosave ready.'
        : 'Demo mode active: microphone unavailable.');
    } catch {
      setRecordingError('The microphone is unavailable. Check permission and try again.');
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
    if (!message) return;
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

  const createArtifact = (kind: ArtifactKind) => {
    const definition = artifactCatalog.find((artifact) => artifact.kind === kind);
    if (!definition) return;
    const artifactId = `${kind}-${Date.now()}`;
    const artifact: Artifact = {
      id: artifactId,
      kind,
      label: definition.label,
      createdAt: 'just now',
      content: `Draft ${definition.label.toLowerCase()} for ${activeLesson.title}. Add a local provider to generate a source-grounded version.`,
    };
    updateActiveWorkspace((current) => ({ ...current, artifacts: [artifact, ...current.artifacts].slice(0, 4) }));
    setSelectedArtifactId(artifactId);
    notify(`${definition.label} added to Studio.`);

    if (!localProvider) return;
    void (async () => {
      try {
        const retrievalDocuments = await loadRetrievalDocuments();
        const retrievalHits = searchDocuments(retrievalDocuments, activeLesson.title, 6);
        const contextDocuments = retrievalHits.map((hit) => hit.document);
        if (!contextDocuments.length) {
          notify('Add a relevant indexed passage before generating this artifact.');
          return;
        }
        const context = contextDocuments.map((document) => document.metadata.resourceName
          ? `[Source: ${document.metadata.resourceName}, part ${document.metadata.part}] ${document.text}`
          : `[${document.metadata.timestamp}] ${document.metadata.speaker}: ${document.text}`).join('\n');
        const result = await localProvider.generate([
          {
            role: 'system',
            content: `Create a concise ${definition.label.toLowerCase()} for ${activeLesson.title} using only these course excerpts. Do not invent facts.\n${context}`,
          },
          { role: 'user', content: `Generate the ${definition.label.toLowerCase()}.` },
        ]);
        const citations = [...new Set(contextDocuments.slice(0, 3).map(formatRetrievalCitation))];
        updateActiveWorkspace((current) => ({
          ...current,
          artifacts: current.artifacts.map((item) => item.id === artifactId
            ? { ...item, content: result.content, citations }
            : item),
        }));
      } catch {
        notify(`${definition.label} draft kept; the local provider could not generate a replacement.`);
      }
    })();
  };

  const importSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    event.target.accept = sourceAccept;
    if (!file) return;
    const lessonId = activeLesson.id;
    try {
      const resource = await createSourceResource(file);
      await sourceBlobStore.save(resource.id, file);
      updateLessonWorkspace(lessonId, (current) => ({ ...current, resources: [resource, ...current.resources] }));
      notify(`${resource.name} added to course sources${sourceBlobStore.durability === 'durable' ? ' and saved locally.' : ' in memory only.'}`);
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
          notify(`${resource.name} was saved, but local transcription needs review.`);
        } finally {
          setTranscribingResourceIds((current) => {
            const next = new Set(current);
            next.delete(resource.id);
            return next;
          });
        }
      }
      const isPdf = resource.kind === 'document' && (resource.mimeType === 'application/pdf' || /\.pdf$/i.test(resource.name));
      if (localDocumentEngine && (isPdf || resource.kind === 'image')) {
        try {
          const extraction = await localDocumentEngine.extract(file);
          const pageSegments = extraction.pages
            .filter((page) => page.text.trim())
            .map((page) => ({
              id: `${resource.id}:page-${page.pageNumber}`,
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
          notify(`${resource.name} was saved, but local document extraction is unavailable.`);
        }
      }
    } catch {
      notify('The source could not be fingerprinted or stored locally.');
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
    if (lessons.length <= 1) {
      notify('Keep at least one course in the workspace.');
      setShowDeleteCourse(false);
      return;
    }
    if (isRecording) {
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
      if (!nextLesson) throw new Error('No replacement course available.');
      setLessons(nextLessons);
      setLessonWorkspaces((current) => {
        const next = { ...current };
        delete next[lessonId];
        return next;
      });
      setActiveLessonId(nextLesson.id);
      setSelectedArtifactId(lessonWorkspaces[nextLesson.id]?.artifacts[0]?.id ?? null);
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

  const importCourse = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
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
    if (!title) return;
    const id = `lesson-${Date.now()}`;
    const lesson: Lesson = {
      id,
      subject: newCourseSubject,
      chapter: 'New courses',
      title,
      teacher: 'To be added',
      duration: '00:00:00',
      date: 'today',
      progress: 0,
    };
    setLessons((current) => [lesson, ...current]);
    setLessonWorkspaces((current) => ({ ...current, [id]: emptyLessonWorkspace }));
    setActiveLessonId(id);
    setSelectedArtifactId(null);
    setNewCourseTitle('');
    setShowNewCourse(false);
    notify('New course created. Ready to record.');
  };

  const renderTranscriptSegment = (segment: TranscriptSegment) => (
    <article className={`transcript-item ${segment.status === 'review' ? 'needs-review' : ''}`} key={segment.id}>
      <div className="transcript-time">{segment.timestamp}</div>
      <div className="transcript-body"><div className="speaker-line"><strong>{segment.speaker}</strong>{segment.provisional ? <span className="review-badge">Live preview</span> : segment.status === 'review' ? <span className="review-badge">Needs review</span> : <span className="verified-badge"><Check size={11} /> verified</span>}</div><p>{segment.text}</p></div>
      {!segment.provisional && <button className="transcript-more" aria-label={segment.status === 'review' ? `Mark segment ${segment.timestamp} verified` : `Mark segment ${segment.timestamp} for review`} onClick={() => toggleTranscriptReview(segment.id)}>...</button>}
    </article>
  );

  return (
    <div className="app-shell">
      <input ref={sourceInputRef} className="visually-hidden" type="file" aria-label="Select course source" accept={sourceAccept} onChange={importSource} />
      <header className="topbar">
        <div className="topbar-leading">
          <button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setShowLeftSidebar((value) => !value)}>
            <Menu size={17} />
          </button>
          <button className="icon-button desktop-only" aria-label="Show or hide navigation" onClick={() => setShowLeftSidebar((value) => !value)}>
            {showLeftSidebar ? <LayoutPanelLeft size={17} /> : <Menu size={17} />}
          </button>
          <div className="brand-mark" aria-hidden="true"><Sparkles size={15} /></div>
          <div className="brand-name">Student<span>LLM</span></div>
          <div className="breadcrumbs desktop-only">
            <span>/</span>
            <span>{activeLesson.subject}</span>
            <span>/</span>
            <strong>{activeLesson.chapter} · {activeLesson.title}</strong>
          </div>
        </div>
        <div className="topbar-actions">
          <label className="search-field desktop-only">
            <Search size={15} />
            <input aria-label="Search courses" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search your courses" />
            <kbd>⌘ K</kbd>
          </label>
          <button className={`icon-button ${showRightSidebar ? 'selected' : ''}`} aria-label="Show or hide Studio" onClick={() => setShowRightSidebar((value) => !value)}>
            {showRightSidebar ? <PanelRight size={17} /> : <Layers3 size={17} />}
          </button>
          <button className="icon-button notification-button" aria-label="Notifications" onClick={() => notify('No new notifications.') }>
            <Activity size={17} />
            <span />
          </button>
          <button className="profile-chip" aria-label="Open profile">
            <span>SO</span>
            <strong className="desktop-only">Shoko-official</strong>
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        {showLeftSidebar && (
          <aside className="left-sidebar" aria-label="Course navigation">
            <div className="sidebar-scroll">
              <button className="primary-action" onClick={() => setShowNewCourse(true)}>
                <span><Plus size={16} /> New course</span>
                <kbd>Ctrl N</kbd>
              </button>

              <div className="sidebar-section-header">
                <span>Library</span>
                <span className="eyebrow-count">{lessons.length} courses</span>
              </div>

              <nav className="course-tree">
                {['Machine Learning', 'Mathematics'].map((subject) => {
                  const subjectLessons = visibleLessons.filter((lesson) => lesson.subject === subject);
                  const expanded = expandedSubjects[subject];
                  return (
                    <div className="tree-group" key={subject}>
                      <button className="tree-subject" onClick={() => setExpandedSubjects((current) => ({ ...current, [subject]: !expanded }))}>
                        <span><BookOpen size={15} /> {subject}</span>
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      {expanded && (
                        <div className="tree-children">
                          {subject === 'Machine Learning' && (
                            <button className="tree-chapter" onClick={() => setExpandedChapter((value) => !value)}>
                              <span><FolderOpen size={14} /> Transformers</span>
                              {expandedChapter ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                          )}
                          {subjectLessons.map((lesson) => (
                            <button key={lesson.id} className={`tree-lesson ${activeLesson.id === lesson.id ? 'active' : ''}`} aria-label={lesson.title} onClick={() => selectLesson(lesson.id)}>
                              <span>{lesson.title}</span>
                              {activeLesson.id === lesson.id && <span className="active-dot" />}
                            </button>
                          ))}
                          {!subjectLessons.length && <span className="tree-empty">No results</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>

              <button className="ghost-row" onClick={() => setShowGlobalSearch(true)}><Search size={14} /> Global search <ArrowUpRight size={13} /></button>
              <button className="ghost-row attention-row" onClick={() => setShowReviewPanel(true)}><Lightbulb size={14} /> Needs review <span className="count-pill">{reviewItems.length}</span></button>
            </div>

            <div className="sidebar-footer">
              <div className="privacy-status"><span className="status-dot" /> Local processing enabled</div>
              <div className="profile-card">
                <div className="profile-avatar">SO</div>
                <div><strong>Shoko-official</strong><span>Student plan</span></div>
                <GraduationCap size={16} />
              </div>
              <div className="footer-links"><button onClick={() => setShowSettingsPanel(true)}><Settings2 size={14} /> Settings</button><button aria-label="Help" onClick={() => notify('Need help? Check the project documentation.') }><CircleHelp size={15} /></button></div>
            </div>
          </aside>
        )}

        <main className="main-panel">
          <div className="main-header">
            <div className="main-heading">
              <div className="section-kicker">{activeLesson.subject} <span>/</span> {activeLesson.chapter}</div>
              <h1>{activeLesson.title}</h1>
              <p>{activeLesson.teacher} · {activeLesson.date}</p>
            </div>
            <div className="main-header-actions">
              <div className="view-tabs" role="tablist" aria-label="Course view">
                <button role="tab" aria-selected={view === 'course'} className={view === 'course' ? 'active' : ''} onClick={() => setView('course')}><BookOpen size={14} /> Course</button>
                <button role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}><MessageCircle size={14} /> Chat</button>
              </div>
              <button className="secondary-action desktop-only" onClick={() => void shareCourse()}><Copy size={14} /> Share</button>
            </div>
          </div>

          {view === 'course' ? (
            <div className="course-view">
              <section className={`recording-card ${isRecording ? 'recording' : ''} ${isFinalizingRecording ? 'finalizing' : ''}`} aria-label="Course recording">
                <div className="recording-topline">
                  <div className="recording-label"><span className="recording-pulse" /> {isRecording ? 'Recording in progress' : isFinalizingRecording ? 'Saving recording' : 'Session ready'}</div>
                  <span className="local-badge"><span className="status-dot" /> On this device</span>
                </div>
                <div className="recording-core">
                  <div>
                    <span className="muted-label">Session duration</span>
                    <strong className="recording-time">{isRecording ? formatElapsed(recordingSeconds) : activeLesson.duration}</strong>
                  </div>
                  <div className="signal-rail" aria-hidden="true">{Array.from({ length: 42 }, (_, index) => <span key={index} style={{ height: `${14 + ((index * 17) % 28)}%` }} />)}</div>
                  <div className="recording-actions">
                    <button className={`record-button ${isRecording ? 'stop' : ''}`} onClick={toggleRecording} disabled={isFinalizingRecording} aria-label={isRecording ? 'Stop recording' : isFinalizingRecording ? 'Finishing recording' : 'Start recording'}>
                      {isRecording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
                    </button>
                    <button className="bookmark-button" onClick={addBookmark} aria-label="Bookmark this passage"><Lightbulb size={16} /> Bookmark</button>
                  </div>
                </div>
                {recordingError && <p className="inline-error">{recordingError}</p>}
                <div className="recording-progress"><span style={{ width: `${activeLesson.progress}%` }} /></div>
                <div className="recording-meta"><span><Clock3 size={13} /> {activeLesson.progress}% complete</span><span><Upload size={13} /> Chunked autosave</span><span><Pause size={13} /> {isFinalizingRecording ? 'Saving audio and preparing transcript...' : 'ASR priority'}</span></div>
              </section>

              <section className="transcript-section">
                <div className="section-toolbar"><div><span className="section-kicker">Live transcript {visibleLiveTranscript.length > 0 && <span className="review-badge">Live preview</span>}</span><h2>The course, source by source</h2></div><button className="text-action" onClick={() => setShowTranscriptPanel(true)}>View all <ArrowUpRight size={13} /></button></div>
                <div className={`transcript-list ${compactTranscript ? 'compact' : ''}`}>
                  {visibleTranscript.length || visibleLiveTranscript.length ? [...visibleTranscript, ...visibleLiveTranscript].map(renderTranscriptSegment) : <p className="empty-state">No transcript segments match the current display settings.</p>}
                </div>
              </section>

              <form className="composer" onSubmit={submitComposer}>
                <div className="composer-input"><MessageCircle size={16} /><input aria-label="Ask a course question" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Ask a question about this course…" /><kbd>@</kbd></div>
                <div className="composer-tools"><button type="button" aria-label="Attach a file" onClick={() => openSourcePicker('audio/*,.pdf,.txt,.md')}><Plus size={17} /></button><button type="button" aria-label="Attach an image" onClick={() => openSourcePicker('image/*')}><FileImage size={16} /></button><button type="button" aria-label="Voice dictation" onClick={toggleRecording}><Mic size={16} /></button><button className="send-button" type="submit" aria-label="Send question"><Send size={15} /></button></div>
                <small>Answers stay linked to sources. Check important formulas against your notes.</small>
              </form>
            </div>
          ) : (
            <div className="chat-view">
              <div className="chat-intro"><span className="ai-orb"><Sparkles size={18} /></span><div><span className="section-kicker">Course assistant</span><h2>Understand with evidence.</h2><p>Answers start with the active session and show the passages consulted.</p></div></div>
              <div className="chat-list">
                {chat.map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === 'assistant' ? <Sparkles size={14} /> : 'SO'}</div><div className="message-content"><span className="message-role">{message.role === 'assistant' ? 'StudentLLM AI' : 'You'}</span><p>{message.content}</p>{message.citations && <div className="citation-list">{message.citations.map((citation) => <button key={citation} onClick={() => notify(`Source opened: ${citation}`)}><Headphones size={12} /> {citation}</button>)}</div>}</div></article>
                ))}
              </div>
              <form className="chat-composer" onSubmit={submitComposer}><input aria-label="Ask the course chat" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Ask for an explanation, example, or summary…" disabled={isSending} /><button type="submit" aria-label="Send" disabled={isSending}><Send size={16} /></button></form>
            </div>
          )}
        </main>

        {showRightSidebar && (
          <aside className="right-sidebar" aria-label="Course Studio">
            <div className="studio-heading"><div><span className="section-kicker">Studio</span><h2>Build for review</h2></div><button className="icon-button" aria-label="Close Studio" onClick={() => setShowRightSidebar(false)}><X size={16} /></button></div>
            <section className="context-card"><div className="context-card-top"><span className="context-icon"><BookOpen size={15} /></span><span className="local-badge"><span className="status-dot" /> local</span></div><h3>{activeLesson.title}</h3><dl><div><dt>Sources</dt><dd>{activeResources.length + 2}</dd></div><div><dt>Duration</dt><dd>{activeLesson.duration}</dd></div><div><dt>State</dt><dd className="success-text">Indexed</dd></div></dl></section>
            <div className="transfer-actions" aria-label="Course transfer"><button className="transfer-action" type="button" onClick={() => void exportCourse()}><Download size={13} /> Export course</button><label className="transfer-action"><input className="visually-hidden" type="file" accept="application/json,.json" aria-label="Import course export" onChange={(event) => void importCourse(event)} /><Upload size={13} /> Import course</label></div>
            <section className="resources-section"><div className="sidebar-section-header"><span>Course sources</span><button className="mini-action" type="button" onClick={() => openSourcePicker(sourceAccept)}><Plus size={13} /> add</button></div><div className="resource-list">{activeResources.map((resource) => <div className="resource-item" key={resource.id}><button className="resource-open" type="button" onClick={() => void openResource(resource)}><span className="resource-icon">{resourceIcon(resource.kind)}</span><span><strong>{resource.name}</strong><small>{transcribingResourceIds.has(resource.id) ? 'Transcribing locally...' : resource.meta}</small></span><ChevronRight size={14} /></button><button className="resource-remove" type="button" aria-label={`Remove source ${resource.name}`} onClick={() => void removeSource(resource)} disabled={transcribingResourceIds.has(resource.id)}><X size={13} /></button></div>)}</div>{resources.length > 3 && <button className="show-more" onClick={() => setShowAllResources((value) => !value)}>{showAllResources ? 'Show fewer' : `Show ${resources.length - 3} more sources`} <ChevronDown size={13} /></button>}</section>
            <section className="studio-actions"><div className="sidebar-section-header"><span>Create an artifact</span><span className="eyebrow-count">source-linked</span></div><div className="artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className="artifact-button" onClick={() => createArtifact(artifact.kind)}><span className={`artifact-icon ${artifact.kind}`}><ListChecks size={15} /></span><span><strong>{artifact.label}</strong><small>{artifact.description}</small></span></button>)}</div></section>
            {artifacts.length > 0 && <section className="recent-section"><div className="sidebar-section-header"><span>Recently created</span><span className="eyebrow-count">{artifacts.length}</span></div>{artifacts.map((artifact) => <button className="recent-artifact" key={artifact.id} type="button" aria-label={`Open artifact ${artifact.label}`} onClick={() => setSelectedArtifactId(artifact.id)}><span className="artifact-icon summary"><Check size={14} /></span><span><strong>{artifact.label}</strong><small>{artifact.createdAt}</small></span></button>)}{selectedArtifactId && (() => { const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId); if (!selectedArtifact) return null; return <article className="artifact-preview"><span className="section-kicker">Artifact preview</span><h3>{selectedArtifact.label}</h3><p>{selectedArtifact.content ?? 'This artifact has no stored content.'}</p>{selectedArtifact.citations && <div className="citation-list">{selectedArtifact.citations.map((citation) => <button key={citation} onClick={() => notify(`Source opened: ${citation}`)}><Headphones size={12} /> {citation}</button>)}</div>}</article>; })()}</section>}
            <button className="studio-link" onClick={() => setShowStudioPanel(true)}>Open full Studio <ArrowUpRight size={14} /></button>
            <button className="danger-link" onClick={() => lessons.length <= 1 ? notify('Keep at least one course in the workspace.') : isRecording ? notify('Stop the recording before deleting this course.') : setShowDeleteCourse(true)}><Trash2 size={13} /> Delete course</button>
          </aside>
        )}
      </div>

      {resourcePreview && <div className="modal-backdrop" role="presentation" onMouseDown={() => setResourcePreview(null)}><section className="modal resource-preview-modal" role="dialog" aria-modal="true" aria-labelledby="resource-preview-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Original source</span><h2 id="resource-preview-title">{resourcePreview.resource.name}</h2></div><button className="icon-button" aria-label="Close source preview" onClick={() => setResourcePreview(null)}><X size={17} /></button></div><p className="modal-description">{resourcePreview.resource.meta}{resourcePreview.resource.sha256 ? ` · SHA-256 ${resourcePreview.resource.sha256.slice(0, 12)}…` : ''}</p>{resourcePreview.state === 'loading' && <p className="empty-state">Opening the locally stored source…</p>}{resourcePreview.state === 'missing' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'error' && <p className="empty-state">{resourcePreview.detail}</p>}{resourcePreview.state === 'ready' && resourcePreview.text !== undefined && <div className="source-text-preview"><pre>{resourcePreview.text}</pre>{resourcePreview.truncated && <small>Preview truncated to 12,000 characters. The original source remains unchanged.</small>}</div>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'image' && <img className="source-image-preview" src={resourcePreview.blobUrl} alt={`Preview of ${resourcePreview.resource.name}`} />}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'audio' && <audio className="source-audio-preview" controls src={resourcePreview.blobUrl}>Your browser cannot play this audio source.</audio>}{resourcePreview.state === 'ready' && resourcePreview.blobUrl && resourcePreview.resource.kind === 'document' && <iframe className="source-document-preview" title={`Preview of ${resourcePreview.resource.name}`} src={resourcePreview.blobUrl} />}</section></div>}
      {showNewCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">New session</span><h2 id="new-course-title">Start a course</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowNewCourse(false)}><X size={17} /></button></div><p className="modal-description">Create a persistent session now. Add audio, images, and documents as the course progresses.</p><form onSubmit={createCourse}><label>Course title<input autoFocus value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} placeholder="e.g. Introduction to probability" /></label><label>Subject<select value={newCourseSubject} onChange={(event) => setNewCourseSubject(event.target.value)}><option>Machine Learning</option><option>Mathematics</option><option>Electronics</option></select></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowNewCourse(false)}>Cancel</button><button className="primary-submit" type="submit" disabled={!newCourseTitle.trim()}><Mic size={15} /> Create and prepare recording</button></div></form></section></div>}
      {showDeleteCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowDeleteCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Delete session</span><h2 id="delete-course-title">Delete {activeLesson.title}?</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowDeleteCourse(false)}><X size={17} /></button></div><p className="modal-description">This removes the course workspace and its locally stored source and recording data. This action cannot be undone from the app.</p><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowDeleteCourse(false)}>Cancel</button><button className="danger-submit" type="button" onClick={() => void deleteActiveCourse()}><Trash2 size={14} /> Delete course permanently</button></div></section></div>}
      {showGlobalSearch && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowGlobalSearch(false)}><section className="modal search-modal" role="dialog" aria-modal="true" aria-labelledby="global-search-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace index</span><h2 id="global-search-title">Search all course content</h2></div><button className="icon-button" aria-label="Close search" onClick={() => setShowGlobalSearch(false)}><X size={17} /></button></div><label className="modal-search"><Search size={15} /><input autoFocus aria-label="Search all course content" value={globalSearchValue} onChange={(event) => setGlobalSearchValue(event.target.value)} placeholder="Search courses, transcripts, and sources" /></label>{globalSearchValue.trim() && <div className="search-results" aria-live="polite">{globalSearchResults.length ? globalSearchResults.map((result) => <button className="search-result" key={`${result.lessonId}:${result.id}`} onClick={() => openSearchResult(result.lessonId)}><strong>{result.title}</strong><small>{result.detail}</small></button>) : <p className="empty-state">No matching course content.</p>}</div>}</section></div>}
      {showReviewPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReviewPanel(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="review-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Review queue</span><h2 id="review-panel-title">Needs review <span className="modal-count">{reviewItems.length}</span></h2></div><button className="icon-button" aria-label="Close review queue" onClick={() => setShowReviewPanel(false)}><X size={17} /></button></div><p className="modal-description">Transcript segments and imported pages that still need a quick human check.</p><div className="review-results">{reviewItems.length ? reviewItems.map(({ lesson, segment }) => <button className="review-result" key={`${lesson.id}:${segment.id}`} onClick={() => { selectLesson(lesson.id); setShowReviewPanel(false); }}><strong>{segment.text}</strong><small>{lesson.title} · {segment.timestamp}</small></button>) : <p className="empty-state">Nothing needs review.</p>}</div></section></div>}
      {showTranscriptPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowTranscriptPanel(false)}><section className="modal transcript-modal" role="dialog" aria-modal="true" aria-labelledby="transcript-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Transcript archive</span><h2 id="transcript-panel-title">Full transcript <span className="modal-count">{transcript.length}</span></h2>{visibleLiveTranscript.length > 0 && <span className="review-badge">Live preview</span>}</div><button className="icon-button" aria-label="Close full transcript" onClick={() => setShowTranscriptPanel(false)}><X size={17} /></button></div><p className="modal-description">Review every indexed segment from {activeLesson.title}. Changes are saved to this course workspace.</p><div className={`transcript-list modal-transcript-list ${compactTranscript ? 'compact' : ''}`}>{transcript.length || visibleLiveTranscript.length ? [...transcript, ...visibleLiveTranscript].map(renderTranscriptSegment) : <p className="empty-state">This course has no transcript segments yet.</p>}</div></section></div>}
      {showStudioPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowStudioPanel(false)}><section className="modal studio-modal" role="dialog" aria-modal="true" aria-labelledby="studio-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Artifact workspace</span><h2 id="studio-panel-title">Full Studio</h2></div><button className="icon-button" aria-label="Close full Studio" onClick={() => setShowStudioPanel(false)}><X size={17} /></button></div><p className="modal-description">Create source-linked study materials for {activeLesson.title}. Select an artifact to inspect its latest draft.</p><div className="artifact-grid modal-artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className="artifact-button" onClick={() => createArtifact(artifact.kind)}><span className={`artifact-icon ${artifact.kind}`}><ListChecks size={15} /></span><span><strong>{artifact.label}</strong><small>{artifact.description}</small></span></button>)}</div>{artifacts.length > 0 && <div className="studio-library"><div className="sidebar-section-header"><span>Saved artifacts</span><span className="eyebrow-count">{artifacts.length}</span></div>{artifacts.map((artifact) => <button className={`recent-artifact ${artifact.id === selectedArtifactId ? 'selected' : ''}`} key={artifact.id} type="button" onClick={() => setSelectedArtifactId(artifact.id)}><span className="artifact-icon summary"><Check size={14} /></span><span><strong>{artifact.label}</strong><small>{artifact.createdAt}</small></span></button>)}{selectedArtifactId && (() => { const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId); if (!selectedArtifact) return null; return <article className="artifact-preview"><span className="section-kicker">Artifact preview</span><h3>{selectedArtifact.label}</h3><p>{selectedArtifact.content ?? 'This artifact has no stored content.'}</p>{selectedArtifact.citations && <div className="citation-list">{selectedArtifact.citations.map((citation) => <button key={citation} onClick={() => notify(`Source opened: ${citation}`)}><Headphones size={12} /> {citation}</button>)}</div>}</article>; })()}</div>}</section></div>}
      {showSettingsPanel && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSettingsPanel(false)}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Workspace preferences</span><h2 id="settings-panel-title">Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setShowSettingsPanel(false)}><X size={17} /></button></div><p className="modal-description">Adjust how this workspace presents local course data. Preferences apply immediately to this session.</p><div className="settings-list"><label className="setting-row"><span><strong>Show verified transcript segments</strong><small>Keep completed segments visible in the course view.</small></span><input type="checkbox" checked={showVerifiedTranscript} onChange={(event) => setShowVerifiedTranscript(event.target.checked)} /></label><label className="setting-row"><span><strong>Compact transcript spacing</strong><small>Fit more indexed content on screen.</small></span><input type="checkbox" checked={compactTranscript} onChange={(event) => setCompactTranscript(event.target.checked)} /></label><div className="setting-info"><span className={`sidecar-status-dot ${sidecarHealth?.asr.available || sidecarHealth?.documents.available ? 'ready' : ''}`} /><span><strong>Local processing</strong><small>Audio and document sidecars are checked without interrupting any running local model.</small></span></div><div className="sidecar-status-list" aria-live="polite"><div><strong>ASR sidecar</strong><span className={sidecarHealth?.asr.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.asr.model ? `${sidecarHealth.asr.model} · ready` : sidecarHealth?.asr.detail ?? 'Not checked.'}</span></div><div><strong>Document sidecar</strong><span className={sidecarHealth?.documents.available ? 'ready' : ''}>{isCheckingSidecars ? 'Checking…' : sidecarHealth?.documents.model ? `${sidecarHealth.documents.model} · ready` : sidecarHealth?.documents.detail ?? 'Not checked.'}</span></div></div><button type="button" className="secondary-action refresh-sidecars" onClick={() => void checkSidecars()} disabled={isCheckingSidecars}>{isCheckingSidecars ? 'Checking local services…' : 'Refresh local services'}</button></div><div className="modal-footer"><button type="button" className="primary-submit" onClick={() => setShowSettingsPanel(false)}>Done</button></div></section></div>}
      {isNativeRuntime() && <div className="managed-sidecar-tray" aria-label="Managed local services"><span>Managed services</span><span aria-live="polite">{managedSidecars.filter((sidecar) => sidecar.running).length}/2 running</span><button type="button" onClick={() => void startConfiguredSidecars()}>Start</button><button type="button" onClick={() => void stopConfiguredSidecars()}>Stop</button></div>}
      {toast && <div className="toast" role="status"><Check size={15} /> {toast}</div>}
    </div>
  );
}

export default App;
