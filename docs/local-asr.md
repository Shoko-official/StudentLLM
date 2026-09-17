# Local transcription

StudentLLM sends saved recordings to a local `faster-whisper` sidecar and keeps the original audio. Full transcription returns timestamped segments for review. An optional preview mode accepts a short, independently decodable PCM WAV window for live feedback.

The default model is `large-v3-turbo`, with French (`fr`), CPU, and `int8` computation. `--model small` remains available for a lighter CPU profile. Recognition quality and speaker identification are separate capabilities: this sidecar does **not** perform diarization, identify voices, or count speakers. It always returns `diarization: false` and an empty `speaker` string. Segment boundaries must not be interpreted as changes of speaker.

Full uploads retain the 250 MiB limit (262,144,000 bytes). Preview uploads have smaller byte and duration bounds below. The sidecar uses the shared localhost binding validation, upload validation, and local-origin CORS helpers. Responses keep `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; model failures do not expose model or filesystem details.

## Start the sidecar

Use an environment with `faster-whisper` installed. For a new environment, install it separately with `python -m pip install faster-whisper`. The selected model must be available locally to avoid a first-use model download.

When ready to start a service:

```powershell
.\.venv-bench-sys\Scripts\python.exe scripts/local_asr_server.py --language fr --device cpu --compute-type int8
```

The default address is `http://127.0.0.1:8765`. An existing process continues using its loaded model and old code until it is explicitly replaced; editing this script or calling `/health` does not reload it. Do not replace a sidecar during an active recording. A separately scheduled evaluation can use a free port such as `--port 8767`.

To choose the lighter model explicitly:

```powershell
.\.venv-bench-sys\Scripts\python.exe scripts/local_asr_server.py --model small --language fr --device cpu --compute-type int8
```

`large-v3-turbo` and word alignment can cost more CPU time and memory than the old `small` configuration. CPU `int8` remains portable and does not allocate GPU inference resources. CUDA is still an explicit CLI option, not an automatic fallback.

## Connect the web app

Before starting Vite, configure the optional endpoint:

```powershell
$env:VITE_LOCAL_ASR_BASE_URL = 'http://127.0.0.1:8765'
$env:VITE_LOCAL_ASR_LANGUAGE = 'fr'
npm run dev
```

For a Tauri desktop build, the app can own the service lifecycle when `STUDENTLLM_ASR_COMMAND` is configured before launch:

```powershell
$env:STUDENTLLM_ASR_COMMAND = 'python scripts/local_asr_server.py --language fr --device cpu --compute-type int8'
```

The desktop service tray can start or stop only the process launched by StudentLLM. The service command is not enabled unless this variable is set.

The client captures 48 kHz mono PCM through AudioWorklet and sends independently decodable windows of at most 24 seconds. A two-minute ring buffer bounds preview memory while the original MediaRecorder audio is persisted independently. Windows overlap at sentence or timed-word boundaries, and only one preview request runs at a time. The client retains earlier passages and revises the unsettled tail. Falling behind the ring buffer is reported; the saved audio remains available for full transcription.

Browsers without AudioWorklet retain recording and a limited transcript preview (up to 60 recorder chunks). They explicitly report that live note drafting is unavailable; notes are generated after stopping. They never keep uploading an ever-growing recording in the background.

With a connected language model, settled transcript passages are drafted into source-linked Markdown every ten seconds when enough text is available. The JSON schema requires prose and restricts source references to actual segment IDs. Headings, paragraphs, inline mathematics and code remain separate from the original verbatim transcript. Model-written notes are drafts, not verified facts. Ambiguous quantities must remain marked for review. Long final transcripts are processed in sequential batches instead of being silently cut to their first 24,000 characters.

At recording stop, the client submits the complete persisted recording without `mode=preview` and treats that result as authoritative. Preview text can change with subsequent context. Repeated HTTP previews are not server-side streaming. Aborting a browser request does not interrupt inference already in progress: model access stays serialized until the lazy segments generator is fully consumed. Clients should avoid accumulating preview requests.

Open Settings and choose `Refresh local services` to query the configured `/health` endpoint without starting, stopping, or reloading the sidecar.

For an NVIDIA GPU with sufficient free memory and a compatible CUDA installation:

```powershell
python scripts/local_asr_server.py --model large-v3-turbo --language fr --device cuda --compute-type int8_float16
```

Leave memory for both ASR and the language model. The development validation used GPT OSS 20B with one prediction worker and a 65,536-token context alongside ASR on an RTX 5080. This is not a universal hardware requirement.

## Contract

`GET /health` reports configuration, including the configured device and compute type (not a measurement of actual hardware utilization):

```json
{
  "status": "ok",
  "model": "large-v3-turbo",
  "device": "cpu",
  "compute_type": "int8",
  "diarization": false
}
```

`POST /transcribe` takes the raw audio body, not multipart form data. A single positive `Content-Length` is required; chunked transfer encoding and incomplete bodies are rejected. `Content-Type: audio/wav` is recommended for previews; full recordings may use `audio/webm` or another format supported by the installed decoder. Actual WAV validation does not trust the MIME label.

The query parameters are:

| Parameter | Contract |
| --- | --- |
| `mode` | Omitted or `full`: transcribe the complete upload, up to 250 MiB, with no preview duration or format restriction. `preview`: more than 0 and at most 30 seconds of 16-bit PCM WAV, one or two channels, sample rate from 8,000 through 48,000 Hz, and at most 8 MiB (8,388,608 bytes). Use 16 kHz mono when available. Other values, including an empty mode, return 400. |
| `language` | Omitted: use the configured default (`fr`). A supplied language code overrides it for this request only; an empty value requests automatic language detection. |
| `prompt` | Optional vocabulary context, for example `intégrale, dérivée, théorème de Bayes`, URL-encoded as UTF-8. Maximum 500 decoded Unicode characters, checked before trimming. Only printable characters are accepted; controls, newlines, formatting controls, and Whisper token delimiters `<\|` and `\|>` are rejected. Leading/trailing spaces are trimmed; blank context is ignored. |

Each recognized parameter may appear only once. The entire encoded query is limited to 8,192 characters and eight fields. Unknown fields cannot override model, device, decoder options, or task. `prompt` is passed only as Whisper's `initial_prompt` for this request's first decoding window. It is vocabulary data, never an executable command or runtime configuration. Use a short list of relevant terms, not instructions or an expected transcript; hints can bias recognition and do not guarantee correct mathematics. No default lecture text is injected.

Preview WAV bounds and completeness are checked before calling the model. The server forwards a canonical WAV containing only the validated PCM frames; metadata and unchecked trailing streams are discarded. Oversized previews are rejected rather than silently shortened.

Example preview request URL: `/transcribe?mode=preview&language=fr&prompt=int%C3%A9grale%2C%20d%C3%A9riv%C3%A9e`.

A successful preview response has this shape:

```json
{
  "model": "large-v3-turbo",
  "mode": "preview",
  "diarization": false,
  "language": "fr",
  "duration": 3.0,
  "segments": [
    {
      "id": "local-asr-0",
      "start": 0.5,
      "end": 2.4,
      "speaker": "",
      "text": "La dérivée est nulle.",
      "words": [
        { "start": 0.5, "end": 0.7, "word": " La" },
        { "start": 0.7, "end": 1.5, "word": " dérivée" },
        { "start": 1.5, "end": 1.7, "word": " est" },
        { "start": 1.7, "end": 2.4, "word": " nulle." }
      ]
    }
  ]
}
```

`start` and `end` are finite numeric seconds relative to the uploaded audio, including its silence. The server does not apply a recording offset; the client must add its window's offset to both segment and word times. Word strings retain Whisper's spacing and punctuation so boundary merging can preserve the text. `words` is included **only in preview mode** and is `[]` if no alignment was returned. Full responses use `mode: "full"`, keep numeric segment times, and omit `words`. Segment IDs are local to each request, not globally unique IDs or speaker identities.

Silence or no usable speech can return HTTP 200 with `segments: []`. Invalid options, invalid preview WAVs, preview duration over 30 seconds, and missing/invalid/incomplete request bodies return 400. Upload bytes over the selected limit return 413. Decode/inference failures and non-finite output timestamps return 422 with `{"error":"Transcription failed."}`. Unknown routes return 404. Transcriptions remain subject to human review.

## Recognition settings and limits

Both modes explicitly transcribe in the requested language, use temperature `0.0`, and disable conditioning on previous generated text to reduce repetitive failure loops. Full transcription keeps beam size 5; preview uses beam size 1 to reduce work on temporary results. No clipping or token budget truncates the full recording. There are no extra repetition penalties or n-gram bans that would suppress repeated mathematical terms.

VAD uses an explicit speech-probability threshold of `0.25`, a 1,000 ms minimum silence and 400 ms speech padding. The lower gate retains quiet lecture phrases that the upstream default `0.5` can remove before Whisper receives them. This is a recall tradeoff, not a calibrated confidence score: background sounds may also be admitted. The decoder keeps the usual no-speech threshold `0.6`, log-probability threshold `-1.0`, and compression-ratio threshold `2.4`. Word alignment is enabled in both modes to support the 2-second hallucination-silence filter; only previews serialize the word payload. These controls reduce some failure modes but do not guarantee silence detection or remove every hallucination. Disabling previous-text conditioning can also reduce consistency across windows. Parameter semantics are documented in the [faster-whisper transcription implementation](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py).

Historical [French ASR benchmarks](benchmarks.md) report 6.5594% WER on FLEURS and 5.4124% on MLS for `large-v3-turbo` using CUDA `float16` with earlier settings. Those measurements do not validate this CPU profile, preview latency, French lecture mathematics, or speaker attribution. Classroom noise, microphone distance, overlapping voices, and specialist vocabulary still need representative evaluation. No equivalence to Zoom or another meeting-transcription service has been established.

## Focused tests

From the repository root, with standard Python and no ML packages:

```powershell
python -S -B -m unittest tests.test_local_asr_server tests.test_local_server_contract tests.test_local_document_security -v
```

The tests use a lazy fake Whisper model and temporary loopback HTTP ports. They check protocol behavior, decoding options, silence responses, word payloads, request bounds, shared security behavior, and lock lifetime. They do not load models, use the GPU, download assets, contact the active sidecar, or measure recognition accuracy. Live PCM browser integration and real-model evaluation require separate checks.

An opt-in Chromium integration test feeds a real WAV through the browser microphone capture, AudioWorklet, local ASR, and LM Studio, then checks that sourced prose appears before stopping and that finalization completes:

```powershell
# ASR on 8767; LM Studio on 1234 with openai/gpt-oss-20b loaded.
$env:STUDENTLLM_QA_AUDIO = 'C:\audio\public-french-speech.wav'
npx playwright test tests/e2e/live-speech.spec.ts
```

The test uses its own browser profile on port 4173, an explicitly allowed local application origin. It does not access the user's microphone or workspace. Without the environment variable it is skipped, not counted as a successful real-model test.

### Targeted validation, 16 September 2026

The first ten examples of `google/fleurs`, `fr_fr`, `test` (293 reference words) were sent unchanged to both HTTP services. The same normalization and edit-distance scoring in `benchmarks/run_asr_fleurs.py` was used for every profile. No reference text was supplied to the models.

| Profile | Word errors | WER | Processing time / audio duration |
| --- | ---: | ---: | ---: |
| Previous small, CPU int8, full | 50 | 17.06% | 0.177 |
| large-v3-turbo, CUDA int8_float16, full | 34 | 11.60% | 0.046 |
| large-v3-turbo, CUDA int8_float16, preview | 33 | 11.26% | 0.024 |

Preview request times ranged from 0.22 to 0.39 seconds. These are service processing times, not end-to-end microphone-to-note latency. This small public-speech integration sample is not a full benchmark, a mathematics-lecture evaluation, or a comparison with Zoom. The opt-in browser test also passed with actual local models and a public FLEURS recording. Speaker diarization remains unsupported.

### Quiet-speech investigation, 17 September 2026

A saved 310.02-second French mathematics lecture exposed a preprocessing failure: the default VAD gate retained 145.168 seconds, while `threshold=0.25` retained 221.808 seconds with the same model and decoding settings. The latter recovered previously truncated numerical passages. Retained duration and transcript length are not accuracy scores; the recording has no independently checked reference. Mathematical terminology and some formulas remain incorrect. The original recording and private transcripts were kept local, and no language-model settings or generated course notes were changed.

The following paired check used the fixed rows 10-49 of `google/fleurs`, `fr_fr`, `test`: 40 recordings, 995 reference words, 421.26 seconds. Rows 0-9 had been used in the earlier investigation and were excluded. Both profiles used `faster-whisper 1.2.1`, `large-v3-turbo` revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`, CUDA `int8_float16`, one worker, beam 5, no vocabulary hint, and the settings above except the VAD threshold. Scoring reused `benchmarks/run_asr_fleurs.py` unchanged. Dataset cache fingerprint: `70bb2e84b976b7e960aa89f1c648e09c59f894dd` (not a verified upstream commit).

| Input | VAD threshold | Word errors | WER | CER |
| --- | ---: | ---: | ---: | ---: |
| Original public recordings | 0.5 | 69 | 6.93% | 2.01% |
| Original public recordings | 0.25 | 69 | 6.93% | 1.99% |
| Same recordings attenuated by 20 dB | 0.5 | 77 | 7.74% | 2.51% |
| Same recordings attenuated by 20 dB | 0.25 | 71 | 7.14% | 2.21% |

The attenuated rows are a controlled stress test, not another natural dataset or an independent benchmark. Aggregate equality on the original sample hides per-recording improvements and regressions. This small comparison does not establish a universal WER improvement, far-field parity with a meeting service, or correct mathematics. The current change is limited to preserving more candidate speech before decoding, for both preview and full transcription; it does not disable VAD or the silence-hallucination filter.

An actual loopback HTTP replay of those 40 recordings returned the same 69 full-mode errors and 71 preview-mode errors. Fourteen synthetic negative controls (24-second silence, white noise and low-frequency noise at -50, -35 and -20 dBFS, in both modes) returned empty transcripts. These controls do not represent all classroom noises. Full large-v3, previous-text conditioning, and an alternate Parakeet v3 pipeline did not resolve the private lecture failure. Qwen3-ASR-1.7B in a local NF4 profile improved some terms but still changed quantities and made 84 word errors on the public sample, versus 69 for Whisper. None of those alternative models or dependencies was added to the app.
