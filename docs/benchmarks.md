# Benchmark evidence and release gates

## Measurement methodology

A passing UI test demonstrates an interface workflow. It does not measure ASR, OCR, retrieval, or generation quality. StudentLLM records the dataset, model version, hardware, quantization, seed, command, raw output, and validity of every published result.

Easy or self-authored checks are useful for regression coverage but are never the only evidence for a frontier claim.

## Available local checks

| Check | Method | Command | Observed result |
| --- | --- | --- | --- |
| TypeScript | TypeScript project check | `npm run check` | PASS |
| Benchmark adapters | Python bytecode compilation | `npm run benchmarks:check` | PASS |
| UI and storage | Vitest + Testing Library | `npm run test:run` | PASS, 59 tests |
| Production artifact | Vite | `npm run build` | PASS |
| Browser workflow | Playwright Chromium + axe | `npm run test:e2e` | PASS, 20 tests |
| FLEURS French ASR | Full public test split, faster-whisper small on CPU | `benchmarks/run_asr_fleurs.py --config fr_fr --split test` | WER 0.1357, CER 0.0491, RTF 0.184 |
| Local ASR sidecar | Python service plus public FLEURS request | `npm run asr:server` with `POST /transcribe` | PASS observed on 2026-08-27; public sample returned timestamped output |
| Local document sidecar | PyMuPDF and RapidOCR service plus public arXiv source | `npm run document:server` with `POST /extract` | PASS observed on 2026-08-27; PDF 15/15 pages, rasterized page 69 OCR blocks |
| Local document browser import | Playwright UI plus the running PyMuPDF sidecar and public arXiv PDF | Manual live UI check | PASS observed on 2026-08-27; source stored, 15 pages indexed, `Page 1` visible, 0 page errors |
| DocVQA OCR diagnostic | Public DocVQA validation images plus RapidOCR | `benchmarks/run_docvqa_ocr.py --split validation --limit 100` | Normalized reference-answer visibility `0.8600` on 100 samples; partial diagnostic |
| RAG unanswerable guard | Provider call suppression with no retrieved passage | App integration test | PASS; unsupported questions return a refusal without a provider request |
| NVIDIA generation | Live API, runtime credential from the Windows User environment | `npm run providers:smoke` | PASS observed on 2026-08-27, 1,260 ms |
| LM Studio generation | Live local server, existing process | `npm run providers:smoke` | PASS observed on 2026-08-27, 310 ms |
| LM Studio browser chat | Playwright UI path through the built-in Vite same-origin proxy to the existing process | Manual live UI check | PASS observed on 2026-08-27; 4 chat messages, 423-character model answer, transcript citations, 0 page errors |
| BEIR SciFact retrieval | Full public test split, deterministic BM25 | `benchmarks/run_beir_bm25.py --dataset scifact` | nDCG@10 0.6593, Recall@10 0.7809, MRR@10 0.6252 |
| BEIR NFCorpus retrieval | Full public test split, deterministic BM25 | `benchmarks/run_beir_bm25.py --dataset nfcorpus` | nDCG@10 0.3037, Recall@10 0.1423, MRR@10 0.5137 |
| BEIR ArguAna dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset arguana --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.4287, Recall@10 0.8414, MRR@10 0.2956 |
| BEIR SCIDOCS dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset scidocs --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.1973, Recall@10 0.2091, MRR@10 0.3344 |
| BEIR FiQA dense retrieval | Full public test split, BGE-small normalized embeddings | `benchmarks/run_beir_dense.py --dataset fiqa --model BAAI/bge-small-en-v1.5 --device cpu` | nDCG@10 0.3848, Recall@10 0.4396, MRR@10 0.4650 |
| MTEB STSBenchmark v2 | Official public test task, BGE-small sentence embeddings | `benchmarks/run_mteb.py --task STSBenchmark.v2 --model BAAI/bge-small-en-v1.5 --device cpu` | Spearman main score 0.857289 |
| MTEB STS22 v2 | Official public multilingual test task, BGE-small sentence embeddings | `benchmarks/run_mteb.py --task STS22.v2 --model BAAI/bge-small-en-v1.5 --device cpu` | 18 subsets, unweighted descriptive macro-average 0.469262; language spread 0.181685-0.740204 |
| BFCL V4 `simple_python`, `parallel_multiple`, and `multi_turn_base` | Official generator and evaluator against the existing LM Studio endpoint | `python -m bfcl_eval generate` + `python -m bfcl_eval evaluate --partial-eval` | `simple_python`: 1.0000 (20/20); `parallel_multiple`: 0.8500 (17/20); `multi_turn_base`: 0.3000 (6/20); partial category samples |

The provider latencies are point observations on the development machine, not production SLOs.

The browser chat result uses the built-in Vite same-origin proxy because the unchanged LM Studio endpoint did not return CORS headers. It validates the application request, response, citation, and rendering path without restarting LM Studio; it is not evidence that the endpoint is directly browser-callable without CORS configuration.

## Observed public result: MMLU-Pro

The first generation benchmark uses the official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) and the public [TIGER-Lab/MMLU-Pro dataset](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro). It calls the LM Studio OpenAI-compatible API without a remote credential.

| Run | Model and backend | Protocol | Result | Validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 1 item per category, seed 42, `temperature=0`, `/no_think` | exact match `0.2143` (3/14) | Technical pipeline pass, partial sample |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 5 items per category, seed 42, `temperature=0`, `/no_think` | exact match `0.3000` (21/70), stderr `0.0484` | Partial public sample; per-category results retained in the local receipt |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 10 items per category, seed 42, `temperature=0`, `/no_think` | exact match `0.2143` (30/140), stderr `0.0347` | Complete 140-item public sample; aggregate and per-task receipts written |
| 2026-08-27 | `openai/gpt-oss-20b` / NVIDIA NIM | same protocol, credential from `NVIDIA_API_KEY` | network timeout before the first response, no aggregate | Transport failure, no score |

The 0.2143 and 0.3000 values are not leaderboard scores. The harness documents that `--limit` is not suitable for a final metric; these runs validate dataset loading, prompt construction, API routing, answer extraction, and metric calculation on public samples. Model strength remains unverified.

## Observed public result: BFCL tool calling

The official [BFCL evaluator](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-calling-leaderboard) was run against the OpenAI-compatible server that was already running in LM Studio. The BFCL model label was `Qwen/Qwen3-4B-Instruct-2507-FC`; the endpoint selected the existing local Qwen model. No local model process was restarted.

| Run | Category and sample | Official result | Latency | Validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | BFCL V4 `simple_python`, 20 public cases, `temperature=0`, one request thread | Accuracy `1.0000` (20/20) | Mean `1.747 s`, approximate p95 `3.112 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `parallel_multiple`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.8500` (17/20) | Mean `2.420 s`, approximate p95 `3.991 s`, max `7.240 s` | Official category scorer, partial evaluation |
| 2026-08-27 | BFCL V4 `multi_turn_base`, 20 public cases, `temperature=0`, one request thread | Accuracy `0.3000` (6/20) | Official category scorer; many empty responses and malformed tool calls were observed | Official category scorer, partial evaluation; model format compatibility remains weak |

These are real public benchmark results for three BFCL categories. They are not global BFCL leaderboard scores, and they do not cover every multi-turn, agentic, or tool schema. The `multi_turn_base` run is evidence of a weak model-output compatibility path: BFCL reported empty responses and malformed tool calls during generation. Raw generations and scorer output are retained locally under `artifacts/benchmarks/bfcl/`, `artifacts/benchmarks/bfcl-parallel-multiple/`, and `artifacts/benchmarks/bfcl-multi-turn/`, all ignored by Git. Reproduction commands are in `benchmarks/README.md`.

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

## Observed public results: BEIR retrieval

The retrieval baseline runs complete public BEIR corpus and query datasets with their public test relevance judgments. The implementation is deterministic BM25 with `k1=1.2`, `b=0.75`, and `top_k=10`.

| Dataset | Run | Corpus | Evaluation set | Result | Validity |
| --- | --- | --- | --- | --- | --- |
| SciFact | 2026-08-27 | 5,183 documents | 300 evaluated test queries, 339 qrel rows | nDCG@10 `0.6593`, Recall@10 `0.7809`, MRR@10 `0.6252` | Full public split, reproducible baseline |
| NFCorpus | 2026-08-27 | 3,633 documents | 323 evaluated test queries, 12,334 qrel rows | nDCG@10 `0.3037`, Recall@10 `0.1423`, MRR@10 `0.5137` | Full public split, reproducible baseline |
| ArguAna | 2026-08-27 | 8,674 documents | 1,406 evaluated test queries, 1,406 qrel rows | nDCG@10 `0.3132`, Recall@10 `0.6636`, MRR@10 `0.2030` | Full public split, reproducible baseline |
| FiQA | 2026-08-27 | 57,638 documents | 648 evaluated test queries, 1,706 qrel rows | nDCG@10 `0.2347`, Recall@10 `0.2962`, MRR@10 `0.2919` | Full public split, reproducible baseline |
| SCIDOCS | 2026-08-27 | 25,657 documents | 1,000 evaluated test queries, 29,928 qrel rows | nDCG@10 `0.1528`, Recall@10 `0.1584`, MRR@10 `0.2736` | Full public split, reproducible baseline |

The receipts are written to `artifacts/benchmarks/beir/`. These are lexical baselines on public BEIR datasets; they are not claims about StudentLLM's future dense retrieval or answer faithfulness.

The rows above correspond, in order, to the public [SciFact](https://huggingface.co/datasets/BeIR/scifact), [NFCorpus](https://huggingface.co/datasets/BeIR/nfcorpus), [ArguAna](https://huggingface.co/datasets/BeIR/arguana), [FiQA](https://huggingface.co/datasets/BeIR/fiqa), and [SCIDOCS](https://huggingface.co/datasets/BeIR/scidocs) datasets. These are lexical baselines on public BEIR datasets; they are not claims about StudentLLM's future dense retrieval or answer faithfulness.

The dense adapter uses the same complete public splits and qrels with a selectable SentenceTransformers model, normalized embeddings, cosine similarity, and `top_k=10`. Dense results are added only after the command completes and writes a receipt.

Observed dense results on 2026-08-27 use `BAAI/bge-small-en-v1.5`, CPU, batch size 32, normalized embeddings, cosine similarity, and `top_k=10`:

| Dataset | Corpus | Evaluation set | Dense result | BM25 result | Comparison |
| --- | ---: | --- | --- | --- | --- |
| SciFact | 5,183 documents | 300 evaluated test queries | nDCG@10 `0.7200`, Recall@10 `0.8452`, MRR@10 `0.6845` | `0.6593`, `0.7809`, `0.6252` | Dense higher on all three metrics |
| NFCorpus | 3,633 documents | 323 evaluated test queries | nDCG@10 `0.3391`, Recall@10 `0.1580`, MRR@10 `0.5299` | `0.3037`, `0.1423`, `0.5137` | Dense higher on all three metrics |
| ArguAna | 8,674 documents | 1,406 evaluated test queries | nDCG@10 `0.4287`, Recall@10 `0.8414`, MRR@10 `0.2956` | `0.3132`, `0.6636`, `0.2030` | Dense higher on all three metrics |
| SCIDOCS | 25,657 documents | 1,000 evaluated test queries | nDCG@10 `0.1973`, Recall@10 `0.2091`, MRR@10 `0.3344` | `0.1528`, `0.1584`, `0.2736` | Dense higher on all three metrics |
| FiQA | 57,638 documents | 648 evaluated test queries | nDCG@10 `0.3848`, Recall@10 `0.4396`, MRR@10 `0.4650` | `0.2347`, `0.2962`, `0.2919` | Dense higher on all three metrics |

These are complete public test splits, not a sampled benchmark. The receipts are `artifacts/benchmarks/beir/scifact-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/nfcorpus-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/arguana-bge-small-en-v1.5.json`, `artifacts/benchmarks/beir/scidocs-bge-small-en-v1.5.json`, and `artifacts/benchmarks/beir/fiqa-bge-small-en-v1.5.json`; they are ignored by Git.

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

The DocVQA adapter reports normalized reference-answer visibility in OCR text. This is a real public-set extractability diagnostic, not the official DocVQA ANLS result, because no question-answering model is included in this baseline.

Observed run on 2026-08-27: RapidOCR exposed at least one normalized reference answer in 86 of 100 public validation images. The sample included form, free-text, layout, table/list, image/photo, figure/diagram, handwritten, and other question types. The local receipt is `artifacts/benchmarks/docvqa/rapidocr-validation-100.json`; it is ignored by Git and is not a full validation-set score.

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
