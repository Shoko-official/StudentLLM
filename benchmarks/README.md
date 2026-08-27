# Reproducible benchmarks

This directory contains benchmark adapters and commands, not raw outputs. Local artifacts are written under `artifacts/` and ignored by Git so prompts and private data are not published accidentally.

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

`run_beir_bm25.py` evaluates complete public SciFact or NFCorpus test splits with a deterministic BM25 baseline. It loads the corpus, queries, and test relevance judgments from the [BeIR SciFact dataset](https://huggingface.co/datasets/BeIR/scifact) or [BeIR NFCorpus dataset](https://huggingface.co/datasets/BeIR/nfcorpus) and reports nDCG@10, Recall@10, and MRR@10.

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

These are retrieval baselines on public information-retrieval datasets. They are independent of the LM Studio process and do not require model inference.
