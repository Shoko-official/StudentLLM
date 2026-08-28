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
npm run desktop:dev
npm run desktop:build
```

`desktop:check` validates the Rust shell without launching a window. `desktop:dev` starts Vite on the Tauri development port and opens the native window. `desktop:build` compiles a debug desktop executable without creating an installer bundle.

## Runtime boundary

The current desktop shell embeds the browser workspace and preserves the existing local persistence adapters. SQLite WAL storage, native sidecar supervision, crash recovery, and packaged release artifacts remain separate implementation stages so each can be validated in the actual desktop runtime before promotion.

## Validation

The GitHub Actions quality job runs `npm run desktop:check` in addition to the frontend typecheck, benchmark adapter checks, unit tests, and production build. Browser workflow coverage remains available through `npm run test:e2e`.
