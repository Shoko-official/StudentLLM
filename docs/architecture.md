# StudentLLM architecture

## Core boundary

StudentLLM keeps three kinds of information separate:

```text
Immutable sources
  audio, images, PDF, documents
          |
          v
Traceable derived content
  transcript, OCR, segments, embeddings
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
- versioned local workspace persistence for lessons, sources, transcript segments, chat history, and artifacts;
- local source import with MIME classification and SHA-256 provenance fingerprints;
- original imported source blobs stored in IndexedDB when the browser supports it;
- `verified` and `review` transcript states;
- Studio artifact actions;
- chat with visible context citations;
- optional local LM Studio chat through an OpenAI-compatible provider adapter;
- local lexical retrieval over transcript and bounded imported text passages with source-part citations;
- provider smoke checks kept independent from the UI.

The browser layer deliberately keeps its provider and retrieval adapters separate from the domain model. LM Studio is opt-in through a non-secret Vite endpoint; remote credentials remain outside the browser bundle.

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
        |-- DocumentEngine (PDF, OCR, vision)
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
  transcribeStream(input: AudioChunk): AsyncIterable<TranscriptEvent>;
  transcribeFile(input: AudioAsset): Promise<Transcript>;
  capabilities(): SpeechCapabilities;
}
```

The domain must not hard-code a model. A speech engine may run on CPU, Metal, CUDA, or a remote service depending on hardware and privacy preferences.

### LLMProvider

```ts
interface LLMProvider {
  models(): Promise<Model[]>;
  generate(request: GenerateRequest): AsyncIterable<GenerationEvent>;
}
```

The application owns the agent loop so it can control scope, permissions, citations, logs, and reproducibility.

## Reliability and privacy

- the web application writes `MediaRecorder` chunks to IndexedDB; the memory fallback is explicitly non-durable;
- the desktop target uses append-only audio chunks, SQLite WAL, and checksummed blobs;
- source files carry checksums;
- migrations and job recovery are tested;
- local mode makes no implicit network request;
- credentials stay in the OS credential manager or process environment, never in SQLite or logs;
- sharing excludes audio by default;
- deleting a course propagates to the database, blobs, indexes, and caches.

The target runtime is implemented incrementally behind the contracts above. Claims about runtime quality require evidence from the packaged runtime and the public benchmark suite, not only from the UI.
