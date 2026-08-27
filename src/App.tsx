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
  Upload,
  X,
} from 'lucide-react';
import { requestRecorderSession, RecorderSession } from './lib/recorder';
import { loadWorkspace, saveWorkspace } from './lib/workspace-storage';
import { createLocalLLMProvider } from './lib/llm-provider';
import type { LLMProvider } from './lib/llm-provider';
import { createSourceResource } from './lib/source-ingest';
import { createSourceBlobStore } from './lib/source-storage';
import { chunkSourceText } from './lib/source-chunking';
import { RetrievalDocument, searchDocuments } from './lib/local-retrieval';
import { Artifact, ArtifactKind, ChatMessage, Lesson, Resource, TranscriptSegment, ViewMode } from './types';

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
}

function App({ provider, recorderSessionFactory = requestRecorderSession }: AppProps) {
  const [workspace] = useState(() => loadWorkspace({
    activeLessonId: initialLessons[0].id,
    lessons: initialLessons,
    resources: initialResources,
    transcript: initialTranscript,
    chat: initialChat,
    artifacts: [],
  }));
  const [lessons, setLessons] = useState(workspace.lessons);
  const [resources, setResources] = useState(workspace.resources);
  const [activeLessonId, setActiveLessonId] = useState(workspace.activeLessonId);
  const [view, setView] = useState<ViewMode>('course');
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [expandedSubjects, setExpandedSubjects] = useState<Record<string, boolean>>({
    'Machine Learning': true,
    Mathematics: true,
  });
  const [expandedChapter, setExpandedChapter] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllResources, setShowAllResources] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingError, setRecordingError] = useState('');
  const [transcript, setTranscript] = useState(workspace.transcript);
  const [chat, setChat] = useState(workspace.chat);
  const [composerValue, setComposerValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>(workspace.artifacts);
  const [toast, setToast] = useState('');
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseSubject, setNewCourseSubject] = useState('Machine Learning');
  const recorderRef = useRef<RecorderSession | null>(null);
  const localProvider = useMemo(() => provider === undefined ? createLocalLLMProvider() : provider, [provider]);
  const sourceBlobStore = useMemo(() => createSourceBlobStore(), []);

  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0];

  const visibleLessons = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return lessons;
    return lessons.filter((lesson) => `${lesson.subject} ${lesson.chapter} ${lesson.title}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [lessons, searchQuery]);

  const activeResources = useMemo(() => {
    const lessonResources = activeLesson.id === initialLessons[0].id ? resources : resources.slice(0, 2);
    return showAllResources ? lessonResources : lessonResources.slice(0, 3);
  }, [activeLesson.id, resources, showAllResources]);

  useEffect(() => {
    if (!isRecording) return undefined;
    const interval = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setShowNewCourse(true);
      }
      if (event.key === 'Escape') setShowNewCourse(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    saveWorkspace({ activeLessonId, lessons, resources, transcript, chat, artifacts });
  }, [activeLessonId, lessons, resources, transcript, chat, artifacts]);

  useEffect(() => () => {
    void recorderRef.current?.stop();
  }, []);

  const notify = (message: string) => setToast(message);

  const selectLesson = (lessonId: string) => {
    setActiveLessonId(lessonId);
    setView('course');
    setShowAllResources(false);
  };

  const toggleRecording = async () => {
    setRecordingError('');
    if (isRecording) {
      const session = recorderRef.current;
      recorderRef.current = null;
      setIsRecording(false);
      if (!session) {
        notify('Session stopped.');
        return;
      }
      void session.stop().then(({ chunksPersisted, persistenceError }) => {
        if (session.stream && session.durability === 'durable' && chunksPersisted > 0) {
          setResources((current) => [{
            id: session.recordingId,
            name: `${activeLesson.title} audio.webm`,
            meta: `Audio · ${chunksPersisted} chunk${chunksPersisted === 1 ? '' : 's'}`,
            kind: 'audio',
            mimeType: 'audio/webm',
          }, ...current]);
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
      }).catch(() => setRecordingError('The audio session could not be finalized correctly.'));
      return;
    }

    try {
      recorderRef.current = await recorderSessionFactory();
      setIsRecording(true);
      setRecordingSeconds(0);
      notify(recorderRef.current.stream ? 'Microphone active, live transcription ready.' : 'Demo mode active: microphone unavailable.');
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
    setTranscript((segments) => [...segments, nextSegment]);
    notify(`Bookmark added at ${nextSegment.timestamp}.`);
  };

  const toggleTranscriptReview = (segmentId: string) => {
    const segment = transcript.find((item) => item.id === segmentId);
    if (!segment) return;
    const nextStatus: TranscriptSegment['status'] = segment.status === 'review' ? 'verified' : 'review';
    setTranscript((segments) => segments.map((item) => item.id === segmentId ? { ...item, status: nextStatus } : item));
    notify(nextStatus === 'verified' ? 'Transcript segment verified.' : 'Transcript segment marked for review.');
  };

  const submitComposer = async (event: FormEvent) => {
    event.preventDefault();
    const message = composerValue.trim();
    if (!message) return;
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now() + 1}`;
    setChat((messages) => [...messages, { id: userMessageId, role: 'user', content: message }]);
    setComposerValue('');

    setIsSending(true);
    try {
      const retrievalDocuments: RetrievalDocument[] = transcript.map((segment) => ({
        id: segment.id,
        text: segment.text,
        metadata: { timestamp: segment.timestamp, speaker: segment.speaker },
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
      const retrievalHits = searchDocuments(retrievalDocuments, message, 4);
      const retrievedCitations = retrievalHits.slice(0, 2).map((hit) => hit.document.metadata.resourceName
        ? `Source · ${hit.document.metadata.resourceName} · part ${hit.document.metadata.part}`
        : `Transcript · ${hit.document.metadata.timestamp}`);
      if (!localProvider) {
        setChat((messages) => [...messages, {
          id: assistantMessageId,
          role: 'assistant',
          content: 'Connect LM Studio to ask the local model. The current workspace keeps this interaction offline.',
          citations: retrievedCitations.length ? retrievedCitations : ['Active course context · local workspace'],
        }]);
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
      setChat((messages) => [...messages, {
        id: assistantMessageId,
        role: 'assistant',
        content: result.content,
        citations: [
          ...retrievedCitations,
          `LM Studio · ${result.model}`,
        ],
      }]);
    } catch (error) {
      setChat((messages) => [...messages, {
        id: assistantMessageId,
        role: 'assistant',
        content: error instanceof Error ? error.message : 'The local provider could not answer this question.',
      }]);
    } finally {
      setIsSending(false);
    }
  };

  const createArtifact = (kind: ArtifactKind) => {
    const definition = artifactCatalog.find((artifact) => artifact.kind === kind);
    if (!definition) return;
    const artifact: Artifact = {
      id: `${kind}-${Date.now()}`,
      kind,
      label: definition.label,
      createdAt: 'just now',
    };
    setArtifacts((current) => [artifact, ...current].slice(0, 4));
    notify(`${definition.label} added to Studio.`);
  };

  const importSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const resource = await createSourceResource(file);
      await sourceBlobStore.save(resource.id, file);
      setResources((current) => [resource, ...current]);
      notify(`${resource.name} added to course sources${sourceBlobStore.durability === 'durable' ? ' and saved locally.' : ' in memory only.'}`);
    } catch {
      notify('The source could not be fingerprinted or stored locally.');
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
    setActiveLessonId(id);
    setNewCourseTitle('');
    setShowNewCourse(false);
    notify('New course created. Ready to record.');
  };

  return (
    <div className="app-shell">
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
                            <button key={lesson.id} className={`tree-lesson ${activeLesson.id === lesson.id ? 'active' : ''}`} onClick={() => selectLesson(lesson.id)}>
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

              <button className="ghost-row" onClick={() => notify('Global search will be available with the local index.') }><Search size={14} /> Global search <ArrowUpRight size={13} /></button>
              <button className="ghost-row attention-row" onClick={() => notify('3 items need manual review.') }><Lightbulb size={14} /> Needs review <span className="count-pill">3</span></button>
            </div>

            <div className="sidebar-footer">
              <div className="privacy-status"><span className="status-dot" /> Local processing enabled</div>
              <div className="profile-card">
                <div className="profile-avatar">SO</div>
                <div><strong>Shoko-official</strong><span>Student plan</span></div>
                <GraduationCap size={16} />
              </div>
              <div className="footer-links"><button onClick={() => notify('Settings will be available in a future update.') }><Settings2 size={14} /> Settings</button><button aria-label="Help" onClick={() => notify('Need help? Check the project documentation.') }><CircleHelp size={15} /></button></div>
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
              <button className="secondary-action desktop-only" onClick={() => notify('Local share link copied.') }><Copy size={14} /> Share</button>
            </div>
          </div>

          {view === 'course' ? (
            <div className="course-view">
              <section className={`recording-card ${isRecording ? 'recording' : ''}`} aria-label="Course recording">
                <div className="recording-topline">
                  <div className="recording-label"><span className="recording-pulse" /> {isRecording ? 'Recording in progress' : 'Session ready'}</div>
                  <span className="local-badge"><span className="status-dot" /> On this device</span>
                </div>
                <div className="recording-core">
                  <div>
                    <span className="muted-label">Session duration</span>
                    <strong className="recording-time">{isRecording ? formatElapsed(recordingSeconds) : activeLesson.duration}</strong>
                  </div>
                  <div className="signal-rail" aria-hidden="true">{Array.from({ length: 42 }, (_, index) => <span key={index} style={{ height: `${14 + ((index * 17) % 28)}%` }} />)}</div>
                  <div className="recording-actions">
                    <button className={`record-button ${isRecording ? 'stop' : ''}`} onClick={toggleRecording} aria-label={isRecording ? 'Stop recording' : 'Start recording'}>
                      {isRecording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
                    </button>
                    <button className="bookmark-button" onClick={addBookmark} aria-label="Bookmark this passage"><Lightbulb size={16} /> Bookmark</button>
                  </div>
                </div>
                {recordingError && <p className="inline-error">{recordingError}</p>}
                <div className="recording-progress"><span style={{ width: `${activeLesson.progress}%` }} /></div>
                <div className="recording-meta"><span><Clock3 size={13} /> {activeLesson.progress}% complete</span><span><Upload size={13} /> Chunked autosave</span><span><Pause size={13} /> ASR priority</span></div>
              </section>

              <section className="transcript-section">
                <div className="section-toolbar"><div><span className="section-kicker">Live transcript</span><h2>The course, source by source</h2></div><button className="text-action" onClick={() => notify('All segments are already available offline.')}>View all <ArrowUpRight size={13} /></button></div>
                <div className="transcript-list">
                  {transcript.map((segment) => (
                    <article className={`transcript-item ${segment.status === 'review' ? 'needs-review' : ''}`} key={segment.id}>
                      <div className="transcript-time">{segment.timestamp}</div>
                      <div className="transcript-body"><div className="speaker-line"><strong>{segment.speaker}</strong>{segment.status === 'review' ? <span className="review-badge">Needs review</span> : <span className="verified-badge"><Check size={11} /> verified</span>}</div><p>{segment.text}</p></div>
                      <button className="transcript-more" aria-label={segment.status === 'review' ? `Mark segment ${segment.timestamp} verified` : `Mark segment ${segment.timestamp} for review`} onClick={() => toggleTranscriptReview(segment.id)}>•••</button>
                    </article>
                  ))}
                </div>
              </section>

              <form className="composer" onSubmit={submitComposer}>
                <div className="composer-input"><MessageCircle size={16} /><input aria-label="Ask a course question" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Ask a question about this course…" /><kbd>@</kbd></div>
                <div className="composer-tools"><button type="button" aria-label="Attach a file" onClick={() => notify('Add a file from Studio.') }><Plus size={17} /></button><button type="button" aria-label="Attach an image" onClick={() => notify('Add a board photo from Studio.') }><FileImage size={16} /></button><button type="button" aria-label="Voice dictation" onClick={toggleRecording}><Mic size={16} /></button><button className="send-button" type="submit" aria-label="Send question"><Send size={15} /></button></div>
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
            <section className="resources-section"><div className="sidebar-section-header"><span>Course sources</span><label className="mini-action"><input className="visually-hidden" type="file" aria-label="Select course source" accept="audio/*,image/*,.pdf,.txt,.md" onChange={importSource} /><Plus size={13} /> add</label></div><div className="resource-list">{activeResources.map((resource) => <button className="resource-item" key={resource.id} onClick={() => notify(`Source selected: ${resource.name}`)}><span className="resource-icon">{resourceIcon(resource.kind)}</span><span><strong>{resource.name}</strong><small>{resource.meta}</small></span><ChevronRight size={14} /></button>)}</div>{resources.length > 3 && activeLesson.id === initialLessons[0].id && <button className="show-more" onClick={() => setShowAllResources((value) => !value)}>{showAllResources ? 'Show fewer' : `Show ${resources.length - 3} more sources`} <ChevronDown size={13} /></button>}</section>
            <section className="studio-actions"><div className="sidebar-section-header"><span>Create an artifact</span><span className="eyebrow-count">source-linked</span></div><div className="artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className="artifact-button" onClick={() => createArtifact(artifact.kind)}><span className={`artifact-icon ${artifact.kind}`}><ListChecks size={15} /></span><span><strong>{artifact.label}</strong><small>{artifact.description}</small></span></button>)}</div></section>
            {artifacts.length > 0 && <section className="recent-section"><div className="sidebar-section-header"><span>Recently created</span><span className="eyebrow-count">{artifacts.length}</span></div>{artifacts.map((artifact) => <div className="recent-artifact" key={artifact.id}><span className="artifact-icon summary"><Check size={14} /></span><span><strong>{artifact.label}</strong><small>{artifact.createdAt}</small></span></div>)}</section>}
            <button className="studio-link" onClick={() => notify('The full Studio editor will open in a future update.')}>Open full Studio <ArrowUpRight size={14} /></button>
          </aside>
        )}
      </div>

      {showNewCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">New session</span><h2 id="new-course-title">Start a course</h2></div><button className="icon-button" aria-label="Close" onClick={() => setShowNewCourse(false)}><X size={17} /></button></div><p className="modal-description">Create a persistent session now. Add audio, images, and documents as the course progresses.</p><form onSubmit={createCourse}><label>Course title<input autoFocus value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} placeholder="e.g. Introduction to probability" /></label><label>Subject<select value={newCourseSubject} onChange={(event) => setNewCourseSubject(event.target.value)}><option>Machine Learning</option><option>Mathematics</option><option>Electronics</option></select></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowNewCourse(false)}>Cancel</button><button className="primary-submit" type="submit" disabled={!newCourseTitle.trim()}><Mic size={15} /> Create and prepare recording</button></div></form></section></div>}
      {toast && <div className="toast" role="status"><Check size={15} /> {toast}</div>}
    </div>
  );
}

export default App;
