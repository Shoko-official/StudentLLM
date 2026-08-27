# Provider configuration

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

## LM Studio

LM Studio is consumed through its local OpenAI-compatible server:

```powershell
lms server status
lms ls
```

The server must already be running with the intended model loaded.

Defaults:

- endpoint: `http://127.0.0.1:1234/v1`;
- model: `qwen/qwen3-4b`, override with `LM_STUDIO_MODEL`.

Optional overrides:

```powershell
$env:LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:LM_STUDIO_MODEL = 'qwen/qwen3-4b'
```

The smoke script appends `/no_think` for Qwen models so the measured response uses the final content channel.

To enable the optional browser chat adapter, use the built-in same-origin Vite proxy before starting the development server:

```powershell
$env:VITE_LM_STUDIO_BASE_URL = '/lm-studio/v1'
$env:VITE_LM_STUDIO_MODEL = 'qwen/qwen3-4b'
npm run dev
```

The frontend sends only course context and the user question to the configured local endpoint. NVIDIA credentials are never accepted by this browser path.

The Vite development server proxies `/lm-studio/*` to `http://127.0.0.1:1234/*`, keeping browser requests same-origin when the local LM Studio server does not emit CORS headers. An absolute `VITE_LM_STUDIO_BASE_URL` remains supported, but then the target must allow the development server origin through CORS.

## Run the live check

```bash
npm run providers:smoke
```

The command prints the selected model, exposed model count, latency, and a short response sample. An unavailable provider is reported as unavailable rather than replaced by a simulation.

Provider credentials are not needed for Vitest, Playwright, or the frontend build.
