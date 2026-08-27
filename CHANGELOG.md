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
- browser reload persistence and microphone-unavailable fallback covered by Playwright;
- local lexical retrieval with timestamp-aware context selection for provider chat;
- reproducible full-split BEIR BM25 benchmark adapter with SciFact, NFCorpus, ArguAna, FiQA, and SCIDOCS receipts;
- benchmark adapter syntax checks included in the local and GitHub verification gates;
- NVIDIA NIM and LM Studio OpenAI-compatible smoke checks with runtime credentials;
- Vitest, Playwright, axe, TypeScript, Vite, and GitHub Actions verification;
- architecture, provider, benchmark, and contribution documentation.
