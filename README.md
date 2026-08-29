# StudentLLM

StudentLLM is a local-first learning studio that turns lectures into searchable, source-linked study material. It connects a course session, its transcript, original sources, and review artifacts without replacing the source material.

[![CI](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml/badge.svg)](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml)

## Product direction

StudentLLM is built around three principles:

- Original audio, documents, and images remain recoverable and traceable.
- PDFs and images can be indexed locally with page-level provenance through the optional PyMuPDF and RapidOCR sidecar.
- Generated answers and study artifacts link back to a source, page, or timestamp.
- Local processing is the default; remote providers are explicit integrations.

## Included today

- Responsive three-panel workspace: Library, Course or Chat, and Studio.
- Course creation, navigation, search, bookmarks, transcript review states, and artifact creation.
- Browser microphone access with a demonstration fallback.
- Versioned local workspace persistence with course-isolated sources, transcript segments, chat history, and artifacts.
- Chunked `MediaRecorder` capture with IndexedDB persistence when supported by the browser.
- Interrupted durable recordings are recovered into the owning course on the next launch.
- Optional local faster-whisper sidecar transcription after durable recording, with timestamped review segments.
- Optional local PDF text extraction and RapidOCR for images or scanned PDF pages, with page-level review segments.
- Local source import with MIME classification, file metadata, and SHA-256 fingerprints.
- Original imported source blobs are stored in IndexedDB when available, alongside their fingerprints.
- Imported text, image, audio, and PDF sources can be opened from the workspace through a local preview.
- Course deletion clears the lesson workspace and its locally stored source and recording blobs before switching sessions.
- Active courses can be exported and imported as versioned JSON packages with source and audio assets.
- OpenAI-compatible smoke checks for NVIDIA NIM and LM Studio.
- Full public French FLEURS ASR baseline with WER, CER, RTF, and reproducibility receipt.
- Public DocVQA OCR extractability diagnostic with a reproducible partial validation receipt.
- Optional live LM Studio chat through a browser-safe OpenAI-compatible provider adapter; no remote API key is bundled in the client.
- Local lexical retrieval selects transcript or bounded imported text passages and preserves source-part citations before a live provider request.
- Vitest unit and integration coverage, Playwright browser coverage, axe accessibility checks, and GitHub Actions CI.
- Tauri v2 desktop shell with a native-window build path, SQLite WAL persistence, and CI build/test gates.
- Unsigned debug desktop bundles produced and retained by CI for Ubuntu, Windows, and macOS.

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

To create a local unsigned desktop bundle:

```bash
npm run desktop:package
```

## Verification

```bash
npm run verify
```

`verify` runs the TypeScript project check, Python benchmark adapter checks, Vitest, the Vite production build, and Playwright Chromium tests. Provider checks are run separately because they depend on a local server or a remote API:

```bash
npm run providers:smoke
```

See [docs/status.md](./docs/status.md) for the current verified application and benchmark coverage.

## Provider configuration

Provider credentials are read at runtime and are never loaded from a repository file.

- NVIDIA NIM reads `NVIDIA_API_KEY` from the Windows User environment or the current process.
- NVIDIA defaults to `https://integrate.api.nvidia.com/v1` and `openai/gpt-oss-20b`.
- LM Studio smoke checks default to `http://127.0.0.1:1234/v1` and `qwen/qwen3-4b`.
- For browser chat, set `VITE_LM_STUDIO_BASE_URL=/lm-studio/v1` before `npm run dev`; the built-in Vite proxy derives its target origin from `LM_STUDIO_BASE_URL` and keeps the request same-origin when LM Studio CORS is disabled.
- An absolute browser endpoint remains supported when it allows the Vite origin through CORS; the browser integration never accepts an NVIDIA credential.
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
  lib/recording-recovery.ts  interrupted-session recovery manifest
  lib/speech-engine.ts       local faster-whisper HTTP adapter
  lib/document-engine.ts     local PDF and image extraction adapter
  lib/source-ingest.ts        local source classification and fingerprinting
  lib/source-storage.ts       IndexedDB source blob storage
  lib/source-chunking.ts      bounded text passages for retrieval
  lib/workspace-storage.ts   versioned workspace persistence
  *.test.tsx                 UI and storage tests
scripts/
  provider-smoke.mjs         NVIDIA and LM Studio smoke check
  local_asr_server.py        local faster-whisper transcription sidecar
  local_document_server.py   local PyMuPDF and RapidOCR document sidecar
  requirements-local-documents.txt  Python sidecar dependencies
benchmarks/
  run_asr_fleurs.py         full public FLEURS French ASR baseline
  run_asr_hf.py             configurable public Hugging Face ASR evaluation
  run_asr_musan.py          public FLEURS plus MUSAN SNR robustness evaluation
  run_mmlu_pro.py            lm-evaluation-harness adapter for MMLU-Pro
  run_beir_bm25.py           full public BEIR BM25 baselines
  run_docvqa_ocr.py          public DocVQA OCR extractability diagnostic
  run_beir_dense.py          full public BEIR dense baseline
  run_mteb.py                official MTEB task wrapper
tests/e2e/
  workspace.spec.ts          real browser workflows
docs/
  architecture.md            system boundaries and target runtime
  status.md                  current verified coverage and remaining work
  benchmarks.md              public benchmark evidence and gates
  providers.md               provider setup and runtime configuration
  local-asr.md               local transcription sidecar setup
  local-documents.md         local PDF and image extraction setup
  desktop.md                 Tauri desktop runtime setup and validation
```

## Roadmap

- Add crash recovery and tested migrations on top of the Tauri SQLite WAL workspace bridge.
- Extend the `SpeechEngine` contract to streaming partials, diarization, and crash-resumable jobs.
- Extend OCR with structured tables, formulas, diagrams, handwriting, and richer page or region provenance.
- Add hybrid BM25 plus dense retrieval, reranking, and a permissioned citation-first agent loop.
- Extend the current lexical retriever with dense retrieval and reranking after the native knowledge store is available.
- Validate the packaged desktop runtime on Windows, macOS, and Linux.
- Expand public benchmark coverage and the versioned LectureBench described in [docs/benchmarks.md](./docs/benchmarks.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and pull request workflow.

## License

MIT. See [LICENSE](./LICENSE).
