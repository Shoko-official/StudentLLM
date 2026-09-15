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
- versioned local workspace persistence with per-lesson sources, transcript segments, chat history, and artifacts;
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
