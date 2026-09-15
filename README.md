# StudentLLM

StudentLLM is a local-first learning studio that turns lectures into searchable, source-linked study material. It connects a course session, its transcript, original sources, and review artifacts without replacing the source material.

[![CI](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml/badge.svg)](https://github.com/Shoko-official/StudentLLM/actions/workflows/ci.yml)

## Product direction

StudentLLM is built around three principles:

- Original audio, documents, and images remain recoverable and traceable.
- PDFs, images, text, Markdown, HTML, RTF, DOCX, and PPTX can be indexed locally with page or section provenance through the optional document sidecar.
- Generated answers and study artifacts link back to a source, page, or timestamp.
- Local processing is the default; remote providers are explicit integrations.

## Included today

- Responsive workspace with a course library and four focused views: Notes, Sources, Chat, and Study.
- Flat, minimal interface with compact controls and an information-first layout.
- Course creation, navigation, search, bookmarks, transcript review states, and artifact creation.
- Quick Start creates a blank course immediately with a provisional human-readable title such as `Study session · 5AB8`; after material is recorded or imported, **Organize material with AI** can propose and apply a reviewed course title and hierarchy.
- Empty library on first launch. Legacy demonstration content is removed with a recoverable backup; user recordings and imports are retained.
- Real browser microphone capture, with explicit errors when capture is unavailable.
- Versioned local workspace persistence with course-isolated sources, transcript segments, chat history, and artifacts.
- Chunked `MediaRecorder` capture with IndexedDB persistence when supported by the browser.
- Interrupted durable recordings are recovered into the owning course on the next launch.
- Optional local faster-whisper sidecar transcription after durable recording, with timestamped review segments.
- Configured local ASR can also show an incremental transcript preview while recording; the post-recording transcription remains authoritative.
- The live lesson is assembled at the same time into a Word-like course note with timestamped paragraphs, readable formulas, code blocks, concept schemas, and small data visualizations when the transcript contains the relevant signals.
- Finalized recordings, imported material, OCR pages, and Quick Start sources can receive a second local GPT OSS formatting pass that adds source-linked LaTeX, code, schemas, and charts; invalid or unsupported model output keeps the deterministic note.
- Course routing keeps notes under `Courses/<subject>/<chapter>/<lesson>/` in the persisted workspace, uses transcript signals as a fallback, and can refine the route through LM Studio JSON classification. After a durable recording is transcribed, the same classifier can move the audio and transcript into an existing course or create a structured new course when confidence is sufficient; uncertain or unavailable classifications stay in the selected course.
- Course notes can be saved as a clean Markdown document using the detected course filename.
- Imported audio can use the same local ASR path, with transcript segments linked back to the audio source.
- Optional local PDF text extraction, RapidOCR, Office XML parsing, and typed document blocks for headings, lists, tables, code, and formula-like regions.
- Local source import with MIME classification, file metadata, and SHA-256 fingerprints.
- Original imported source blobs are stored in IndexedDB when available, alongside their fingerprints.
- Imported text, image, audio, and PDF sources can be opened from the workspace through a local preview.
- Course questions can attach supported local sources directly from the composer.
- Course deletion clears the lesson workspace and its locally stored source and recording blobs before switching sessions.
- Active courses can be exported and imported as versioned JSON packages with source and audio assets.
- OpenAI-compatible smoke checks for NVIDIA NIM and LM Studio.
- Full public French FLEURS ASR baseline with WER, CER, RTF, and reproducibility receipt.
- Public DocVQA OCR extractability diagnostic with a reproducible partial validation receipt.
- Optional live LM Studio chat through a browser-safe OpenAI-compatible provider adapter; no remote API key is bundled in the client.
- KaTeX-powered rendering for formulas in transcripts, chat answers, course notes, and study artifacts, with semantic MathML and accessible formula labels.
- Connection settings for LM Studio, Bionic, and other OpenAI-compatible local endpoints, with model discovery, automatic selection, and on-demand availability checks.
- Persistent light/dark workspace themes, compact course navigation, and visually distinct user and assistant chat messages.
- Text imports appear in course notes immediately. Saved audio can be transcribed or retried from Sources.
- Study material is saved only after a model returns content; failed requests do not create placeholder artifacts.
- Local hybrid retrieval selects transcript or bounded imported passages with deterministic lexical ranking and optional OpenAI-compatible embeddings, while preserving source-part citations before a live provider request.
- Audio-derived transcript citations retain their source filename and timestamp, and removing the audio removes its derived segments.
- Vitest unit and integration coverage, Playwright browser coverage, axe accessibility checks, and GitHub Actions CI.
- Tauri v2 desktop shell with a native-window build path, SQLite WAL persistence, crash-recovery coverage, and CI build/test gates.
- Unsigned debug desktop bundles produced and retained by CI for Ubuntu, Windows, and macOS.

## Quick start

Requirements: Node.js 22.13+ and npm 10+.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. Use **Quick start** to create a blank course in one click, then use **Record** or **Import file**. Once material exists, **Organize material with AI** proposes the course group, subject, lesson, note title, optional sublesson, and destination; review the proposal before applying it. Sources contains original files, Chat answers questions about them, and Study generates revision material. Export and transcript review are under **More**.

Open **Settings** to configure AI services, choose a light or dark theme, and inspect detected local models. In development, keep the endpoint at `/lm-studio/v1` and select a model available in LM Studio, Bionic, or another OpenAI-compatible local server. Speech and document services are configured separately; see [Provider configuration](docs/providers.md). Recording and text import do not require a model.

To inspect the production build:

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
- LM Studio smoke checks default to `http://127.0.0.1:1234/v1` and `openai/gpt-oss-20b`.
- Browser development chat uses `/lm-studio/v1` through the built-in Vite proxy by default; set `VITE_LM_STUDIO_BASE_URL` only when overriding the endpoint. The proxy derives its target origin from `LM_STUDIO_BASE_URL` and keeps the request same-origin when LM Studio CORS is disabled.
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
  lib/document-engine.ts     local multi-format document extraction adapter
  lib/source-ingest.ts        local source classification and fingerprinting
  lib/source-storage.ts       IndexedDB source blob storage
  lib/source-chunking.ts      bounded text passages for retrieval
  lib/rich-text.tsx           accessible KaTeX and MathML formula rendering
  lib/course-notes.ts         deterministic and provider-backed course note formatting
  lib/workspace-storage.ts   versioned workspace persistence
  *.test.tsx                 UI and storage tests
scripts/
  provider-smoke.mjs         NVIDIA and LM Studio smoke check
  local_asr_server.py        local faster-whisper transcription sidecar
  local_document_server.py   local PDF/OCR/Office/XML document sidecar
  requirements-local-documents.txt  Python sidecar dependencies
benchmarks/
  run_asr_fleurs.py         full public FLEURS French ASR baseline
  run_asr_hf.py             configurable public Hugging Face ASR evaluation
  run_asr_musan.py          public FLEURS plus MUSAN SNR robustness evaluation
  run_mmlu_pro.py            lm-evaluation-harness adapter for MMLU-Pro
  run_beir_bm25.py           full public BEIR BM25 baselines
  run_docvqa_ocr.py          public DocVQA OCR extractability diagnostic
  run_docvqa_anls.py         public DocVQA vision ANLS evaluation
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
  course-notes.md             live note lifecycle and rich-block provider contract
```

## Roadmap

- Produce self-contained desktop release bundles with isolated ASR and document sidecar runtimes, then add signed release artifacts.
- Extend the `SpeechEngine` contract to diarization and crash-resumable jobs while preserving the current live partial transcript path.
- Extend OCR with handwriting recognition, richer formula recovery, diagram understanding, and region-level provenance.
- Add reranking and a citation-first retrieval loop on top of the current hybrid lexical/dense adapter.
- Expand public benchmark coverage and the versioned LectureBench described in [docs/benchmarks.md](./docs/benchmarks.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and pull request workflow.

## License

MIT. See [LICENSE](./LICENSE).
