# Provider configuration

## In the app

Open **Settings** to set the local OpenAI-compatible endpoint and model, speech service address, and document service address. **Save connections** persists these settings on the current device and checks the services. The app reads `/models`, shows the discovered model IDs, and selects the first available model when the configured model is not loaded. A reachable model catalog confirms availability, not successful generation.

During development, use `/lm-studio/v1` for LM Studio. The same field accepts Bionic and any server implementing the OpenAI-compatible `/v1/models` and `/v1/chat/completions` routes. For a packaged app, use its local server address and enable CORS for the application origin when needed. The packaged app only connects to `127.0.0.1` and `localhost` because of its Content Security Policy; a remote or LAN address is reported as unavailable. Reach a remote model through a local proxy or tunnel on `127.0.0.1` (see [Desktop runtime](./desktop.md#remote-model-endpoints-in-the-packaged-app)).

Start the optional local services with a Python environment that has their dependencies installed:

```bash
python scripts/local_asr_server.py --model small --language fr
python scripts/local_document_server.py --port 8766
```

Set the speech address to `http://127.0.0.1:8765` and the document address to `http://127.0.0.1:8766`. The development web app pre-fills the document address with this local default. Speech requires `faster-whisper`; document extraction uses PyMuPDF and optional RapidOCR. Existing recordings can be transcribed from **Sources**. Text notes are imported directly without either service.

The Qwen3 adapter requests a direct answer using the model's documented `/no_think` instruction. Reasoning-only responses are treated as incomplete, not displayed as final answers. See the [Qwen3 model documentation](https://huggingface.co/Qwen/Qwen3-4B).

The provider smoke script uses OpenAI-compatible endpoints. It reads configuration at runtime and does not require provider values in the repository.

## NVIDIA NIM

The NVIDIA credential is read from the Windows User environment variable `NVIDIA_API_KEY`.

Set it outside the repository in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', '<your-key>', 'User')
```

Close and reopen the terminal so new processes inherit the variable. The smoke script never prints the credential.

Defaults:

- endpoint: `https://integrate.api.nvidia.com/v1`;
- model: `openai/gpt-oss-20b`, override with `NVIDIA_MODEL`.

The NVIDIA catalog may contain models that are unavailable for generation. The smoke script checks the exposed catalog and a real completion independently.

### NVIDIA NIM in the development app

NVIDIA NIM is an opt-in cloud provider for the development web app (`npm run dev`). Local LM Studio stays the default, and the app makes no request to NVIDIA until **NVIDIA NIM (cloud)** is chosen under **Settings > AI provider** and saved. While it is selected, lecture transcripts (including live recording drafts), imported document text, notes and chat questions are sent to NVIDIA automatically for note formatting, chat and study material.

The browser calls the same-origin route `/nvidia-nim/v1`. The Vite dev server reads `NVIDIA_API_KEY` from the environment it started with, adds the `Authorization` header, and forwards the call to the fixed endpoint `https://integrate.api.nvidia.com/v1`. The route:

- never returns the credential to the page and never logs it;
- ignores `.env` files for the key, because the variable must come from the Windows User environment;
- exposes only `GET /models` and non-streaming `POST /chat/completions`;
- answers only same-origin browser requests (`Sec-Fetch-Site: same-origin`) from a loopback client on a loopback host, so another website, device, script or tunnel cannot spend the key;
- does not follow `NVIDIA_BASE_URL`, so the key cannot be redirected to another host.

Set the key, open a new terminal so it inherits the variable, then start the dev server:

```powershell
[Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', '<your-key>', 'User')
npm run dev
```

Restart the dev server after setting or rotating the key. If the key is missing, Settings reports it and the route answers HTTP 503 with an `x-studentllm-proxy-error: missing_key` header. Retrieval uses lexical ranking with NVIDIA NIM because the route has no embeddings endpoint. The model defaults to `openai/gpt-oss-20b`; the app keeps the chosen model instead of switching to the first catalog entry, because some catalog models cannot generate. Packaged desktop builds do not offer NVIDIA NIM yet.

## LM Studio

LM Studio is consumed through its local OpenAI-compatible server:

```powershell
lms server status
lms ls
```

The server must already be running with the intended model loaded.

Defaults:

- endpoint: `http://127.0.0.1:1234/v1`;
- model: `openai/gpt-oss-20b`, override with `LM_STUDIO_MODEL`.

Optional overrides:

```powershell
$env:LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:LM_STUDIO_MODEL = 'openai/gpt-oss-20b'
```

The smoke script appends `/no_think` for Qwen models so the measured response uses the final content channel.

Browser development chat uses the built-in same-origin Vite proxy by default, so no additional endpoint variable is required when LM Studio is listening on its default local port. To override the route or model explicitly:

```powershell
$env:VITE_LM_STUDIO_BASE_URL = '/lm-studio/v1'
$env:VITE_LM_STUDIO_MODEL = 'openai/gpt-oss-20b'
npm run dev
```

The frontend sends only course context and the user question to the configured endpoint. The browser never receives or sends an NVIDIA credential; see [NVIDIA NIM in the development app](#nvidia-nim-in-the-development-app).

The Vite development server proxies `/lm-studio/*` to the origin configured by `LM_STUDIO_BASE_URL`, keeping browser requests same-origin when the local LM Studio server does not emit CORS headers. If the variable is unset or malformed, the proxy falls back to `http://127.0.0.1:1234`. An absolute `VITE_LM_STUDIO_BASE_URL` remains supported, but then the target must allow the development server origin through CORS. The automatic development default is limited to Vite development mode; production and test environments still require an explicit endpoint.

The Playwright web server disables this automatic connection so browser regression tests remain deterministic and offline. Set `VITE_LM_STUDIO_AUTO_CONNECT=false` in another isolated test environment when the local server should not be contacted.

The live browser path was revalidated on 2026-09-13 against the existing `openai/gpt-oss-20b` process: the Vite proxy returned HTTP 200, Settings reported the selected model as available, Quick Start returned a real JSON-schema-constrained proposal at 90% confidence, and the isolated smoke context applied it, persisted one text source, and received a course-chat answer with citations. The same run kept the local ASR and document sidecars available for source processing.

## Run the live check

```bash
npm run providers:smoke
python scripts/live_web_smoke.py
```

The provider smoke prints the selected model, exposed model count, latency, and a short response sample. The live web smoke starts from an empty browser workspace, saves the local LM Studio connection, waits for the model availability check, opens Quick Start, validates a real JSON-schema-constrained proposal, applies it in the isolated context, verifies the saved source and rendered note, and asks the course chat for a cited answer. An unavailable provider is reported as unavailable rather than replaced by a simulation.

Provider credentials are not needed for Vitest, Playwright, or the frontend build.
