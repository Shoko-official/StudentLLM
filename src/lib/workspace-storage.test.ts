import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspace, loadWorkspaceAsync, runPackagedIpcSmoke, saveWorkspace, saveWorkspaceAsync, WORKSPACE_MIGRATION_BACKUP_KEY, WORKSPACE_STORAGE_KEY, WorkspaceSnapshot } from './workspace-storage';
import { buildCourseNote } from './course-notes';
import { RECORDING_RECOVERY_STORAGE_KEY, savePendingRecording } from './recording-recovery';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const fallback: WorkspaceSnapshot = {
  activeLessonId: 'fallback',
  lessons: [{
    id: 'fallback',
    subject: 'Mathematics',
    chapter: 'Algebra',
    title: 'Initial course',
    teacher: 'Professor',
    duration: '00:10:00',
    date: 'today',
    progress: 0,
  }],
  resources: [],
  transcript: [],
  chat: [],
  artifacts: [],
};

const emptySnapshot: WorkspaceSnapshot = {
  activeLessonId: '', lessons: [], resources: [], transcript: [], chat: [], artifacts: [],
};

// Captured from the former App.tsx defaults, not imported from the migration.
function legacySnapshot(): WorkspaceSnapshot {
  return {
    activeLessonId: 'transformers-06',
    lessons: [
      {
        id: 'transformers-06', subject: 'Machine Learning', chapter: 'Transformers',
        title: 'Attention & Scaled Dot-Product', teacher: 'Prof. Yann LeCun',
        duration: '01:32:47', date: '15 May 2025', progress: 72,
      },
      {
        id: 'transformers-05', subject: 'Machine Learning', chapter: 'Transformers',
        title: 'Self-attention and Context', teacher: 'Prof. Yann LeCun',
        duration: '01:18:12', date: '08 May 2025', progress: 100,
      },
      {
        id: 'linear-algebra-03', subject: 'Mathematics', chapter: 'Linear Algebra',
        title: 'Matrices and Linear Maps', teacher: 'Dr. Camille Roux',
        duration: '00:54:08', date: '02 May 2025', progress: 36,
      },
    ],
    resources: [
      { id: 'r1', name: 'transcript.txt', meta: 'Text · 126 KB', kind: 'transcript' },
      { id: 'r2', name: 'lecture_audio.mp3', meta: 'HD audio · 98.3 MB', kind: 'audio' },
      { id: 'r3', name: 'board_photo_02.jpg', meta: 'Board · 3.4 MB', kind: 'image' },
      { id: 'r4', name: 'lecture_slides.pdf', meta: 'Slides · 5.6 MB', kind: 'document' },
      { id: 'r5', name: 'handwritten_notes.pdf', meta: 'Notes · 1.8 MB', kind: 'document' },
    ],
    transcript: [
      {
        id: 't1', timestamp: '01:13:42', speaker: 'Professor',
        text: 'We can write attention as the softmax of Q K transposed over the square root of d, multiplied by V.',
        status: 'verified',
      },
      {
        id: 't2', timestamp: '01:14:18', speaker: 'Professor',
        text: 'The square-root factor keeps the logits in a range where softmax remains sensitive.',
        status: 'verified',
      },
      {
        id: 't3', timestamp: '01:15:02', speaker: 'Professor',
        text: 'Without this normalization, dot products grow with the key dimension.',
        status: 'review',
      },
    ],
    chat: [
      { id: 'm1', role: 'user', content: 'Why do we divide by √dₖ in scaled dot-product attention?' },
      {
        id: 'm2', role: 'assistant',
        content: 'We divide by √dₖ to keep variance stable as the key dimension grows. Without this factor, logits become too large, softmax saturates, and gradients become very small.',
        citations: ['Course audio · 01:14:18', 'Slides · page 31'], citationTargets: ['r2', 'r4'],
      },
    ],
    artifacts: [],
  };
}

function workspaceContent(snapshot: WorkspaceSnapshot) {
  return { resources: snapshot.resources, transcript: snapshot.transcript, chat: snapshot.chat, artifacts: snapshot.artifacts };
}

function withGeneratedNotes(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  snapshot.lessonWorkspaces = Object.fromEntries(snapshot.lessons.map((lesson) => {
    const workspace = snapshot.lessonWorkspaces?.[lesson.id]
      ?? workspaceContent(lesson.id === snapshot.activeLessonId ? snapshot : emptySnapshot);
    return [lesson.id, { ...workspace, courseNote: buildCourseNote(lesson, workspace.transcript, () => '2025-06-01T00:00:00.000Z') }];
  }));
  return snapshot;
}

describe('workspace storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    invoke.mockReset();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  });

  it('round-trips a workspace snapshot through local storage', () => {
    const snapshot: WorkspaceSnapshot = {
      ...fallback,
      activeLessonId: 'new-lesson',
      lessons: [{ ...fallback.lessons[0], id: 'new-lesson', title: 'Persistent course' }],
      chat: [{ id: 'message-1', role: 'user', content: 'Question' }],
      artifacts: [{ id: 'artifact-1', kind: 'summary', label: 'Summary', createdAt: 'just now' }],
    };

    expect(saveWorkspace(snapshot)).toBe(true);
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });

  describe.each(['browser', 'native'] as const)('%s load migration', (runtime) => {
    let nativeRaw: string | null;

    beforeEach(() => {
      nativeRaw = null;
      if (runtime === 'native') {
        (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
        invoke.mockImplementation(async (command: string, args?: { snapshot: string }) => {
          if (command === 'load_workspace') return nativeRaw;
          if (command === 'save_workspace') nativeRaw = args!.snapshot;
          return undefined;
        });
      }
    });

    const storeRaw = (raw: string) => {
      if (runtime === 'native') nativeRaw = raw;
      else localStorage.setItem(WORKSPACE_STORAGE_KEY, raw);
    };
    const storedRaw = () => runtime === 'native' ? nativeRaw : localStorage.getItem(WORKSPACE_STORAGE_KEY);
    const load = () => runtime === 'native' ? loadWorkspaceAsync(fallback) : Promise.resolve(loadWorkspace(fallback));

    it.each([false, true])('reloads an explicitly empty workspace (per-lesson map: %s)', async (withMap) => {
      const snapshot = { ...emptySnapshot, ...(withMap ? { lessonWorkspaces: {} } : {}) };
      expect(await saveWorkspaceAsync(snapshot)).toBe(true);
      expect(await load()).toEqual(snapshot);
      expect(await load()).toEqual(snapshot);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBeNull();
      if (runtime === 'native') expect(invoke.mock.calls.filter(([command]) => command === 'save_workspace')).toHaveLength(1);
    });

    it('does not inject fallback content into a persisted empty workspace', async () => {
      storeRaw(JSON.stringify({ version: 1, activeLessonId: 'transformers-06', lessons: [] }));
      const loaded = runtime === 'native' ? await loadWorkspaceAsync(legacySnapshot()) : loadWorkspace(legacySnapshot());
      expect(loaded).toEqual(emptySnapshot);
    });

    it('still falls back for a nonempty array containing no valid lessons', async () => {
      storeRaw(JSON.stringify({ version: 1, lessons: [{ id: 'broken' }] }));
      expect(await load()).toEqual(fallback);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBeNull();
    });

    it.each([false, true])('backs up and removes every exact bundled record (per-lesson map: %s)', async (withMap) => {
      const snapshot = legacySnapshot();
      if (withMap) snapshot.lessonWorkspaces = Object.fromEntries(snapshot.lessons.map((lesson) => [lesson.id, workspaceContent(snapshot)]));
      // Formatting and unrecognized top-level data must survive in the raw backup.
      const raw = JSON.stringify({ version: 1, ...snapshot, futureMetadata: { value: 'recover me' } }, null, 2);
      storeRaw(raw);
      const expected = { ...emptySnapshot, ...(withMap ? { lessonWorkspaces: {} } : {}) };

      expect(await load()).toEqual(expected);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
      expect(JSON.parse(storedRaw()!)).toEqual({ version: 1, ...expected });
      expect(await load()).toEqual(expected);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBeNull();
    });

    it('matches content independently of JSON object property order', async () => {
      const snapshot = legacySnapshot();
      const raw = JSON.stringify({ version: 1, ...snapshot }, (_key, value: unknown) => {
        return value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse()) : value;
      });
      storeRaw(raw);
      expect(await load()).toEqual(emptySnapshot);
    });

    it.each(['resources', 'transcript', 'chat', 'artifacts'] as const)('keeps a demo lesson with user %s while stripping exact demo records', async (field) => {
      const snapshot = legacySnapshot();
      const realContent = {
        resources: [{ id: 'recording-123', name: 'My recording.webm', meta: 'Recorded today', kind: 'audio' as const, mimeType: 'audio/webm', sizeBytes: 1234 }],
        transcript: [{ ...snapshot.transcript[0], text: 'My corrected transcript.' }],
        chat: [{ ...snapshot.chat[0], content: 'My own question.' }],
        artifacts: [{ id: 'summary-1', kind: 'summary' as const, label: 'My summary', createdAt: 'today', content: 'User work', citations: ['t1'] }],
      };
      const expectedContent = { ...workspaceContent(emptySnapshot), [field]: realContent[field] };
      const mixedContent = { ...workspaceContent(snapshot), [field]: [...snapshot[field], ...realContent[field]] };
      Object.assign(snapshot, mixedContent);
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.activeLessonId).toBe(snapshot.activeLessonId);
      expect(workspaceContent(loaded)).toEqual(expectedContent);
    });

    it('preserves source metadata and changed status/citations on colliding record IDs', async () => {
      const snapshot = legacySnapshot();
      const preserved = {
        resources: [
          { ...snapshot.resources[0], sha256: 'real-file-hash', sizeBytes: 128, lastModified: 42 },
          { ...snapshot.resources[1], mimeType: 'audio/mpeg' },
          { ...snapshot.resources[2], name: 'My board photo.jpg' },
        ],
        transcript: [
          { ...snapshot.transcript[0], sourceId: 'recording-123' },
          { ...snapshot.transcript[1], status: 'review' as const },
          { ...snapshot.transcript[2], provisional: false },
        ],
        chat: [
          { ...snapshot.chat[0], citations: ['My source'] },
          { ...snapshot.chat[1], citationTargets: ['my-import'] },
        ],
        artifacts: [],
      };
      Object.assign(snapshot, {
        resources: [...snapshot.resources, ...preserved.resources],
        transcript: [...snapshot.transcript, ...preserved.transcript],
        chat: [...snapshot.chat, ...preserved.chat],
      });
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(workspaceContent(loaded)).toEqual(preserved);
    });

    it('preserves custom work from both active copies and every inactive lesson', async () => {
      const snapshot = legacySnapshot();
      const originalContent = workspaceContent(snapshot);
      const topChat = { id: 'custom-question', role: 'user' as const, content: 'Top-level question' };
      const mappedChat = { ...topChat, content: 'Different per-lesson question' };
      const imported = { id: 'import-1', name: 'Real notes.pdf', meta: 'PDF', kind: 'document' as const, sha256: 'abc' };
      const transcript = { id: 'speech-1', timestamp: '00:01', speaker: 'Me', text: 'Real speech', sourceId: 'recording-1' };
      const artifact = { id: 'artifact-1', kind: 'quiz' as const, label: 'My quiz', content: 'Question', createdAt: 'today' };
      snapshot.chat = [...snapshot.chat, topChat];
      snapshot.lessonWorkspaces = {
        'transformers-06': { ...originalContent, chat: [...originalContent.chat, mappedChat] },
        'transformers-05': { ...originalContent, resources: [...originalContent.resources, imported] },
        'linear-algebra-03': { ...originalContent, transcript: [...originalContent.transcript, transcript], artifacts: [artifact] },
      };
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual(snapshot.lessons);
      expect(loaded.chat).toEqual([mappedChat, topChat]);
      expect(loaded.lessonWorkspaces).toEqual({
        'transformers-06': { ...workspaceContent(emptySnapshot), chat: [mappedChat, topChat] },
        'transformers-05': { ...workspaceContent(emptySnapshot), resources: [imported] },
        'linear-algebra-03': { ...workspaceContent(emptySnapshot), transcript: [transcript], artifacts: [artifact] },
      });
      expect(await load()).toEqual(loaded);
    });

    it('retains top-level work when the active lesson is missing from the per-lesson map', async () => {
      const snapshot = legacySnapshot();
      snapshot.chat = [{ id: 'my-question', role: 'user', content: 'Keep me' }];
      snapshot.lessonWorkspaces = { 'transformers-05': workspaceContent(emptySnapshot) };
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId]).toEqual({ ...workspaceContent(emptySnapshot), chat: snapshot.chat });
    });

    it('selects a surviving real lesson and exposes its content after dropping the active demo', async () => {
      const snapshot = legacySnapshot();
      const lesson = { ...fallback.lessons[0], id: 'real-course' };
      const real = { ...workspaceContent(emptySnapshot), resources: [{ id: 'recording-1', kind: 'audio' as const, name: 'Lecture.webm', meta: 'Audio' }] };
      snapshot.lessons.push(lesson);
      snapshot.lessonWorkspaces = { [lesson.id]: real };
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      expect(await load()).toEqual({ activeLessonId: lesson.id, lessons: [lesson], ...real, lessonWorkspaces: { [lesson.id]: real } });
    });

    it.each(['title', 'subject', 'chapter', 'teacher', 'date', 'duration', 'progress'] as const)('leaves a reused lesson ID with changed %s untouched', async (field) => {
      const snapshot = legacySnapshot();
      snapshot.lessons = [{ ...snapshot.lessons[0], [field]: field === 'progress' ? 73 : 'My custom value' }];
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);
      expect(await load()).toEqual(snapshot);
      expect(storedRaw()).toBe(raw);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBeNull();
    });

    it('does not remove demo-looking records from an unrelated lesson', async () => {
      const snapshot = legacySnapshot();
      snapshot.lessons = [{ ...snapshot.lessons[0], id: 'my-imported-course' }];
      snapshot.activeLessonId = snapshot.lessons[0].id;
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));
      expect(await load()).toEqual(snapshot);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBeNull();
    });

    it('keeps course notes and their owning lesson', async () => {
      const snapshot = legacySnapshot();
      const note = {
        id: 'my-note', title: 'Notes', subject: 'Math', chapter: 'Algebra', folderPath: ['Math'],
        fileName: 'notes.md', updatedAt: 'today',
        detection: { method: 'active course' as const, confidence: 1, basis: 'User course' },
        blocks: [{ id: 'paragraph-1', type: 'paragraph' as const, text: 'My notes' }],
      };
      snapshot.lessonWorkspaces = { [snapshot.activeLessonId]: { ...workspaceContent(snapshot), courseNote: note } };
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));
      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId]).toEqual({ ...workspaceContent(emptySnapshot), courseNote: note });
    });

    it.each([false, true])('drops exact generated demo notes, including empty notes (previous cleanup: %s)', async (alreadyCleaned) => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      if (alreadyCleaned) {
        Object.assign(snapshot, workspaceContent(emptySnapshot));
        for (const workspace of Object.values(snapshot.lessonWorkspaces!)) Object.assign(workspace, workspaceContent(emptySnapshot));
      }
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);

      expect(await load()).toEqual({ ...emptySnapshot, lessonWorkspaces: {} });
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
    });

    it.each(['title', 'routing', 'detection', 'paragraph', 'formula', 'extra field'] as const)('preserves an otherwise generated note with an edited %s', async (edit) => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      const note = snapshot.lessonWorkspaces![snapshot.activeLessonId].courseNote!;
      note.updatedAt = '2030-01-01T00:00:00.000Z';
      if (edit === 'title') note.title = 'My edited title';
      if (edit === 'routing') note.folderPath.push('My folder');
      if (edit === 'detection') note.detection.basis += ' My correction.';
      if (edit === 'paragraph') {
        const block = note.blocks.find((item) => item.id === 'paragraph-t1');
        if (block?.type !== 'paragraph') throw new Error('Missing generated paragraph');
        block.text += ' My correction.';
      }
      if (edit === 'formula') {
        const block = note.blocks.find((item) => item.type === 'formula');
        if (block?.type !== 'formula') throw new Error('Missing generated formula');
        block.latex = '$$x = 1$$';
      }
      if (edit === 'extra field') Object.assign(note, { userAnnotation: 'My annotation' });
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId]).toEqual({ ...workspaceContent(emptySnapshot), courseNote: note });
      expect(await load()).toEqual(loaded);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBeNull();
    });

    it.each([false, true])('rebuilds exact generated mixed notes from real transcript only (previous cleanup: %s)', async (alreadyCleaned) => {
      const snapshot = legacySnapshot();
      const realTranscript = [{ id: 't1', timestamp: '00:01', speaker: 'Me', text: 'My actual lecture notes.', sourceId: 'recording-1' }];
      snapshot.transcript = [...snapshot.transcript, ...realTranscript];
      withGeneratedNotes(snapshot);
      const note = snapshot.lessonWorkspaces![snapshot.activeLessonId].courseNote!;
      if (alreadyCleaned) {
        const cleanedContent = { ...workspaceContent(emptySnapshot), transcript: realTranscript };
        Object.assign(snapshot, cleanedContent);
        Object.assign(snapshot.lessonWorkspaces![snapshot.activeLessonId], cleanedContent);
      }
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.transcript).toEqual(realTranscript);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId]).toEqual({
        ...workspaceContent(emptySnapshot), transcript: realTranscript,
        courseNote: buildCourseNote(snapshot.lessons[0], realTranscript, () => note.updatedAt),
      });
      expect(await load()).toEqual(loaded);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBeNull();
    });

    it('leaves generated notes intact if the migration backup fails', async () => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });

      expect(await load()).toEqual(snapshot);
      expect(storedRaw()).toBe(raw);
      expect(invoke.mock.calls.some(([command]) => command === 'save_workspace')).toBe(false);
    });

    it('rebuilds a generated note after merging real transcript from the active top-level copy', async () => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      const realTranscript = [{ id: 'my-speech', timestamp: '00:01', speaker: 'Me', text: 'Keep this top-level transcript.' }];
      snapshot.transcript = [...snapshot.transcript, ...realTranscript];
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.transcript).toEqual(realTranscript);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId].courseNote).toEqual(
        buildCourseNote(snapshot.lessons[0], realTranscript, () => snapshot.lessonWorkspaces![snapshot.activeLessonId].courseNote!.updatedAt),
      );
      expect(await load()).toEqual(loaded);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBeNull();
    });

    it.each([0, 1, 2])('preserves demo lesson %s with pending recording chunks but no resource', async (lessonIndex) => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      const lesson = snapshot.lessons[lessonIndex];
      expect(savePendingRecording({ recordingId: 'pending-1', lessonId: lesson.id, lessonTitle: lesson.title, startedAt: 100 })).toBe(true);
      const manifest = localStorage.getItem(RECORDING_RECOVERY_STORAGE_KEY);
      storeRaw(JSON.stringify({ version: 1, ...snapshot }));

      const loaded = await load();
      expect(loaded.lessons).toEqual([lesson]);
      expect(loaded.activeLessonId).toBe(lesson.id);
      expect(workspaceContent(loaded)).toEqual(workspaceContent(emptySnapshot));
      expect(loaded.lessonWorkspaces?.[lesson.id]).toEqual({
        ...workspaceContent(emptySnapshot), courseNote: buildCourseNote(lesson, [], () => '2025-06-01T00:00:00.000Z'),
      });
      expect(localStorage.getItem(RECORDING_RECOVERY_STORAGE_KEY)).toBe(manifest);
    });

    it.each(['pending recording', 'resource', 'transcript'] as const)('does not remigrate a retained %s lesson when App refreshes generated note timestamps', async (retainedBy) => {
      const snapshot = legacySnapshot();
      if (retainedBy === 'pending recording') {
        savePendingRecording({ recordingId: 'pending-1', lessonId: snapshot.activeLessonId, lessonTitle: snapshot.lessons[0].title, startedAt: 100 });
      }
      if (retainedBy === 'resource') snapshot.resources.push({ id: 'recording-1', name: 'My recording.webm', meta: 'Audio', kind: 'audio' });
      if (retainedBy === 'transcript') snapshot.transcript.push({ id: 'my-speech', timestamp: '00:01', speaker: 'Me', text: 'My real transcript.' });
      withGeneratedNotes(snapshot);
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);
      const writes = vi.spyOn(Storage.prototype, 'setItem');
      let loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);

      for (let render = 0; render < 3; render += 1) {
        const workspace = loaded.lessonWorkspaces![loaded.activeLessonId];
        workspace.courseNote = buildCourseNote(loaded.lessons[0], workspace.transcript, () => `2030-01-0${render + 1}T00:00:00.000Z`);
        expect(await saveWorkspaceAsync(loaded)).toBe(true);
        const saved = storedRaw();
        loaded = await load();
        expect(storedRaw()).toBe(saved);
        expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      }

      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
      expect(writes.mock.calls.filter(([key]) => key.startsWith(WORKSPACE_MIGRATION_BACKUP_KEY))).toHaveLength(1);
    });

    it.each(['unreadable', 'invalid JSON', 'invalid entries'] as const)('skips cleanup when recording recovery state is %s', async (failure) => {
      const snapshot = withGeneratedNotes(legacySnapshot());
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);
      if (failure === 'invalid JSON') localStorage.setItem(RECORDING_RECOVERY_STORAGE_KEY, '{bad json');
      if (failure === 'invalid entries') localStorage.setItem(RECORDING_RECOVERY_STORAGE_KEY, JSON.stringify({ recordings: [{}] }));
      if (failure === 'unreadable') {
        const originalGet = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
          if (key === RECORDING_RECOVERY_STORAGE_KEY) throw new Error('recovery storage unavailable');
          return originalGet.call(this, key);
        });
      }

      expect(await load()).toEqual(snapshot);
      expect(storedRaw()).toBe(raw);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBeNull();
    });

    it('keeps a lesson containing unrecognized per-lesson fields', async () => {
      const snapshot = legacySnapshot();
      storeRaw(JSON.stringify({ version: 1, ...snapshot, lessonWorkspaces: {
        [snapshot.activeLessonId]: { ...workspaceContent(snapshot), userAnnotations: ['My annotation'] },
      } }));
      const loaded = await load();
      expect(loaded.lessons).toEqual([snapshot.lessons[0]]);
      expect(loaded.lessonWorkspaces?.[snapshot.activeLessonId]).toEqual({ ...workspaceContent(emptySnapshot), userAnnotations: ['My annotation'] });
    });

    it.each(['throws', 'silently fails', 'cannot verify'] as const)('does not clean or save when the backup %s', async (failure) => {
      const snapshot = legacySnapshot();
      const raw = JSON.stringify({ version: 1, ...snapshot });
      storeRaw(raw);
      const originalSet = Storage.prototype.setItem;
      const originalGet = Storage.prototype.getItem;
      const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key.startsWith(WORKSPACE_MIGRATION_BACKUP_KEY)) {
          if (failure === 'throws') throw new DOMException('full', 'QuotaExceededError');
          if (failure === 'silently fails') return;
        }
        originalSet.call(this, key, value);
      });
      if (failure === 'cannot verify') {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
          if (key.startsWith(WORKSPACE_MIGRATION_BACKUP_KEY) && originalGet.call(this, key) !== null) throw new Error('read blocked');
          return originalGet.call(this, key);
        });
      }

      expect(await load()).toEqual(snapshot);
      expect(storedRaw()).toBe(raw);
      expect(writes.mock.calls.some(([key]) => key === WORKSPACE_STORAGE_KEY)).toBe(false);
      expect(invoke.mock.calls.some(([command]) => command === 'save_workspace')).toBe(false);
    });

    it('verifies the backup before persisting cleanup', async () => {
      const raw = JSON.stringify({ version: 1, ...legacySnapshot() });
      storeRaw(raw);
      const originalSet = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === WORKSPACE_STORAGE_KEY) expect(this.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
        originalSet.call(this, key, value);
      });
      if (runtime === 'native') {
        invoke.mockImplementation(async (command: string, args?: { snapshot: string }) => {
          if (command === 'load_workspace') return nativeRaw;
          expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
          nativeRaw = args!.snapshot;
        });
      }
      expect(await load()).toEqual(emptySnapshot);
    });

    it('never overwrites an earlier distinct backup and reuses matching backups', async () => {
      const previous = JSON.stringify({ version: 1, ...legacySnapshot(), previous: true });
      localStorage.setItem(WORKSPACE_MIGRATION_BACKUP_KEY, previous);
      const raw = JSON.stringify({ version: 1, ...legacySnapshot() });
      storeRaw(raw);
      expect(await load()).toEqual(emptySnapshot);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(previous);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBe(raw);

      storeRaw(raw);
      expect(await load()).toEqual(emptySnapshot);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.1`)).toBe(raw);
      expect(localStorage.getItem(`${WORKSPACE_MIGRATION_BACKUP_KEY}.2`)).toBeNull();
    });

    it('keeps a recoverable backup if persisting the cleaned snapshot fails', async () => {
      const raw = JSON.stringify({ version: 1, ...legacySnapshot() });
      storeRaw(raw);
      if (runtime === 'native') {
        invoke.mockImplementation(async (command: string) => {
          if (command === 'load_workspace') return nativeRaw;
          throw new Error('disk full');
        });
      } else {
        const originalSet = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
          if (key === WORKSPACE_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError');
          originalSet.call(this, key, value);
        });
      }
      expect(await load()).toEqual(emptySnapshot);
      expect(storedRaw()).toBe(raw);
      expect(localStorage.getItem(WORKSPACE_MIGRATION_BACKUP_KEY)).toBe(raw);
    });
  });

  it('keeps a native demo snapshot intact if local storage is unavailable for backup', async () => {
    const snapshot = legacySnapshot();
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    invoke.mockResolvedValueOnce(JSON.stringify({ version: 1, ...snapshot }));
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });

    expect(await loadWorkspaceAsync(fallback)).toEqual(snapshot);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('falls back safely when stored data is malformed', () => {
    localStorage.setItem('studentllm.workspace.v1', '{not-json');

    expect(loadWorkspace(fallback)).toEqual(fallback);
  });

  it('falls back safely when the WebView blocks local storage access', () => {
    const localStorageGetter = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('local storage is unavailable', 'SecurityError');
    });

    expect(loadWorkspace(fallback)).toEqual(fallback);

    localStorageGetter.mockRestore();
  });

  it('drops invalid child records instead of restoring corrupt state', () => {
    localStorage.setItem('studentllm.workspace.v1', JSON.stringify({
      version: 1,
      activeLessonId: 'valid',
      lessons: [{ ...fallback.lessons[0], id: 'valid' }, { id: 42 }],
      transcript: [{ id: 'ok', timestamp: '00:01', speaker: 'Professor', text: 'Text' }, { id: 7 }],
      chat: [{ id: 'ok', role: 'assistant', content: 'Answer', citations: ['Source'] }, { id: 8 }],
      artifacts: [{ id: 'ok', kind: 'summary', label: 'Summary', createdAt: 'now' }, { id: 'bad', kind: 'unknown' }],
    }));

    const loaded = loadWorkspace(fallback);
    expect(loaded.lessons).toHaveLength(1);
    expect(loaded.transcript).toHaveLength(1);
    expect(loaded.chat).toHaveLength(1);
    expect(loaded.artifacts).toHaveLength(1);
  });

  it('round-trips isolated lesson workspaces', () => {
    const snapshot: WorkspaceSnapshot = {
      ...fallback,
      activeLessonId: 'lesson-one',
      lessons: [
        { ...fallback.lessons[0], id: 'lesson-one', title: 'Course one' },
        { ...fallback.lessons[0], id: 'lesson-two', title: 'Course two' },
      ],
      lessonWorkspaces: {
        'lesson-one': { resources: [], transcript: [{ id: 'one', timestamp: '00:01', speaker: 'Professor', text: 'First course' }], chat: [], artifacts: [] },
        'lesson-two': { resources: [], transcript: [{ id: 'two', timestamp: '00:02', speaker: 'Professor', text: 'Second course' }], chat: [], artifacts: [] },
      },
    };

    expect(saveWorkspace(snapshot)).toBe(true);
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });

  it('round-trips through the native invoke bridge when Tauri is available', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const snapshot = { ...fallback, activeLessonId: 'native-lesson' };
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    expect(await loadWorkspaceAsync(fallback)).toEqual(fallback);
    expect(await saveWorkspaceAsync(snapshot)).toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_workspace');
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_workspace', { snapshot: JSON.stringify({ version: 1, ...fallback }) });
    expect(invoke).toHaveBeenNthCalledWith(3, 'save_workspace', { snapshot: JSON.stringify({ version: 1, ...snapshot }) });
  });

  it('uses the global Tauri core bridge when the packaged runtime exposes it', async () => {
    const globalInvoke = vi.fn().mockResolvedValue(JSON.stringify({ version: 1, ...fallback }));
    (window as Window & { __TAURI__?: unknown }).__TAURI__ = { core: { invoke: globalInvoke } };

    expect(await loadWorkspaceAsync(fallback)).toEqual(fallback);
    expect(globalInvoke).toHaveBeenCalledWith('load_workspace');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes the packaged frontend IPC smoke command through the native bridge', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    invoke.mockResolvedValue('ok');

    await expect(runPackagedIpcSmoke()).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledWith('smoke_frontend_ipc');
  });

  it('replaces an invalid native bootstrap snapshot with the application fallback', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    invoke.mockResolvedValueOnce(JSON.stringify({ version: 1, bootstrap: true })).mockResolvedValueOnce(undefined);

    expect(await loadWorkspaceAsync(fallback)).toEqual(fallback);
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_workspace', { snapshot: JSON.stringify({ version: 1, ...fallback }) });
  });

  it('validates a native snapshot before restoring it', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const snapshot = { ...fallback, activeLessonId: 'native-lesson', lessons: [{ ...fallback.lessons[0], id: 'native-lesson' }] };
    invoke.mockResolvedValue(JSON.stringify({ version: 1, ...snapshot }));

    expect(await loadWorkspaceAsync(fallback)).toEqual(snapshot);
  });

  it('reports native load failures before using the local fallback', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const onError = vi.fn();
    invoke.mockRejectedValueOnce(new Error('database is locked'));
    saveWorkspace(fallback);

    expect(await loadWorkspaceAsync({ ...fallback, lessons: [] }, undefined, { onError })).toEqual(fallback);
    expect(onError).toHaveBeenCalledWith({ operation: 'load', message: 'database is locked' });
  });

  it('reports native save failures while preserving the local fallback', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const onError = vi.fn();
    const snapshot = {
      ...fallback,
      activeLessonId: 'native-lesson',
      lessons: [{ ...fallback.lessons[0], id: 'native-lesson' }],
    };
    invoke.mockRejectedValueOnce(new Error('disk full'));

    expect(await saveWorkspaceAsync(snapshot, undefined, { onError })).toBe(true);
    expect(onError).toHaveBeenCalledWith({ operation: 'save', message: 'disk full' });
    expect(loadWorkspace(fallback)).toEqual(snapshot);
  });

  it('serializes overlapping native saves so the newest snapshot is written last', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const pending: Array<{ snapshot: string; resolve: () => void }> = [];
    invoke.mockImplementation((_command: string, args: { snapshot: string }) => new Promise<void>((resolve) => {
      pending.push({ snapshot: args.snapshot, resolve });
    }));
    const first = { ...fallback, activeLessonId: 'first' };
    const second = { ...fallback, activeLessonId: 'second' };

    const firstSave = saveWorkspaceAsync(first);
    const secondSave = saveWorkspaceAsync(second);
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(pending[0]?.snapshot).toBe(JSON.stringify({ version: 1, ...first }));

    pending[0]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(pending[1]?.snapshot).toBe(JSON.stringify({ version: 1, ...second }));

    pending[1]!.resolve();
    await expect(firstSave).resolves.toBe(true);
    await expect(secondSave).resolves.toBe(true);
  });
});
