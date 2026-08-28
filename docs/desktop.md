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
```

`desktop:check` validates the Rust shell without launching a window. `desktop:test` runs the native persistence tests without opening a window. `desktop:dev` starts Vite on the Tauri development port and opens the native window. `desktop:build` compiles a debug desktop executable without creating an installer bundle.

## Runtime boundary

The desktop shell embeds the existing Vite workspace. In a Tauri runtime, workspace snapshots are loaded and saved through native Rust commands backed by a SQLite database in the application data directory. The database uses WAL mode and a versioned single-row snapshot schema. Browser runs continue to use the local storage adapter.

Native sidecar supervision, crash recovery soak testing, and packaged release artifacts remain separate stages so each can be validated in the actual desktop runtime before promotion.

## Validation

The GitHub Actions quality job runs both `npm run desktop:check` and `npm run desktop:test` in addition to the frontend typecheck, benchmark adapter checks, unit tests, and production build. Browser workflow coverage remains available through `npm run test:e2e`.
