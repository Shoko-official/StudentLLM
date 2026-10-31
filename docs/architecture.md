# StudentLLM architecture

## Core boundary

StudentLLM keeps three kinds of information separate:

```text
Immutable sources
  audio, images, PDF, text, Markdown, HTML, RTF, DOCX, PPTX
          |
          v
Traceable derived content
  transcript, OCR, structured blocks, segments, embeddings
          |
          v
Versioned generated content
  answers, quizzes, guides, cards, maps
```

Generated content can be regenerated or removed. Original sources remain recoverable and their checksums remain verifiable.

## Current web implementation

The React and TypeScript application defines the product interaction contract:

- navigation by subject and course;
- persistent course creation at the user experience layer;
- optional browser microphone capture;
- chunked `MediaRecorder` capture with an IndexedDB store when available;
- interrupted durable recordings are reattached to their course from a local recovery manifest on the next launch;
- optional local faster-whisper transcription of persisted recordings through `SpeechEngine`;
- optional local PDF, image, text, Markdown, HTML, RTF, DOCX, and PPTX extraction through `DocumentEngine`, with page/section-level transcript provenance;
- versioned local workspace persistence with per-lesson sources, transcript segments, chat history, and artifacts (see [Browser workspace storage](#browser-workspace-storage));
- legacy flat workspace data migrates into the active lesson without exposing it to newly created lessons;
- local source import with MIME classification and SHA-256 provenance fingerprints;
- original imported source blobs stored in IndexedDB when the browser supports it;
- `verified` and `review` transcript states;
- Studio artifact actions;
- chat with visible context citations;
- optional local LM Studio chat through an OpenAI-compatible provider adapter;
- local hybrid retrieval over transcript and bounded imported passages: deterministic lexical ranking is always available, and an OpenAI-compatible local embeddings endpoint is used when the configured LM Studio-compatible server exposes one; citations retain the exact source part;
- deterministic course-note assembly during capture, followed by optional strict source-linked rich-block formatting through the local LLM provider;
- provider smoke checks kept independent from the UI.

The browser layer deliberately keeps its provider and retrieval adapters separate from the domain model. LM Studio is opt-in through a non-secret Vite endpoint; remote credentials remain outside the browser bundle.

Course-note formatting follows the same separation. Transcript segments are the source of truth, `buildCourseNote` provides the immediate offline representation, and `formatCourseNoteWithProvider` can add only validated blocks linked to submitted segment IDs. The provider result is never allowed to replace the transcript or create an unlinked note block.

## Browser workspace storage

The workspace is one JSON document (`version: 1`, the active course in `lessonWorkspaces[activeLessonId]` only; the older shape that also repeated it as top-level `resources`, `transcript`, `chat` and `artifacts` is still read). Where it lives depends on the runtime:

| Runtime | Workspace | Notes |
| --- | --- | --- |
| Desktop (Tauri) | SQLite through `save_workspace` / `load_workspace` | Unchanged. No quota. |
| Browser with IndexedDB | database `studentllm-workspace`, object store `kv`, key `studentllm.workspace.v1` (the JSON string) | Several hundred MB. Opens asynchronously. |
| Browser without a usable IndexedDB | `localStorage` key `studentllm.workspace.v1` | About 5 MB. The earlier behavior, with its alerts. |

`src/lib/browser-workspace-store.ts` opens the browser workspace and returns the snapshot, any load issue and a store with `save`, `onChangedElsewhere` and `readCopy`. `src/lib/workspace-idb.ts` is the IndexedDB layer. `App` renders a loading screen until the workspace has loaded, so nothing is saved before the load finished and there is no flash of an empty workspace. Where there is no IndexedDB (and in the desktop shell) the workspace is read synchronously before the first render, as before.

**Keys in the `kv` store.** `studentllm.workspace.v1` (the snapshot), `studentllm.workspace.v1.meta` (`{ version, writer, at, migrated? }`), and the aside copies `studentllm.workspace.v1.unreadable-backup[.n]` and `studentllm.workspace.v1.legacy-demo-backup[.n]` (same rules as in localStorage: a distinct original is never replaced, an identical one is reused). The small side stores stay in localStorage: the interrupted-recording manifest, the pending-erase ledger, preferences and service addresses.

**Migration from localStorage.** If IndexedDB holds no workspace and localStorage does, and the value parses as a workspace, it is copied to IndexedDB byte for byte with a write that only succeeds when the key is still empty (a slower tab cannot replace newer work), read back and compared, and only then recorded in `meta.migrated` (with a fingerprint of the original) and flagged in localStorage (`studentllm.workspace.v1.idb-active`). A copy that does not verify is removed and the session continues on localStorage. The localStorage value is never written, changed or removed by the migration or by later saves; it stays as a fallback for at least one release, after which a cleanup may remove it only for a profile whose `meta.migrated` is present. Unreadable, newer-format or bootstrap values are not copied: IndexedDB stays empty, and they are handled as before (an aside copy, an alert, saving paused when needed). An interrupted migration is completed or repeated at the next start; running it twice changes nothing. When both stores hold a workspace, IndexedDB wins; a localStorage value that differs from the one that was migrated is kept as an aside copy and reported once.

**Damaged IndexedDB value.** The same rules as localStorage: copy aside first, alert, and pause saving when no copy could be kept or a newer version owns the data. If the value is unreadable but the pre-upgrade localStorage workspace is readable, that one is shown instead and the alert says so.

**Two tabs.** Every save is a compare-and-swap inside one IndexedDB transaction: the snapshot and the `meta.version` counter are written together, and only if the version is the one this tab loaded or last wrote. A stale tab is refused (its change is not stored) and shows the "changed in another tab" alert. A `BroadcastChannel` makes the other tab find out at once instead of at its next save; the version check is what guarantees correctness where the channel is missing. A connection closed by another tab's upgrade or by deleting the database (`versionchange`, `close`) is treated the same way. Saving what was just loaded is a no-op, so merely opening a second tab disturbs nobody. The localStorage fallback keeps the `storage` event.

**Failures.** `indexedDB.open` throwing or failing, or not answering within 10 seconds, falls back to localStorage with a notice, unless IndexedDB held the workspace before (then the stale localStorage copy is shown with saving paused). A write that the browser refuses (`QuotaExceededError`, reported when the transaction commits) is a failed save: the previous version stays stored, the alert and the Export button appear, and the next successful save clears them. Writes are queued; only the newest of the saves waiting behind a running one is written.

**Erasing originals.** An original (file or recording) is erased only when the workspace that stopped listing it is itself stored. While saving is paused or failing, `commitSourceRemoval` and course deletion keep the files and the pending-erase ledger entry; the startup sweep, which checks references and does nothing when the workspace did not load cleanly, finishes the job later. A deleted course is stored first, then its files are erased. Interrupted-recording manifests are kept while the workspace has a load issue, and a manifest whose course is missing is only forgotten when no audio is left to recover.

## Target runtime

```text
React + TypeScript
  |-- Library / Course / Chat / Studio
  v
Tauri 2 + Rust
  |-- chunked audio capture
  |-- SQLite WAL + migrations
  |-- durable job queue
  |-- sidecar workers
        |-- SpeechEngine (whisper.cpp, NeMo, faster-whisper)
        |-- DocumentEngine (PDF text, RapidOCR, Office XML, and structured source blocks)
        |-- LLMProvider (LM Studio, NIM, vLLM)
  v
Knowledge store
  |-- SQLite + FTS5 for source-of-truth records
  |-- rebuildable vector index
  |-- filesystem blobs with checksums
```

## Stable contracts

### SpeechEngine

```ts
interface SpeechEngine {
  transcribe: (audio: Blob) => Promise<{
    segments: TranscriptSegment[];
    model: string;
    language?: string;
  }>;
}
```

The domain does not hard-code a model. The current browser adapter targets a local `faster-whisper` HTTP sidecar; future desktop workers can run on CPU, Metal, or CUDA depending on hardware and privacy preferences.

### LLMProvider

```ts
interface LLMProvider {
  models(): Promise<Model[]>;
  generate(request: GenerateRequest): AsyncIterable<GenerationEvent>;
}
```

The application owns the agent loop so it can control scope, permissions, citations, logs, and reproducibility.

### DocumentEngine

```ts
interface DocumentEngine {
  extract: (document: Blob) => Promise<{
    model: string;
    pages: Array<{
      pageNumber: number;
      text: string;
      blocks: Array<{ x: number; y: number; width: number; height: number; text: string; kind?: string; rows?: string[][] }>;
    }>;
  }>;
}
```

The current browser adapter sends supported source bytes to a local PyMuPDF, RapidOCR, and Office XML sidecar. Extracted pages or logical sections are added as reviewable transcript segments with source and page provenance. Structured tables and document blocks are retained for rendering and retrieval. Formula and diagram interpretation remains conservative: the original source and extracted text remain available whenever a semantic reconstruction is uncertain.

## Reliability and privacy

- the web application writes `MediaRecorder` chunks to IndexedDB; the memory fallback is explicitly non-durable;
- the desktop target uses append-only audio chunks, SQLite WAL, and checksummed blobs;
- source files carry checksums;
- browser recording recovery is covered by Playwright; desktop migrations and job recovery remain target-runtime work;
- local mode makes no implicit network request;
- credentials stay in the OS credential manager or process environment, never in SQLite or logs;
- sharing excludes audio by default;
- deleting a course propagates to the database, blobs, indexes, and caches.

The target runtime is implemented incrementally behind the contracts above. Claims about runtime quality require evidence from the packaged runtime and the public benchmark suite, not only from the UI.
