# Local transcription

StudentLLM can send a saved browser recording to a local `faster-whisper` sidecar. The browser persists the original audio chunks first. The sidecar returns timestamped segments, and the application adds them to the active course with `review` status so they can be checked before study artifacts are generated.

## Start the sidecar

Install the Python dependency in the benchmark environment or another isolated environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install faster-whisper
.\.venv-bench-sys\Scripts\python.exe scripts/local_asr_server.py --model small --language fr --device cpu --compute-type int8
```

The service listens on `http://127.0.0.1:8765` and exposes:

- `GET /health` for a readiness check;
- `POST /transcribe` with an audio body such as `audio/webm`.

The default CPU configuration is intentionally safe for a machine that is already running LM Studio. Use `--device cuda` only when GPU scheduling is explicitly available.

## Connect the web app

Before starting Vite, configure the optional endpoint:

```powershell
$env:VITE_LOCAL_ASR_BASE_URL = 'http://127.0.0.1:8765'
$env:VITE_LOCAL_ASR_LANGUAGE = 'fr'
npm run dev
```

When the recording is stopped, the app reports the saved-audio state, submits the persisted chunks to the sidecar, and appends returned segments to the transcript. If the sidecar is unavailable, the durable audio remains available and the transcript is not changed.

The complete browser path was also exercised on 2026-08-27 with one public `google/fleurs` French sample: the browser recording flow persisted the audio, the sidecar returned a non-empty timestamped segment, and the UI rendered it with `Needs review` status. The run produced no page errors and did not restart the existing LM Studio process.

## Contract

The browser adapter is implemented in `src/lib/speech-engine.ts`. It accepts a `Blob` and expects:

```json
{
  "model": "small",
  "language": "fr",
  "segments": [
    { "id": "local-asr-0", "start": 0.0, "end": 2.4, "speaker": "Speaker", "text": "..." }
  ]
}
```

The server does not overwrite the source audio. Empty or failed responses are surfaced as a review message, and all successful segments remain editable through the transcript review control.
