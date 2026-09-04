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

The validated local CUDA quality profile uses the same complete split with `large-v3-turbo`:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_fleurs.py `
  --model large-v3-turbo `
  --config fr_fr `
  --split test `
  --device cuda `
  --compute-type float16 `
  --output artifacts\benchmarks\asr\fleurs-fr-large-v3-turbo-cuda-full.json
```

Observed on 2026-09-01: WER `0.065594`, CER `0.021253`, and RTF `0.023544` over all 676 public examples and 7,024.08 seconds of audio. The run took 165.38 seconds on an RTX 5080 and is the selected local quality profile; it does not replace the CPU baseline used for low-resource deployment.

## DROP reading comprehension through NVIDIA NIM

The official `drop` task from `lm-evaluation-harness` evaluates discrete and passage-based reading comprehension with exact-match and token-level F1 scoring. The following run used the public validation split, the NVIDIA NIM OpenAI-compatible endpoint, four concurrent requests, and an explicit 512-example public sample:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:PYTHONUTF8 = '1'
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=4,max_retries=3" `
  --tasks drop `
  --limit 512 `
  --num_fewshot 0 `
  --batch_size 1 `
  --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low,until=None" `
  --seed 42 `
  --output_path artifacts\benchmarks\drop\gpt-oss-20b-nvidia-limit512.json `
  --log_samples
```

Observed on 2026-08-28: 512/512 requests completed in `205.12` seconds. Official harness metrics were exact match `0.0020` (1/512) and F1 `0.1109` with stderr `0.0061`. The sample contains 512 unique document IDs, no malformed rows or duplicates, and one empty provider response. This is a partial public sample; the harness warns that `--limit` must not be used to represent a full benchmark score. The receipt and sample JSONL are written under `artifacts\benchmarks\drop` and remain ignored by Git.

## Generic Hugging Face ASR adapter

`run_asr_hf.py` evaluates a public Hugging Face audio dataset with the same `faster-whisper` scoring path. The dataset must expose an `audio` column and a text reference field. The adapter uses decoded audio bytes when available, records the public split scope, and writes WER, CER, real-time factor, elapsed time, and hardware metadata.

The observed MLS French run evaluated the complete public `facebook/multilingual_librispeech` test split:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_hf.py `
  --dataset facebook/multilingual_librispeech `
  --config french `
  --split test `
  --reference-field transcript `
  --language fr `
  --model small `
  --device cpu `
  --compute-type int8 `
  --output artifacts\benchmarks\asr\mls-fr-small-cpu-full.json
```

The run returned WER `0.130395`, CER `0.056910`, and RTF `0.164801` over 36,241.89 seconds of public audio and 2,426 examples. This is a reproducible public MLS baseline, not a lecture-domain score or a product-level quality claim.

The validated local CUDA quality profile uses the same complete split with `large-v3-turbo`:

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_hf.py `
  --dataset facebook/multilingual_librispeech `
  --config french `
  --split test `
  --reference-field transcript `
  --language fr `
  --model large-v3-turbo `
  --device cuda `
  --compute-type float16 `
  --output artifacts\benchmarks\asr\mls-fr-large-v3-turbo-cuda-full.json
```

Observed on 2026-09-01: WER `0.054124`, CER `0.028423`, and RTF `0.020460` over all 2,426 public examples and 36,241.89 seconds of audio. The run took 741.52 seconds on an RTX 5080 and is the selected local quality profile.

For large public splits, pass `--streaming` to iterate examples without materializing the complete dataset. This mode was used for the complete AMI meeting-speech SDM evaluation:

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_hf.py `
  --dataset edinburghcstr/ami `
  --config sdm `
  --split test `
  --reference-field text `
  --language en `
  --model large-v3-turbo `
  --streaming `
  --device cuda `
  --compute-type float16 `
  --output artifacts\benchmarks\asr\ami-sdm-en-large-v3-turbo-cuda-full.json
```

The complete public `sdm/test` split returned WER `0.408331`, CER `0.314221`, and RTF `0.068351` over 12,643 examples and 31,253.32 seconds of audio. The complete public `ihm/test` split returned WER `0.209307`, CER `0.134698`, and RTF `0.068221` over the same 12,643 segments and 31,253.32 seconds of audio. The full SDM and IHM results are recorded in [`docs/benchmarks.md`](../docs/benchmarks.md); they demonstrate the far-field meeting gap and do not include diarization scoring.

## Earnings-22 long-form ASR

Earnings-22 is a public English benchmark built from real corporate earnings calls with varied accents and spontaneous speech. The [`distil-whisper/earnings22`](https://huggingface.co/datasets/distil-whisper/earnings22) dataset exposes a `chunked` configuration with timestamped `audio` and `transcription` fields. The public `test` split contains 57,391 segments.

Run a reproducible local CUDA sample with:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_hf.py `
  --dataset distil-whisper/earnings22 `
  --config chunked `
  --split test `
  --reference-field transcription `
  --language en `
  --model large-v3-turbo `
  --limit 1000 `
  --streaming `
  --device cuda `
  --compute-type float16 `
  --output artifacts\benchmarks\asr\earnings22-en-large-v3-turbo-cuda-1000.json
```

Observed on 2026-09-01: the first 1,000 public segments returned WER `0.172654`, CER `0.114494`, and RTF `0.065921` over 6,767.08 seconds of audio. The run took 446.09 seconds on an RTX 5080. This is a robust partial public sample, not a full split score; the receipt is `artifacts\benchmarks\asr\earnings22-en-large-v3-turbo-cuda-1000.json` and is ignored by Git.

Run the complete public split with the same local CUDA profile:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_hf.py `
  --dataset distil-whisper/earnings22 `
  --config chunked `
  --split test `
  --reference-field transcription `
  --language en `
  --model large-v3-turbo `
  --streaming `
  --device cuda `
  --compute-type float16 `
  --output artifacts\benchmarks\asr\earnings22-large-v3-turbo-cuda-full.json
```

Observed on 2026-09-02: all 57,391 public segments completed with WER `0.205965`, CER `0.142776`, and RTF `0.032013` over 415,566.96 seconds of audio. The run took 13,303.49 seconds on an RTX 5080. The receipt is `artifacts\benchmarks\asr\earnings22-large-v3-turbo-cuda-full.json`; its SHA-256 is `73D771877B4F6397E1FA83D56B3AEC30A09247E30CDC3AB5D9A866CCE135EA2B`.

## FLEURS plus MUSAN robustness

`run_asr_musan.py` evaluates a public FLEURS French sample in clean form and after deterministic mixing with public [MUSAN](https://www.openslr.org/17/) noise, music, and speech sources. It reports WER, CER, RTF, condition, seed, source paths, and hardware. The protocol is a composite public-data robustness check, not an official MUSAN leaderboard metric.

MUSAN is a 10.32 GB archive. Download and extract only the four files used by the recorded run:

```powershell
New-Item -ItemType Directory -Force artifacts\benchmarks\musan | Out-Null
curl.exe -L --fail --retry 3 -o artifacts\benchmarks\musan\musan.tar.gz https://www.openslr.org/resources/17/musan.tar.gz
tar -xzf artifacts\benchmarks\musan\musan.tar.gz -C artifacts\benchmarks\musan `
  musan/noise/free-sound/noise-free-sound-0001.wav `
  musan/noise/sound-bible/noise-sound-bible-0001.wav `
  musan/music/hd-classical/music-hd-0022.wav `
  musan/speech/librivox/speech-librivox-0001.wav
```

Run the 100-example public sample:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_asr_musan.py `
  --musan-root artifacts\benchmarks\musan `
  --model small `
  --limit 100 `
  --snrs 10,0 `
  --device cpu `
  --compute-type int8 `
  --seed 42 `
  --output artifacts\benchmarks\musan\fleurs-fr-musan-100.json
```

The observed run evaluated 100 public FLEURS examples across clean, 10 dB, and 0 dB conditions for four MUSAN source categories. Clean WER was `0.157592`; noisy WER ranged from `0.173696` to `0.844709` at 10/0 dB depending on the source category. The full condition table is recorded in [`docs/benchmarks.md`](../docs/benchmarks.md).

## CoVoST 2 speech translation

`run_covost2_st.py` evaluates French-to-English speech translation on the public CoVoST 2 `fr_en/test` split. The runner uses the public `fixie-ai/covost2` parquet mirror, decodes its embedded Common Voice audio with PyAV, and scores model output with SacreBLEU and chrF. The default model is the official `facebook/s2t-small-covost2-fr-en-st` checkpoint and the default local CUDA precision is FP32. FP16 is available for comparison but is not the selected profile because the observed RTX 5080 run produced degenerate output in that mode.

Install the optional COMET scorer when a learned translation-quality metric is required:

```powershell
$env:USE_TF = '0'
.\.venv-bench-sys\Scripts\python.exe -m pip install -r requirements-speech-translation.txt
```

Set `USE_TF=0` in this Windows benchmark environment before importing the scorer. Add `--comet-model Unbabel/wmt22-comet-da` to a run to score each source, hypothesis, and reference triplet with COMET. The receipt records the model name and aggregate score. COMET is optional because it downloads a separate checkpoint and is not needed for SacreBLEU/chrF-only runs.

Install the benchmark dependencies in the isolated benchmark environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install datasets transformers sacrebleu av torch
```

Run a reproducible public sample:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_covost2_st.py `
  --dataset fixie-ai/covost2 `
  --config fr_en `
  --split test `
  --limit 1000 `
  --device cuda `
  --compute-type float32 `
  --output artifacts\benchmarks\covost2\facebook-s2t-small-fr-en-cuda-float32-1000.json
```

Observed on 2026-09-01: the first 1,000 public `fr_en/test` examples returned BLEU `0.228565` and chrF `0.488345` over 5,861.93 seconds of audio. The run took 306.67 seconds on an RTX 5080 (RTF `0.052315`). This is a partial public sample; the complete split result is recorded below.

Run the complete public test split with the selected CUDA FP32 profile:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_covost2_st.py `
  --dataset fixie-ai/covost2 `
  --config fr_en `
  --split test `
  --device cuda `
  --compute-type float32 `
  --output artifacts\benchmarks\covost2\facebook-s2t-small-fr-en-cuda-float32-full.json
```

Observed on 2026-09-01: all 14,760 public `fr_en/test` examples returned BLEU `0.263113` and chrF `0.535307` over 83,894.74 seconds of audio. The run took 5,313.33 seconds on an RTX 5080 (RTF `0.063333`). The full receipt SHA-256 is `D4A17B74133AD626EF33D800188460D7B2779A790344FD94B67FCF3DF9107AD2`.

Run the complete split with COMET scoring:

```powershell
$env:USE_TF = '0'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_covost2_st.py `
  --dataset fixie-ai/covost2 `
  --config fr_en `
  --split test `
  --device cuda `
  --compute-type float32 `
  --comet-model Unbabel/wmt22-comet-da `
  --comet-batch-size 8 `
  --output artifacts\benchmarks\covost2\facebook-s2t-small-fr-en-cuda-float32-comet-full.json
```

Observed on 2026-09-02: all 14,760 public examples returned COMET `0.706765`, BLEU `0.263113`, and chrF `0.535308` over 83,894.74 seconds of audio. The run took 4,557.37 seconds on an RTX 5080 (RTF `0.054322`). The full receipt SHA-256 is `69A2FB77CE05E3B46ABDDA9C0B9907A01BABC68DFE85602CF8944D0FDFB656AD`.

The first COMET diagnostic used the same public split and model on 100 examples:

```powershell
$env:USE_TF = '0'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_covost2_st.py `
  --dataset fixie-ai/covost2 `
  --config fr_en `
  --split test `
  --limit 100 `
  --device cuda `
  --compute-type float32 `
  --comet-model Unbabel/wmt22-comet-da `
  --output artifacts\benchmarks\covost2\facebook-s2t-small-fr-en-cuda-float32-comet-100.json
```

Observed on 2026-09-01: the 100-example diagnostic returned COMET `0.651932`, BLEU `0.223430`, chrF `0.476032`, and RTF `0.058232` on an RTX 5080. A larger 1,000-example diagnostic returned COMET `0.668898`, BLEU `0.228565`, chrF `0.488345`, and RTF `0.066166`, with 1,000/1,000 provider evaluations completed. Both remain partial diagnostics; the complete COMET result is recorded above.

The larger diagnostic is reproducible by changing the sample limit and receipt name:

```powershell
$env:USE_TF = '0'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_covost2_st.py `
  --dataset fixie-ai/covost2 `
  --config fr_en `
  --split test `
  --limit 1000 `
  --device cuda `
  --compute-type float32 `
  --comet-model Unbabel/wmt22-comet-da `
  --output artifacts\benchmarks\covost2\facebook-s2t-small-fr-en-cuda-float32-comet-1000.json
```

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

## OmniDocBench text OCR diagnostic

`run_omnidocbench_ocr.py` evaluates RapidOCR on the public `rwood-97/english_OmniDocBench_with_eval` derivative, which provides document images and OmniDocBench-style text annotations in the same dataset rows. It reports two clearly separated normalized character edit-similarity metrics:

- full-page similarity, which includes OCR reading order and detection;
- oracle-span similarity, which assigns detections inside each annotated text polygon and isolates recognition quality from layout detection.

The oracle-span protocol is intentionally labeled as a diagnostic. It is not the overall official OmniDocBench score and does not measure tables, formulas, layout, or document-level parsing.

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_omnidocbench_ocr.py `
  --limit 100 `
  --output artifacts\benchmarks\omnidocbench\rapidocr-english-100.json
```

The observed 100-page public run returned full-page edit similarity `0.389089` and oracle-span text-recognition similarity `0.650826` in `783.930` seconds. The receipt is local and ignored by Git; the complete official OmniDocBench evaluation remains open.

## PubTabNet TEDS table reconstruction

`run_pubtabnet_teds.py` evaluates a multimodal provider against the public `apoidea/pubtabnet-html` validation derivative. Each request asks for one HTML table, and the first returned `<table>` element is scored with the APTED tree-edit-distance implementation used by the public PubTabNet metric. The receipt stores every prediction and provider/scorer error.

For long evaluations, add `--checkpoint-path` and optionally `--checkpoint-every` to persist completed rows atomically. Reusing the same command loads the checkpoint, validates its dataset, split, model, endpoint, and range metadata, and skips completed image IDs. Add `--expected-samples` when the public split cardinality is known so the final receipt can distinguish a complete split from a selected range.

Install the optional scorer dependency in the benchmark environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install apted lxml
```

Run the NVIDIA evaluation with the Windows User credential:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_pubtabnet_teds.py `
  --split validation `
  --limit 100 `
  --concurrency 4 `
  --output artifacts\benchmarks\pubtabnet\nvidia-llama-11b-validation-100.json
```

The observed 100-table public run scored raw TEDS `-0.220134` and structure-only TEDS `0.724814` with `meta/llama-3.2-11b-vision-instruct` in `829.855` seconds. All 100 provider responses were scored. This is a partial validation evaluation; the structure-only score does not replace content-sensitive TEDS, and the target remains unmet.

The complete public validation run used the same model and protocol with bounded batches and atomic checkpoints:

```powershell
$env:HF_HUB_DISABLE_XET = '1'
$env:USE_TF = '0'
$env:PYTHONIOENCODING = 'utf-8'
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
python benchmarks\run_pubtabnet_teds.py `
  --dataset apoidea/pubtabnet-html `
  --split validation `
  --limit 9115 `
  --expected-samples 9115 `
  --model meta/llama-3.2-11b-vision-instruct `
  --base-url https://integrate.api.nvidia.com/v1 `
  --api-key-env NVIDIA_API_KEY `
  --concurrency 8 `
  --timeout-seconds 180 `
  --max-retries 2 `
  --checkpoint-path artifacts\benchmarks\pubtabnet\nvidia-llama-11b-validation-full.checkpoint.json `
  --checkpoint-every 100 `
  --output artifacts\benchmarks\pubtabnet\nvidia-llama-11b-validation-full.json
```

The observed complete public split contains 9,115 tables, with 9,114 successful responses and one retained provider failure. Content-sensitive TEDS was `-0.196956`, structure-only TEDS was `0.712401`, and elapsed time was `32695.114` seconds. The final receipt is local and ignored by Git at `artifacts/benchmarks/pubtabnet/nvidia-llama-11b-validation-full.json`; its SHA-256 is `7776F95F20890B1165F7A9F17949FB252820945489EE5E8DBD224B4604244202`. This is complete public-split coverage, but the content-fidelity target remains unmet.

## DocVQA ANLS vision evaluation

`run_docvqa_anls.py` evaluates an OpenAI-compatible vision model against the
public DocVQA validation split. It uses the official ANLS calculation: the
best normalized Levenshtein similarity against the reference answers, with
scores below `0.5` set to zero. Every prediction and provider error is stored
in the receipt.

```powershell
$env:NVIDIA_API_KEY=[Environment]::GetEnvironmentVariable('NVIDIA_API_KEY','User')
python benchmarks\run_docvqa_anls.py `
  --model meta/llama-3.2-11b-vision-instruct `
  --split validation `
  --limit 100 `
  --concurrency 4 `
  --output artifacts\benchmarks\docvqa\nvidia-llama-vision-validation-100.json
```

The observed 100-image public subset returned ANLS `0.8591` with 100/100
successful provider calls. This is official metric computation on a public
subset, not a full validation-set score or a claim against a leaderboard.

A matched NVIDIA `meta/llama-3.2-90b-vision-instruct` comparison on the same
100 examples returned ANLS `0.8203` with 99/100 successful calls in
`1722.917` seconds. The measured 11B run remains the selected baseline because
it scored higher and completed substantially faster; the 90B receipt is kept
as a negative comparison at
`artifacts/benchmarks/docvqa/nvidia-llama-90b-vision-validation-100.json`.

A larger run with the 11B model scored ANLS `0.8297` on 500 public validation
examples, with 498/500 successful calls in `388.186` seconds. This larger
sample supersedes the 100-image result as the selected partial baseline. Its
receipt is `artifacts/benchmarks/docvqa/nvidia-llama-11b-vision-validation-500.json`.

The largest measured run with the same model scored ANLS `0.8321` on 1,000
public validation examples, with 988/1,000 successful calls in `504.538`
seconds. Twelve provider calls returned HTTP 429 after retries; those failures
are retained in the receipt and are included as zero-scored rows in the
aggregate. This remains a partial public subset, not a full validation-set
score. Its receipt is
`artifacts/benchmarks/docvqa/nvidia-llama-11b-vision-validation-1000.json`.

Run the complete public validation split with the selected NVIDIA profile:

```powershell
$env:HF_HUB_DISABLE_XET = '1'
$env:USE_TF = '0'
python benchmarks\run_docvqa_anls.py `
  --dataset lmms-lab/DocVQA `
  --config DocVQA `
  --split validation `
  --limit 5349 `
  --model meta/llama-3.2-11b-vision-instruct `
  --base-url https://integrate.api.nvidia.com/v1 `
  --concurrency 4 `
  --timeout-seconds 180 `
  --max-retries 2 `
  --output artifacts\benchmarks\docvqa\nvidia-llama-11b-vision-validation-full.json
```

Observed full-split result: ANLS `0.829761` across all 5,349 public validation
images, with 5,295 successful responses and 54 provider failures retained as
zero-scored rows. The run took `3258.636` seconds. The receipt SHA-256 is
`8B547D326CCE456C56059ABE5363C169DF975015299C3E88BAFE857A5A69611A`.

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

### Resumable complete MMLU-Pro run

`run_mmlu_pro_full.py` runs the official fourteen-category `mmlu_pro` group one category at a time. Each completed category keeps its own lm-evaluation-harness receipt, while `mmlu_pro_full_manifest.json` records the exact command, configuration, exit code, and receipt path. Re-running the command reuses complete category receipts and continues from the first missing category.

Use the NVIDIA User environment value without placing credentials in a file:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro_full.py `
  --output-dir artifacts\benchmarks\mmlu-pro\full `
  --num-concurrent 4 `
  --reasoning-effort low
```

The runner expects the complete public group of 12,032 items and writes `mmlu_pro_full_summary.json` only after every selected category has a scored receipt. Use `--dry-run` to inspect the category commands without making provider requests. For long or unstable provider runs, add `--chunk-size 100`: each category is evaluated through explicit contiguous `--samples` ranges, each completed range gets its own receipt, and a later invocation reuses completed ranges. Chunked category aggregates are labeled as weighted means of their harness receipts. The current campaign has complete receipts for 13 categories (11,234 items); `psychology` is recorded as interrupted after provider timeouts at item 34/798 and can be resumed with the chunked mode.

The adapter selects `NVIDIA_API_KEY` when the configured endpoint is NVIDIA NIM and preserves `OPENAI_API_KEY` for other OpenAI-compatible endpoints such as the existing LM Studio server.

The first completed category campaign covered all 717 public biology test items and returned exact match `0.2720` (195/717, stderr `0.0166`). This is a complete category result, not a complete fourteen-category MMLU-Pro result. Its local receipt is `artifacts/benchmarks/mmlu-pro/full/mmlu_pro_biology_2026-08-30T17-52-59.449454.json`.

## NVIDIA NIM

The same adapter can target NVIDIA NIM through the Windows User environment variable:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
.\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks mmlu_pro --limit 20 --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low" --seed 42 `
  --output_path artifacts/benchmarks/mmlu-pro/gpt-oss-20b-nvidia-limit20-low.json --log_samples
```

The first August 27, 2026 NVIDIA run timed out after retries before producing a response aggregate and is recorded as a transport failure with no score. A subsequent 140-item public sample across all 14 MMLU-Pro categories completed through NVIDIA NIM with exact match `0.2857` (40/140, stderr `0.0387`) using `reasoning_effort=low`. A larger 280-item public sample completed on August 28, 2026 with exact match `0.2821` (79/280, stderr `0.0262`) across 20 items in each category; the recorded evaluation time was `4,124.09 s`. Both are partial public samples, not leaderboard scores or a full-suite result. The larger receipt is `artifacts/benchmarks/mmlu-pro/gpt-oss-20b-nvidia-limit20-low_*.json`.

## BIG-Bench Hard through NVIDIA NIM

The same official `lm-evaluation-harness` adapter can run public [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard) tasks through NVIDIA NIM. The observed partial runs completed all 250 public cases for five task configurations with `openai/gpt-oss-20b`, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, and `reasoning_effort=low`:

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

The observed logical-deduction score was flexible-extract exact match `0.5920` (148/250, stderr `0.0311`) in `1,335.02 s`. The arithmetic score was flexible-extract exact match `0.9640` (241/250, stderr `0.0118`) and strict-match `0.6480` (162/250, stderr `0.0303`) in `362.54 s`. The tracking score was flexible-extract exact match `0.8520` (213/250, stderr `0.0225`) in `884.61 s`; strict-match returned `0.0000`. The Dyck-language score was flexible-extract exact match `0.0360` (9/250, stderr `0.0118`) and strict-match `0.0320` (8/250, stderr `0.0112`) in `776.45 s`. The colored-objects score was flexible-extract exact match `0.4880` (122/250, stderr `0.0317`) in `294.17 s`; strict-match returned `0.0000`. The aggregate receipts are `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-logical-deduction-seven-objects_2026-08-28T04-09-12.159146.json`, `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-multistep-arithmetic-two_2026-08-28T04-24-52.265096.json`, `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-tracking-shuffled-objects-seven_2026-08-28T04-44-38.193434.json`, `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-dyck-languages_2026-08-28T05-02-55.787704.json`, and `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-reasoning-colored-objects_2026-08-28T05-12-54.724570.json`. These are complete public samples for five official BBH tasks, not a full BBH result or a leaderboard claim.

The complete official `bbh_zeroshot` group was then evaluated through the same endpoint with four concurrent requests and `until=None`. The installed official harness enumerated 27 task configurations and 6,511 public cases. The aggregate flexible-extract exact match was `0.7474` (4,866/6,511, stderr `0.0047`). The receipt retained 152 empty provider responses and no malformed sample rows. The detailed per-task table, exact command, and timestamped receipt paths are maintained in [`docs/benchmarks.md`](../docs/benchmarks.md).

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

The aggregate receipt is `artifacts/benchmarks/bbh/gpt-oss-20b-nvidia-full_2026-08-28T10-16-27.620727.json`. `lm-eval` writes one sample file per task and one row per metric filter, so the 13,022 raw filter rows represent 6,511 unique public cases.

## HumanEval+ through EvalPlus and NVIDIA NIM

The official [EvalPlus](https://github.com/evalplus/evalplus) evaluator measures the public HumanEval+ tasks with the original HumanEval tests and the extended public tests. `run_evalplus_wsl.sh` uses EvalPlus `0.3.1`, the OpenAI-compatible NVIDIA endpoint, greedy decoding, and a code-only instruction prompt. The generation bridge preserves the official EvalPlus sanitisation and handles empty provider content without changing the benchmark tests or scorer.

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_evalplus_wsl.sh
```

The complete run evaluated 164 unique public tasks. Official EvalPlus returned base `pass@1` `0.8963` (147/164) and HumanEval+ `pass@1` `0.8232` (135/164). `evalplus.syncheck` found one non-compilable sanitised sample, which remained a scored failure. The result file is `artifacts/benchmarks/humaneval-plus-code-only/samples_humaneval_evalplus_eval_results.json`; sanitised and raw samples are stored beside it as `samples_humaneval_evalplus.jsonl` and `samples_humaneval_evalplus.raw.jsonl`.

## MBPP+ through EvalPlus and NVIDIA NIM

The same official [EvalPlus](https://github.com/evalplus/evalplus) evaluator supports the public MBPP+ task set. Pass `--dataset mbpp` to the WSL runner to select the 378-task MBPP+ dataset; the runner reuses the pinned EvalPlus `0.3.1` environment, the OpenAI-compatible NVIDIA endpoint, greedy decoding, and the code-only instruction prompt.

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_evalplus_wsl.sh --dataset mbpp
```

The complete run evaluated 378 unique public tasks. Official EvalPlus returned MBPP base `pass@1` `0.8571` (324/378) and MBPP+ `pass@1` `0.6852` (259/378). `evalplus.syncheck` found three non-compilable sanitised samples (`Mbpp/430`, `Mbpp/462`, and `Mbpp/581`), which remained scored failures. The result file is `artifacts/benchmarks/mbpp-plus-code-only/samples_mbpp_evalplus_eval_results.json`; sanitised and raw samples are stored beside it as `samples_mbpp_evalplus.jsonl` and `samples_mbpp_evalplus.raw.jsonl`.

## HumanEval through NVIDIA NIM

The official [HumanEval](https://huggingface.co/datasets/openai/openai_humaneval) task can be run through NVIDIA NIM with the official Linux `code_eval` scorer. Windows cannot provide the evaluator's Linux Python test-process runtime, so use the WSL runner from the repository root. It creates or reuses `/root/studentllm-human-eval`, retrieves `NVIDIA_API_KEY` from the Windows User environment at run time, and does not store the credential in the repository.

Install and run the default instruction task:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh
```

Run the standard continuation task or a one-case probe:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh --task humaneval
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh --probe
```

To evaluate the same public split with an explicit code-only output contract while retaining the official HumanEval scorer, run:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/Code/Travail/Etudes/StudentLLM/benchmarks/run_humaneval_wsl.sh --code-only
```

This is a separate protocol and writes a separate receipt. The adapter extracts a fenced or entry-point code region before applying the official candidate construction; it does not overwrite the earlier explanation-first result.

The complete observed `humaneval_instruct` and `humaneval` runs each evaluated all 164 public problems with `openai/gpt-oss-20b`, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=1024`, `reasoning_effort=low`, four concurrent requests, and `until=None`. Both official `pass@1` values were `0.0000` (0/164), with zero empty responses. The raw outputs consistently began with explanatory prose followed by a fenced Python block, while the official filters expect a code-only continuation. The separate `--code-only` protocol evaluated all 164 public problems with the same model and decoding settings, scored `0.8780` (144/164, stderr `0.0256`), and retained one empty provider response. Its receipt is `artifacts/benchmarks/humaneval/gpt-oss-20b-nvidia-code-only-full_2026-08-30T13-39-52.840104.json`, with samples in `samples_humaneval_code_only_2026-08-30T13-39-52.840104.jsonl`. The two protocols remain separately labeled and independently reproducible.

## GSM8K through NVIDIA NIM

The same official `lm-evaluation-harness` adapter evaluates the public [GSM8K](https://github.com/openai/grade-school-math) task through NVIDIA NIM. The observed run completed the full `openai/gsm8k` test split of 1,319 public problems with `openai/gpt-oss-20b`, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, and one concurrent request. The harness was `lm-evaluation-harness 0.4.12`.

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks gsm8k `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low" --seed 42 `
  --output_path artifacts/benchmarks/gsm8k/gpt-oss-20b-nvidia.json --log_samples
```

The full public test split returned flexible-extract exact match `0.8544` (1,127/1,319, stderr `0.0097`) and strict-match `0.0000` (0/1,319) in `2,420.32 s`. The aggregate receipt is `artifacts/benchmarks/gsm8k/gpt-oss-20b-nvidia_2026-08-28T05-59-45.464108.json`. This is a complete single-task result, not a general model ranking or a full benchmark suite result.

## MATH-500 through NVIDIA NIM

The official [MATH-500](https://huggingface.co/datasets/HuggingFaceH4/MATH-500) test split is available through the official `minerva_math500` task in `lm-evaluation-harness`. Install the math extra before running this task:

```powershell
python -m pip install "lm-eval[math]"
```

The corrected runner keeps the official dataset and scoring functions while avoiding the nested Windows timeout subprocess used by `math_verify` in a single-worker evaluation:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_math.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks minerva_math500 `
  --num_fewshot 4 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=2048,reasoning_effort=low" --seed 42 `
  --output_path artifacts/benchmarks/math500/gpt-oss-20b-nvidia.json --log_samples
```

The observed full public run evaluated all 500 MATH-500 problems and returned official `math_verify` `0.8220` (411/500, stderr `0.0171`) and official `exact_match` `0.0000` in `2,572.14 s` of generation. The corrected receipt is `artifacts/benchmarks/math500/gpt-oss-20b-nvidia-math-verify-rescored.json`. The first direct harness receipt is retained separately because its Windows timeout path produced invalid zero metrics; it is not used for the reported score. The `math_verify` result is the usable metric for these boxed model answers, while the legacy string extractor returned no matches. This is a complete public single-task result, not a full math suite or a general model ranking.

## AIME 2024 and AIME 2025 through NVIDIA NIM

The official [AIME 2024](https://huggingface.co/datasets/Maxwell-Jia/AIME_2024) and [AIME 2025](https://huggingface.co/datasets/math-ai/aime25) tasks in `lm-evaluation-harness` provide compact, difficult public competition-mathematics evaluations. Each observed run covered all 30 public problems with `openai/gpt-oss-20b`, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=32768`, `reasoning_effort=low`, and one concurrent request through NVIDIA NIM:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_mmlu_pro.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks aime24 `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=32768,reasoning_effort=low" --seed 42 `
  --output_path artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime24.json --log_samples
```

The AIME 2024 receipt returned exact match `0.3667` (11/30, stderr `0.0895`) in `889.95 s`. The AIME 2025 receipt returned exact match `0.3000` (9/30, stderr `0.0851`) in `460.16 s`; change the task and output filename to `aime25` to reproduce it. The aggregate receipts are `artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime24_2026-08-28T07-20-06.666685.json` and `artifacts/benchmarks/aime/gpt-oss-20b-nvidia-aime25_2026-08-28T07-30-35.078582.json`. These are complete public samples for two years, not a combined leaderboard score or a general model ranking.

## ARC-Challenge through NVIDIA NIM

The official `lm-evaluation-harness 0.4.12` includes both the log-likelihood `arc_challenge` task and the generation-compatible `arc_challenge_chat` task. Chat-completions providers must use the latter. The observed run evaluated all 1,172 public `allenai/ai2_arc` ARC-Challenge test questions with `openai/gpt-oss-20b`, zero-shot prompts, seed 42, `temperature=0`, `max_gen_toks=512`, `reasoning_effort=low`, one concurrent request, and the Windows User `NVIDIA_API_KEY` environment variable.

`run_arc.py` removes only the `The best answer is` prefix echoed by NVIDIA NIM before the official task filter runs. The command also sets `until=None` because the task's default period stop sequence can terminate this provider after its reasoning channel and leave the content field empty:

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:OPENAI_API_KEY = $env:NVIDIA_API_KEY
$env:PYTHONUTF8 = '1'
& .\.venv-bench\Scripts\python.exe benchmarks\run_arc.py run `
  --model local-chat-completions `
  --model_args "model=openai/gpt-oss-20b,base_url=https://integrate.api.nvidia.com/v1/chat/completions,tokenizer_backend=None,num_concurrent=1,max_retries=3" `
  --tasks arc_challenge_chat `
  --num_fewshot 0 --batch_size 1 --apply_chat_template `
  --gen_kwargs "temperature=0,max_gen_toks=512,reasoning_effort=low,until=None" --seed 42 `
  --output_path artifacts/benchmarks/arc-challenge/gpt-oss-20b-nvidia-full.json --log_samples
```

The full public run returned exact match `0.8473` (993/1,172, stderr `0.0105`) in `1,156.65 s`, with zero empty responses. Its aggregate receipt is `artifacts/benchmarks/arc-challenge/gpt-oss-20b-nvidia-full_2026-08-28T08-03-59.129683.json`. This is complete single-task evidence, not a global model ranking.

## IFEval through NVIDIA NIM

The official [IFEval](https://github.com/google-research/google-research/tree/master/ifeval) task in `lm-evaluation-harness` measures whether generated responses follow verifiable instructions. Install the pinned benchmark environment:

```powershell
& .\.venv-bench\Scripts\python.exe -m pip install -r requirements-ifeval.txt
```

Run the complete public 541-prompt task through NVIDIA NIM:

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

The observed run on 2026-08-28 evaluated all 541 public prompts with the official `lm-evaluation-harness 0.4.12` task. Prompt-level strict accuracy was `0.7024` (stderr `0.0197`), instruction-level strict accuracy was `0.7878`, prompt-level loose accuracy was `0.7412` (stderr `0.0188`), and instruction-level loose accuracy was `0.8177`. Four provider responses had empty content; the harness retained them as empty strings, so they remain part of the reported result. The aggregate receipt is `artifacts/benchmarks/ifeval/gpt-oss-20b-nvidia-full_2026-08-28T08-34-22.627222.json` and the 541 raw samples are in the matching `samples_ifeval_2026-08-28T08-34-22.627222.jsonl` file. This is complete public single-task evidence, not a general model ranking.

## BEIR BM25 baselines

`run_beir_bm25.py` evaluates complete public SciFact, NFCorpus, ArguAna, FiQA, SCIDOCS, or TREC-COVID test splits with a deterministic BM25 baseline. It loads the corpus, queries, and test relevance judgments from the corresponding [BEIR datasets](https://github.com/beir-cellar/beir/wiki/Datasets-available) and reports nDCG@10, Recall@10, and MRR@10.

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
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_bm25.py --dataset trec-covid --output_path artifacts\benchmarks\beir\trec-covid-bm25.json
```

These are retrieval baselines on public information-retrieval datasets. They are independent of the LM Studio process and do not require model inference.

The observed TREC-COVID run evaluated 171,332 documents, 50 public test queries, and 66,336 qrel rows. BM25 returned nDCG@10 `0.5537`, Recall@10 `0.0157`, and MRR@10 `0.7906` in 46.10 seconds.

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

The 2026-09-01 CUDA encoder comparison on the complete SciFact test split measured BGE-base at nDCG@10 `0.737626`, Recall@10 `0.865889`, and MRR@10 `0.700366` in `34.958` seconds. BGE-large measured nDCG@10 `0.734632`, Recall@10 `0.859222`, and MRR@10 `0.701276` in `83.342` seconds. BGE-base is the best of the measured small/base/large variants for nDCG and Recall, but all remain below the target; these are benchmark candidates, not an automatic app-model switch.

The observed ArguAna run evaluated 8,674 documents and 1,406 public test queries with `BAAI/bge-small-en-v1.5` on CPU. It returned nDCG@10 `0.4287`, Recall@10 `0.8414`, and MRR@10 `0.2956`, compared with the BM25 baseline of `0.3132`, `0.6636`, and `0.2030`.

The observed SCIDOCS run evaluated 25,657 documents and 1,000 public test queries with the same model and settings. It returned nDCG@10 `0.1973`, Recall@10 `0.2091`, and MRR@10 `0.3344`, compared with the BM25 baseline of `0.1528`, `0.1584`, and `0.2736`.

The observed FiQA run evaluated 57,638 documents and 648 public test queries with the same model and settings. It returned nDCG@10 `0.3848`, Recall@10 `0.4396`, and MRR@10 `0.4650`, compared with the BM25 baseline of `0.2347`, `0.2962`, and `0.2919`.

The observed TREC-COVID dense run evaluated 171,332 documents and 50 public test queries with the same model and settings. It returned nDCG@10 `0.6438`, Recall@10 `0.0184`, and MRR@10 `0.8779`, compared with the BM25 baseline of `0.5537`, `0.0157`, and `0.7906`. The CPU run completed in 3,002.23 seconds.

## BEIR hybrid retrieval

`run_beir_hybrid.py` combines deterministic BM25 and normalized dense retrieval with fixed reciprocal-rank fusion. It exists to test whether lexical and semantic retrieval are complementary on a public split; it is not assumed to improve the dense baseline.

```powershell
$env:USE_TF = '0'
$env:TRANSFORMERS_NO_TF = '1'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_hybrid.py `
  --dataset scifact `
  --model BAAI/bge-base-en-v1.5 `
  --device cuda `
  --batch-size 64 `
  --candidate-k 100 `
  --output-path artifacts\benchmarks\beir\scifact-bge-base-hybrid.json
```

The complete SciFact test split returned nDCG@10 `0.721434`, Recall@10 `0.836056`, and MRR@10 `0.691434`. The matched BGE-base dense run was higher at `0.737626`, `0.865889`, and `0.700366`, so the tested hybrid configuration is not the selected default.

## BEIR CrossEncoder reranking

`run_beir_rerank.py` performs dense BGE retrieval into a fixed top-100 candidate set and reranks those candidates with a public SentenceTransformers CrossEncoder. This is an evaluation adapter, not an automatic runtime switch.

```powershell
$env:USE_TF = '0'
$env:TRANSFORMERS_NO_TF = '1'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_beir_rerank.py `
  --dataset scifact `
  --model BAAI/bge-base-en-v1.5 `
  --reranker-model BAAI/bge-reranker-base `
  --device cuda `
  --batch-size 64 `
  --rerank-batch-size 32 `
  --candidate-k 100 `
  --output-path artifacts\benchmarks\beir\scifact-reranked.json
```

On the complete SciFact test split, `BAAI/bge-reranker-base` scored nDCG@10 `0.713320`, Recall@10 `0.840111`, and MRR@10 `0.679505`; `cross-encoder/ms-marco-MiniLM-L-6-v2` scored `0.694969`, `0.822222`, and `0.663997`. Both are below dense-only BGE-base (`0.737626`, `0.865889`, `0.700366`) and are therefore not promoted.

## MTRAG human retrieval

`run_mtrag_retrieval.py` evaluates the official [IBM MTRAG benchmark](https://github.com/IBM/mt-rag-benchmark) retrieval tasks across the public passage-level corpora. It supports the human `lastturn`, `rewrite`, and `questions` variants and `bm25`, `dense`, and fixed `hybrid` retrievers. The output metrics are compatible with the official evaluator and the optional prediction JSONL can be passed to it directly.

```powershell
$env:USE_TF = '0'
$env:TRANSFORMERS_NO_TF = '1'
$env:HF_HUB_DISABLE_XET = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_mtrag_retrieval.py `
  --dataset-root C:\path\to\mt-rag-benchmark `
  --variant rewrite `
  --retriever dense `
  --model BAAI/bge-base-en-v1.5 `
  --device cuda `
  --batch-size 64 `
  --candidate-k 100 `
  --collections clapnq cloud fiqa govt `
  --predictions-path artifacts\benchmarks\mtrag\predictions.jsonl `
  --output-path artifacts\benchmarks\mtrag\receipt.json
```

The complete measured rewrite run covered 777 public qrels-scored queries across all four collections. BGE-base dense scored nDCG@10 `0.354194` and Recall@10 `0.446961`; BM25 rewrite scored `0.240306` and `0.316811`. Full evidence is recorded in `docs/benchmarks.md`.

## CRAG Task 1/2 generation

`run_crag.py` evaluates the official [Facebook Research CRAG](https://github.com/facebookresearch/CRAG) Task 1 and Task 2 development file through any OpenAI-compatible endpoint. The gold answer is used only after generation by the optional public-style judge. The runner supports bounded requests, concurrent workers, split selection, and JSON receipts that retain every response and failure.

```powershell
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_crag.py `
  --data-path C:\path\to\crag_task_1_and_2_dev_v4.jsonl.bz2 `
  --split 0 `
  --model openai/gpt-oss-20b `
  --base-url https://integrate.api.nvidia.com/v1 `
  --api-key-env NVIDIA_API_KEY `
  --judge-model openai/gpt-oss-20b `
  --workers 4 `
  --output-path artifacts\benchmarks\crag\validation.json
```

The first bounded validation smoke covered 10 of 1,371 examples and scored `-0.2000` under the public-style judge. It is integration evidence only; the full validation and public campaigns remain open.

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

The same official wrapper can run the multilingual `STS22.v2` task:

```powershell
$env:CUDA_VISIBLE_DEVICES = ''
$env:PYTHONUTF8 = '1'
.\.venv-bench-sys\Scripts\python.exe benchmarks\run_mteb.py `
  --model BAAI/bge-small-en-v1.5 `
  --task STS22.v2 `
  --split test `
  --device cpu `
  --batch-size 32 `
  --output artifacts\benchmarks\mteb\sts22-v2-bge-small-en-v1.5.json
```

The observed public test run evaluated 3,958 sentence pairs across 18 language or cross-language subsets in 208.23 seconds. The unweighted macro-average of the 18 reported MTEB main scores was `0.469262`; individual scores ranged from Arabic `0.188313` to French `0.740204`. This descriptive average is not an official leaderboard aggregate and should not hide the language-level spread.

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

The observed run used the existing LM Studio process and completed 20 public `simple_python` cases with the official scorer: accuracy `1.0000` (20/20), mean latency `1.747 s`, and approximate p95 latency `3.112 s`. A second run completed 20 public `parallel_multiple` cases: accuracy `0.8500` (17/20), mean latency `2.420 s`, and approximate p95 latency `3.991 s`. A third run completed 20 public `multiple` cases: accuracy `0.9500` (19/20), mean latency `1.563 s`, and approximate p95 latency `2.407 s`. A fourth run completed 20 public `irrelevance` cases: accuracy `1.0000` (20/20), mean latency `2.593 s`, and approximate p95 latency `5.067 s`.

To reproduce the `multiple` category, use a separate ignored root and public IDs `multiple_0` through `multiple_19`:

```powershell
$env:BFCL_PROJECT_ROOT = (Resolve-Path artifacts\benchmarks\bfcl-multiple).Path
New-Item -ItemType Directory -Force artifacts\benchmarks\bfcl-multiple | Out-Null
@{ multiple = 0..19 | ForEach-Object { "multiple_$($_)" } } | ConvertTo-Json | Set-Content -Encoding utf8 artifacts\benchmarks\bfcl-multiple\test_case_ids_to_generate.json
```

Run the same official `generate` and `evaluate` commands above with `--test-category multiple` and `--result-dir result`.

The `irrelevance` category uses the same process and official scorer. Reproduce it with an isolated `artifacts\benchmarks\bfcl-irrelevance` root and public IDs `irrelevance_0` through `irrelevance_19`, then run the commands above with `--test-category irrelevance`. The observed partial category score was `1.0000` (20/20); the result does not represent global BFCL performance.

The multi-turn run uses a separate ignored root so its files do not overwrite the single-turn receipts:

```powershell
$env:BFCL_PROJECT_ROOT = (Resolve-Path artifacts\benchmarks\bfcl-multi-turn).Path
New-Item -ItemType Directory -Force artifacts\benchmarks\bfcl-multi-turn | Out-Null
```

Create `artifacts\benchmarks\bfcl-multi-turn\test_case_ids_to_generate.json` with the public IDs `multi_turn_base_0` through `multi_turn_base_19`, then run the same `generate` and `evaluate` commands above with `--test-category multi_turn_base` and `--result-dir result`. The official scorer returned accuracy `0.3000` (6/20). Generation produced many empty responses and malformed tool calls, so this is a partial category result and a compatibility finding, not a global BFCL score or a general multi-turn capability claim. The result and score directories are local ignored artifacts.

The same official path was run against 20 public `multi_turn_miss_func` cases and 20 public `multi_turn_miss_param` cases using separate ignored roots. `multi_turn_miss_func` returned `0.1500` (3/20) across 263 requests, with mean latency `4.135 s` and approximate p95 `11.188 s`. `multi_turn_miss_param` returned `0.1500` (3/20) across 285 requests, with mean latency `5.597 s`, approximate p95 `17.944 s`, and maximum `72.238 s`. Both runs produced empty responses and long tool sequences. These are partial category diagnostics, not global BFCL scores.

Reproduce either negative multi-turn category by creating an ignored `test_case_ids_to_generate.json` containing the matching public IDs (`multi_turn_miss_func_0` through `multi_turn_miss_func_19` or `multi_turn_miss_param_0` through `multi_turn_miss_param_19`), setting `BFCL_PROJECT_ROOT` to the isolated root, and running the same official commands with the matching `--test-category`.

### NVIDIA NIM through the OpenAI-compatible API

`run_bfcl_openai_compatible.py` runs the same official BFCL generator and scorer against an OpenAI-compatible endpoint. It registers the selected provider model with the official evaluator in-process, so the result remains a BFCL result rather than a locally authored tool-calling check. The API key is read from the Windows User environment variable `NVIDIA_API_KEY`.

```powershell
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:PYTHONUTF8 = '1'
& .\.venv-bfcl\Scripts\python.exe benchmarks\run_bfcl_openai_compatible.py `
  --project-root artifacts\benchmarks\bfcl-nvidia-gpt-oss-simple-python `
  --category simple_python `
  --model openai/gpt-oss-20b `
  --base-url https://integrate.api.nvidia.com/v1 `
  --limit 20 `
  --num-threads 1 `
  --request-timeout 120 `
  --allow-overwrite
```

For the complete `live_irrelevance` category, use `--start 0 --limit 884 --num-threads 8` and an isolated project root. The 884-case NVIDIA run completed with official BFCL irrelevance detection accuracy `81.90%` (724/884); the result and score files are retained locally under `artifacts\benchmarks\bfcl-nvidia-live-irrelevance-full`.

`--limit 20` selects 20 public entries for the requested category using the IDs stored in the official BFCL dataset. Live and multi-turn categories use compound IDs from that dataset rather than synthetic `category_index` IDs. Memory categories contain prerequisite conversations before the scored questions, so the wrapper selects 20 non-prerequisite targets and automatically adds their transitive prerequisite closure to the ID file. For example, the first `memory_kv` sample contains 20 scored targets and 10 prerequisites, for 30 selected generation entries. The JSON receipt reports `case_count`, `prerequisite_case_count`, and `selected_case_count` separately. It is a reproducible category sample, not a full BFCL leaderboard run. Use a separate `--project-root` for each category so raw generations and scorer output remain isolated.

The wrapper bounds each provider request to 120 seconds by default. This keeps a stalled OpenAI-compatible request from holding a multi-turn run indefinitely; the value can be changed with `--request-timeout` when a provider needs a different limit.

The observed NVIDIA NIM runs on 2026-08-28 used `openai/gpt-oss-20b`, `temperature=0`, one request thread, and the Windows User `NVIDIA_API_KEY` value:

| Category | Public cases | Official category accuracy | Latency evidence |
| --- | ---: | ---: | --- |
| `simple_python` | 20 | `45.00%` (9/20) | Mean `0.929 s`, p95 `1.648 s`, max `1.792 s` |
| `simple_java` | 20 | `0.00%` (0/20) | Mean `1.391 s`, p95 `2.380 s` |
| `simple_javascript` | 20 | `45.00%` (9/20) | Mean `4.232 s`, p95 `11.300 s` |
| `multiple` | 20 | `5.00%` (1/20) | Mean `2.175 s`, p95 `11.156 s`, max `16.268 s` |
| `parallel` | 20 | `0.00%` (0/20) | Mean `3.212 s`, p95 `6.790 s` |
| `parallel_multiple` | 20 | `0.00%` (0/20) | Mean `1.352 s`, p95 `2.370 s`, max `2.569 s` |
| `live_simple` | 20 | `85.00%` (17/20) | Mean `0.813 s` |
| `live_multiple` | 20 | `15.00%` (3/20) | Mean `1.888 s` |
| `live_parallel` | 16 | `0.00%` (0/16) | Mean `1.571 s` |
| `live_parallel_multiple` | 24 | `0.00%` (0/24) | Mean `1.224 s` |
| `live_relevance` | 16 | `87.50%` (14/16) | Mean `2.045 s`; two empty result arrays |
| `live_irrelevance` | 128 of 884 | `96.88%` (124/128) | Mean `6.534 s`; partial public sample with 124 no-tool result arrays |
| `multi_turn_base` | 20 | `25.00%` (5/20) | 366 requests, mean `2.042 s`, p95 `3.769 s`, max `81.768 s` |
| `multi_turn_miss_func` | 20 | `15.00%` (3/20) | 389 requests, mean `3.055 s`, p95 `5.703 s`, max `173.977 s` |
| `multi_turn_miss_param` | 20 | `10.00%` (2/20) | 325 requests, mean `2.000 s`, p95 `4.392 s`, max `123.501 s` |
| `multi_turn_long_context` | 20 | `15.00%` (3/20) | 345 requests, mean `1.852 s`, p95 `4.311 s`, max `33.633 s` |

These are official category scores on public samples, not global BFCL scores. The `simple_java`, `simple_javascript`, and `parallel` runs used isolated ignored roots and produced 20 unique public result rows each; the JavaScript run retained three empty result arrays. The corrected `live_simple` run selected the official compound IDs and produced 20 unique rows with no empty result arrays. The multi-turn runs produced empty responses, malformed tool calls, failed decodes, and non-exploitable provider responses during generation; the failures remain in the local ignored result and score directories. An initial legacy NVIDIA handler attempt returned an HTTP 404 before scoring and is not counted as a benchmark result.

The memory-case selector was validated against the official BFCL dataset on 2026-08-29. An NVIDIA `memory_kv` run then generated nine of ten required prerequisite entries before repeated empty responses made the remaining runtime exceed 90 minutes. The runner was stopped before any scored target case or aggregate score was produced. The artifact root `artifacts\\benchmarks\\bfcl-nvidia-memory-kv-20-fixed` is retained locally as an unscored diagnostic and must not be interpreted as a memory accuracy result.

## Resumable long-form ASR runs

Long public ASR evaluations can be resumed without repeating completed examples. Add `--checkpoint-path` to persist aggregate state atomically during the run:

```powershell
python benchmarks/run_asr_hf.py `
  --dataset distil-whisper/earnings22 `
  --config chunked `
  --split test `
  --reference-field transcription `
  --language en `
  --model large-v3-turbo `
  --streaming `
  --device cuda `
  --compute-type float16 `
  --checkpoint-path artifacts/benchmarks/asr/earnings22.checkpoint.json `
  --output artifacts/benchmarks/asr/earnings22.json
```

The checkpoint is automatically loaded when it already exists. Its run metadata is validated before any examples are skipped, so a checkpoint cannot silently resume a different dataset, split, model, or runtime configuration. A `KeyboardInterrupt` also saves the latest aggregate state before exiting. Keep the checkpoint next to the raw result until the final result has been independently reviewed.
