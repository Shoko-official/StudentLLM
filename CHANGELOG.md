# Changelog

## Unreleased

### Changed

- Licensing and compliance: the document sidecar no longer uses PyMuPDF (AGPL-3.0 or a commercial licence). PDF text and layout now come from pdfminer.six (MIT) and scanned pages are rendered with pypdfium2 (Apache-2.0 or BSD-3-Clause); the health model is `pdfminer` or `pdfminer+rapidocr`. Page text and OCR output matched the previous engine on synthetic fixtures, but block grouping differs and pdfminer.six is slower, so every PDF now runs in a worker process with a 240-second budget (HTTP 504 when it runs out), a per-page character cap (OCR or HTTP 422 above it), a 64 MB cap on any decoded stream (decompression bombs get HTTP 422), a 2048 MB memory limit per worker, cleanup when the client disconnects, and a worker that exits by itself when its sidecar is hard-killed. Glyphs without a Unicode map that pdfminer.six reports as `(cid:N)` trigger the OCR fallback and are dropped from the text the web app keeps; presentation ligatures are expanded. See [docs/local-documents.md](docs/local-documents.md#differences-from-the-pymupdf-engine).
- The animated Lordicon icons are replaced by Lucide icons with a CSS animation, because the Lordicon free licence does not clearly allow shipping the icon files in a product that is sold. `@lordicon/react` is removed.
- `NOTICE.md`, a generated `THIRD_PARTY_LICENSES.md`, `docs/licensing.md` and a CI licence policy (`npm run licenses:check:all`) document and enforce the licences of npm, Cargo and Python dependencies. The release workflow attaches the full licence texts, the installers carry `LICENSE`, `NOTICE.md` and `THIRD_PARTY_LICENSES.md` under `licenses/`, and Settings has an "Open-source licences" dialog that shows them offline.

### Fixed

- An unreachable AI model, speech service or document service is explained in plain language in Chat, Study, the organizer, imports and Settings, instead of "Provider request failed (502)" or "Failed to fetch". A failed chat request is no longer saved as an assistant answer; the question returns to the composer ([#338](https://github.com/Shoko-official/StudentLLM/issues/338)).
- Work is no longer lost silently: a transcription, extraction, recording or organizer call that finishes later merges into the transcript as it is then, so text imported during it is kept; a course deleted while an import runs is not resurrected; removing or deleting a source or course never erases a stored original that another course uses or is still importing; a full or blocked browser store shows an alert instead of "saved locally"; a damaged, partly unreadable or newer-format workspace is copied aside and, when no copy can be kept or a newer version owns the data, left untouched with saving paused and a download of the saved data (the copy is a raw workspace file, not a course export, so it cannot be imported back and must be kept and restored by hand); a write from another tab pauses saving in the stale tab, which then offers Reload and Export; closing the tab during an import, transcription, recording or while changes are not being saved asks for confirmation; a recording stopped while saving is paused stays recoverable. Empty files and a second copy of a file in one course are refused.
- When the microphone disappears during a recording, the recording now ends cleanly and says why. Before, Stop left the interface on "Saving recording" until a reload. Blocked and missing microphones get plain-language messages, and a full store is reported while recording.
- Imported Markdown shows headings, lists and tables in the course notes; citation chips still open their source after a course import; exporting a course too large to import back warns about it.
- Search finds French text typed without accents (`ete` finds `été`) and across apostrophe styles.
- Typing in a search field or the chat no longer re-typesets every note block and transcript segment: with 800 segments and the CPU slowed 4x, 20 keystrokes went from 5.3 s to 0.8 s and opening the Notes tab from 11.9 s to 3.3 s.
- The selected tab, open course and needs-review segments stay visible in Windows High Contrast (forced colors).
- A PDF or Word file the document service refuses is reported as a problem with the file (damaged or password-protected) instead of a service to restart.
- PPTX extraction returned no text for real files because it looked for the DrawingML `txBody` instead of the PresentationML one that holds shape text, and fused the paragraphs of a shape; each paragraph is now its own line.
- The desktop app now runs as a single instance: starting it a second time brings the existing window to the front instead of opening a second process on the same workspace, where the last writer overwrote the other window's work (#399).

### Added

- [User guide](docs/user-guide.md) for students, linked from the README and from Settings.

### Security

- The packaged desktop app now enforces a Content Security Policy instead of running with none (`csp: null`): scripts only from the app itself (no `eval`, no inline code), no plugins, no framing, no form posts, and requests only to the app, Tauri IPC and loopback services (`127.0.0.1` and `localhost`). Inline style attributes are the one allowance, for KaTeX. A navigation guard in the Rust shell keeps the webview on the app's own origins, because a Content Security Policy does not cover top-level navigation; a new-window guard refuses `window.open` and `target="_blank"` links (the few links the app had are shown as text to copy in the packaged app). A browser test serves the production build with this exact policy and fails on any violation. Because of it, the packaged app no longer connects to remote or LAN model and service addresses, and Settings refuses to save such an address and says why instead of reporting a missing server. See [docs/desktop.md](docs/desktop.md#content-security-policy).

## 0.1.0 - 2026-10-31

### Fixed

- Removing a source is no longer instant and irreversible: an Undo toast (a live region, keyboard reachable, paused while hovered or focused) restores the source, its transcript and its note for 8 seconds, and the stored original is only erased afterwards, including after a reload.
- Course-note concept schemas keep terms that start with an accented capital (for example `Énergie`) and recognise French relation verbs (`entraîne`, `provoque`, `engendre`, `mène à`, `dépend de/du/des`), including elided articles such as `l'`.
- Course search results and the per-keystroke filter strip Markdown and LaTeX through a linear-time pattern and a bounded cache, instead of a quadratic whitespace pattern and repeated stripping.
- Importing a course export clears the error banner left over from the previous course.
- Interface wording is consistent: "course" replaces "session", the create-course button no longer shows a microphone, and the AI organizer has one name.

### Added

- A `Release` workflow turns a `v*` tag into a draft GitHub release with unsigned Windows, macOS (Apple Silicon), and Linux installers and per-platform SHA-256 checksums.
- Live course notes now turn the incremental transcript into a persisted, routed document with formulas, code, schemas, and compact data visualizations when appropriate; LM Studio can refine the detected subject, chapter, title, and Markdown filename.
- Course metadata can be edited after creation from the compact More menu; title, subject, chapter, and sublesson changes update the course tree and persisted note path together.
- Course chat now wraps retrieved passages in explicit evidence boundaries and requires a grounded answer or a clear insufficient-evidence response; the live LM Studio smoke also checks for concepts present in the source.
- Study artifacts now use bounded, source-labelled evidence with explicit insufficient-evidence handling, and citations only point to passages actually sent to the local model.
- Manual transcription of an existing audio source now reuses the catalog-aware LM Studio router, moving the source and its transcript into a confident existing or newly proposed course while preserving the current-course fallback.
- A flat, minimal workspace visual system with compact artifact rows and no decorative gradients, shadows, or complex motion.
- React and TypeScript learning workspace;
- course navigation, transcript review, recording controls, chat, and Studio artifact actions;
- versioned local workspace persistence for lessons, sources, chat history, and artifacts, plus chunked `MediaRecorder` audio storage;
- local source import with MIME classification, metadata, and SHA-256 fingerprints;
- original imported source blobs stored in IndexedDB when available;
- imported text, image, audio, and PDF sources can be opened through a local workspace preview;
- course composer attachment actions now open the local source picker for supported files and images;
- the composer image attachment action is covered by a browser regression with MIME-filter verification;
- imported image preview rendering is covered through local blob retrieval and browser output verification;
- native SQLite coverage preserves legacy snapshots during migration and rejects newer unsupported schemas;
- native workspace writes now wait briefly on SQLite locks and are covered by an overlapping-writers integrity test;
- native workspace load and save failures now surface an actionable toast while preserving the local fallback;
- Tauri can now own explicitly configured local sidecar processes, expose their lifecycle status, and stop its children on exit;
- packaged desktop smoke coverage now autostarts two configured sidecars and verifies both are stopped after a clean runtime exit;
- packaged desktop crash-recovery smoke now verifies ten relaunch cycles on Ubuntu, Windows, and macOS;
- packaged desktop smoke now verifies that the frontend invokes a native IPC command and receives its response;
- imported text sources are available to local lexical retrieval with source-name citations;
- imported text is chunked into bounded passages with source-part citations before provider calls;
- injected live-provider coverage verifies source context and provider citations;
- provider failures are rendered as actionable chat messages and covered by UI tests;
- recorder failure contracts cover missing browser APIs, unavailable recorder construction, construction errors, and microphone permission rejection;
- durable recording sessions now appear as course audio resources after successful finalization;
- recording finalization now remains visible and blocks a second start until audio processing completes;
- configured local ASR now shows an incremental live preview during durable recording, then replaces it with the final transcript after stop;
- the full transcript archive now includes an active live preview while preserving its persisted-segment count;
- packaged desktop UI coverage now drives the Linux and Windows Tauri windows through course creation, native reload persistence, and Studio artifact persistence;
- a manual cross-platform desktop recovery soak workflow now exercises configurable repeated packaged relaunches, with the first 30-cycle Ubuntu, Windows, and macOS campaign passing;
- interrupted durable recordings are recovered from their local manifest on the next launch;
- durable recording startup now stops safely when its interrupted-session recovery manifest cannot be persisted;
- deleting a course now removes orphaned interrupted-recording manifests and persisted chunks;
- transcript review controls can now promote a segment to verified or send it back for review;
- Studio artifacts now expose an offline draft preview and can be replaced with source-grounded local-provider content;
- course sources, transcripts, chats, and artifacts are isolated per lesson with legacy workspace migration;
- full public French FLEURS ASR benchmarking is available through a faster-whisper adapter with WER, CER, RTF, and hardware receipts;
- a generic Hugging Face ASR adapter and full public MLS French receipt are available with explicit dataset, split, and validity metadata;
- a reproducible public-data FLEURS plus MUSAN SNR robustness adapter records WER and CER by noise category;
- a dated English project status page summarizes verified workflows, public benchmark coverage, and remaining evaluation work;
- imported course sources can be removed from the active workspace and their IndexedDB blobs are deleted;
- removing an audio source also clears any persisted recording chunks associated with it;
- the browser suite now verifies recorded-audio deletion through the real IndexedDB store;
- Settings transcript display preferences now persist in browser-local storage and restore after reload;
- durable recordings can be sent to an optional local faster-whisper service and added back as reviewable transcript segments;
- imported audio can be transcribed through the optional local faster-whisper service, with source-linked transcript provenance;
- imported audio now reuses the catalog-aware LM Studio router after transcription, moving the source and transcript into a confident existing or newly proposed course while retaining the selected course as a fallback;
- imported text, PDF, and OCR image material now reuses the catalog-aware LM Studio router after extraction, preserving the source and extracted transcript in a confident existing or newly proposed course while retaining the selected course as a fallback;
- removing an audio source now removes its derived transcript segments and preserves source links across course export and import;
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
- TREC-COVID support in the BEIR BM25 and dense adapters, with complete public receipts and comparison metrics;
- official MTEB task wrapper and public STSBenchmark v2 CPU receipt with a Spearman main score of `0.857289`;
- official MTEB `STS22.v2` multilingual public test receipt covering 18 language and cross-language subsets;
- official BFCL V4 `simple_python` partial evaluation through the existing LM Studio endpoint, with 20/20 official category accuracy;
- official BFCL V4 `multiple` partial evaluation through the existing LM Studio endpoint, with 19/20 official category accuracy;
- official BFCL V4 `parallel_multiple` partial evaluation through the existing LM Studio endpoint, with 17/20 official category accuracy;
- official BFCL V4 `irrelevance` partial evaluation through the existing LM Studio endpoint, with 20/20 official category accuracy;
- official BFCL V4 `multi_turn_base` partial evaluation through the existing LM Studio endpoint, with 6/20 official category accuracy and recorded format failures;
- official BFCL V4 `multi_turn_miss_func` and `multi_turn_miss_param` partial evaluations, both 3/20, with long-sequence and empty-response compatibility findings;
- official BFCL V4 OpenAI-compatible NVIDIA NIM runner using the Windows User `NVIDIA_API_KEY` environment variable;
- configurable 120-second default request timeout for the OpenAI-compatible BFCL runner, preventing stalled multi-turn requests from holding a run indefinitely;
- six official BFCL V4 NVIDIA NIM category samples for `openai/gpt-oss-20b`: `simple_python` 9/20, `multiple` 1/20, `parallel_multiple` 0/20, `multi_turn_base` 5/20, `multi_turn_miss_func` 3/20, and `multi_turn_miss_param` 2/20;
- official BFCL V4 NVIDIA NIM `multi_turn_long_context` sample for `openai/gpt-oss-20b`: 3/20, with 345 requests and recorded empty-response and decode-failure findings;
- deterministic single-worker local Playwright mode to prevent Windows browser-test contention while keeping CI parallel;
- 70-item public MMLU-Pro LM Studio receipt covering all 14 categories with explicit partial-sample validity;
- 140-item public MMLU-Pro LM Studio receipt covering all 14 categories, plus UTF-8 output handling for Windows benchmark runs;
- 140-item public MMLU-Pro NVIDIA NIM receipt covering all 14 categories with per-category scores and runtime generation settings;
- 280-item public MMLU-Pro NVIDIA NIM receipt covering 20 items in each of the 14 categories: exact match `0.2821` (79/280, stderr `0.0262`);
- complete 250-case public BIG-Bench Hard `bbh_zeroshot_logical_deduction_seven_objects` receipt through NVIDIA NIM: flexible-extract exact match `0.5920` (148/250, stderr `0.0311`);
- complete 250-case public BIG-Bench Hard `bbh_zeroshot_multistep_arithmetic_two` receipt through NVIDIA NIM: flexible-extract exact match `0.9640` (241/250, stderr `0.0118`) and strict-match `0.6480` (162/250, stderr `0.0303`);
- complete 250-case public BIG-Bench Hard `bbh_zeroshot_tracking_shuffled_objects_seven_objects` receipt through NVIDIA NIM: flexible-extract exact match `0.8520` (213/250, stderr `0.0225`);
- complete 250-case public BIG-Bench Hard `bbh_zeroshot_dyck_languages` receipt through NVIDIA NIM: flexible-extract exact match `0.0360` (9/250, stderr `0.0118`) and strict-match `0.0320` (8/250, stderr `0.0112`);
- complete 250-case public BIG-Bench Hard `bbh_zeroshot_reasoning_about_colored_objects` receipt through NVIDIA NIM: flexible-extract exact match `0.4880` (122/250, stderr `0.0317`);
- complete public GSM8K test split receipt through NVIDIA NIM: flexible-extract exact match `0.8544` (1,127/1,319, stderr `0.0097`) and strict-match `0.0000`;
- Windows-compatible official MATH task runner and posthoc scorer for `math_verify`, preserving the public task and metrics without nested timeout subprocesses;
- complete 500-case public MATH-500 receipt through NVIDIA NIM: `math_verify` `0.8220` (411/500, stderr `0.0171`) and legacy `exact_match` `0.0000`;
- complete public AIME 2024 receipt through NVIDIA NIM: exact match `0.3667` (11/30, stderr `0.0895`);
- complete public AIME 2025 receipt through NVIDIA NIM: exact match `0.3000` (9/30, stderr `0.0851`);
- NVIDIA-compatible official ARC-Challenge generation adapter that normalizes the provider-echoed answer prefix;
- complete public ARC-Challenge receipt through NVIDIA NIM: exact match `0.8473` (993/1,172, stderr `0.0105`) with zero empty responses;
- pinned IFEval benchmark dependencies and reproducible official-harness instructions for NVIDIA NIM;
- complete 541-prompt public IFEval receipt through NVIDIA NIM: prompt strict `0.7024`, instruction strict `0.7878`, prompt loose `0.7412`, and instruction loose `0.8177`, with four empty provider responses retained in the official sample log;
- complete 817-example public TruthfulQA generation receipt through NVIDIA NIM: BLEU accuracy `0.3513`, ROUGE-1 accuracy `0.3856`, ROUGE-2 accuracy `0.2778`, and ROUGE-L accuracy `0.3917`, with 289 null-content placeholders retained in the official sample log;
- partial public DROP reading-comprehension receipt through NVIDIA NIM: 512 validation examples, exact match `0.0020`, token-level F1 `0.1109`, and one retained empty provider response;
- three additional official BFCL V4 NVIDIA NIM category receipts: `simple_java` `0/20`, `simple_javascript` `9/20`, and `parallel` `0/20`, with isolated result roots and retained empty-result findings;
- official BFCL V4 NVIDIA NIM `live_simple` receipt: `17/20` with the corrected official compound-ID selection, and the OpenAI-compatible runner now derives all category IDs from the dataset;
- official BFCL V4 NVIDIA NIM `live_multiple` receipt: `3/20`, with 20 compound-ID cases, four empty result arrays, and a retained raw receipt;
- official BFCL V4 NVIDIA NIM `live_parallel` receipt: `0/16`, covering every public entry in the category with no empty result arrays;
- official BFCL V4 NVIDIA NIM `live_parallel_multiple` receipt: `0/24`, covering every public entry in the category with one retained empty result array;
- official BFCL V4 NVIDIA NIM `live_relevance` receipt: `14/16` relevance detections, covering every public entry in the category with two retained empty result arrays;
- official BFCL V4 NVIDIA NIM `live_irrelevance` receipt: `124/128` irrelevance detections from a 128-case public sample, with no-tool result arrays retained;
- Vite's same-origin LM Studio proxy now derives its target origin from `LM_STUDIO_BASE_URL`, with a documented local fallback, and the live browser chat path was revalidated against the existing `openai/gpt-oss-20b` process;
- delete confirmation dialogs can now be dismissed with `Escape`, covered by a dedicated Playwright regression test;
- complete official BIG-Bench Hard `bbh_zeroshot` group through NVIDIA NIM: 27 task configurations and 6,511 public cases, flexible-extract exact match `0.7474` (4,866/6,511, stderr `0.0047`), with 152 empty provider responses retained in the official sample logs;
- detailed per-task BBH receipt and reproducible full-suite command documented in `docs/benchmarks.md` and `benchmarks/README.md`;
- dedicated Ubuntu WSL HumanEval runner using the official Linux `code_eval` scorer and the Windows User `NVIDIA_API_KEY` environment value;
- complete public HumanEval `humaneval_instruct` and `humaneval` receipts through NVIDIA NIM: official `pass@1` `0.0000` (0/164) for each task, with zero empty responses and an explanation-first output-format finding;
- pinned EvalPlus `0.3.1` environment and an OpenAI-compatible NVIDIA bridge that preserves the official HumanEval+ sanitisation and scorer;
- complete public HumanEval+ evaluation through NVIDIA NIM: base `pass@1` `0.8963` (147/164) and extended `pass@1` `0.8232` (135/164), with one non-compilable sanitised sample retained as a failure;
- generalized the official EvalPlus WSL runner to select HumanEval or MBPP+ explicitly and to resume timestamped model outputs;
- complete public MBPP+ evaluation through NVIDIA NIM: MBPP base `pass@1` `0.8571` (324/378) and extended `pass@1` `0.6852` (259/378), with three non-compilable sanitised samples retained as failures;
- recorded the official GPQA Diamond dataset access finding: the gated `Idavidrein/gpqa` source stopped the task before generation without a configured Hugging Face token;
- benchmark adapter syntax checks included in the local and GitHub verification gates;
- NVIDIA NIM and LM Studio OpenAI-compatible smoke checks with runtime credentials;
- browser OpenAI-compatible provider requests now bind the default fetch context correctly;
- live LM Studio browser chat path verified through the built-in Vite same-origin proxy without restarting the model process;
- live browser recording to the faster-whisper sidecar verified with a public FLEURS sample and a rendered review segment;
- live browser PDF import verified against the local PyMuPDF sidecar with a public 15-page source;
- live NVIDIA NIM and LM Studio smoke checks reverified on 2026-08-27 without restarting the local model process;
- latest provider smoke receipt confirms NVIDIA NIM at 1,260 ms and LM Studio at 310 ms on the development machine;
- provider smoke reverified on 2026-08-30 without restarting the local model process: NVIDIA NIM `openai/gpt-oss-20b` 1,374 ms and LM Studio `qwen/qwen3-4b` 20,199 ms;
- the environment example now makes the Windows User source of `NVIDIA_API_KEY` explicit without declaring a file variable;
- Vitest, Playwright, axe, TypeScript, Vite, and GitHub Actions verification;
- architecture, provider, benchmark, and contribution documentation.
