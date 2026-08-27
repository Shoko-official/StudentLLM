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
- interrupted durable recordings are recovered from their local manifest on the next launch;
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
- mobile navigation now starts closed on narrow viewports and opens on demand;
- mobile axe and viewport-overflow regression coverage;
- browser local ASR and document adapters now bind their default fetch implementation correctly;
- local lexical retrieval with timestamp-aware context selection for provider chat;
- reproducible full-split BEIR BM25 benchmark adapter with SciFact, NFCorpus, ArguAna, FiQA, and SCIDOCS receipts;
- public DocVQA OCR extractability adapter with explicit partial-split validity and receipts;
- Playwright coverage for PDF source import and browser persistence;
- reproducible public BEIR dense-retrieval adapter using selectable SentenceTransformers models with shared BM25 metrics;
- full SciFact and NFCorpus dense receipts using `BAAI/bge-small-en-v1.5` and shared BM25 comparison;
- full ArguAna dense receipt using `BAAI/bge-small-en-v1.5`, with the shared BM25 comparison;
- full SCIDOCS dense receipt using `BAAI/bge-small-en-v1.5`, with the shared BM25 comparison;
- full FiQA dense receipt using `BAAI/bge-small-en-v1.5`, with the shared BM25 comparison;
- official MTEB task wrapper and public STSBenchmark v2 CPU receipt with a Spearman main score of `0.857289`;
- official MTEB `STS22.v2` multilingual public test receipt covering 18 language and cross-language subsets;
- official BFCL V4 `simple_python` partial evaluation through the existing LM Studio endpoint, with 20/20 official category accuracy;
- official BFCL V4 `parallel_multiple` partial evaluation through the existing LM Studio endpoint, with 17/20 official category accuracy;
- deterministic single-worker local Playwright mode to prevent Windows browser-test contention while keeping CI parallel;
- 70-item public MMLU-Pro LM Studio receipt covering all 14 categories with explicit partial-sample validity;
- 140-item public MMLU-Pro LM Studio receipt covering all 14 categories, plus UTF-8 output handling for Windows benchmark runs;
- benchmark adapter syntax checks included in the local and GitHub verification gates;
- NVIDIA NIM and LM Studio OpenAI-compatible smoke checks with runtime credentials;
- browser OpenAI-compatible provider requests now bind the default fetch context correctly;
- live LM Studio browser chat path verified through a temporary local CORS proxy without restarting the model process;
- live NVIDIA NIM and LM Studio smoke checks reverified on 2026-08-27 without restarting the local model process;
- Vitest, Playwright, axe, TypeScript, Vite, and GitHub Actions verification;
- architecture, provider, benchmark, and contribution documentation.
