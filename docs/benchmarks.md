# Benchmark evidence and release gates

## Measurement methodology

A passing UI test demonstrates an interface workflow. It does not measure ASR, OCR, retrieval, or generation quality. StudentLLM records the dataset, model version, hardware, quantization, seed, command, raw output, and validity of every published result.

Regression checks complement the public benchmark results below. Each reported score identifies its dataset, split, model configuration, and evaluation scope.

## Available local checks

| Check | Method | Command | Observed result |
| --- | --- | --- | --- |
| TypeScript | TypeScript project check | `npm run check` | PASS |
| Benchmark adapters | Python bytecode compilation | `npm run benchmarks:check` | PASS |
| UI and storage | Vitest + Testing Library | `npm run test:run` | PASS, 90 tests |
| Production artifact | Vite | `npm run build` | PASS |
| Browser workflow | Playwright Chromium + axe | `npm run test:e2e` | PASS, 32 tests |
| Live web smoke | Python Playwright against the running Vite interface | `$env:PYTHONUTF8='1'; python scripts/live_web_smoke.py` | PASS observed on 2026-09-01; page load, new-course dialog, Escape dismissal, and zero page or console errors |
| FLEURS French ASR | Full public test split, faster-whisper small on CPU | `benchmarks/run_asr_fleurs.py --config fr_fr --split test` | WER 0.1357, CER 0.0491, RTF 0.184 |
| MLS French ASR | Full public test split from `facebook/multilingual_librispeech`, faster-whisper small on CPU | `benchmarks/run_asr_hf.py --dataset facebook/multilingual_librispeech --config french --split test --reference-field transcript --language fr --device cpu --compute-type int8` | WER 0.1304, CER 0.0569, RTF 0.1648 |
| FLEURS plus MUSAN robustness | 100 public FLEURS test examples mixed with four public MUSAN sources at 10 dB and 0 dB | `benchmarks/run_asr_musan.py --musan-root artifacts\\benchmarks\\musan --limit 100 --snrs 10,0` | Clean WER 0.1576; noisy WER 0.1737-0.8447 at 10/0 dB across public MUSAN categories |
| Local ASR sidecar | Python service plus public FLEURS request | `npm run asr:server` with `POST /transcribe` | PASS observed on 2026-08-27; public sample returned timestamped output |
| Local ASR browser recording | Playwright browser, durable recording, public FLEURS audio, and running faster-whisper sidecar | Manual live UI check | PASS observed on 2026-08-27; one French review segment rendered, 0 page errors |
| Local document sidecar | PyMuPDF and RapidOCR service plus public arXiv source | `npm run document:server` with `POST /extract` | PASS observed on 2026-08-27; PDF 15/15 pages, rasterized page 69 OCR blocks |
| Local document browser import | Playwright UI plus the running PyMuPDF sidecar and public arXiv PDF | Manual live UI check | PASS observed on 2026-08-27; source stored, 15 pages indexed, `Page 1` visible, 0 page errors |
| DocVQA OCR diagnostic | Public DocVQA validation images plus RapidOCR | `benchmarks/run_docvqa_ocr.py --split validation --limit 100` | Normalized reference-answer visibility `0.8600` on 100 samples; partial diagnostic |
| DocVQA ANLS vision evaluation | Public DocVQA validation images through NVIDIA `meta/llama-3.2-11b-vision-instruct` | `benchmarks/run_docvqa_anls.py --split validation --limit 100 --concurrency 4` | Official ANLS `0.8591` on 100/100 successful public validation examples; partial subset |
| RAG unanswerable guard | Provider call suppression with no retrieved passage | App integration test | PASS; unsupported questions return a refusal without a provider request |
| NVIDIA generation | Live API, runtime credential from the Windows User environment | `npm run providers:smoke` | PASS observed on 2026-08-30 with `openai/gpt-oss-20b`, 1,374 ms |
| LM Studio generation | Live local server, existing process | `npm run providers:smoke` | PASS observed on 2026-08-30 with `qwen/qwen3-4b`, 20,199 ms; the existing model process was not restarted |
| LM Studio browser chat | Playwright UI path through the built-in Vite same-origin proxy to the existing process | Manual live UI check | PASS observed on 2026-08-28; HTTP 200, 886-character model answer, 0 page or console errors |
| BEIR SciFact retrieval | Full public test split, deterministic BM25 | `benchmarks/run_beir_bm25.py --dataset scifact` | nDCG@10 0.6593, Recall@10 0.7809, MRR@10 0.6252 |
| BEIR SciFact dense retrieval | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset scifact --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.7200, Recall@10 0.8452, MRR@10 0.6845; 14.873 seconds |
| BEIR NFCorpus retrieval | Full public test split, deterministic BM25 | `benchmarks/run_beir_bm25.py --dataset nfcorpus` | nDCG@10 0.3037, Recall@10 0.1423, MRR@10 0.5137 |
| BEIR NFCorpus dense retrieval | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset nfcorpus --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.3393, Recall@10 0.1583, MRR@10 0.5299; 64.003 seconds |
| BEIR ArguAna BM25 retrieval | Full public test split, deterministic BM25 | `benchmarks/run_beir_bm25.py --dataset arguana --output_path artifacts/benchmarks/beir-arguana-bm25.json` | nDCG@10 0.3132, Recall@10 0.6636, MRR@10 0.2030; 1,406/1,406 queries, 8,674 corpus documents, 178.241 seconds |
| BEIR ArguAna dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset arguana --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.4287, Recall@10 0.8414, MRR@10 0.2956 |
| BEIR ArguAna dense retrieval on CUDA | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset arguana --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.4287, Recall@10 0.8414, MRR@10 0.2956; 21.863 seconds |
| BEIR SCIDOCS dense retrieval on CUDA | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset scidocs --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.1973, Recall@10 0.2091, MRR@10 0.3344; 38.282 seconds |
| BEIR SCIDOCS dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset scidocs --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.1973, Recall@10 0.2091, MRR@10 0.3344 |
| BEIR FiQA dense retrieval on CUDA | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset fiqa --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.3848, Recall@10 0.4396, MRR@10 0.4650; 57.480 seconds |
| BEIR FiQA dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset fiqa --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.3848, Recall@10 0.4396, MRR@10 0.4650 |
| BEIR TREC-COVID dense retrieval on CUDA | Full public test split, BGE-small normalized embeddings on local CUDA | `benchmarks/run_beir_dense.py --dataset trec-covid --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 0.6438, Recall@10 0.0183, MRR@10 0.8779; 221.038 seconds |
| BEIR TREC-COVID retrieval | Full public test split, deterministic BM25 and BGE-small dense retrieval | `benchmarks/run_beir_bm25.py --dataset trec-covid` and `benchmarks/run_beir_dense.py --dataset trec-covid --model BAAI/bge-small-en-v1.5 --device cpu` | BM25 nDCG@10 0.5537, Recall@10 0.0157, MRR@10 0.7906; dense nDCG@10 0.6438, Recall@10 0.0184, MRR@10 0.8779 |
| MTEB STSBenchmark v2 | Official public test task, BGE-small sentence embeddings | `benchmarks/run_mteb.py --task STSBenchmark.v2 --model BAAI/bge-small-en-v1.5 --device cpu` | Spearman main score 0.857289 |
| MTEB STS22 v2 | Official public multilingual test task, BGE-small sentence embeddings | `benchmarks/run_mteb.py --task STS22.v2 --model BAAI/bge-small-en-v1.5 --device cpu` | 18 subsets, unweighted descriptive macro-average 0.469262; language spread 0.181685-0.740204 |
| MTEB STS22 v2 on CUDA | Official public multilingual test task, BGE-small sentence embeddings on local CUDA | `benchmarks/run_mteb.py --task STS22.v2 --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | 18 subsets, unweighted descriptive macro-average 0.469258; 17.278 seconds; language spread 0.181685-0.740204 |
| MTEB Banking77Classification v2 on CUDA | Official public 77-intent classification task, BGE-small sentence embeddings on local CUDA | `benchmarks/run_mteb.py --task Banking77Classification.v2 --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 128` | Accuracy `0.817555`; macro F1 `0.808097`; precision `0.838071`; recall `0.817389`; 3,076 test items; 15.704 seconds |
| MTEB NQ on CUDA | Official public Natural Questions retrieval task, BGE-small normalized embeddings on local CUDA | `benchmarks/run_mteb.py --task NQ --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 `0.501790`; Recall@10 `0.708290`; MRR@10 `0.451624`; 3,452 test queries over 2,681,468 corpus passages; 1,411.804 seconds |
| MTEB HotpotQA on CUDA | Official public multi-hop question retrieval task, BGE-small normalized embeddings on local CUDA | `benchmarks/run_mteb.py --task HotpotQA --model BAAI/bge-small-en-v1.5 --device cuda --batch-size 64` | nDCG@10 `0.699310`; Recall@10 `0.727890`; MRR@10 `0.841258`; 14,810 test queries over 5,233,329 corpus passages; 1,967.274 seconds |
| ARC-Challenge | Complete public ARC-Challenge test split through the official generation-compatible chat task | `benchmarks/run_arc.py` with `arc_challenge_chat` and NVIDIA NIM | Exact match 0.8473 (993/1,172), stderr 0.0105; no empty responses |
| IFEval | Complete public instruction-following task through the official generation harness | `python -m lm_eval run` with `ifeval` and NVIDIA NIM | Prompt strict 0.7024; instruction strict 0.7878; prompt loose 0.7412; instruction loose 0.8177 |
| TruthfulQA generation | Complete public `truthfulqa_gen` validation split, 817 questions through the official generation harness | `python -m lm_eval run` with `truthfulqa_gen` and NVIDIA NIM | BLEU accuracy 0.3513, ROUGE-1 accuracy 0.3856, ROUGE-2 accuracy 0.2778, ROUGE-L accuracy 0.3917; 289 null-content placeholders retained |
| DROP reading comprehension | Public `EleutherAI/drop` validation split, 512 of 9,536 examples through NVIDIA NIM | `python -m lm_eval run` with `drop`, `--limit 512`, and the OpenAI-compatible NVIDIA endpoint | Exact match 0.0020, F1 0.1109, F1 stderr 0.0061; one empty provider response retained; partial public sample |
| BIG-Bench Hard zero-shot suite | Official public `bbh_zeroshot` group, 27 task configurations, 6,511 cases through NVIDIA NIM | `python -m lm_eval run` with `bbh_zeroshot` and the OpenAI-compatible NVIDIA endpoint | Flexible-extract exact match 0.7474 (4,866/6,511), stderr 0.0047; 152 empty provider responses retained |
| HumanEval | Complete public `openai/openai_humaneval` test split, 164 problems through NVIDIA NIM with the official Linux code evaluator | `benchmarks/run_humaneval_wsl.sh` with legacy tasks and the separate `--code-only` protocol | Legacy `humaneval` and `humaneval_instruct` scored `0.0000`; the explicit code-only protocol scored `0.8780` (144/164, stderr `0.0256`) |
| HumanEval+ | Complete public 164-problem HumanEval+ evaluation through the official EvalPlus evaluator | `benchmarks/run_evalplus_wsl.sh` with a code-only prompt and NVIDIA NIM | Base `pass@1` 0.8963 (147/164); HumanEval+ `pass@1` 0.8232 (135/164); one sanitised sample was not compilable and remained a scored failure |
| MBPP+ | Complete public 378-problem MBPP+ evaluation through the official EvalPlus evaluator | `benchmarks/run_evalplus_wsl.sh --dataset mbpp` with a code-only prompt and NVIDIA NIM | MBPP base `pass@1` 0.8571 (324/378); MBPP+ `pass@1` 0.6852 (259/378); three sanitised samples were not compilable and remained scored failures |
| BFCL V4 through LM Studio | Official generator and evaluator against the existing LM Studio endpoint | `python -m bfcl_eval generate` + `python -m bfcl_eval evaluate --partial-eval` | `simple_python`: 1.0000 (20/20); `multiple`: 0.9500 (19/20); `parallel_multiple`: 0.8500 (17/20); `irrelevance`: 1.0000 (20/20); `multi_turn_base`: 0.3000 (6/20); `multi_turn_miss_func`: 0.1500 (3/20); `multi_turn_miss_param`: 0.1500 (3/20); partial category samples |
| BFCL V4 through NVIDIA NIM | Official generator and evaluator through the OpenAI-compatible NVIDIA endpoint | `benchmarks/run_bfcl_openai_compatible.py --category <category> --model openai/gpt-oss-20b --base-url https://integrate.api.nvidia.com/v1` | `simple_python`: 0.4500 (9/20); `simple_java`: 0.0000 (0/20); `simple_javascript`: 0.4500 (9/20); `multiple`: 0.0500 (1/20); `parallel`: 0.0000 (0/20); `parallel_multiple`: 0.0000 (0/20); `live_simple`: 0.8500 (17/20); `live_multiple`: 0.1500 (3/20); `live_parallel`: 0.0000 (0/16); `live_parallel_multiple`: 0.0000 (0/24); `live_relevance`: 0.8750 (14/16); complete `live_irrelevance`: 0.8190 (724/884); `multi_turn_base`: 0.2500 (5/20); `multi_turn_miss_func`: 0.1500 (3/20); `multi_turn_miss_param`: 0.1000 (2/20); `multi_turn_long_context`: 0.1500 (3/20); remaining categories are partial samples |
| BFCL memory-case selection | Wrapper validation plus an interrupted official `memory_kv` generation | `benchmarks/run_bfcl_openai_compatible.py --category memory_kv ...` | Selection now resolves 20 scored targets plus 10 required prerequisites; the live run generated 9/10 prerequisites before being stopped after repeated empty responses and a projected runtime above 90 minutes; no score was produced |

The provider latencies are point observations on the development machine, not production SLOs.

The CUDA ArguAna run evaluated all 1,406 public test queries against 8,674 corpus documents with BAAI/bge-small-en-v1.5, normalized embeddings, and batch size 64. It reproduced the earlier CPU metrics while reducing embedding and scoring time to 21.863 seconds. The receipt is `artifacts/benchmarks/beir-arguana-bge-small-cuda.json`; this is an independent hardware comparison, not a change to the model or retrieval protocol.

The browser chat result uses the built-in Vite same-origin proxy because the unchanged LM Studio endpoint did not return CORS headers. It validates the application request, response, citation, and rendering path without restarting LM Studio; it is not evidence that the endpoint is directly browser-callable without CORS configuration.

## Observed public result: DROP

The DROP run uses the official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) `drop` task and the public [EleutherAI/drop dataset](https://huggingface.co/datasets/EleutherAI/drop). It evaluates the public validation split with the NVIDIA NIM OpenAI-compatible endpoint and keeps the official exact-match and token-level F1 filters.

| Field | Value |
| --- | --- |
| Model | `openai/gpt-oss-20b` through NVIDIA NIM |
| Dataset and split | `EleutherAI/drop`, validation, 9,536 available examples |
| Evaluated scope | 512 public examples selected by harness `--limit 512` |
| Prompting | zero-shot, chat template enabled |
| Generation | `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, `until=None` |
| Seeds | Python, NumPy, Torch, and few-shot seed 42 |
| Concurrency | four API requests |
| Result | exact match `0.0020` (1/512); F1 `0.1109`, stderr `0.0061` |
| Integrity | 512 JSONL rows, 512 unique document IDs, no malformed rows or duplicates, one empty provider response retained |
| Receipt | `artifacts/benchmarks/drop/gpt-oss-20b-nvidia-limit512_2026-08-28T23-21-27.029273.json` |
| Samples | `artifacts/benchmarks/drop/samples_drop_2026-08-28T23-21-27.029273.jsonl` |
| SHA-256 | receipt `58CF2E9CD43EFDB0A77721EB9027F9784B043AE5BCD45A91E42AE1F93D531195`; samples `822C8A72756C643D9EC8667C19DE2988B91853DB7DE319AE9532FF645E2D38A2` |

This is a partial public sample, not a full DROP score or a leaderboard claim. An earlier attempt to run the complete validation split through the existing LM Studio process was interrupted before it produced an aggregate receipt; it is not counted as a result and the model process was left running.

## Observed public result: MMLU-Pro

The first generation benchmark uses the official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) and the public [TIGER-Lab/MMLU-Pro dataset](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro). It calls the LM Studio OpenAI-compatible API without a remote credential.

| Run | Model and backend | Protocol | Result | Validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 1 item per category, seed 42, `temperature=0`, `/no_think` | exact match `0.2143` (3/14) | Technical pipeline pass, partial sample |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 5 items per category, seed 42, `temperature=0`, `/no_think` | exact match `0.3000` (21/70), stderr `0.0484` | Partial public sample; per-category results retained in the local receipt |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 10 items per category, seed 42, `temperature=0`, `/no_think` | exact match `0.2143` (30/140), stderr `0.0347` | Complete 140-item public sample; aggregate and per-task receipts written |
| 2026-08-27 | `openai/gpt-oss-20b` / NVIDIA NIM | same protocol, credential from the Windows User `NVIDIA_API_KEY`, `max_gen_toks=512`, `reasoning_effort=low` | exact match `0.2857` (40/140), stderr `0.0387` | Complete 140-item public sample across all 14 categories; partial benchmark evidence |
| 2026-08-28 | `openai/gpt-oss-20b` / NVIDIA NIM | same protocol, 20 items per category, 14 categories, seed 42, `max_gen_toks=512`, `reasoning_effort=low` | exact match `0.2821` (79/280), stderr `0.0262` | Complete 280-item public sample across all 14 categories; 4,124.09 s evaluation time; partial benchmark evidence |
| 2026-08-30 | `openai/gpt-oss-20b` / NVIDIA NIM | official biology category, all 717 test items, zero-shot, seed 42, `max_gen_toks=512`, `reasoning_effort=low`, four concurrent requests | exact match `0.2720` (195/717), stderr `0.0166` | Complete public category; receipt `artifacts/benchmarks/mmlu-pro/full/mmlu_pro_biology_2026-08-30T17-52-59.449454.json`; the fourteen-category group is still incomplete |
| 2026-08-31 | `openai/gpt-oss-20b` / NVIDIA NIM | official categories, zero-shot, seed 42, `max_gen_toks=512`, `reasoning_effort=low`, two concurrent requests; 13 complete categories | weighted exact match `0.2655` (2,983/11,234), across 13 complete categories | Complete public receipts for biology, business, chemistry, computer science, economics, engineering, health, history, law, math, other, philosophy, and physics; `psychology` interrupted at 34/798 after provider timeouts and has no score; not a complete fourteen-category result |
| 2026-08-31 | `openai/gpt-oss-20b` / NVIDIA NIM | `psychology[50:100]` contiguous resume chunk, zero-shot, seed 42, `max_gen_toks=256`, `reasoning_effort=low`, one concurrent request, one retry | no score; 6/50 requests observed before interruption while provider latency rose to approximately 69.5 seconds per item | Rejected transport attempt; no complete receipt or benchmark score; the runner now records console interruption and stale-process recovery as terminal manifest states |
| 2026-08-31 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | official psychology category, all 798 test items, zero-shot, seed 42, `temperature=0`, `max_gen_toks=256`, 16 contiguous receipts of 48-50 items | exact match `0.2431` (194/798) | Complete public category through the local OpenAI-compatible endpoint; weighted aggregate from 16 official harness receipts; receipt set and aggregate are under `artifacts/benchmarks/mmlu-pro/lmstudio-psychology/`; this is a separate LM Studio result and does not complete the NVIDIA fourteen-category score |
| 2026-09-01 | `openai/gpt-oss-20b` / NVIDIA NIM | all 14 official categories, zero-shot, seed 42, `max_gen_toks=256`, `reasoning_effort=low`, four concurrent requests, contiguous resumable chunks of 50 | weighted exact match `0.2729` (3,284/12,032) | Complete public fourteen-category result; 12,032/12,032 items scored; psychology completed at `0.3772` (301/798); full receipt `artifacts/benchmarks/mmlu-pro/full/mmlu_pro_full_summary.json` |

The complete fourteen-category campaign produced the following public per-category receipts:

| Category | Items | Exact match |
| --- | ---: | ---: |
| Biology | 717 | `27.20%` (195/717) |
| Business | 789 | `40.68%` (321/789) |
| Chemistry | 1,132 | `18.73%` (212/1,132) |
| Computer science | 410 | `34.88%` (143/410) |
| Economics | 844 | `34.24%` (289/844) |
| Engineering | 969 | `11.87%` (115/969) |
| Health | 818 | `28.00%` (229/818) |
| History | 381 | `29.66%` (113/381) |
| Law | 1,101 | `25.61%` (282/1,101) |
| Math | 1,351 | `37.01%` (500/1,351) |
| Other | 924 | `26.52%` (245/924) |
| Philosophy | 499 | `18.24%` (91/499) |
| Physics | 1,299 | `19.09%` (248/1,299) |
| Psychology | 798 | `37.72%` (301/798) |

The weighted aggregate is `27.2939%` exact match, or 3,284 correct answers out of 12,032. It is a complete public MMLU-Pro result for this model and protocol; it remains far below the product target of 99%.

The earlier weighted aggregate was descriptive of 11,234 completed questions only. The resumed campaign now covers all 12,032 questions and is the complete MMLU-Pro result for this model and protocol. The manifest retains the initial interrupted `psychology` run, the rejected chunk retry, and the successful contiguous completion chunks with their exact provider states.

The separate LM Studio campaign completed all 798 public `psychology` questions on `qwen/qwen3-4b`. Its weighted exact match is `0.2431` (194/798), calculated from 16 contiguous `lm-evaluation-harness` receipts with no missing chunk and no malformed receipt. The campaign ran against `http://127.0.0.1:1234/v1/chat/completions` and took approximately 19 minutes including chunk orchestration. It is valid category-level evidence for that local model and endpoint; it must not be combined with the NVIDIA results because the model, backend, and generation budget differ.

The earlier NVIDIA timeout is retained as a failed transport attempt with no score. The 0.2143, 0.3000, 0.2857, and 0.2821 values are public samples, not leaderboard scores. The 280-item receipt includes 20 examples for each of the 14 categories:

| Category | Exact match |
| --- | ---: |
| Biology | `0.2500` (5/20) |
| Business | `0.2500` (5/20) |
| Chemistry | `0.4500` (9/20) |
| Computer science | `0.3000` (6/20) |
| Economics | `0.3500` (7/20) |
| Engineering | `0.1500` (3/20) |
| Health | `0.2500` (5/20) |
| History | `0.1500` (3/20) |
| Law | `0.1000` (2/20) |
| Math | `0.7000` (14/20) |
| Other | `0.3000` (6/20) |
| Philosophy | `0.2500` (5/20) |
| Physics | `0.2500` (5/20) |
| Psychology | `0.2000` (4/20) |

The harness documents that `--limit` is not suitable for a final metric; these runs validate dataset loading, prompt construction, API routing, answer extraction, and metric calculation on public samples. Model strength remains unverified.

## Observed public result: BIG-Bench Hard

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) ran the public [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard) task `bbh_zeroshot_logical_deduction_seven_objects` through the OpenAI-compatible NVIDIA NIM endpoint. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, and one concurrent request.

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | `bbh_zeroshot_logical_deduction_seven_objects`, 250 public cases | Flexible-extract exact match `0.5920` (148/250), stderr `0.0311` | Complete task sample; 1,335.02 s evaluation time; partial BBH evidence |
| 2026-08-28 | `bbh_zeroshot_multistep_arithmetic_two`, 250 public cases | Flexible-extract exact match `0.9640` (241/250), stderr `0.0118`; strict-match `0.6480` (162/250), stderr `0.0303` | Complete task sample; 362.54 s evaluation time; partial BBH evidence |
| 2026-08-28 | `bbh_zeroshot_tracking_shuffled_objects_seven_objects`, 250 public cases | Flexible-extract exact match `0.8520` (213/250), stderr `0.0225`; strict-match `0.0000` (0/250) | Complete task sample; 884.61 s evaluation time; partial BBH evidence |
| 2026-08-28 | `bbh_zeroshot_dyck_languages`, 250 public cases | Flexible-extract exact match `0.0360` (9/250), stderr `0.0118`; strict-match `0.0320` (8/250), stderr `0.0112` | Complete task sample; 776.45 s evaluation time; partial BBH evidence |
| 2026-08-28 | `bbh_zeroshot_reasoning_about_colored_objects`, 250 public cases | Flexible-extract exact match `0.4880` (122/250), stderr `0.0317`; strict-match `0.0000` (0/250) | Complete task sample; 294.17 s evaluation time; partial BBH evidence |

Reproduce the observed run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks bbh_zeroshot_logical_deduction_seven_objects `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low" `
  --seed 42 `
  --output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-logical-deduction-seven-objects.json `
  --log_samples
```

The aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-logical-deduction-seven-objects_2026-08-28T04-09-12.159146.json`. The official flexible-extract metric is reported because the task's strict-match filter produced no matches under this harness configuration. This is one complete public BBH task, not a full BBH suite or a global model ranking.

The arithmetic task uses the same environment, model arguments, and generation settings; change the task and output path to:

```text
--tasks bbh_zeroshot_multistep_arithmetic_two
--output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-multistep-arithmetic-two.json
```

Its aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-multistep-arithmetic-two_2026-08-28T04-24-52.265096.json`. Together these are two complete public task samples, not a full BBH suite or a global model ranking.

The tracking task uses the same environment, model arguments, and generation settings; change the task and output path to:

```text
--tasks bbh_zeroshot_tracking_shuffled_objects_seven_objects
--output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-tracking-shuffled-objects-seven.json
```

Its aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-tracking-shuffled-objects-seven_2026-08-28T04-44-38.193434.json`. The flexible-extract filter is the useful reported metric for this task; strict-match returned no matches under this harness configuration.

The Dyck-language task uses the same environment, model arguments, and generation settings; change the task and output path to:

```text
--tasks bbh_zeroshot_dyck_languages
--output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-dyck-languages.json
```

Its aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-dyck-languages_2026-08-28T05-02-55.787704.json`. Unlike the tracking task, both filters returned non-zero results, and both remain very low. The four task samples are not a full BBH suite or a global model ranking.

The colored-objects task uses the same environment, model arguments, and generation settings; change the task and output path to:

```text
--tasks bbh_zeroshot_reasoning_about_colored_objects
--output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-reasoning-colored-objects.json
```

Its aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-reasoning-colored-objects_2026-08-28T05-12-54.724570.json`. The flexible-extract filter is the useful reported metric for this task; strict-match returned no matches under this harness configuration. The five task samples are not a full BBH suite or a global model ranking.

## Observed public result: complete BIG-Bench Hard zero-shot suite

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard) `bbh_zeroshot` group through the OpenAI-compatible NVIDIA NIM endpoint. The installed official harness enumerated 27 task configurations and 6,511 public cases. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, four concurrent requests, and `until=None`. The harness version was `0.4.12`.

| Task | Cases | Flexible-extract exact match | Strict-match exact match |
| --- | ---: | ---: | ---: |
| `boolean_expressions` | 250 | 1.0000 (250/250) | 0.8960 (224/250) |
| `causal_judgement` | 187 | 0.6257 (117/187) | 0.1604 (30/187) |
| `date_understanding` | 250 | 0.8440 (211/250) | 0.0000 (0/250) |
| `disambiguation_qa` | 250 | 0.5480 (137/250) | 0.0000 (0/250) |
| `dyck_languages` | 250 | 0.0040 (1/250) | 0.0040 (1/250) |
| `formal_fallacies` | 250 | 0.8640 (216/250) | 0.0000 (0/250) |
| `geometric_shapes` | 250 | 0.6480 (162/250) | 0.0000 (0/250) |
| `hyperbaton` | 250 | 0.9240 (231/250) | 0.0000 (0/250) |
| `logical_deduction_five_objects` | 250 | 0.8160 (204/250) | 0.0000 (0/250) |
| `logical_deduction_seven_objects` | 250 | 0.6000 (150/250) | 0.0000 (0/250) |
| `logical_deduction_three_objects` | 250 | 0.9880 (247/250) | 0.0000 (0/250) |
| `movie_recommendation` | 250 | 0.6400 (160/250) | 0.0000 (0/250) |
| `multistep_arithmetic_two` | 250 | 0.6280 (157/250) | 0.2320 (58/250) |
| `navigate` | 250 | 0.9720 (243/250) | 0.6280 (157/250) |
| `object_counting` | 250 | 0.9680 (242/250) | 0.0000 (0/250) |
| `penguins_in_a_table` | 146 | 0.9863 (144/146) | 0.0000 (0/146) |
| `reasoning_about_colored_objects` | 250 | 0.8440 (211/250) | 0.0000 (0/250) |
| `ruin_names` | 250 | 0.5600 (140/250) | 0.0000 (0/250) |
| `salient_translation_error_detection` | 250 | 0.6840 (171/250) | 0.0000 (0/250) |
| `snarks` | 178 | 0.7753 (138/178) | 0.0000 (0/178) |
| `sports_understanding` | 250 | 0.7240 (181/250) | 0.0000 (0/250) |
| `temporal_sequences` | 250 | 0.9200 (230/250) | 0.0000 (0/250) |
| `tracking_shuffled_objects_five_objects` | 250 | 0.8480 (212/250) | 0.0000 (0/250) |
| `tracking_shuffled_objects_seven_objects` | 250 | 0.6520 (163/250) | 0.0000 (0/250) |
| `tracking_shuffled_objects_three_objects` | 250 | 0.9440 (236/250) | 0.0000 (0/250) |
| `web_of_lies` | 250 | 0.8320 (208/250) | 0.0000 (0/250) |
| `word_sorting` | 250 | 0.4160 (104/250) | 0.0280 (7/250) |
| **Aggregate** | **6,511** | **0.7474 (4,866/6,511), stderr 0.0047** | - |

The complete group result is a weighted aggregate over the 6,511 public cases. The receipt retained 152 empty provider responses and the official metrics included them as incorrect outputs; no sample rows were malformed. Because `--log_samples` writes one row for each metric filter, the 27 task files contain 13,022 filter rows representing 6,511 unique cases.

Reproduce the observed full-suite run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe -m lm_eval run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=4,max_retries=3" `
  --tasks bbh_zeroshot `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low,until=None" `
  --seed 42 `
  --output_path artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-full.json `
  --log_samples
```

The aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-full_2026-08-28T10-16-27.620727.json`. The matching per-task sample files use the same timestamp. This is complete public BBH evidence for the task group exposed by harness version `0.4.12`, not a global model ranking.

## Observed public result: GSM8K

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) ran the public [GSM8K](https://github.com/openai/grade-school-math) `gsm8k` task through the OpenAI-compatible NVIDIA NIM endpoint. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, the complete public test split, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, and one concurrent request. The harness version was `0.4.12`.

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | `openai/gsm8k` test split, 1,319 public problems | Flexible-extract exact match `0.8544` (1,127/1,319), stderr `0.0097`; strict-match `0.0000` (0/1,319) | Complete public test split; 2,420.32 s evaluation time; single-task evidence |

Reproduce the observed run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks gsm8k `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low" `
  --seed 42 `
  --output_path artifacts/benchmarks/gsm8k/gpt-oss-20b-nvidia.json `
  --log_samples
```

The aggregate receipt is `artifacts/benchmarks/gsm8k/gpt-oss-20b-nvidia_2026-08-28T05-59-45.464108.json`. This is a complete public GSM8K test split for one model and configuration, not a full general-capability evaluation or a leaderboard ranking.

## Observed public result: MATH-500

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) ran the public [MATH-500](https://huggingface.co/datasets/HuggingFaceH4/MATH-500) test split through the OpenAI-compatible NVIDIA NIM endpoint with the official `minerva_math500` task. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, four-shot prompts, seed 42, `temperature=0`, `max_gen_toks=2048`, `reasoning_effort=low`, and one concurrent request. The harness version was `0.4.12`.

The first direct run generated all 500 answers, but its default Windows `math_verify` timeout path emitted `WinError 6` during per-answer parsing and wrote zero aggregate metrics. That receipt is retained as diagnostic evidence and is not used as a score. The same 500 logged model outputs were re-scored with the official MATH task `process_results` through `benchmarks/rescore_math.py`, which disables only the nested Windows timeout subprocesses for the single-worker evaluation.

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | `HuggingFaceH4/MATH-500` test split, 500 public problems, four-shot | `math_verify` `0.8220` (411/500), stderr `0.0171`; official `exact_match` `0.0000` | Complete public test split; 2,572.14 s generation time; corrected official posthoc scoring |

Run the corrected official evaluator with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_math.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks minerva_math500 `
  --num_fewshot 4 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=2048,reasoning_effort=low" `
  --seed 42 `
  --output_path artifacts/benchmarks/math500/gpt-oss-20b-nvidia.json `
  --log_samples
```

To reproduce the corrected receipt from the completed public generation without making new provider requests:

```powershell
& .\.venv-bench\Scripts\python.exe benchmarks\rescore_math.py `
  artifacts/benchmarks/math500/samples_minerva_math500_2026-08-28T06-51-06.552685.jsonl `
  artifacts/benchmarks/math500/gpt-oss-20b-nvidia_2026-08-28T06-51-06.552685.json `
  artifacts/benchmarks/math500/gpt-oss-20b-nvidia-math-verify-rescored.json
```

The corrected receipt is `artifacts/benchmarks/math500/gpt-oss-20b-nvidia-math-verify-rescored.json`; the initial zero-metric diagnostic receipt is `artifacts/benchmarks/math500/gpt-oss-20b-nvidia_2026-08-28T06-51-06.552685.json`. The `math_verify` value is the usable official metric for this run because the model's boxed mathematical answers did not match the task's legacy `Final Answer: The final answer is ...` string extractor. This is a complete single-task result, not a general model ranking or a full benchmark suite result.

## Observed public result: AIME 2024 and AIME 2025

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [AIME 2024](https://huggingface.co/datasets/Maxwell-Jia/AIME_2024) and [AIME 2025](https://huggingface.co/datasets/math-ai/aime25) problem sets through the OpenAI-compatible NVIDIA NIM endpoint. Both runs used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=32768`, `reasoning_effort=low`, and one concurrent request. The harness version was `0.4.12`. Each set contained 30 public problems and had zero empty responses.

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | Official `aime24`, 30 public problems | Exact match `0.3667` (11/30), stderr `0.0895` | Complete public year sample; 889.95 s evaluation time |
| 2026-08-28 | Official `aime25`, 30 public problems | Exact match `0.3000` (9/30), stderr `0.0851` | Complete public year sample; 460.16 s evaluation time |

Reproduce the AIME 2024 run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks aime24 `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=32768,reasoning_effort=low" `
  --seed 42 `
  --output_path artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime24.json `
  --log_samples
```

For AIME 2025, change `--tasks aime24` to `--tasks aime25` and change the output filename to `gpt-oss-20b-nvidia-aime25.json`. The aggregate receipts are `artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime24_2026-08-28T07-20-06.666685.json` and `artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime25_2026-08-28T07-30-35.078582.json`. These are complete public samples for two AIME years, not a combined leaderboard result or a general model ranking.

## Observed public result: ARC-Challenge

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [AI2 ARC-Challenge](https://allenai.org/data/arc) test split through its official `arc_challenge_chat` generation task. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, and one concurrent request through NVIDIA NIM. The harness version was `0.4.12`.

The standard `arc_challenge` task is a log-likelihood evaluation and cannot run through a chat-completions endpoint. The official generation-compatible `arc_challenge_chat` task was used instead. NVIDIA NIM echoes the task's `The best answer is` assistant prefix in its content; `benchmarks/run_arc.py` removes only that echoed prefix before the official task filter and metric run. The task's default punctuation stop sequence also caused reasoning-only responses with this provider, so the recorded command explicitly sets `until=None`.

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | `allenai/ai2_arc`, `ARC-Challenge` test split, 1,172 public questions | Exact match `0.8473` (993/1,172), stderr `0.0105` | Complete public test split; 0 empty responses; 1,156.65 s evaluation time |

Reproduce the observed run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_arc.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks arc_challenge_chat `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low,until=None" `
  --seed 42 `
  --output_path artifacts/benchmarks/arc-challenge/gpt-oss-20b-nvidia-full.json `
  --log_samples
```

The aggregate receipt is `artifacts/benchmarks/arc-challenge/gpt-oss-20b-nvidia-full_2026-08-28T08-03-59.129683.json`, with the 1,172 logged samples in the matching `samples_arc_challenge_chat_2026-08-28T08-03-59.129683.jsonl` file. This is a complete single-task public result, not a full general-reasoning evaluation or a global model ranking.

## Observed public result: IFEval

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [Google IFEval](https://github.com/google-research/google-research/tree/master/ifeval) task through the OpenAI-compatible NVIDIA NIM endpoint. The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=1280`, `reasoning_effort=low`, four concurrent requests, and the harness's official strict and loose instruction-following metrics. The harness version was `0.4.12` and the task version was `4`.

Install the pinned IFEval environment:

```powershell
& .\.venv-bench\Scripts\python.exe -m pip install -r requirements-ifeval.txt
```

Reproduce the observed complete public task run with the official harness directly:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe -m lm_eval run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=4,max_retries=3" `
  --tasks ifeval `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=1280,reasoning_effort=low,until=None" `
  --seed 42 `
  --output_path artifacts/benchmarks/ifeval/gpt-oss-20b-nvidia-full.json `
  --log_samples
```

| Run | Public scope | Result | Validity |
| --- | --- | --- | --- |
| 2026-08-28 | Official `google/IFEval` task, 541 public prompts | Prompt strict `0.7024` (stderr `0.0197`); instruction strict `0.7878`; prompt loose `0.7412` (stderr `0.0188`); instruction loose `0.8177` | Complete public task; four empty provider responses were retained by the harness and included in the metrics |

The aggregate receipt is `artifacts/benchmarks/ifeval/gpt-oss-20b-nvidia-full_2026-08-28T08-34-22.627222.json`, with 541 logged samples in the matching `samples_ifeval_2026-08-28T08-34-22.627222.jsonl` file. The receipt records `sample_len=541`; the terminal run completed in approximately 1,126 seconds. This is complete single-task instruction-following evidence, not a general model ranking.

## Observed public result: TruthfulQA generation

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [TruthfulQA](https://huggingface.co/datasets/truthfulqa/truthful_qa) `truthfulqa_gen` task through the OpenAI-compatible NVIDIA NIM endpoint. This task uses the public generation validation split and its official BLEU and ROUGE reference-overlap metrics. It is not the `truthfulqa_mc1` or `truthfulqa_mc2` likelihood task and does not use a separate judge model, so these results must not be described as a standalone truthfulness score.

The run used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=256`, four concurrent requests, and up to three retries. The repository adapter adds `/no_think` to the final user message for the OpenAI-compatible request. The harness version was `0.4.12` and the task version was `3`.

Reproduce the complete public validation run with:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=4,max_retries=3" `
  --tasks truthfulqa_gen `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/truthfulqa/gpt-oss-20b-nvidia-full.json `
  --log_samples
```

| Metric | Value | Stderr |
| --- | ---: | ---: |
| `bleu_max` | `5.4202` | `0.3755` |
| `bleu_acc` | `0.3513` | `0.0167` |
| `bleu_diff` | `0.3931` | `0.2509` |
| `rouge1_max` | `20.9657` | `0.7792` |
| `rouge1_acc` | `0.3856` | `0.0170` |
| `rouge1_diff` | `2.3154` | `0.4882` |
| `rouge2_max` | `10.3161` | `0.6013` |
| `rouge2_acc` | `0.2778` | `0.0157` |
| `rouge2_diff` | `0.6846` | `0.4577` |
| `rougeL_max` | `18.9569` | `0.7327` |
| `rougeL_acc` | `0.3917` | `0.0171` |
| `rougeL_diff` | `2.2426` | `0.4834` |

The complete run evaluated all 817 public validation examples in `1,244.89 s`. The sample file contains 817 unique document IDs and 289 null-content placeholders from the provider; those placeholders remain in the denominator and are included in the official metrics. The aggregate receipt is `artifacts/benchmarks/truthfulqa/gpt-oss-20b-nvidia-full_2026-08-28T19-11-55.851418.json`, with samples in `samples_truthfulqa_gen_2026-08-28T19-11-55.851418.jsonl`. The dataset task hash is `911ee70018dbce882fc57ce935a97752ab8188e2d8ce9a0bb1d056be346b4c48`; the sample SHA-256 is `8C05744D3678C5BF5D4C696C4049E73855FA7E4BE304ADC907D41DB7916ACB70` and the receipt SHA-256 is `5EB03138829BA549ED70E2714665549FE33D25A4581E4BC89B587631EDFE479C`. This is complete public generation-task evidence for the stated model and protocol, not a general truthfulness or leaderboard claim.

## Observed public result: HumanEval

The official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) evaluated the public [OpenAI HumanEval](https://huggingface.co/datasets/openai/openai_humaneval) test split through the OpenAI-compatible NVIDIA NIM endpoint. The runs used `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=1024`, `reasoning_effort=low`, four concurrent requests, and `until=None`. The harness version was `0.4.12`. Generation and the official `code_eval` scorer ran inside Ubuntu WSL because the evaluator requires Linux Python test-process support.

The reproducible runner creates or reuses a dedicated WSL environment, retrieves the Windows User environment value at run time, enables the official code-execution evaluation flag, and writes timestamped receipts under `artifacts/benchmarks/humaneval/`:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh --task humaneval
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh --code-only
```

| Task | Public scope | Official result | Validity and finding |
| --- | --- | --- | --- |
| `humaneval_instruct` | `openai/openai_humaneval` test split, 164 problems | `pass@1` `0.0000` (0/164) | Complete public task; `sample_len=164`; zero empty responses; the generated answer began with explanation text and a fenced Python block |
| `humaneval` | `openai/openai_humaneval` test split, 164 problems | `pass@1` `0.0000` (0/164) | Complete public task; `sample_len=164`; zero empty responses; the standard continuation filter received the same explanation-first output format |
| `humaneval_code_only` | `openai/openai_humaneval` test split, 164 problems | `pass@1` `0.8780` (144/164, stderr `0.0256`) | Complete public task; explicit code-only prompt; one empty provider response retained; official scorer completed |

The legacy zero scores remain official benchmark results and format-compatibility findings. The separate code-only protocol uses a repository task definition, extracts a fenced or entry-point code region when needed, and preserves its own receipt. The complete code-only receipt is `artifacts/benchmarks/humaneval/gpt-oss-20b-nvidia-code-only-full_2026-08-30T13-39-52.840104.json`, with per-sample data in `samples_humaneval_code_only_2026-08-30T13-39-52.840104.jsonl`; the sample SHA-256 is `784F0200D9278E0C8632FDA534589423AA25A7533F9954CA74902C926BA50C69` and the receipt SHA-256 is `F0F92CE6ADC93A0C376A027F49F5441AA16A0F5DFA816FE097A0CAA04723F55F`. The result is complete public code-correctness evidence for this model and protocol, not a general coding leaderboard claim.

## Observed public result: HumanEval+ through EvalPlus

The public [EvalPlus](https://github.com/evalplus/evalplus) framework evaluated the HumanEval+ dataset through the OpenAI-compatible NVIDIA NIM endpoint. EvalPlus adds an independent extended test suite to the original HumanEval problems and runs the generated solutions against both the original and extended inputs. The run used EvalPlus `0.3.1`, `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, the official EvalPlus instruction prompt, greedy decoding, `temperature=0`, `reasoning_effort=low`, and one solution per task. The official evaluator ran inside Ubuntu WSL.

The repository bridge handles provider responses whose `content` field is empty while preserving the reasoning field when present, applies the official EvalPlus sanitiser, and writes a resumable JSONL file before invoking the official evaluator:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_evalplus_wsl.sh
```

| Evaluation | Public scope | Official result | Validity |
| --- | --- | --- | --- |
| HumanEval base tests | 164 HumanEval+ tasks, original public tests | `pass@1` `0.8963` (147/164) | Complete public task; greedy one-sample evaluation |
| HumanEval+ base plus extra tests | 164 HumanEval+ tasks, original plus extended public tests | `pass@1` `0.8232` (135/164) | Complete public extended evaluation; greedy one-sample evaluation |

The EvalPlus sample file contains 164 unique task IDs and no empty solutions. The official `evalplus.syncheck` pass found one non-compilable sanitised sample, `HumanEval/118`; the official evaluator included it as a failure. The scorer receipt is `artifacts/benchmarks/humaneval-plus-code-only/samples_humaneval_evalplus_eval_results.json`, with the sanitised samples in `samples_humaneval_evalplus.jsonl` and raw provider captures in `samples_humaneval_evalplus.raw.jsonl`. These are complete public code-correctness results for this model and protocol, not a general coding leaderboard claim.

## Observed public result: MBPP+ through EvalPlus

The public [EvalPlus](https://github.com/evalplus/evalplus) framework evaluated the MBPP+ dataset through the OpenAI-compatible NVIDIA NIM endpoint. The run used EvalPlus `0.3.1`, `openai/gpt-oss-20b`, the Windows User `NVIDIA_API_KEY` environment variable, the official EvalPlus code-generation prompt, greedy decoding, `temperature=0`, `reasoning_effort=low`, and one solution per task. Generation and official evaluation ran inside Ubuntu WSL.

The generalized runner selects the public dataset explicitly and resumes from the existing JSONL sample file:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_evalplus_wsl.sh --dataset mbpp
```

| Evaluation | Public scope | Official result | Validity |
| --- | --- | --- | --- |
| MBPP base tests | 378 MBPP+ tasks, original public tests | `pass@1` `0.8571` (324/378) | Complete public task; greedy one-sample evaluation |
| MBPP+ base plus extra tests | 378 MBPP+ tasks, original plus extended public tests | `pass@1` `0.6852` (259/378) | Complete public extended evaluation; greedy one-sample evaluation |

The sample and result files contain 378 unique task IDs, with no duplicates, empty solutions, or empty raw provider contents. The official `evalplus.syncheck` pass found three non-compilable sanitised samples: `Mbpp/430`, `Mbpp/462`, and `Mbpp/581`; the official evaluator included them as failures. The dataset hash was `ee43ecabebf20deef4bb776a405ac5b1`. The scorer receipt is `artifacts/benchmarks/mbpp-plus-code-only/samples_mbpp_evalplus_eval_results.json`, with sanitised samples in `samples_mbpp_evalplus.jsonl` and raw provider captures in `samples_mbpp_evalplus.raw.jsonl`. The recorded SHA-256 values are `C6F84EBC76211583E41C1834AE693F6D4752040942DC6D70364F9979A7F910AF` for the sanitised samples, `BDC0EFBCF6055394604AA6EF1B9F8B478DD2AA289C0EB54122D885A4E154342F` for the raw samples, and `5678713FD2DC9914CF98BFCC97467828219EC53BED51B67BF18E5D90481FD491` for the scorer receipt. This is complete public code-correctness evidence for the stated model and protocol, not a general coding leaderboard claim.

## Observed public result: BFCL tool calling

The official [BFCL evaluator](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-calling-leaderboard) was run against the OpenAI-compatible server that was already running in LM Studio. The BFCL model label was `Qwen/Qwen3-4B-Instruct-2507-FC`; the endpoint selected the existing local Qwen model. No local model process was restarted.

| Run | Category and sample | Official result | Latency | Validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | BFCL V4 `simple_python`, 20 public cases, `temperature=0`, one request thread | Accuracy `1.0000` (20/20) | Mean `1.747 s`, approximate p95 `3.112 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `multiple`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.9500` (19/20) | Mean `1.563 s`, approximate p95 `2.407 s`, max `2.826 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `parallel_multiple`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.8500` (17/20) | Mean `2.420 s`, approximate p95 `3.991 s`, max `7.240 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `irrelevance`, 20 public cases, `temperature=0`, one request thread | Accuracy `1.0000` (20/20) | Mean `2.593 s`, approximate p95 `5.067 s`, max `8.377 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `multi_turn_base`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.3000` (6/20) | Official category scorer; many empty responses and malformed tool calls were observed | Official category scorer, partial evaluation; model format compatibility remains weak |
| 2026-08-27 | BFCL V4 `multi_turn_miss_func`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.1500` (3/20) | 263 requests, mean `4.135 s`, approximate p95 `11.188 s` | Official category scorer, partial evaluation; empty responses and long tool sequences observed |
| 2026-08-27 | BFCL V4 `multi_turn_miss_param`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.1500` (3/20) | 285 requests, mean `5.597 s`, approximate p95 `17.944 s`, max `72.238 s` | Official category scorer, partial evaluation; empty responses and long tool sequences observed |

These are real public benchmark results for seven BFCL categories. They are not global BFCL leaderboard scores, and they do not cover every multi-turn, agentic, or tool schema. The `multi_turn_base`, `multi_turn_miss_func`, and `multi_turn_miss_param` runs are evidence of a weak model-output compatibility path: BFCL reported empty responses, malformed tool calls, and long sequences during generation. Raw generations and scorer output are retained locally under `artifacts/benchmarks/bfcl/`, `artifacts/benchmarks/bfcl-multiple/`, `artifacts/benchmarks/bfcl-parallel-multiple/`, `artifacts/benchmarks/bfcl-irrelevance/`, `artifacts/benchmarks/bfcl-multi-turn/`, `artifacts/benchmarks/bfcl-multi-turn-miss-func/`, and `artifacts/benchmarks/bfcl-multi-turn-miss-param/`, all ignored by Git. Reproduction commands are in `benchmarks/README.md`.

### NVIDIA NIM results

The official BFCL generator and evaluator also ran through the OpenAI-compatible NVIDIA NIM endpoint using `openai/gpt-oss-20b`. The API key came from the Windows User environment variable `NVIDIA_API_KEY`; no key file is used. The wrapper bounds each provider request to 120 seconds by default, and the exact reproduction command is in [`benchmarks/README.md`](../benchmarks/README.md).

| Category and sample | Official result | Latency | Validity |
| --- | --- | --- | --- |
| `simple_python`, 20 public cases | Accuracy `0.4500` (9/20) | Mean `0.929 s`, approximate p95 `1.648 s`, max `1.792 s` | Official category scorer, partial evaluation |
| `simple_java`, 20 public cases | Accuracy `0.0000` (0/20) | Mean `1.391 s`, approximate p95 `2.380 s` | Official category scorer, partial evaluation |
| `simple_javascript`, 20 public cases | Accuracy `0.4500` (9/20) | Mean `4.232 s`, approximate p95 `11.300 s` | Official category scorer, partial evaluation; three empty result arrays |
| `multiple`, 20 public cases | Accuracy `0.0500` (1/20) | Mean `2.175 s`, approximate p95 `11.156 s`, max `16.268 s` | Official category scorer, partial evaluation |
| `parallel`, 20 public cases | Accuracy `0.0000` (0/20) | Mean `3.212 s`, approximate p95 `6.790 s` | Official category scorer, partial evaluation |
| `parallel_multiple`, 20 public cases | Accuracy `0.0000` (0/20) | Mean `1.352 s`, approximate p95 `2.370 s`, max `2.569 s` | Official category scorer, partial evaluation |
| `live_simple`, 20 public cases | Accuracy `0.8500` (17/20) | Mean `0.813 s` | Official category scorer, partial evaluation; 20 unique result rows and no empty result arrays |
| `live_multiple`, 20 public cases | Accuracy `0.1500` (3/20) | Mean `1.888 s` | Official category scorer, partial evaluation; 20 unique result rows and four empty result arrays |
| `live_parallel`, 16 public cases | Accuracy `0.0000` (0/16) | Mean `1.571 s` | Complete public category; 16 unique result rows and no empty result arrays |
| `live_parallel_multiple`, 24 public cases | Accuracy `0.0000` (0/24) | Mean `1.224 s` | Complete public category; 24 unique result rows and one empty result array |
| `live_relevance`, 16 public cases | Relevance detection `0.8750` (14/16) | Mean `2.045 s` | Complete public category; 16 unique result rows and two empty result arrays |
| `live_irrelevance`, 884 public cases | Irrelevance detection `0.8190` (724/884) | Mean `7.04 s`, p95 `21.38 s`, cost `$0.41` | Complete public category; 884 unique result rows; single-category partial evaluation |
| `multi_turn_base`, 20 public cases | Accuracy `0.2500` (5/20) | 366 requests, mean `2.042 s`, approximate p95 `3.769 s`, max `81.768 s` | Official category scorer; empty responses and malformed tool calls observed |
| `multi_turn_miss_func`, 20 public cases | Accuracy `0.1500` (3/20) | 389 requests, mean `3.055 s`, approximate p95 `5.703 s`, max `173.977 s` | Official category scorer; empty responses and malformed tool calls observed |
| `multi_turn_miss_param`, 20 public cases | Accuracy `0.1000` (2/20) | 325 requests, mean `2.000 s`, approximate p95 `4.392 s`, max `123.501 s` | Official category scorer; empty responses and non-exploitable provider responses observed |
| `multi_turn_long_context`, 20 public cases | Accuracy `0.1500` (3/20) | 345 requests, mean `1.852 s`, approximate p95 `4.311 s`, max `33.633 s` | Official category scorer; empty responses and failed decodes observed |

These are seventeen public category samples, not a global BFCL leaderboard result. The additional `simple_java`, `simple_javascript`, and `parallel` runs used isolated ignored roots under `artifacts/benchmarks/bfcl-nvidia-gpt-oss-*`; each contains 20 unique public IDs. The `live_simple` run also contains 20 unique official compound IDs and no empty result arrays; its result JSONL SHA-256 is `B6E0740BD7FFFAB8FE358D7EED9769A60DFB89340109D05E5698F40861AF11EB`. The `live_multiple` run contains 20 unique official compound IDs, four empty result arrays, and result JSONL SHA-256 `43EEE1E2EEA02167D67FAC770DD0A9680CB832E54F85011CB98611F455391424`. The `live_parallel` run covers all 16 official entries, has no empty result arrays, and result JSONL SHA-256 `2D4E20A5661F5B128DA2E728271A6DC8D6EDE7CD6FF72E8A9AEA447ED8CB3226`. The `live_parallel_multiple` run covers all 24 official entries, retains one empty result array, and result JSONL SHA-256 `5E46B52A4D38FBCFDA200EFC7807B62F2F114C58123447E14CE539037B808EA5`. The `live_relevance` run covers all 16 official entries, records 14/16 relevance detections, retains two empty result arrays, and result JSONL SHA-256 `0FED52073D0235DEBBB62FC26EC7E60F67AC81B61161E4D7E9BDF910F6FEFDB9`. The complete `live_irrelevance` run covers all 884 official entries, records 724/884 irrelevance detections, and has result JSONL SHA-256 `D2B8ACCEC696F4F2320E757B6FF0C5E28C8B5E0DA58BDB6B1E36C08BC5D91D21` plus scorer JSONL SHA-256 `5B99980242A51CEB00CA064A24D75E2806DD8F9F2C9648115469802D84E37B4C`. The other new result JSONL SHA-256 values are `E9473244DEBF61A4C4827906095FD556FBDA68C95008B16D1AF87D04C9D5BC41` for `simple_java`, `8858F35C369205BBE3ECD59C0417B9C86895BF5709AEFC9867E63BF86AD3F9FA` for `simple_javascript`, and `3A6DAFA8D7FF3D7563B9ADE229892E4285D397D144FE44C25535165E5EB131C2` for `parallel`. The legacy NVIDIA handler path produced an HTTP 404 before scoring in an earlier attempt; that failed transport attempt has no score and is not mixed into the table above. A first unbounded `multi_turn_miss_func` attempt was stopped after the provider request stalled; the corrected 120-second wrapper run completed all 20 cases. The `multi_turn_long_context` run also completed all 20 cases with the same bounded request policy. Raw NVIDIA result and score directories are local ignored artifacts under `artifacts/benchmarks/bfcl-nvidia-gpt-oss-*`.

## Observed public result: MTEB STS22 v2

The official [MTEB task runner](https://github.com/embeddings-benchmark/mteb) evaluated `STS22.v2` with `BAAI/bge-small-en-v1.5`, MTEB `2.20.2`, model revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, CPU execution, and batch size 32. The complete public test task contained 3,958 pairs across 18 subsets and completed in 208.23 seconds.

| Subset | Main score |
| --- | ---: |
| en | `0.657866` |
| de | `0.327885` |
| es | `0.604861` |
| pl | `0.371839` |
| tr | `0.462127` |
| ar | `0.188313` |
| ru | `0.206349` |
| zh | `0.519045` |
| fr | `0.740204` |
| de-en | `0.491496` |
| es-en | `0.607575` |
| it | `0.638268` |
| pl-en | `0.397313` |
| zh-en | `0.488365` |
| es-it | `0.510473` |
| de-fr | `0.433278` |
| de-pl | `0.181685` |
| fr-pl | `0.619780` |

The unweighted macro-average of these reported main scores is `0.469262`. It is a descriptive summary calculated from the subset results, not an official MTEB aggregate. The local receipt is `artifacts/benchmarks/mteb/sts22-v2-bge-small-en-v1.5.json`; it is ignored by Git.

A separate complete local-CUDA run used the same public task, model, and MTEB version with batch size 64. It produced the same practical language spread, an unweighted descriptive macro-average of `0.469258`, and completed in `17.278` seconds. The CUDA receipt is `artifacts/benchmarks/mteb/sts22-v2-bge-small-cuda.json`; it is ignored by Git. The small difference in the sixth decimal place is numerical aggregation variation, not a change in the evaluated task or model.

## Observed public result: MTEB Banking77Classification v2

The official [MTEB task runner](https://github.com/embeddings-benchmark/mteb) evaluated the current `Banking77Classification.v2` test task with `BAAI/bge-small-en-v1.5`, MTEB `2.20.2`, model revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, CUDA execution, and batch size 128. The task contains 3,076 public test utterances assigned to 77 banking-support intents.

| Metric | Result |
| --- | ---: |
| Accuracy | `0.817555` |
| Macro F1 | `0.808097` |
| Macro precision | `0.838071` |
| Macro recall | `0.817389` |
| Evaluation time | `15.704` seconds |

This is a complete public classification-task result for the stated embedding model and hardware. It is not a measure of the full StudentLLM RAG answer quality or a leaderboard claim. The compact receipt is `artifacts/benchmarks/mteb/banking77-v2-bge-small-cuda.json`; the native MTEB result remains in its local cache.

## Observed public result: MTEB NQ

The official [MTEB task runner](https://github.com/embeddings-benchmark/mteb) evaluated the public `NQ` test task with `BAAI/bge-small-en-v1.5`, MTEB `2.20.2`, model revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, CUDA execution, and batch size 64. The complete test task evaluated 3,452 questions against 2,681,468 Wikipedia passages. MTEB uses `nDCG@10` as the task's main score.

| Metric | Result |
| --- | ---: |
| nDCG@1 | `0.318080` |
| nDCG@10 | `0.501790` |
| nDCG@100 | `0.549830` |
| Recall@10 | `0.708290` |
| MRR@10 | `0.451624` |
| Evaluation time | `1,411.804` seconds |

The compact receipt is `artifacts/benchmarks/mteb/nq-bge-small-cuda.json`; the native MTEB result remains in its local cache. This is a complete public retrieval-task result for the stated embedding model and protocol. It does not establish the full StudentLLM RAG quality target or a global MTEB ranking.

## Observed public result: MTEB HotpotQA

The official [MTEB task runner](https://github.com/embeddings-benchmark/mteb) evaluated the public `HotpotQA` test task with `BAAI/bge-small-en-v1.5`, MTEB `2.20.2`, model revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, CUDA execution, and batch size 64. The complete test task evaluated 14,810 multi-hop questions against 5,233,329 Wikipedia passages. MTEB uses `nDCG@10` as the task's main score.

The run used the repository MTEB wrapper. Because this Windows environment exposes an incompatible optional TensorFlow/JAX installation through the benchmark virtual environment, the invocation supplied a small TensorFlow seed compatibility shim before importing MTEB; dataset loading, embedding, retrieval, and official scoring were unchanged.

| Metric | Result |
| --- | ---: |
| nDCG@1 | `0.782710` |
| nDCG@10 | `0.699310` |
| nDCG@100 | `0.730170` |
| Recall@10 | `0.727890` |
| MRR@10 | `0.841258` |
| Evaluation time | `1,967.274` seconds |

The compact receipt is `artifacts/benchmarks/mteb/hotpotqa-bge-small-cuda.json`; the native MTEB result remains in its local cache. This is a complete public retrieval-task result for the stated embedding model and protocol. It does not establish the full StudentLLM RAG quality target or a global MTEB ranking.

The 140-item run completed all API requests and saved the aggregate receipt `artifacts/benchmarks/mmlu-pro/qwen3-4b-limit10_2026-08-27T15-43-26.008905.json` before the first invocation failed while printing a Unicode arrow to a CP1252 terminal. The adapter now configures UTF-8 stdout so future runs report a clean exit status; the saved metrics are valid for the stated public sample and the presentation failure is recorded separately.

An expanded LM Studio run with 20 items per category was interrupted by the transport at 132/280 before aggregation. It is rejected and contributes no score.

Reproduction:

```powershell
python -m venv .venv-bench
.\.venv-bench\Scripts\python.exe -m pip install "lm-eval[api]"
$env:PYTHONUTF8 = '1'
python benchmarks/run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=qwen/qwen3-4b,base_url=http://127.0.0.1:1234/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/qwen3-4b.json --log_samples
```

Raw outputs are local and ignored by Git. A partial or full run is not promoted without its command, commit, dataset, hardware, and validity record.

## Observed public result: FLEURS French ASR

The ASR adapter ran the complete public `google/fleurs` `fr_fr` test split with `faster-whisper small`, CPU `int8` execution, beam size 5, and VAD filtering. The receipt is stored locally at `artifacts/benchmarks/asr/fleurs-fr-small-cpu-full.json` and is ignored by Git.

| Run | Model and backend | Evaluation set | Result | Hardware and validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `small` / faster-whisper, CPU | 676 examples, 17,151 reference words, 7,024.08 seconds of public audio | WER `13.5677%`, CER `4.9086%`, RTF `0.1840`, elapsed `1,292.36s` | Windows, Intel Core Ultra 7 270K Plus, 63.4 GB RAM, RTX 5080 host; full public split, reproducible CPU baseline |

This is an ASR baseline for the public French split. It is not a lecture-domain score, not a diarization result, and not evidence that the product meets the stricter V1 targets.

## Observed public result: MLS French ASR

The generic Hugging Face ASR adapter evaluated the complete public `facebook/multilingual_librispeech` French test split with `faster-whisper small`, CPU `int8` execution, beam size 5, and VAD filtering. The receipt is stored locally at `artifacts/benchmarks/asr/mls-fr-small-cpu-full.json` and is ignored by Git.

| Run | Model and backend | Evaluation set | Result | Hardware and validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `small` / faster-whisper, CPU | 2,426 examples, 94,283 reference words, 36,241.89 seconds of public audio | WER `13.0395%`, CER `5.6910%`, RTF `0.1648`, elapsed `5,972.70s` | Windows 11, 24 logical CPUs, 63.4 GB RAM, RTX 5080 host; complete public test split, reproducible CPU baseline |

This is a public MLS French ASR baseline. It is not a lecture-domain score, not a diarization result, and not evidence that the product meets the stricter V1 targets.

## Observed public result: FLEURS plus MUSAN robustness

The robustness adapter combines public `google/fleurs` French test speech with four public files from the [MUSAN corpus](https://www.openslr.org/17/). It evaluates clean audio and deterministic mixtures at 10 dB and 0 dB SNR with `faster-whisper small`, CPU `int8` execution, beam size 5, VAD filtering, and seed 42. This is a reproducible composite robustness protocol built from public corpora, not an official MUSAN leaderboard score.

The run used the first 100 FLEURS test examples and these extracted MUSAN files:

- `noise/free-sound/noise-free-sound-0001.wav`;
- `noise/sound-bible/noise-sound-bible-0001.wav`;
- `music/hd-classical/music-hd-0022.wav`;
- `speech/librivox/speech-librivox-0001.wav`.

The local receipt is `artifacts/benchmarks/musan/fleurs-fr-musan-100.json` and is ignored by Git.

| Condition | Reference words | WER | CER | RTF |
| --- | ---: | ---: | ---: | ---: |
| Clean | 2,608 | `15.7592%` | `6.0743%` | `0.1563` |
| MUSAN noise, 10 dB | 2,608 | `34.1641%` | `17.7633%` | `0.1761` |
| MUSAN noise, 0 dB | 2,608 | `84.4709%` | `56.8288%` | `0.3456` |
| MUSAN ambient, 10 dB | 2,608 | `17.3696%` | `7.0548%` | `0.1570` |
| MUSAN ambient, 0 dB | 2,608 | `17.8681%` | `7.2922%` | `0.1977` |
| MUSAN music, 10 dB | 2,608 | `20.7439%` | `8.8089%` | `0.1548` |
| MUSAN music, 0 dB | 2,608 | `34.1258%` | `18.2765%` | `0.1597` |
| MUSAN speech, 10 dB | 2,608 | `24.8466%` | `11.8728%` | `0.1597` |
| MUSAN speech, 0 dB | 2,608 | `56.9785%` | `37.5948%` | `0.2422` |

This result is a public-data robustness baseline for the current ASR engine. It is not evidence of diarization quality, classroom far-field performance, or the stricter V1 target.

## Observed public results: BEIR retrieval

The retrieval baseline runs complete public BEIR corpus and query datasets with their public test relevance judgments. The implementation is deterministic BM25 with `k1=1.2`, `b=0.75`, and `top_k=10`.

| Dataset | Run | Corpus | Evaluation set | Result | Validity |
| --- | --- | --- | --- | --- | --- |
| SciFact | 2026-08-27 | 5,183 documents | 300 evaluated test queries, 339 qrel rows | nDCG@10 `0.6593`, Recall@10 `0.7809`, MRR@10 `0.6252` | Full public split, reproducible baseline |
| NFCorpus | 2026-08-27 | 3,633 documents | 323 evaluated test queries, 12,334 qrel rows | nDCG@10 `0.3037`, Recall@10 `0.1423`, MRR@10 `0.5137` | Full public split, reproducible baseline |
| ArguAna | 2026-08-27 | 8,674 documents | 1,406 evaluated test queries, 1,406 qrel rows | nDCG@10 `0.3132`, Recall@10 `0.6636`, MRR@10 `0.2030` | Full public split, reproducible baseline |
| FiQA | 2026-08-27 | 57,638 documents | 648 evaluated test queries, 1,706 qrel rows | nDCG@10 `0.2347`, Recall@10 `0.2962`, MRR@10 `0.2919` | Full public split, reproducible baseline |
| SCIDOCS | 2026-08-27 | 25,657 documents | 1,000 evaluated test queries, 29,928 qrel rows | nDCG@10 `0.1528`, Recall@10 `0.1584`, MRR@10 `0.2736` | Full public split, reproducible baseline |
| TREC-COVID | 2026-08-27 | 171,332 documents | 50 evaluated test queries, 66,336 qrel rows | nDCG@10 `0.5537`, Recall@10 `0.0157`, MRR@10 `0.7906` | Full public split, reproducible baseline |

The receipts are written to `artifacts/benchmarks/beir/`. These are lexical baselines on public BEIR datasets; they are not claims about StudentLLM's future dense retrieval or answer faithfulness.

The rows above correspond, in order, to the public [SciFact](https://huggingface.co/datasets/BeIR/scifact), [NFCorpus](https://huggingface.co/datasets/BeIR/nfcorpus), [ArguAna](https://huggingface.co/datasets/BeIR/arguana), [FiQA](https://huggingface.co/datasets/BeIR/fiqa), [SCIDOCS](https://huggingface.co/datasets/BeIR/scidocs), and [TREC-COVID](https://huggingface.co/datasets/BeIR/trec-covid) datasets. These are lexical baselines on public BEIR datasets; they are not claims about StudentLLM's future dense retrieval or answer faithfulness.

The dense adapter uses the same complete public splits and qrels with a selectable SentenceTransformers model, normalized embeddings, cosine similarity, and `top_k=10`. Dense results are added only after the command completes and writes a receipt.

The first dense baseline on 2026-08-27 used `BAAI/bge-small-en-v1.5`, CPU, batch size 32, normalized embeddings, cosine similarity, and `top_k=10`. A later NFCorpus rerun used local CUDA and batch size 64; it is recorded separately because hardware and batch size changed:

| Dataset | Corpus | Evaluation set | Dense result | BM25 result | Comparison |
| --- | ---: | --- | --- | --- | --- |
| SciFact | 5,183 documents | 300 evaluated test queries | nDCG@10 `0.7200` CPU / `0.7200` CUDA, Recall@10 `0.8452` CPU / `0.8452` CUDA, MRR@10 `0.6845` CPU / `0.6845` CUDA | `0.6593`, `0.7809`, `0.6252` | Dense higher on all three metrics; CUDA receipt is `artifacts/benchmarks/beir-scifact-bge-small-cuda.json` |
| NFCorpus | 3,633 documents | 323 evaluated test queries | nDCG@10 `0.3391` CPU / `0.3393` CUDA, Recall@10 `0.1580` CPU / `0.1583` CUDA, MRR@10 `0.5299` | `0.3037`, `0.1423`, `0.5137` | Dense higher on all three metrics; CUDA receipt is `artifacts/benchmarks/beir-nfcorpus-bge-small-cuda.json` |
| ArguAna | 8,674 documents | 1,406 evaluated test queries | nDCG@10 `0.4287`, Recall@10 `0.8414`, MRR@10 `0.2956` | `0.3132`, `0.6636`, `0.2030` | Dense higher on all three metrics |
| SCIDOCS | 25,657 documents | 1,000 evaluated test queries | nDCG@10 `0.1973` CPU / `0.1973` CUDA, Recall@10 `0.2091` CPU / `0.2091` CUDA, MRR@10 `0.3344` CPU / `0.3344` CUDA | `0.1528`, `0.1584`, `0.2736` | Dense higher on all three metrics; CUDA receipt is `artifacts/benchmarks/beir-scidocs-bge-small-cuda.json` |
| FiQA | 57,638 documents | 648 evaluated test queries | nDCG@10 `0.3848` CPU / `0.3848` CUDA, Recall@10 `0.4396` CPU / `0.4396` CUDA, MRR@10 `0.4650` CPU / `0.4650` CUDA | `0.2347`, `0.2962`, `0.2919` | Dense higher on all three metrics; CUDA receipt is `artifacts/benchmarks/beir-fiqa-bge-small-cuda.json` |
| TREC-COVID | 171,332 documents | 50 evaluated test queries | nDCG@10 `0.6438` CPU / `0.6438` CUDA, Recall@10 `0.0184` CPU / `0.0183` CUDA, MRR@10 `0.8779` CPU / `0.8779` CUDA | `0.5537`, `0.0157`, `0.7906` | Dense higher on all three metrics; CUDA receipt is `artifacts/benchmarks/beir-trec-covid-bge-small-cuda.json` |

These are complete public test splits, not sampled benchmarks. The receipts are `artifacts/benchmarks/beir/scifact-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/nfcorpus-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/arguana-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/scidocs-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/fiqa-bge-small-en-v1.5.json`, and `artifacts/benchmarks/beir/trec-covid-bge-small-en-v1.5.json`; they are ignored by Git. The TREC-COVID dense run took 3,002.23 seconds on CPU.

The 2026-08-31 NFCorpus CUDA rerun used the same complete public split and qrels with BGE-small, batch size 64, normalized embeddings, cosine similarity, and `top_k=10`. It wrote `artifacts/benchmarks/beir-nfcorpus-bge-small-cuda.json` with nDCG@10 `0.3393`, Recall@10 `0.1583`, MRR@10 `0.5299`, and elapsed time `64.003` seconds. This is an independent hardware comparison, not a replacement for the earlier CPU receipt.

The 2026-08-31 SciFact CUDA rerun used the same complete public split and qrels with BGE-small, batch size 64, normalized embeddings, cosine similarity, and `top_k=10`. It wrote `artifacts/benchmarks/beir-scifact-bge-small-cuda.json` with nDCG@10 `0.7200`, Recall@10 `0.8452`, MRR@10 `0.6845`, and elapsed time `14.873` seconds. The deterministic result matches the earlier CPU receipt while providing an independently verified local-GPU timing point.

The 2026-08-31 SCIDOCS CUDA rerun used the same complete public split and qrels with BGE-small, batch size 64, normalized embeddings, cosine similarity, and `top_k=10`. It wrote `artifacts/benchmarks/beir-scidocs-bge-small-cuda.json` with nDCG@10 `0.1973`, Recall@10 `0.2091`, MRR@10 `0.3344`, and elapsed time `38.282` seconds. The metrics match the CPU receipt while providing an independently verified local-GPU timing point.

The 2026-08-31 FiQA CUDA rerun used the same complete public split and qrels with BGE-small, batch size 64, normalized embeddings, cosine similarity, and `top_k=10`. It wrote `artifacts/benchmarks/beir-fiqa-bge-small-cuda.json` with nDCG@10 `0.3848`, Recall@10 `0.4396`, MRR@10 `0.4650`, and elapsed time `57.480` seconds. The metrics match the CPU receipt while providing an independently verified local-GPU timing point.

The 2026-08-31 TREC-COVID CUDA rerun used the same complete public split and qrels with BGE-small, batch size 64, normalized embeddings, cosine similarity, and `top_k=10`. It wrote `artifacts/benchmarks/beir-trec-covid-bge-small-cuda.json` with nDCG@10 `0.6438`, Recall@10 `0.0183`, MRR@10 `0.8779`, and elapsed time `221.038` seconds. The result is consistent with the CPU receipt within floating-point and execution variation while providing an independently verified local-GPU timing point.

## Public benchmarks to integrate

| Domain | Public benchmark | Primary measurements |
| --- | --- | --- |
| Multilingual ASR | [FLEURS](https://huggingface.co/datasets/google/fleurs) | WER, CER |
| French ASR | [MLS](https://www.openslr.org/94/) | WER, technical term accuracy |
| French ASR | [Common Voice](https://commonvoice.mozilla.org/datasets) | WER by accent and noise |
| Speech translation | [CoVoST 2](https://github.com/facebookresearch/fairseq/tree/main/examples/speech_to_text) | BLEU, COMET |
| Far-field speech | [AMI](https://groups.inf.ed.ac.uk/ami/corpus/) | WER, DER, SA-WER |
| Noise robustness | [MUSAN](https://www.openslr.org/17/) | WER by SNR |
| Diarization | [DIHARD](https://dihardchallenge.github.io/dihard3/) | DER, JER |
| Document parsing | [OmniDocBench](https://github.com/opendatalab/OmniDocBench) | TextEdit, TEDS, CDM |
| Document QA | [DocVQA](https://www.docvqa.org/) | ANLS, exact match |
| Tables | [PubTabNet](https://github.com/ibm-aur-nlp/PubTabNet) | TEDS |
| Retrieval | [BEIR](https://github.com/beir-cellar/beir) | nDCG, Recall, MRR |
| Embeddings | [MTEB](https://github.com/embeddings-benchmark/mteb) | scores by task and language |
| Tool calling | [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) | tool accuracy, AST validity |
| General generation | [MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro) | exact match by domain |
| Mathematical reasoning | [MATH-500](https://huggingface.co/datasets/HuggingFaceH4/MATH-500) | exact match, math_verify |
| Competition mathematics | [AIME 2024 and AIME 2025](https://huggingface.co/datasets/math-ai/aime25) | exact match by year |

The DocVQA OCR adapter reports normalized reference-answer visibility in OCR text. This is a real public-set extractability diagnostic, not the official DocVQA ANLS result, because no question-answering model is included in that baseline.

Observed run on 2026-08-27: RapidOCR exposed at least one normalized reference answer in 86 of 100 public validation images. The sample included form, free-text, layout, table/list, image/photo, figure/diagram, handwritten, and other question types. The local receipt is `artifacts/benchmarks/docvqa/rapidocr-validation-100.json`; it is ignored by Git and is not a full validation-set score.

The vision adapter runs an OpenAI-compatible multimodal endpoint and computes the official DocVQA ANLS formula from the model prediction and reference answers. Observed run on 2026-09-01: NVIDIA `meta/llama-3.2-11b-vision-instruct` scored ANLS `0.8591` on 100 public validation examples, with 100 successful responses and no provider failures. The local receipt is `artifacts/benchmarks/docvqa/nvidia-llama-vision-validation-100.json`; it is ignored by Git and remains a partial subset.

## LectureBench

LectureBench is the versioned product benchmark, not a replacement for public datasets. It will include:

- a stable golden set with controlled changes;
- classroom audio in French and English, code-switching, noise, microphone distance, and overlapping speech;
- documents with pages, tables, formulas, diagrams, and handwriting;
- answerable and intentionally unanswerable retrieval questions;
- exact citations and reference timestamps;
- crash, recovery, export, import, and deletion scenarios.

## Initial hard gates

The detailed thresholds belong in versioned manifests. Initial P0 gates are:

```text
lost audio = 0
corrupted source = 0
scope violation = 0
unexpected local-only network traffic = 0
critical formula error on the golden set = 0
migration failure = 0
recording soak failure = 0
```

Initial V1 calibration targets include normal-class WER <= 10%, RTF < 1, RAG Recall@10 >= 98%, faithfulness >= 98%, citation precision >= 99%, and quiz accuracy >= 99%. Until the engines and datasets are integrated, these are targets rather than results.

## Reproducibility record

Every result keeps:

- Git commit and manifest version;
- exact dataset and split;
- model, backend, and quantization;
- OS, CPU, RAM, GPU, VRAM, threads, and power mode;
- seed and generation parameters;
- raw metrics and summary;
- promotion or rejection reason.
