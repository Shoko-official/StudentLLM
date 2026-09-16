# StudentLLM Production Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring StudentLLM to an evidence-backed production-ready state for the requested local-first course capture, document understanding, grounded chat, study artifacts, and desktop workflows.

**Architecture:** Keep the browser and Tauri shell as thin workspace clients over explicit local adapters. Preserve original files and audio as the source of truth, normalize extracted content once at the document boundary, and pass only bounded, source-linked evidence into retrieval and generation. Deterministic fallbacks remain available whenever LM Studio, NVIDIA, ASR, or document services are unavailable.

**Tech Stack:** React 19, TypeScript 7, Vite 8, KaTeX, react-markdown, Playwright, Vitest, Python local sidecars, OpenAI-compatible providers, Tauri 2, SQLite WAL, GitHub Actions.

**Spec:** User requirements in the current conversation, with the existing contracts in `docs/architecture.md`, `docs/course-notes.md`, `docs/local-documents.md`, `docs/local-asr.md`, and `docs/benchmarks.md`.

## Global Constraints

- Keep all repository-facing copy and documentation in English.
- Preserve original source blobs and source/page/timestamp provenance.
- Never fabricate benchmark results or claim a target is met without a fresh receipt.
- Never send NVIDIA credentials to the browser; read `NVIDIA_API_KEY` only from the runtime environment.
- Do not require a model for recording, text import, persistence, or source preview.
- Use one worker and the largest safe context for the requested GPT OSS benchmark runs.
- Every implementation slice must include a regression test and pass the relevant local checks before publishing.

---

### Task 1: Establish a fresh completion baseline

**Files:**
- Modify: `docs/status.md`
- Modify: `docs/benchmarks.md`
- Create: `docs/superpowers/plans/2026-09-16-production-completion.md`
- Test: repository status and the complete local verification commands

**Interfaces:**
- Consumes: current `main` at `d63998d`, existing test suites, provider/service availability, and current benchmark receipts.
- Produces: a dated baseline separating implemented behavior, fresh evidence, and external blockers.

- [ ] **Step 1: Run the complete local application verification**

Run `npm run check`, `npm run test:run`, `npm run build`, `npm run test:e2e`, `npm run benchmarks:check`, and `npm audit --omit=dev --audit-level=high`. Record counts and failures, not impressions.

- [ ] **Step 2: Probe configured local services**

Run `npm run providers:smoke`, query LM Studio `/v1/models`, query the configured ASR `/health`, and query the configured document `/health`. If a service is unavailable, retain that fact as an external blocker instead of replacing it with a mock.

- [ ] **Step 3: Inspect the browser workflows against the acceptance matrix**

Exercise empty workspace, Quick Start, course routing, import, source preview, chat, Study, recording consent, recording, reload, export/import, deletion, theme switching, responsive widths, and citation opening with Playwright or the existing browser harness.

- [ ] **Step 4: Update the status documents with only observed evidence**

Add the current commit, test counts, provider states, and explicit open gates. Do not mark benchmark targets complete merely because an adapter or partial dataset exists.

- [ ] **Step 5: Run `git diff --check` and commit the baseline documentation**

Use commit message `docs: refresh production completion baseline`.

### Task 2: Make document extraction and rendering source-faithful

**Files:**
- Modify: `scripts/local_document_server.py`
- Modify: `src/lib/document-engine.ts`
- Modify: `src/lib/document-text.ts`
- Modify: `src/lib/rich-text.tsx`
- Modify: `src/lib/visual-blocks.ts`
- Modify: `src/lib/visual-blocks-view.tsx`
- Test: `tests/test_local_document_server.py`, `src/lib/document-engine.test.ts`, `src/lib/document-text.test.ts`, `src/lib/rich-text.test.tsx`, `src/lib/visual-blocks.test.tsx`

**Interfaces:**
- Consumes: PDF/image/text/Markdown/HTML/RTF/DOCX/PPTX bytes and typed extraction blocks.
- Produces: deterministic normalized blocks with page/region provenance, safe formula fallback, semantic tables, and declarative diagrams/charts that render identically in Notes, Chat, and Study.

- [ ] **Step 1: Add failing fixtures for the reported failure classes**

Cover escaped `\\partial` commands, mojibake operators, unclosed delimiters, multi-line display math, tables containing formulas, code fences containing dollar signs, empty OCR pages, and diagram/chart blocks with invalid source IDs.

- [ ] **Step 2: Run the focused tests and confirm each regression is red**

Run `npm run test:run -- src/lib/document-engine.test.ts src/lib/document-text.test.ts src/lib/rich-text.test.tsx src/lib/visual-blocks.test.tsx` and the targeted Python document tests.

- [ ] **Step 3: Implement boundary normalization and strict typed-block validation**

Keep ambiguous formulas as readable source text, reject malformed visual blocks, preserve page numbers, and never turn untrusted extracted content into executable HTML or script URLs.

- [ ] **Step 4: Implement visual regression assertions**

Render a source preview and a course note from the same fixture, assert that formulas use KaTeX/MathML when valid, tables have semantic rows and cells, code remains code, and invalid formulas remain readable instead of showing raw broken commands in red.

- [ ] **Step 5: Run the focused tests and the browser source-preview flow**

Confirm the focused suites pass, then verify that a cited PDF source opens its original preview and that a missing blob produces a recoverable message without losing the metadata.

- [ ] **Step 6: Commit**

Use commit message `fix: preserve structure across document rendering`.

### Task 3: Harden live recording and transcription behavior

**Files:**
- Modify: `src/lib/recorder.ts`
- Modify: `src/lib/speech-engine.ts`
- Modify: `src/lib/recording-storage.ts`
- Modify: `src/lib/recording-recovery.ts`
- Modify: `src/lib/recording-routing.ts`
- Modify: `src/App.tsx`
- Test: `src/lib/recorder.test.ts`, `src/lib/speech-engine.test.ts`, `src/lib/recording-storage.test.ts`, `src/lib/recording-recovery.test.ts`, `src/lib/recording-routing.test.ts`, `src/App.test.tsx`, `tests/e2e/workspace.spec.ts`

**Interfaces:**
- Consumes: durable MediaRecorder chunks, local ASR responses, recording notice acknowledgement, and active course metadata.
- Produces: immediate bounded live preview, authoritative post-recording transcript, resumable storage, deterministic cleanup, and correct course routing without duplicate or phantom segments.

- [ ] **Step 1: Add failing tests for timing and accuracy boundaries**

Assert that no microphone session is created before the consent acknowledgement, preview segments are not persisted as authoritative content, final segments replace preview content, aborted requests do not leave stale transcript rows, and reloading after an interrupted recording preserves exactly one recovery entry.

- [ ] **Step 2: Implement only the minimal state-machine changes required by the failing tests**

Keep the live preview explicitly marked temporary, debounce overlapping ASR windows, discard stale responses by recording generation, and use the final complete audio as the only authoritative transcript input.

- [ ] **Step 3: Validate with a real local ASR service**

Record a short French sample, measure first-preview latency, final transcription latency, segment count, and whether the original audio remains playable. Record the model, language, device, and sample hash.

- [ ] **Step 4: Run focused and E2E tests**

Run the recording library tests, the consent tests, and the real-browser recording workflow with the configured sidecar. Fail if browser console errors, duplicate segments, or missing timestamps appear.

- [ ] **Step 5: Commit**

Use commit message `fix: make live transcription state authoritative`.

### Task 4: Make provider and grounded-chat behavior robust

**Files:**
- Modify: `src/lib/llm-provider.ts`
- Modify: `src/lib/local-retrieval.ts`
- Modify: `src/lib/source-chunking.ts`
- Modify: `src/App.tsx`
- Modify: `scripts/provider-smoke.mjs`
- Test: `src/lib/llm-provider.test.ts`, `src/lib/local-retrieval.test.ts`, `src/lib/provider-response-limits.test.ts`, `src/App.test.tsx`, `tests/e2e/workspace.spec.ts`

**Interfaces:**
- Consumes: local OpenAI-compatible chat/embedding endpoints, bounded course evidence, and general-knowledge questions.
- Produces: clear provider state, source-grounded answers when evidence is relevant, useful general answers when the question is not source-dependent, and an explicit uncertainty response only when the question actually requires missing course evidence.

- [ ] **Step 1: Add failing chat cases**

Cover a source-grounded question, a general trigonometry question with no relevant source, an intentionally unanswerable course-specific question, an empty provider response, a reasoning-only response, a citation whose blob is missing, and a provider timeout.

- [ ] **Step 2: Separate relevance from evidence absence**

Use retrieval relevance thresholds and question intent so a generic mathematical request is not incorrectly rejected as “not enough evidence,” while course-specific claims still require cited evidence.

- [ ] **Step 3: Make citations actionable and readable**

Render filename, page or timestamp, and source type in a compact citation control; clicking it must open the original local source or a recoverable missing-source state. Do not display a citation chip that has no action.

- [ ] **Step 4: Exercise LM Studio and NVIDIA through the real adapters**

Run the provider smoke and isolated browser smoke against the configured LM Studio model and NVIDIA `NVIDIA_API_KEY`. Capture model IDs, latency, HTTP status, and failure reasons without logging credentials.

- [ ] **Step 5: Commit**

Use commit message `fix: improve grounded and general chat behavior`.

### Task 5: Validate the complete user workflow and responsive UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `tests/e2e/workspace.spec.ts`
- Modify: `tests/desktop-ui/studentllm.spec.mjs`
- Test: Playwright browser and desktop UI suites plus axe checks

**Interfaces:**
- Consumes: the stabilized document, recording, provider, and retrieval flows.
- Produces: a minimal responsive interface with clear user/assistant separation, consistent light/dark surfaces, predictable sidebar hierarchy, readable source chips, and no fake course data in a fresh workspace.

- [ ] **Step 1: Add failing responsive assertions**

At 320px, 768px, and desktop widths assert no horizontal overflow, visible composer focus, usable source preview, separated message groups, aligned provider metadata, and a sidebar without decorative child borders.

- [ ] **Step 2: Fix the smallest CSS/component boundaries**

Preserve the existing visual language, remove redundant controls, keep Quick Start visibly random/provisional, and ensure every modal and menu has keyboard dismissal and an accessible name.

- [ ] **Step 3: Run browser and desktop UI tests with axe**

Treat console errors, failed source opening, broken formulas, layout overflow, and serious/critical accessibility violations as failures.

- [ ] **Step 4: Commit**

Use commit message `fix: finish responsive workspace interaction states`.

### Task 6: Run real public benchmark campaigns and publish receipts

**Files:**
- Modify: `benchmarks/run_beir_bm25.py`, `benchmarks/run_beir_dense.py`, `benchmarks/run_beir_hybrid.py`, `benchmarks/run_beir_rerank.py`
- Modify: `benchmarks/run_mtrag_retrieval.py`, `benchmarks/run_mtrag_generation.py`, `benchmarks/run_crag.py`
- Modify: `docs/benchmarks.md`, `docs/status.md`
- Test: benchmark adapter unit tests and receipt validators

**Interfaces:**
- Consumes: public datasets, official qrels/evaluators, one-worker GPT OSS generation, local CUDA embeddings where available, and the configured NVIDIA/LM Studio endpoints.
- Produces: reproducible receipts with commit, dataset split, model, parameters, counts, failures, latency, and SHA-256; no self-made easy benchmark is accepted as a frontier score.

- [ ] **Step 1: Verify dataset and evaluator availability before spending compute**

Run each runner's `--help` and adapter tests, confirm the exact public files and official evaluator versions, and stop any campaign whose source or evaluator is unavailable rather than substituting a private or synthetic set.

- [ ] **Step 2: Run complete selected BEIR collections**

Run BM25, dense, hybrid, and rerank profiles on the documented complete collections with fixed seeds and receipt output. Compare retrieval metrics without silently promoting a weaker profile.

- [ ] **Step 3: Run complete MTRAG retrieval and generation**

Run the official four-collection retrieval qrels and the selected public generation split with one worker, maximum safe context, bounded retries, and checkpointing. Evaluate with IBM's official evaluator and retain failed records in the receipt.

- [ ] **Step 4: Run CRAG validation and public campaigns**

Run the available official split(s) with the corrected judge protocol, deterministic exact match before judge calls, one worker, and resumable checkpoints. Report quality honestly even when the target is missed.

- [ ] **Step 5: Update benchmark docs and add receipt integrity tests**

Validate required fields and SHA-256 values, document exact commands, and mark each target as met, measured-but-unmet, or blocked by external data/access.

- [ ] **Step 6: Commit benchmark evidence separately**

Use commit message `docs: publish reproducible public benchmark evidence`.

### Task 7: Release gate and publication cycle

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/status.md`
- Modify: `docs/architecture.md`
- Modify: `CONTRIBUTING.md`
- Test: `npm run verify`, `npm run desktop:check`, CI, and clean working-tree checks

**Interfaces:**
- Consumes: all completed slices, receipts, and CI artifacts.
- Produces: a professional English repository, a release decision based on evidence, and a squash-merged PR with deleted branch.

- [ ] **Step 1: Reconcile README, status, roadmap, and benchmark claims**

Remove stale counts, distinguish local proof from external-service proof, and keep all remaining blockers explicit.

- [ ] **Step 2: Run the full verification matrix from a clean checkout state**

Run TypeScript, all Vitest suites, benchmark adapter tests, production build, Playwright, desktop checks, provider smoke when services are available, npm audit, and `git diff --check`.

- [ ] **Step 3: Create a focused feature branch and PR**

Push one coherent slice, wait for all required CI jobs, squash merge only after green checks, delete the remote/local branch and worktree, then fast-forward `main`.

- [ ] **Step 4: Perform the final release gate**

Report exact evidence, exact external blockers, and whether the application is production-ready, release-candidate-ready, or still blocked. Never use “100%” as a substitute for a missing measurement.

