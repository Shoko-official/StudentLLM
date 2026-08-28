# Project status

Last validated: 2026-08-28

StudentLLM is an active local-first learning workspace. The application workflow is covered by automated tests and live integration checks. Public benchmark coverage is growing, but the evidence below is intentionally separated by scope.

## Delivered and verified

| Area | Evidence | Current result |
| --- | --- | --- |
| Application verification | `npm run verify` | TypeScript, benchmark adapter checks, 59 Vitest tests, Vite production build, and 20 Playwright tests pass |
| Browser accessibility | Playwright plus axe | No serious or critical violations observed; mobile overflow and navigation regressions pass |
| Local persistence | Vitest and Playwright | Course isolation, reload recovery, corrupted export rejection, source blob fidelity, audio recovery, and deletion flows pass |
| LM Studio integration | Historical live provider smoke and browser chat | Last live check passed on 2026-08-27; latest audit found no listener on `127.0.0.1:1234`, so no new local benchmark is recorded |
| NVIDIA integration | Live provider smoke and official BFCL, GSM8K, and MATH-500 evaluations | NIM requests pass using the Windows User `NVIDIA_API_KEY` environment variable; seven BFCL public category samples, the complete GSM8K test split, and the complete MATH-500 test split completed |
| Local speech pipeline | Public FLEURS sample, sidecar, and browser recording | Timestamped transcription and review-segment rendering pass |
| Local document pipeline | Public arXiv PDF, sidecar, and browser import | 15/15 pages indexed and page-level review content rendered |

## Public benchmark evidence

| Benchmark | Scope | Result status |
| --- | --- | --- |
| FLEURS French ASR | Complete public `fr_fr` test split, 676 examples | WER 13.5677%, CER 4.9086%, RTF 0.1840 |
| MLS French ASR | Complete public French test split, 2,426 examples | WER 13.0395%, CER 5.6910%, RTF 0.1648 |
| FLEURS plus MUSAN robustness | 100 public FLEURS examples, clean plus four MUSAN source categories at 10 dB and 0 dB | Composite public-data check; WER 15.7592% clean and 17.3696%-84.4709% across noisy conditions |
| BEIR retrieval | Complete public test splits for SciFact, NFCorpus, ArguAna, SCIDOCS, FiQA, and TREC-COVID | BM25 and dense receipts plus comparisons recorded in [`benchmarks.md`](./benchmarks.md) |
| MTEB | Complete public STSBenchmark v2 and STS22 v2 tasks | Spearman and per-subset results recorded in [`benchmarks.md`](./benchmarks.md) |
| BFCL V4 through LM Studio | Seven public categories, 20 cases per category | Official category scores recorded; multi-turn negative cases expose format compatibility failures |
| BFCL V4 through NVIDIA NIM | Seven public categories, 20 cases per category, `openai/gpt-oss-20b` | `simple_python` 45.00%; `multiple` 5.00%; `parallel_multiple` 0.00%; `multi_turn_base` 25.00%; `multi_turn_miss_func` 15.00%; `multi_turn_miss_param` 10.00%; `multi_turn_long_context` 15.00%; partial samples |
| MMLU-Pro | Public 140- and 280-item samples across all 14 categories through LM Studio and NVIDIA NIM | LM Studio `21.43%` on 140 items; NVIDIA `28.57%` on 140 and `28.21%` on 280; partial samples, not leaderboard scores |
| BIG-Bench Hard | Five official tasks, 250 public cases per task through NVIDIA NIM | `logical_deduction_seven_objects`: flexible-extract `59.20%`; `multistep_arithmetic_two`: flexible-extract `96.40%`, strict-match `64.80%`; `tracking_shuffled_objects_seven_objects`: flexible-extract `85.20%`; `dyck_languages`: flexible-extract `3.60%`, strict-match `3.20%`; `reasoning_about_colored_objects`: flexible-extract `48.80%`; five task samples, not a full BBH result |
| GSM8K | Complete public `openai/gsm8k` test split, 1,319 problems through NVIDIA NIM | Flexible-extract exact match `85.44%` (1,127/1,319, stderr `0.97%`); strict-match `0.00%`; complete single-task result |
| MATH-500 | Complete public `HuggingFaceH4/MATH-500` test split, 500 problems, four-shot through NVIDIA NIM | `math_verify` `82.20%` (411/500, stderr `1.71%`); legacy `exact_match` `0.00%`; complete single-task result |
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

## Data-source notes

The Hugging Face `mozilla-foundation/common_voice_17_0` repository now contains metadata only; its dataset card states that Common Voice datasets are exclusively available through [Mozilla Data Collective](https://datacollective.mozillafoundation.org) as of October 2025. The current `datasets` runtime rejects `facebook/covost2` because its legacy dataset script is no longer supported. The official `gpqa_diamond_zeroshot` task was also loaded far enough to confirm that its `Idavidrein/gpqa` source is gated; the run stopped before generation because no Hugging Face token was configured. These are data-access or tooling findings, not benchmark scores. The official source paths remain listed in [`benchmarks.md`](./benchmarks.md) for the next integration pass.

## Delivery state

Changes are delivered through short-lived branches and pull requests into `main`. Recent verified deliveries include PR [#80](https://github.com/Shoko-official/StudentLLM/pull/80) for the NVIDIA MMLU-Pro evaluation, PR [#81](https://github.com/Shoko-official/StudentLLM/pull/81) for TREC-COVID retrieval coverage, PR [#82](https://github.com/Shoko-official/StudentLLM/pull/82) for NVIDIA BFCL coverage, PR [#83](https://github.com/Shoko-official/StudentLLM/pull/83) for status history, PR [#84](https://github.com/Shoko-official/StudentLLM/pull/84) for bounded BFCL provider requests, PR [#85](https://github.com/Shoko-official/StudentLLM/pull/85) for long-context BFCL coverage and cold-start browser tests, PR [#86](https://github.com/Shoko-official/StudentLLM/pull/86) for the expanded NVIDIA MMLU-Pro sample, PR [#87](https://github.com/Shoko-official/StudentLLM/pull/87) for the first public BBH task and the offline chat test stabilization, PR [#88](https://github.com/Shoko-official/StudentLLM/pull/88) for the second public BBH task, PR [#89](https://github.com/Shoko-official/StudentLLM/pull/89) for the third public BBH task, PR [#90](https://github.com/Shoko-official/StudentLLM/pull/90) for the fourth public BBH task, PR [#91](https://github.com/Shoko-official/StudentLLM/pull/91) for the fifth public BBH task, and PR [#92](https://github.com/Shoko-official/StudentLLM/pull/92) for the complete GSM8K evaluation. Their PR checks and post-merge GitHub Actions runs passed, and the temporary branches were deleted.
