# Desktop runtime

StudentLLM includes a Tauri v2 desktop shell around the existing Vite application. The shell provides a native window and keeps the web workspace as the single frontend entry point.

## Requirements

- Node.js 22.13 or newer;
- Rust stable with the Windows MSVC toolchain;
- Microsoft Edge WebView2 on Windows.

## Commands

```powershell
npm ci
npm run desktop:check
npm run desktop:test
npm run desktop:dev
npm run desktop:build
npm run desktop:package
```

`desktop:check` validates the Rust shell without launching a window. `desktop:test` runs the native persistence tests without opening a window. `desktop:dev` starts Vite on the Tauri development port and opens the native window. `desktop:build` compiles a debug desktop executable without creating an installer bundle.
`desktop:package` creates unsigned debug installer bundles for the current platform. CI runs it on Ubuntu, Windows, and macOS and uploads the resulting bundle directory as a workflow artifact.

## Runtime boundary

The desktop shell embeds the existing Vite workspace. In a Tauri runtime, workspace snapshots are loaded and saved through native Rust commands backed by a SQLite database in the application data directory. The database uses WAL mode and a versioned single-row snapshot schema. Browser runs continue to use the local storage adapter.

The desktop shell can own optional local sidecars when their commands are configured through `STUDENTLLM_ASR_COMMAND` and `STUDENTLLM_DOCUMENT_COMMAND`. Each value is a whitespace-separated command line with single or double quoted arguments, for example `python scripts/local_asr_server.py --port 8765`. The desktop UI exposes start and stop controls, reports child PIDs and exit status, and retries a stopped service when Start is pressed again. Only processes launched by the current app instance are stopped during shutdown; existing local services remain untouched.

This supervisor is intentionally opt-in because the current unsigned package does not bundle Python runtimes or the optional sidecar dependencies. Use absolute script paths for packaged desktop experiments, and configure the matching `VITE_LOCAL_ASR_BASE_URL` or `VITE_LOCAL_DOCUMENT_BASE_URL` endpoint so the health probe can verify readiness after launch.

## Validation

The GitHub Actions quality job runs both `npm run desktop:check` and `npm run desktop:test` in addition to the frontend typecheck, benchmark adapter checks, unit tests, and production build. Browser workflow coverage remains available through `npm run test:e2e`.

The CI matrix builds unsigned packages on Ubuntu, Windows, and macOS. The Ubuntu package job launches the packaged debug executable under Xvfb with isolated data directories, force-stops it after 30 seconds, relaunches it for 15 seconds, and verifies that the same SQLite workspace remains present with `PRAGMA integrity_check` returning `ok`. The workspace database is initialized before the Tauri event loop, so persistence setup does not depend on WebView readiness. This verifies packaged Linux startup and recovery; it does not replace interactive validation on each desktop platform or a longer cross-platform recovery soak.
