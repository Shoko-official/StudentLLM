import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
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
import { Artifact, ArtifactKind, ChatMessage, Lesson, Resource, TranscriptSegment, ViewMode } from './types';

const initialLessons: Lesson[] = [
  {
    id: 'transformers-06',
    subject: 'Machine Learning',
    chapter: 'Transformers',
    title: 'Attention & Scaled Dot-Product',
    teacher: 'Prof. Yann LeCun',
    duration: '01:32:47',
    date: '15 mai 2025',
    progress: 72,
  },
  {
    id: 'transformers-05',
    subject: 'Machine Learning',
    chapter: 'Transformers',
    title: 'Self-attention et contexte',
    teacher: 'Prof. Yann LeCun',
    duration: '01:18:12',
    date: '08 mai 2025',
    progress: 100,
  },
  {
    id: 'linear-algebra-03',
    subject: 'Mathematics',
    chapter: 'Linear Algebra',
    title: 'Matrices et applications linéaires',
    teacher: 'Dr. Camille Roux',
    duration: '00:54:08',
    date: '02 mai 2025',
    progress: 36,
  },
];

const initialResources: Resource[] = [
  { id: 'r1', name: 'transcription.txt', meta: 'Texte · 126 KB', kind: 'transcript' },
  { id: 'r2', name: 'enregistrement_audio.mp3', meta: 'Audio HD · 98,3 MB', kind: 'audio' },
  { id: 'r3', name: 'photo_tableau_02.jpg', meta: 'Tableau · 3,4 MB', kind: 'image' },
  { id: 'r4', name: 'support_slides.pdf', meta: 'Diapos · 5,6 MB', kind: 'document' },
  { id: 'r5', name: 'notes_manuscrites.pdf', meta: 'Notes · 1,8 MB', kind: 'document' },
];

const initialTranscript: TranscriptSegment[] = [
  {
    id: 't1',
    timestamp: '01:13:42',
    speaker: 'Professeur',
    text: 'On peut donc écrire l’attention sous la forme softmax de Q K transposée sur racine de d, multiplié par V.',
    status: 'verified',
  },
  {
    id: 't2',
    timestamp: '01:14:18',
    speaker: 'Professeur',
    text: 'Et le facteur racine de d permet de garder les logits dans une zone où le softmax reste sensible.',
    status: 'verified',
  },
  {
    id: 't3',
    timestamp: '01:15:02',
    speaker: 'Professeur',
    text: 'Sans cette normalisation, les produits scalaires grandissent avec la dimension des clés.',
    status: 'review',
  },
];

const initialChat: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: 'Pourquoi divise-t-on par √dₖ dans le scaled dot-product attention ?',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'On divise par √dₖ pour conserver une variance stable lorsque la dimension des clés augmente. Sans ce facteur, les logits deviennent trop grands, le softmax se sature et les gradients deviennent très faibles.',
    citations: ['Audio du cours · 01:14:18', 'Support · diapositive 31'],
  },
];

const artifactCatalog: { kind: ArtifactKind; label: string; description: string }[] = [
  { kind: 'summary', label: 'Résumé express', description: 'Les idées essentielles en une page.' },
  { kind: 'guide', label: 'Fiche de révision', description: 'Une synthèse structurée et sourcée.' },
  { kind: 'quiz', label: 'QCM ciblé', description: 'Teste les notions qui restent fragiles.' },
  { kind: 'flashcards', label: 'Flashcards', description: 'Prépare un paquet de cartes révisables.' },
  { kind: 'mindmap', label: 'Carte conceptuelle', description: 'Relie les concepts et leurs dépendances.' },
  { kind: 'glossary', label: 'Glossaire', description: 'Définitions des termes du cours.' },
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

function App() {
  const [workspace] = useState(() => loadWorkspace({
    activeLessonId: initialLessons[0].id,
    lessons: initialLessons,
    transcript: initialTranscript,
    artifacts: [],
  }));
  const [lessons, setLessons] = useState(workspace.lessons);
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
  const [chat, setChat] = useState(initialChat);
  const [composerValue, setComposerValue] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[]>(workspace.artifacts);
  const [toast, setToast] = useState('');
  const [showNewCourse, setShowNewCourse] = useState(false);
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseSubject, setNewCourseSubject] = useState('Machine Learning');
  const recorderRef = useRef<RecorderSession | null>(null);

  const activeLesson = lessons.find((lesson) => lesson.id === activeLessonId) ?? lessons[0];

  const visibleLessons = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return lessons;
    return lessons.filter((lesson) => `${lesson.subject} ${lesson.chapter} ${lesson.title}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [lessons, searchQuery]);

  const activeResources = useMemo(() => {
    const resources = activeLesson.id === initialLessons[0].id ? initialResources : initialResources.slice(0, 2);
    return showAllResources ? resources : resources.slice(0, 3);
  }, [activeLesson.id, showAllResources]);

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
    saveWorkspace({ activeLessonId, lessons, transcript, artifacts });
  }, [activeLessonId, lessons, transcript, artifacts]);

  const notify = (message: string) => setToast(message);

  const selectLesson = (lessonId: string) => {
    setActiveLessonId(lessonId);
    setView('course');
    setShowAllResources(false);
  };

  const toggleRecording = async () => {
    setRecordingError('');
    if (isRecording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setIsRecording(false);
      notify('Session enregistrée en segments locaux.');
      return;
    }

    try {
      recorderRef.current = await requestRecorderSession();
      setIsRecording(true);
      setRecordingSeconds(0);
      notify(recorderRef.current.stream ? 'Microphone actif, transcription live prête.' : 'Mode démonstration actif: microphone non disponible.');
    } catch {
      setRecordingError('Le microphone est indisponible. Vérifiez l’autorisation puis réessayez.');
    }
  };

  const addBookmark = () => {
    const nextSegment: TranscriptSegment = {
      id: `bookmark-${Date.now()}`,
      timestamp: formatElapsed(recordingSeconds),
      speaker: 'Marque-page',
      text: 'Point marqué par l’étudiant: à revoir dans le cours.',
      status: 'review',
    };
    setTranscript((segments) => [...segments, nextSegment]);
    notify(`Point marqué à ${nextSegment.timestamp}.`);
  };

  const submitComposer = (event: FormEvent) => {
    event.preventDefault();
    const message = composerValue.trim();
    if (!message) return;
    setChat((messages) => [
      ...messages,
      { id: `user-${Date.now()}`, role: 'user', content: message },
      {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: 'Je vais chercher dans les sources du cours et afficher les passages utilisés pour répondre.',
        citations: ['Contexte du cours · recherche locale'],
      },
    ]);
    setComposerValue('');
  };

  const createArtifact = (kind: ArtifactKind) => {
    const definition = artifactCatalog.find((artifact) => artifact.kind === kind);
    if (!definition) return;
    const artifact: Artifact = {
      id: `${kind}-${Date.now()}`,
      kind,
      label: definition.label,
      createdAt: 'à l’instant',
    };
    setArtifacts((current) => [artifact, ...current].slice(0, 4));
    notify(`${definition.label} ajouté au Studio.`);
  };

  const createCourse = (event: FormEvent) => {
    event.preventDefault();
    const title = newCourseTitle.trim();
    if (!title) return;
    const id = `lesson-${Date.now()}`;
    const lesson: Lesson = {
      id,
      subject: newCourseSubject,
      chapter: 'Nouveaux cours',
      title,
      teacher: 'À renseigner',
      duration: '00:00:00',
      date: 'aujourd’hui',
      progress: 0,
    };
    setLessons((current) => [lesson, ...current]);
    setActiveLessonId(id);
    setNewCourseTitle('');
    setShowNewCourse(false);
    notify('Nouveau cours créé. Prêt à enregistrer.');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-leading">
          <button className="icon-button mobile-menu" aria-label="Ouvrir le menu" onClick={() => setShowLeftSidebar((value) => !value)}>
            <Menu size={17} />
          </button>
          <button className="icon-button desktop-only" aria-label="Afficher ou masquer la navigation" onClick={() => setShowLeftSidebar((value) => !value)}>
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
            <input aria-label="Rechercher dans les cours" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Rechercher dans vos cours" />
            <kbd>⌘ K</kbd>
          </label>
          <button className={`icon-button ${showRightSidebar ? 'selected' : ''}`} aria-label="Afficher ou masquer le Studio" onClick={() => setShowRightSidebar((value) => !value)}>
            {showRightSidebar ? <PanelRight size={17} /> : <Layers3 size={17} />}
          </button>
          <button className="icon-button notification-button" aria-label="Notifications" onClick={() => notify('Aucune nouvelle notification.') }>
            <Activity size={17} />
            <span />
          </button>
          <button className="profile-chip" aria-label="Ouvrir le profil">
            <span>SO</span>
            <strong className="desktop-only">Shoko-official</strong>
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        {showLeftSidebar && (
          <aside className="left-sidebar" aria-label="Navigation des cours">
            <div className="sidebar-scroll">
              <button className="primary-action" onClick={() => setShowNewCourse(true)}>
                <span><Plus size={16} /> Nouveau cours</span>
                <kbd>Ctrl N</kbd>
              </button>

              <div className="sidebar-section-header">
                <span>Bibliothèque</span>
                <span className="eyebrow-count">{lessons.length} cours</span>
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
                          {!subjectLessons.length && <span className="tree-empty">Aucun résultat</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>

              <button className="ghost-row" onClick={() => notify('La recherche globale sera disponible avec l’index local.') }><Search size={14} /> Recherche globale <ArrowUpRight size={13} /></button>
              <button className="ghost-row attention-row" onClick={() => notify('3 éléments attendent une vérification manuelle.') }><Lightbulb size={14} /> À vérifier <span className="count-pill">3</span></button>
            </div>

            <div className="sidebar-footer">
              <div className="privacy-status"><span className="status-dot" /> Traitement local activé</div>
              <div className="profile-card">
                <div className="profile-avatar">SO</div>
                <div><strong>Shoko-official</strong><span>Plan étudiant</span></div>
                <GraduationCap size={16} />
              </div>
              <div className="footer-links"><button onClick={() => notify('Les paramètres seront disponibles dans la prochaine tranche.') }><Settings2 size={14} /> Paramètres</button><button aria-label="Aide" onClick={() => notify('Besoin d’aide ? Consultez la documentation du projet.') }><CircleHelp size={15} /></button></div>
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
              <div className="view-tabs" role="tablist" aria-label="Vue du cours">
                <button role="tab" aria-selected={view === 'course'} className={view === 'course' ? 'active' : ''} onClick={() => setView('course')}><BookOpen size={14} /> Cours</button>
                <button role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}><MessageCircle size={14} /> Chat</button>
              </div>
              <button className="secondary-action desktop-only" onClick={() => notify('Lien de partage local copié.') }><Copy size={14} /> Partager</button>
            </div>
          </div>

          {view === 'course' ? (
            <div className="course-view">
              <section className={`recording-card ${isRecording ? 'recording' : ''}`} aria-label="Enregistrement du cours">
                <div className="recording-topline">
                  <div className="recording-label"><span className="recording-pulse" /> {isRecording ? 'Enregistrement en cours' : 'Session prête'}</div>
                  <span className="local-badge"><span className="status-dot" /> Sur cet appareil</span>
                </div>
                <div className="recording-core">
                  <div>
                    <span className="muted-label">Durée de la session</span>
                    <strong className="recording-time">{isRecording ? formatElapsed(recordingSeconds) : activeLesson.duration}</strong>
                  </div>
                  <div className="signal-rail" aria-hidden="true">{Array.from({ length: 42 }, (_, index) => <span key={index} style={{ height: `${14 + ((index * 17) % 28)}%` }} />)}</div>
                  <div className="recording-actions">
                    <button className={`record-button ${isRecording ? 'stop' : ''}`} onClick={toggleRecording} aria-label={isRecording ? 'Arrêter l’enregistrement' : 'Démarrer l’enregistrement'}>
                      {isRecording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
                    </button>
                    <button className="bookmark-button" onClick={addBookmark} aria-label="Marquer ce passage"><Lightbulb size={16} /> Marquer</button>
                  </div>
                </div>
                {recordingError && <p className="inline-error">{recordingError}</p>}
                <div className="recording-progress"><span style={{ width: `${activeLesson.progress}%` }} /></div>
                <div className="recording-meta"><span><Clock3 size={13} /> {activeLesson.progress}% parcouru</span><span><Upload size={13} /> Autosauvegarde segmentée</span><span><Pause size={13} /> ASR prioritaire</span></div>
              </section>

              <section className="transcript-section">
                <div className="section-toolbar"><div><span className="section-kicker">Live transcript</span><h2>Le cours, au fil de la source</h2></div><button className="text-action" onClick={() => notify('Tous les segments sont déjà disponibles hors ligne.')}>Voir tout <ArrowUpRight size={13} /></button></div>
                <div className="transcript-list">
                  {transcript.map((segment) => (
                    <article className={`transcript-item ${segment.status === 'review' ? 'needs-review' : ''}`} key={segment.id}>
                      <div className="transcript-time">{segment.timestamp}</div>
                      <div className="transcript-body"><div className="speaker-line"><strong>{segment.speaker}</strong>{segment.status === 'review' ? <span className="review-badge">À vérifier</span> : <span className="verified-badge"><Check size={11} /> vérifié</span>}</div><p>{segment.text}</p></div>
                      <button className="transcript-more" aria-label={`Actions pour le segment ${segment.timestamp}`} onClick={() => notify(`Segment ${segment.timestamp} sélectionné.`)}>•••</button>
                    </article>
                  ))}
                </div>
              </section>

              <form className="composer" onSubmit={submitComposer}>
                <div className="composer-input"><MessageCircle size={16} /><input aria-label="Poser une question sur le cours" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Posez une question sur ce cours…" /><kbd>@</kbd></div>
                <div className="composer-tools"><button type="button" aria-label="Joindre un fichier" onClick={() => notify('Ajoutez un fichier depuis le Studio.') }><Plus size={17} /></button><button type="button" aria-label="Joindre une image" onClick={() => notify('Ajoutez une photo du tableau depuis le Studio.') }><FileImage size={16} /></button><button type="button" aria-label="Dictée vocale" onClick={toggleRecording}><Mic size={16} /></button><button className="send-button" type="submit" aria-label="Envoyer la question"><Send size={15} /></button></div>
                <small>Les réponses restent reliées aux sources. Vérifiez les formules importantes avec vos notes.</small>
              </form>
            </div>
          ) : (
            <div className="chat-view">
              <div className="chat-intro"><span className="ai-orb"><Sparkles size={18} /></span><div><span className="section-kicker">Assistant du cours</span><h2>Comprendre, avec preuves à l’appui.</h2><p>Les réponses s’appuient d’abord sur la session active et indiquent les passages consultés.</p></div></div>
              <div className="chat-list">
                {chat.map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === 'assistant' ? <Sparkles size={14} /> : 'SO'}</div><div className="message-content"><span className="message-role">{message.role === 'assistant' ? 'StudentLLM AI' : 'Vous'}</span><p>{message.content}</p>{message.citations && <div className="citation-list">{message.citations.map((citation) => <button key={citation} onClick={() => notify(`Source ouverte: ${citation}`)}><Headphones size={12} /> {citation}</button>)}</div>}</div></article>
                ))}
              </div>
              <form className="chat-composer" onSubmit={submitComposer}><input aria-label="Poser une question au chat" value={composerValue} onChange={(event) => setComposerValue(event.target.value)} placeholder="Demandez une explication, un exemple ou une synthèse…" /><button type="submit" aria-label="Envoyer"><Send size={16} /></button></form>
            </div>
          )}
        </main>

        {showRightSidebar && (
          <aside className="right-sidebar" aria-label="Studio du cours">
            <div className="studio-heading"><div><span className="section-kicker">Studio</span><h2>Fabriquer pour réviser</h2></div><button className="icon-button" aria-label="Fermer le Studio" onClick={() => setShowRightSidebar(false)}><X size={16} /></button></div>
            <section className="context-card"><div className="context-card-top"><span className="context-icon"><BookOpen size={15} /></span><span className="local-badge"><span className="status-dot" /> local</span></div><h3>{activeLesson.title}</h3><dl><div><dt>Sources</dt><dd>{activeResources.length + 2}</dd></div><div><dt>Durée</dt><dd>{activeLesson.duration}</dd></div><div><dt>État</dt><dd className="success-text">Indexé</dd></div></dl></section>
            <section className="resources-section"><div className="sidebar-section-header"><span>Sources du cours</span><button className="mini-action" onClick={() => notify('Sélecteur de fichiers disponible dans le shell desktop.') }><Plus size={13} /> ajouter</button></div><div className="resource-list">{activeResources.map((resource) => <button className="resource-item" key={resource.id} onClick={() => notify(`Source sélectionnée: ${resource.name}`)}><span className="resource-icon">{resourceIcon(resource.kind)}</span><span><strong>{resource.name}</strong><small>{resource.meta}</small></span><ChevronRight size={14} /></button>)}</div>{initialResources.length > 3 && activeLesson.id === initialLessons[0].id && <button className="show-more" onClick={() => setShowAllResources((value) => !value)}>{showAllResources ? 'Afficher moins' : `Afficher les ${initialResources.length - 3} autres sources`} <ChevronDown size={13} /></button>}</section>
            <section className="studio-actions"><div className="sidebar-section-header"><span>Créer un artefact</span><span className="eyebrow-count">sourcé</span></div><div className="artifact-grid">{artifactCatalog.map((artifact) => <button key={artifact.kind} className="artifact-button" onClick={() => createArtifact(artifact.kind)}><span className={`artifact-icon ${artifact.kind}`}><ListChecks size={15} /></span><span><strong>{artifact.label}</strong><small>{artifact.description}</small></span></button>)}</div></section>
            {artifacts.length > 0 && <section className="recent-section"><div className="sidebar-section-header"><span>Récemment créé</span><span className="eyebrow-count">{artifacts.length}</span></div>{artifacts.map((artifact) => <div className="recent-artifact" key={artifact.id}><span className="artifact-icon summary"><Check size={14} /></span><span><strong>{artifact.label}</strong><small>{artifact.createdAt}</small></span></div>)}</section>}
            <button className="studio-link" onClick={() => notify('L’éditeur de Studio sera ouvert dans une prochaine étape.')}>Ouvrir le Studio complet <ArrowUpRight size={14} /></button>
          </aside>
        )}
      </div>

      {showNewCourse && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowNewCourse(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-course-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="section-kicker">Nouvelle session</span><h2 id="new-course-title">Commencer un cours</h2></div><button className="icon-button" aria-label="Fermer" onClick={() => setShowNewCourse(false)}><X size={17} /></button></div><p className="modal-description">Créez la session persistante maintenant. Vous pourrez ajouter l’audio, les images et les documents au fil du cours.</p><form onSubmit={createCourse}><label>Titre du cours<input autoFocus value={newCourseTitle} onChange={(event) => setNewCourseTitle(event.target.value)} placeholder="Ex. Introduction aux probabilités" /></label><label>Matière<select value={newCourseSubject} onChange={(event) => setNewCourseSubject(event.target.value)}><option>Machine Learning</option><option>Mathematics</option><option>Electronics</option></select></label><div className="modal-footer"><button type="button" className="secondary-action" onClick={() => setShowNewCourse(false)}>Annuler</button><button className="primary-submit" type="submit" disabled={!newCourseTitle.trim()}><Mic size={15} /> Créer et préparer l’enregistrement</button></div></form></section></div>}
      {toast && <div className="toast" role="status"><Check size={15} /> {toast}</div>}
    </div>
  );
}

export default App;
