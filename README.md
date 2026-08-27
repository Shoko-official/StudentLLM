# StudentLLM

StudentLLM is a local-first learning studio that turns lectures into searchable, source-linked study material. It connects a course session, its transcript, original sources, and review artifacts without replacing the source material.

[![CI](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml/badge.svg)](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml)

## Product direction

StudentLLM is built around three principles:

- Original audio, documents, and images remain recoverable and traceable.
- Generated answers and study artifacts link back to a source, page, or timestamp.
- Local processing is the default; remote providers are explicit integrations.

## Included today

- Responsive three-panel workspace: Library, Course or Chat, and Studio.
- Course creation, navigation, search, bookmarks, transcript review states, and artifact creation.
- Browser microphone access with a demonstration fallback.
- Versioned local workspace persistence with course-isolated sources, transcript segments, chat history, and artifacts.
- Chunked `MediaRecorder` capture with IndexedDB persistence when supported by the browser.
- Optional local faster-whisper sidecar transcription after durable recording, with timestamped review segments.
- Local source import with MIME classification, file metadata, and SHA-256 fingerprints.
- Original imported source blobs are stored in IndexedDB when available, alongside their fingerprints.
- Course deletion clears the lesson workspace and its locally stored source and recording blobs before switching sessions.
- Active courses can be exported and imported as versioned JSON packages with source and audio assets.
- OpenAI-compatible smoke checks for NVIDIA NIM and LM Studio.
- Full public French FLEURS ASR baseline with WER, CER, RTF, and reproducibility receipt.
- Optional live LM Studio chat through a browser-safe OpenAI-compatible provider adapter; no remote API key is bundled in the client.
- Local lexical retrieval selects transcript or bounded imported text passages and preserves source-part citations before a live provider request.
- Vitest unit and integration coverage, Playwright browser coverage, axe accessibility checks, and GitHub Actions CI.

## Quick start

Requirements: Node.js 22.13+ and npm 10+.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. To inspect the production build:

```bash
npm run build
npm run preview
```

## Verification

```bash
npm run verify
```

`verify` runs the TypeScript project check, Python benchmark adapter checks, Vitest, the Vite production build, and Playwright Chromium tests. Provider checks are run separately because they depend on a local server or a remote API:

```bash
npm run providers:smoke
```

## Provider configuration

Provider credentials are read at runtime and are never loaded from a repository file.

- NVIDIA NIM reads `NVIDIA_API_KEY` from the Windows User environment or the current process.
- NVIDIA defaults to `https://integrate.api.nvidia.com/v1` and `openai/gpt-oss-20b`.
- LM Studio defaults to `http://127.0.0.1:1234/v1` and `qwen/qwen3-4b`.
- Set `VITE_LM_STUDIO_BASE_URL` before `npm run dev` to enable live chat against the local server; the browser integration never accepts an NVIDIA credential.
- Optional endpoint and model overrides are listed in [.env.example](./.env.example); it contains no secret values.

See [docs/providers.md](./docs/providers.md) for provider-specific commands.

## Repository layout

```text
src/
  App.tsx                    workspace UI and interactions
  styles.css                 responsive visual system
  types.ts                   frontend data contracts
  lib/recorder.ts            microphone and MediaRecorder capture
  lib/recording-storage.ts   IndexedDB audio chunk storage
  lib/speech-engine.ts       local faster-whisper HTTP adapter
  lib/source-ingest.ts        local source classification and fingerprinting
  lib/source-storage.ts       IndexedDB source blob storage
  lib/source-chunking.ts      bounded text passages for retrieval
  lib/workspace-storage.ts   versioned workspace persistence
  *.test.tsx                 UI and storage tests
scripts/
  provider-smoke.mjs         NVIDIA and LM Studio smoke check
  local_asr_server.py        local faster-whisper transcription sidecar
benchmarks/
  run_asr_fleurs.py         full public FLEURS French ASR baseline
  run_mmlu_pro.py            lm-evaluation-harness adapter for MMLU-Pro
  run_beir_bm25.py           full public BEIR BM25 baselines
tests/e2e/
  workspace.spec.ts          real browser workflows
docs/
  architecture.md            system boundaries and target runtime
  benchmarks.md              public benchmark evidence and gates
  providers.md               provider setup and runtime configuration
  local-asr.md               local transcription sidecar setup
```

## Roadmap

- Move browser persistence to SQLite WAL in the Tauri desktop runtime, with crash recovery and tested migrations.
- Extend the `SpeechEngine` contract to streaming partials, diarization, and crash-resumable jobs.
- Extend source import with PDF and image parsing, OCR, page or region provenance, and formula-aware extraction.
- Add hybrid BM25 plus dense retrieval, reranking, and a permissioned citation-first agent loop.
- Extend the current lexical retriever with dense retrieval and reranking after the native knowledge store is available.
- Validate the desktop shell on Windows, macOS, and Linux.
- Expand public benchmark coverage and the versioned LectureBench described in [docs/benchmarks.md](./docs/benchmarks.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and pull request workflow.

## License

MIT. See [LICENSE](./LICENSE).
