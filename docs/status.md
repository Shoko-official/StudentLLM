# Project status

Last validated: 2026-08-29

StudentLLM is an active local-first learning workspace. The application workflow is covered by automated tests and live integration checks. Public benchmark coverage is growing, but the evidence below is intentionally separated by scope.

## Delivered and verified

| Area | Evidence | Current result |
| --- | --- | --- |
| Application verification | `npm run verify` | TypeScript, benchmark adapter checks, 59 Vitest tests, Vite production build, and 21 Playwright tests pass |
| Browser accessibility | Playwright plus axe | No serious or critical violations observed; mobile overflow, navigation, and Escape dismissal regressions pass |
| Local persistence | Vitest and Playwright | Course isolation, reload recovery, corrupted export rejection, source blob fidelity, audio recovery, and deletion flows pass |
| LM Studio integration | Existing `llama-server` process, live provider smoke, browser chat, and public DROP probe | The existing `openai/gpt-oss-20b` process is reachable through the LM Studio router on `127.0.0.1:1234`; live browser chat returned HTTP 200 and rendered an 886-character answer with no page or console errors. A larger local DROP run was interrupted before writing a receipt and is not counted as a score |
| NVIDIA integration | Live provider smoke and official BFCL, BIG-Bench Hard, ARC-Challenge, IFEval, TruthfulQA, HumanEval, HumanEval+, MBPP+, GSM8K, MATH-500, and AIME evaluations | NIM requests pass using the Windows User `NVIDIA_API_KEY` environment variable; sixteen BFCL public category samples, the complete 27-configuration BBH zero-shot group, complete ARC-Challenge, IFEval, TruthfulQA, HumanEval, HumanEval+, and MBPP+ tasks, the complete GSM8K and MATH-500 test splits, and complete AIME 2024 and AIME 2025 samples completed |
| Local speech pipeline | Public FLEURS sample, sidecar, and browser recording | Timestamped transcription and review-segment rendering pass |
| Local document pipeline | Public arXiv PDF, sidecar, and browser import | 15/15 pages indexed and page-level review content rendered |
| Tauri desktop shell | Rust `cargo check` and native-window build path | Shell scaffold added; browser workspace remains the frontend entry point; SQLite WAL and packaged installer validation remain pending |

## Public benchmark evidence

| Benchmark | Scope | Result status |
| --- | --- | --- |
| FLEURS French ASR | Complete public `fr_fr` test split, 676 examples | WER 13.5677%, CER 4.9086%, RTF 0.1840 |
| MLS French ASR | Complete public French test split, 2,426 examples | WER 13.0395%, CER 5.6910%, RTF 0.1648 |
| FLEURS plus MUSAN robustness | 100 public FLEURS examples, clean plus four MUSAN source categories at 10 dB and 0 dB | Composite public-data check; WER 15.7592% clean and 17.3696%-84.4709% across noisy conditions |
| BEIR retrieval | Complete public test splits for SciFact, NFCorpus, ArguAna, SCIDOCS, FiQA, and TREC-COVID | BM25 and dense receipts plus comparisons recorded in [`benchmarks.md`](./benchmarks.md) |
| MTEB | Complete public STSBenchmark v2 and STS22 v2 tasks | Spearman and per-subset results recorded in [`benchmarks.md`](./benchmarks.md) |
| BFCL V4 through LM Studio | Seven public categories, 20 cases per category | Official category scores recorded; multi-turn negative cases expose format compatibility failures |
| BFCL V4 through NVIDIA NIM | Sixteen public category samples, `openai/gpt-oss-20b` | `simple_python` 45.00%; `multiple` 5.00%; `parallel_multiple` 0.00%; `live_parallel_multiple` 0.00% (0/24); `live_relevance` 87.50% (14/16); `live_irrelevance` 96.88% (124/128 sampled from 884); multi-turn and remaining categories are partial samples |
| MMLU-Pro | Public 140- and 280-item samples across all 14 categories through LM Studio and NVIDIA NIM | LM Studio `21.43%` on 140 items; NVIDIA `28.57%` on 140 and `28.21%` on 280; partial samples, not leaderboard scores |
| BIG-Bench Hard | Complete official `bbh_zeroshot` group, 27 task configurations, 6,511 public cases through NVIDIA NIM | Flexible-extract exact match `74.74%` (4,866/6,511, stderr `0.47%`); 152 empty provider responses retained; complete public group result for harness version `0.4.12` |
| GSM8K | Complete public `openai/gsm8k` test split, 1,319 problems through NVIDIA NIM | Flexible-extract exact match `85.44%` (1,127/1,319, stderr `0.97%`); strict-match `0.00%`; complete single-task result |
| MATH-500 | Complete public `HuggingFaceH4/MATH-500` test split, 500 problems, four-shot through NVIDIA NIM | `math_verify` `82.20%` (411/500, stderr `1.71%`); legacy `exact_match` `0.00%`; complete single-task result |
| AIME 2024 and AIME 2025 | Complete public 30-problem set for each year through NVIDIA NIM | AIME 2024 `36.67%` (11/30, stderr `8.95%`); AIME 2025 `30.00%` (9/30, stderr `8.51%`); complete year samples |
| ARC-Challenge | Complete public `allenai/ai2_arc` test split, 1,172 questions through NVIDIA NIM | Exact match `84.73%` (993/1,172, stderr `1.05%`); zero empty responses; complete single-task result |
| IFEval | Complete public official task, 541 prompts through NVIDIA NIM | Prompt strict `70.24%` (stderr `1.97%`); instruction strict `78.78%`; prompt loose `74.12%` (stderr `1.88%`); instruction loose `81.77%`; four empty provider responses included |
| TruthfulQA generation | Complete public `truthfulqa_gen` validation split, 817 questions through NVIDIA NIM | BLEU accuracy `35.13%` (stderr `1.67%`); ROUGE-1 accuracy `38.56%` (stderr `1.70%`); ROUGE-2 accuracy `27.78%` (stderr `1.57%`); ROUGE-L accuracy `39.17%` (stderr `1.71%`); 289 null-content placeholders included |
| DROP reading comprehension | Public `EleutherAI/drop` validation split, 512 of 9,536 examples through NVIDIA NIM | Exact match `0.20%` (1/512); F1 `11.09%` (stderr `0.61%`); one empty provider response retained; partial public sample |
| HumanEval | Complete public `openai/openai_humaneval` test split, 164 problems through NVIDIA NIM with the official Linux scorer | `pass@1` `0.00%` (0/164) for both `humaneval_instruct` and `humaneval`; zero empty responses; explanation-first output format is incompatible with the official code-only filters |
| HumanEval+ | Complete public 164-problem EvalPlus evaluation through NVIDIA NIM | Base `pass@1` `89.63%` (147/164); HumanEval+ `pass@1` `82.32%` (135/164); one non-compilable sanitised sample retained as a failure |
| MBPP+ | Complete public 378-problem EvalPlus evaluation through NVIDIA NIM | MBPP base `pass@1` `85.71%` (324/378); MBPP+ `pass@1` `68.52%` (259/378); three non-compilable sanitised samples retained as failures |
| DocVQA | Public 100-image OCR extractability diagnostic | Normalized answer visibility 86.00%; not official ANLS |

Detailed commands, model versions, hardware, validity labels, and local receipt paths are maintained in [`benchmarks.md`](./benchmarks.md). Raw receipts stay local and ignored by Git.

## Remaining benchmark coverage

The following targets are not yet complete product evidence:

- Common Voice French WER by accent and noise;
- CoVoST 2 speech translation BLEU and COMET;
- AMI far-field WER, DER, and SA-WER;
- MUSAN noise robustness by SNR;
- DIHARD and VoxConverse diarization metrics;
- OmniDocBench parsing metrics, official DocVQA ANLS, and PubTabNet TEDS;
- full MTEB, BEIR, BFCL, MMLU-Pro, and Ragas evaluation suites;
- versioned LectureBench held-out classroom and document scenarios;
- SQLite WAL and Tauri runtime validation, crash recovery soak, and cross-platform desktop checks.
- additional code-generation protocols;

## Data-source notes

The Hugging Face `mozilla-foundation/common_voice_17_0` repository now contains metadata only; its dataset card states that Common Voice datasets are exclusively available through [Mozilla Data Collective](https://datacollective.mozillafoundation.org) as of October 2025. The current `datasets` runtime rejects `facebook/covost2` because its legacy dataset script is no longer supported. The official `gpqa_diamond_zeroshot` task was also loaded far enough to confirm that its `Idavidrein/gpqa` source is gated; the run stopped before generation because no Hugging Face token was configured. These are data-access or tooling findings, not benchmark scores. The official source paths remain listed in [`benchmarks.md`](./benchmarks.md) for the next integration pass.

## Delivery state

Changes are delivered through short-lived branches and pull requests into `main`. Recent verified deliveries include PR [#80](https://github.com/Shoko-official/StudentLLM/pull/80) for the NVIDIA MMLU-Pro evaluation, PR [#81](https://github.com/Shoko-official/StudentLLM/pull/81) for TREC-COVID retrieval coverage, PR [#82](https://github.com/Shoko-official/StudentLLM/pull/82) for NVIDIA BFCL coverage, PR [#83](https://github.com/Shoko-official/StudentLLM/pull/83) for status history, PR [#84](https://github.com/Shoko-official/StudentLLM/pull/84) for bounded BFCL provider requests, PR [#85](https://github.com/Shoko-official/StudentLLM/pull/85) for long-context BFCL coverage and cold-start browser tests, PR [#86](https://github.com/Shoko-official/StudentLLM/pull/86) for the expanded NVIDIA MMLU-Pro sample, PR [#87](https://github.com/Shoko-official/StudentLLM/pull/87) for the first public BBH task and the offline chat test stabilization, PR [#88](https://github.com/Shoko-official/StudentLLM/pull/88) for the second public BBH task, PR [#89](https://github.com/Shoko-official/StudentLLM/pull/89) for the third public BBH task, PR [#90](https://github.com/Shoko-official/StudentLLM/pull/90) for the fourth public BBH task, PR [#91](https://github.com/Shoko-official/StudentLLM/pull/91) for the fifth public BBH task, PR [#92](https://github.com/Shoko-official/StudentLLM/pull/92) for the complete GSM8K evaluation, PR [#93](https://github.com/Shoko-official/StudentLLM/pull/93) for Windows-compatible MATH-500 scoring, PR [#94](https://github.com/Shoko-official/StudentLLM/pull/94) for AIME 2024 and AIME 2025 coverage, PR [#95](https://github.com/Shoko-official/StudentLLM/pull/95) for the complete ARC-Challenge evaluation, PR [#96](https://github.com/Shoko-official/StudentLLM/pull/96) for the complete IFEval evaluation, PR [#98](https://github.com/Shoko-official/StudentLLM/pull/98) for the official HumanEval Linux runner, PR [#99](https://github.com/Shoko-official/StudentLLM/pull/99) for the independent HumanEval+ public code evaluator, PR [#100](https://github.com/Shoko-official/StudentLLM/pull/100) for the complete MBPP+ public code evaluation, and PR [#101](https://github.com/Shoko-official/StudentLLM/pull/101) for the complete TruthfulQA generation evaluation. Their PR checks and post-merge GitHub Actions runs passed, and the temporary branches were deleted.
