# Reproducible benchmarks

This directory contains benchmark adapters and commands, not raw outputs. Local artifacts are written under `artifacts/` and ignored by Git so prompts and private data are not published accidentally.

## FLEURS French ASR

`run_asr_fleurs.py` evaluates the public `google/fleurs` French test split with `faster-whisper`. It reports WER, CER, real-time factor, scope, model settings, and a hardware snapshot. Use CPU execution when a local inference server is already using the GPU:

```powershell
python -m pip install datasets faster-whisper psutil
python benchmarks\run_asr_fleurs.py `
  --model small `
  --config fr_fr `
  --split test `
  --device cpu `
  --compute-type int8 `
  --output artifacts\benchmarks\asr\fleurs-fr-small-cpu-full.json
```

The command above evaluates all 676 examples in the public French test split. A partial run can be requested with `--limit`, but it must be labeled partial in the resulting receipt.

## Local ASR sidecar

The app-side speech contract can be exercised with the local `faster-whisper` service:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install faster-whisper
.\.venv-bench-sys\Scripts\python.exe scripts\local_asr_server.py --model small --language fr --device cpu --compute-type int8
```

The service exposes `GET /health` and accepts an audio body at `POST /transcribe`. It is intentionally separate from the public score adapter so service integration evidence and benchmark quality remain distinct.

## DocVQA OCR diagnostic

`run_docvqa_ocr.py` evaluates OCR answer visibility on public DocVQA validation images. It checks whether at least one normalized reference answer occurs in the OCR output. This is an extractability diagnostic, not the official DocVQA ANLS score, because it does not include a question-answering model.

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install -r requirements-local-documents.txt datasets
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_docvqa_ocr.py `
  --split validation `
  --limit 100 `
  --output artifacts\benchmarks\docvqa\rapidocr-validation-100.json
```

The observed 100-image run returned `0.8600` normalized answer visibility across multiple public question types. It is labeled partial and must not be presented as a full DocVQA result.

## MMLU-Pro through LM Studio

`run_mmlu_pro.py` uses the public MMLU-Pro task from the [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) project. The adapter appends `/no_think` to the final user message for Qwen3 models so scoring evaluates the final answer channel.

Prepare a local Python environment:

```powershell
python -m venv .venv-bench
.\.venv-bench\Scripts\python.exe -m pip install "lm-eval[api]"
```

LM Studio must already be running and expose the requested model. The following command is a reproducibility smoke run with one item per category, not a final score:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=qwen/qwen3-4b,base_url=http://127.0.0.1:1234/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/qwen3-4b.json --log_samples
```

Every published result declares its split and sample size, keeps raw outputs locally, and identifies partial runs separately from aggregate benchmark results.

An observed 70-item run on 2026-08-27 covered all 14 MMLU-Pro categories with 5 items per category and returned exact match `0.3000` (21/70, stderr `0.0484`). This remains a partial public sample, not a leaderboard score or a model-strength claim.

An observed 140-item run covered all 14 categories with 10 items per category and returned exact match `0.2143` (30/140, stderr `0.0347`). All requests and aggregate receipts were written; the initial process exit was affected only by Windows CP1252 terminal output after scoring, and the adapter now forces UTF-8 stdout.

## NVIDIA NIM

The same adapter can target NVIDIA NIM without placing the credential on the command line:

```powershell
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 1 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=256" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/gpt-oss-20b.json --log_samples
```

The August 27, 2026 NVIDIA run timed out after retries before producing a response aggregate. It is recorded as a transport failure with no score. The credential remains runtime-only through the Windows User environment.

## BEIR BM25 baselines

`run_beir_bm25.py` evaluates complete public SciFact, NFCorpus, ArguAna, FiQA, or SCIDOCS test splits with a deterministic BM25 baseline. It loads the corpus, queries, and test relevance judgments from the corresponding [BEIR datasets](https://github.com/beir-cellar/beir/wiki/Datasets-available) and reports nDCG@10, Recall@10, and MRR@10.

Install the optional benchmark dependency and run SciFact:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install datasets
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py `
  --dataset scifact `
  --output_path artifacts/benchmarks/beir/scifact-bm25.json
```

Run NFCorpus with the same protocol:

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py `
  --dataset nfcorpus `
  --output_path artifacts/benchmarks/beir/nfcorpus-bm25.json
```

Run the additional multi-domain splits with the same protocol:

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py --dataset arguana --output_path artifacts\benchmarks\beir\arguana-bm25.json
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py --dataset fiqa --output_path artifacts\benchmarks\beir\fiqa-bm25.json
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py --dataset scidocs --output_path artifacts\benchmarks\beir\scidocs-bm25.json
```

These are retrieval baselines on public information-retrieval datasets. They are independent of the LM Studio process and do not require model inference.

## BEIR dense baseline

`run_beir_dense.py` evaluates the same complete public BEIR splits with normalized SentenceTransformers embeddings and cosine similarity. The default model is `BAAI/bge-small-en-v1.5`, which is practical on CPU. `BAAI/bge-m3` can be selected explicitly for a larger multilingual run; use `--device cpu` when another local service is using the GPU.

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install sentence-transformers datasets
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_dense.py `
  --dataset scifact `
  --model BAAI/bge-small-en-v1.5 `
  --device cpu `
  --output-path artifacts\benchmarks\beir\scifact-bge-m3.json
```

Dense and BM25 results share the same public corpus, queries, test qrels, metrics, and `top_k=10`, which makes the comparison reproducible. Observed full-split results are recorded in `docs/benchmarks.md`. A dense retrieval result is still a retrieval metric; it does not establish answer faithfulness or citation correctness.

The observed ArguAna run evaluated 8,674 documents and 1,406 public test queries with `BAAI/bge-small-en-v1.5` on CPU. It returned nDCG@10 `0.4287`, Recall@10 `0.8414`, and MRR@10 `0.2956`, compared with the BM25 baseline of `0.3132`, `0.6636`, and `0.2030`.

The observed SCIDOCS run evaluated 25,657 documents and 1,000 public test queries with the same model and settings. It returned nDCG@10 `0.1973`, Recall@10 `0.2091`, and MRR@10 `0.3344`, compared with the BM25 baseline of `0.1528`, `0.1584`, and `0.2736`.

The observed FiQA run evaluated 57,638 documents and 648 public test queries with the same model and settings. It returned nDCG@10 `0.3848`, Recall@10 `0.4396`, and MRR@10 `0.4650`, compared with the BM25 baseline of `0.2347`, `0.2962`, and `0.2919`.

## MTEB embedding task

`run_mteb.py` wraps the official MTEB Python API and writes a compact receipt while MTEB keeps its native task output in its cache. It is intended for one explicit public task at a time so the model, split, device, and batch size remain visible:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install -r requirements-embeddings.txt
$env:CUDA_VISIBLE_DEVICES = ''
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_mteb.py `
  --model BAAI/bge-small-en-v1.5 `
  --task STSBenchmark.v2 `
  --split test `
  --device cpu `
  --batch-size 32 `
  --output artifacts\benchmarks\mteb\stsbenchmark-v2-bge-small-en-v1.5.json
```

The observed public STSBenchmark v2 test run returned Spearman main score `0.857289` with `BAAI/bge-small-en-v1.5` on CPU. This is a sentence-similarity embedding result, not a product-level retrieval, answer-faithfulness, or generation score.

## BFCL tool-calling task

`bfcl-eval` is the official evaluator for the [Berkeley Function-Calling Leaderboard](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-calling-leaderboard). It can target the OpenAI-compatible endpoint already exposed by LM Studio. Keep the benchmark environment separate from the application environment because the evaluator has a large optional dependency set:

```powershell
python -m venv .venv-bfcl
.\.venv-bfcl\Scripts\python.exe -m pip install -r requirements-bfcl.txt
$env:BFCL_PROJECT_ROOT = (Resolve-Path artifacts\benchmarks\bfcl).Path
$env:LOCAL_SERVER_ENDPOINT = '127.0.0.1'
$env:LOCAL_SERVER_PORT = '1234'
$env:REMOTE_OPENAI_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:REMOTE_OPENAI_API_KEY = 'EMPTY'
$env:PYTHONUTF8 = '1'
```

Create an ignored `test_case_ids_to_generate.json` below `artifacts\benchmarks\bfcl` with the public IDs to evaluate, then run the official generator and scorer. The following example uses the first 20 `simple_python` cases:

```powershell
New-Item -ItemType Directory -Force artifacts\benchmarks\bfcl | Out-Null
@{
  simple_python = 1..20 | ForEach-Object { "simple_python_$($_)" }
} | ConvertTo-Json | Set-Content -Encoding utf8 artifacts\benchmarks\bfcl\test_case_ids_to_generate.json

\.venv-bfcl\Scripts\python.exe -m bfcl_eval generate `
  --model Qwen/Qwen3-4B-Instruct-2507-FC `
  --test-category simple_python `
  --skip-server-setup `
  --num-threads 1 `
  --temperature 0 `
  --run-ids `
  --result-dir result

\.venv-bfcl\Scripts\python.exe -m bfcl_eval evaluate `
  --model Qwen/Qwen3-4B-Instruct-2507-FC `
  --test-category simple_python `
  --result-dir result `
  --score-dir score `
  --partial-eval
```

The observed run used the existing LM Studio process and completed 20 public `simple_python` cases with the official scorer: accuracy `1.0000` (20/20), mean latency `1.747 s`, and approximate p95 latency `3.112 s`. A second run completed 20 public `parallel_multiple` cases: accuracy `0.8500` (17/20), mean latency `2.420 s`, and approximate p95 latency `3.991 s`. These are partial BFCL V4 category results, not a global BFCL score or a multi-turn/tool-use claim. The result and score directories are local ignored artifacts.
