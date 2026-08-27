# Benchmark evidence and release gates

## Measurement methodology

A passing UI test demonstrates an interface workflow. It does not measure ASR, OCR, retrieval, or generation quality. StudentLLM records the dataset, model version, hardware, quantization, seed, command, raw output, and validity of every published result.

Easy or self-authored checks are useful for regression coverage but are never the only evidence for a frontier claim.

## Available local checks

| Check | Method | Command | Observed result |
| --- | --- | --- | --- |
| TypeScript | TypeScript project check | `npm run check` | PASS |
| UI and storage | Vitest + Testing Library | `npm run test:run` | PASS, 13 tests |
| Production artifact | Vite | `npm run build` | PASS |
| Browser workflow | Playwright Chromium + axe | `npm run test:e2e` | PASS, 4 tests |
| NVIDIA generation | Live API, runtime credential | `npm run providers:smoke` | PASS observed, 1,288 ms |
| LM Studio generation | Live local server | `npm run providers:smoke` | PASS observed, 351 ms |

The provider latencies are point observations on the development machine, not production SLOs.

## Observed public result: MMLU-Pro

The first generation benchmark uses the official [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) and the public [TIGER-Lab/MMLU-Pro dataset](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro). It calls the LM Studio OpenAI-compatible API without a remote credential.

| Run | Model and backend | Protocol | Result | Validity |
| --- | --- | --- | --- | --- |
| 2026-08-27 | `qwen/qwen3-4b` / LM Studio, RTX 5080 | test split, 14 categories, 1 item per category, seed 42, `temperature=0`, `/no_think` | exact match `0.2143` (3/14) | Technical pipeline pass, partial sample |
| 2026-08-27 | `openai/gpt-oss-20b` / NVIDIA NIM | same protocol, credential from `NVIDIA_API_KEY` | network timeout before the first response, no aggregate | Transport failure, no score |

The 0.2143 value is not a leaderboard score. The harness documents that `--limit` is not suitable for a final metric; this run validates dataset loading, prompt construction, API routing, answer extraction, and metric calculation. Model strength remains unverified.

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
