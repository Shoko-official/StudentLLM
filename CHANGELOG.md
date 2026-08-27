# Changelog

## Unreleased

### Added

- React and TypeScript learning workspace;
- course navigation, transcript review, recording controls, chat, and Studio artifact actions;
- versioned local workspace persistence for lessons, sources, chat history, and artifacts, plus chunked `MediaRecorder` audio storage;
- local source import with MIME classification, metadata, and SHA-256 fingerprints;
- original imported source blobs stored in IndexedDB when available;
- imported text sources are available to local lexical retrieval with source-name citations;
- imported text is chunked into bounded passages with source-part citations before provider calls;
- injected live-provider coverage verifies source context and provider citations;
- provider failures are rendered as actionable chat messages and covered by UI tests;
- recorder failure contracts cover missing browser APIs, unavailable recorder construction, construction errors, and microphone permission rejection;
- durable recording sessions now appear as course audio resources after successful finalization;
- transcript review controls can now promote a segment to verified or send it back for review;
- Studio artifacts now expose an offline draft preview and can be replaced with source-grounded local-provider content;
- course sources, transcripts, chats, and artifacts are isolated per lesson with legacy workspace migration;
- full public French FLEURS ASR benchmarking is available through a faster-whisper adapter with WER, CER, RTF, and hardware receipts;
- imported course sources can be removed from the active workspace and their IndexedDB blobs are deleted;
- durable recordings can be sent to an optional local faster-whisper service and added back as reviewable transcript segments;
- course deletion clears the active lesson workspace and its local source and recording blobs;
- active courses can be exported and imported as versioned JSON packages with source and audio fidelity;
- unsupported chat questions now return an evidence refusal without calling a provider on empty context;
- optional local PyMuPDF and RapidOCR extraction indexes PDF pages and images as reviewable, page-cited transcript segments;
- browser reload persistence and microphone-unavailable fallback covered by Playwright;
- local lexical retrieval with timestamp-aware context selection for provider chat;
- reproducible full-split BEIR BM25 benchmark adapter with SciFact, NFCorpus, ArguAna, FiQA, and SCIDOCS receipts;
- public DocVQA OCR extractability adapter with explicit partial-split validity and receipts;
- Playwright coverage for PDF source import and browser persistence;
- reproducible public BEIR dense-retrieval adapter using selectable SentenceTransformers models with shared BM25 metrics;
- full SciFact and NFCorpus dense receipts using `BAAI/bge-small-en-v1.5` and shared BM25 comparison;
- full ArguAna dense receipt using `BAAI/bge-small-en-v1.5`, with the shared BM25 comparison;
- 70-item public MMLU-Pro LM Studio receipt covering all 14 categories with explicit partial-sample validity;
- benchmark adapter syntax checks included in the local and GitHub verification gates;
- NVIDIA NIM and LM Studio OpenAI-compatible smoke checks with runtime credentials;
- Vitest, Playwright, axe, TypeScript, Vite, and GitHub Actions verification;
- architecture, provider, benchmark, and contribution documentation.
