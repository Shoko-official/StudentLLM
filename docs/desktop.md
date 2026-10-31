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

## Single instance

Only one StudentLLM process runs per user session. Two processes would open the same `workspace.sqlite3` and the same webview profile, and each saves its whole snapshot on every change, so the last writer would silently overwrite the other window's work. The browser protection ("changed in another tab") relies on the `storage` event and is not active in the native runtime, so the desktop shell prevents the situation instead.

`src-tauri/src/single_instance.rs` registers the official `tauri-plugin-single-instance` (pinned to `=2.4.5`, the newest release that accepts the Tauri 2.11 line; 2.5.x needs Tauri 2.12) as the first plugin, as its documentation requires: a second launch exits from the plugin's setup, before the workspace is opened and before any window exists. It hands over to the running instance, whose callback restores the main window if it is minimized, shows it, and focuses it. The second launch's arguments and working directory are neither used nor logged.

- **Where the lock lives.** The operating system holds it, so it disappears with the process and a crash or a force-stop leaves nothing to clean up: a named mutex on Windows, a D-Bus session-bus name on Linux, and a Unix socket in `/tmp` on macOS (a leftover socket file refuses connections, and the next instance replaces it). The packaged smoke test force-stops the app repeatedly and starts it again, which is how this is checked.
- **Keyed by the app identifier, not by the data directory.** A second launch with another `XDG_DATA_HOME`, `APPDATA` or `HOME` is also redirected. There is no supported way to run two copies side by side; the smoke and WebDriver tests run one instance at a time.
- **Linux without a session bus.** The plugin cannot find another instance and the app starts normally without the protection; it does not fail to start. Desktop environments provide the bus, and CI runs under `dbus-run-session`.
- **Windows.** The handover waits for the running instance to process one message. A running instance that is hung does not answer, so the second launch waits as well.

`scripts/desktop-runtime-smoke.mjs --single-instance` checks the behaviour on the packaged binary: with an instance running and its window loaded, a second launch (same data directory) and a third (another data directory) each exit with code 0 within 15 seconds, the first instance keeps running and reports the redirect, no workspace database appears in the other data directory, and after the first instance is force-stopped a new one starts normally. The `Desktop UI` WebDriver test also launches the app a second time while its window is open and asserts that the process exits with code 0 and that the session still has exactly one window.

## Content Security Policy

The webview runs with the policy below, set in `src-tauri/tauri.conf.json` (`app.security.csp`). It replaces the former `null` policy and is part of the prerequisites for the optional cloud tier in [cloud-plan.md](./cloud-plan.md): imported documents and model output reach the webview, which must not be able to load remote script or send data to arbitrary hosts. The policy stops script from making `fetch`, XHR, WebSocket, beacon, image, font, frame or form requests to non-loopback hosts. It does **not** cover top-level navigation (`location.href = "https://host/?d=..."` sends the request), `window.open`, or resource hints such as `<link rel="preconnect">` and `dns-prefetch`; see [Navigation guard](#navigation-guard).

```text
default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self';
frame-src blob:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:*;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

| Directive | Decision |
| --- | --- |
| `script-src 'self'` | No `unsafe-eval`, no `unsafe-inline`, no remote script. The production bundle, the pdf.js worker and the audio worklet are all same-origin files. |
| `style-src 'self'` and `style-src-attr 'unsafe-inline'` | Style sheets and `<style>` elements must come from the app. Inline style **attributes** are allowed because KaTeX renders formulas as HTML with `style="..."` attributes (strut heights, spacing, vertical alignment) that cannot be expressed as classes; without it, formulas lose their layout. This is the one allowance and it never applies to scripts. An attribute cannot run code, and the only thing it can reference, `url(...)`, is limited by `img-src` and `font-src`. |
| `img-src`, `font-src` | `'self' data: blob:` and `'self' data:`. The bundled KaTeX and Fraunces fonts and the imported images and PDF pages work; a remote image in model output or in a document cannot load, which also closes image-beacon exfiltration. |
| `media-src 'self' blob:`, `frame-src blob:` | The audio source preview and the preview of a document that is not a PDF use `blob:` URLs of the locally stored original. Blob documents inherit this policy. `worker-src` needs no `blob:`: pdf.js loads its worker from a bundled file. |
| `connect-src` | The app itself, Tauri IPC (`ipc:` and `http://ipc.localhost`, the two transports Tauri uses on its platforms) and **loopback only**: `http://127.0.0.1:*` and `http://localhost:*`, for LM Studio (default `127.0.0.1:1234`), the speech service (`:8765`) and the document service (`:8766`). Ports stay open because Settings lets the user pick them. IPv6 loopback (`[::1]`) is not allowed; use `127.0.0.1`. The cloud gateway origin is **not** allowed; the cloud client will make its calls from Rust or add its origin deliberately. Allowing loopback means that injected script can still reach any service listening on this computer, not only the three the app uses; the policy narrows the webview to this machine, not to these services. |
| `object-src`, `base-uri`, `form-action`, `frame-ancestors` | All `'none'`. |

### Remote model endpoints in the packaged app

Settings accepts any `http(s)` address for the model and the two local services, and the browser or development app can still use a remote OpenAI-compatible endpoint when it allows CORS. The packaged app cannot: a strict `connect-src` cannot name hosts the user has not entered yet, and the only way to support arbitrary endpoints is `connect-src https:` (or `*`), which would let any script or injected markup in the webview send course content and tokens anywhere. The decision is to keep the webview on this computer. In the packaged app, Settings shows a hint under each address field, refuses to save a remote address ("Not saved. ...: The desktop app only connects to services on this computer (localhost or 127.0.0.1)."), and reports the same reason in the health check if such an address was saved earlier, instead of the misleading "start the server" message.

To use a remote or LAN model from the packaged app, run it behind a loopback address: LM Studio's own server, or a local proxy or SSH tunnel listening on `127.0.0.1`. Remote providers selected by the user in a later release (bring-your-own key, the cloud tier) are called from the Rust shell, where the key also stays out of the webview. A narrower alternative, listing individual hosts in `connect-src`, would need a rebuild or a runtime-configurable policy for every new host and is not offered.

### Navigation guard

`src-tauri/src/navigation.rs` registers a plugin whose `on_navigation` hook cancels any navigation that is not to `tauri://localhost`, `http(s)://tauri.localhost`, `blob:` URLs created from those origins (the source previews, including the opaque `blob:null/<uuid>` form WebKit may write for a custom scheme), `about:blank`, or, in debug builds only, the Vite development server on port 1420. Everything else, including `https://` hosts, `file:`, `data:` and `javascript:` URLs, is refused, and the log records only the scheme and host. The allow decision is a pure function covered by Rust unit tests, including a test that only exists without debug assertions and pins that the dev server is denied in a shipped build (CI runs it with `CARGO_PROFILE_TEST_DEBUG_ASSERTIONS=false`). The packaged `Desktop UI` test also exercises the guard in a real webview: it runs `location.href = 'https://example.com/'` (and a loopback port) from script, asserts that the URL is still an app origin and the page still works, and loads an app-created blob document in a frame. Tauri lets the initial page load bypass the hook, so that test, not a successful launch, is the evidence.

### New windows

New-window requests (`window.open`, `target="_blank"` links, a form with `target`) are refused. Tauri exposes `on_new_window` only on window builders, so the main window is no longer created from the configuration: `tauri.conf.json` and `tauri.webdriver.conf.json` declare it with `"create": false`, and `create_windows` in `src-tauri/src/lib.rs` builds every declared window in the `setup` hook with `WebviewWindowBuilder::from_config(...)` and `on_new_window` set. (A window must not be created from a synchronous command or event handler: the Tauri documentation warns that this can deadlock on Windows.) `from_config` reads the same configuration, so the size, `dataDirectory` and `additionalBrowserArgs` of the WebDriver build are unchanged. The WebDriver configuration replaces the whole `windows` array when it is merged, which is why it repeats `"create": false`; `tauri.windows.conf.json` declares no window. `src/test/tauri-windows.test.ts` fails if a declared window forgets the setting, because Tauri would then create that window itself, with no hook.

The decision is a pure function, `is_allowed_new_window` in `src-tauri/src/navigation.rs`, covered by Rust unit tests. It answers no for every address: the app has no popup of its own. The navigation guard above still applies to the window.

The app had four `target="_blank"` links: the French Penal Code and CNIL references in the recording notice, the user guide link and the Lordicon credit in Settings. Opening the system browser needs an opener, and the app ships none (the only new dependency of the desktop shell is the single-instance plugin); spawning `xdg-open`, `open` or `start` by hand from a URL that script can influence is the kind of mechanism this guard exists to avoid. So the decision is to deny and keep the addresses readable: in the packaged app the `ExternalLink` component in `src/App.tsx` renders the label followed by the address as selectable text, so the user can copy it into a browser; in a browser it stays a normal link that opens a new tab. Markdown links in course content were already inert or same-window navigations, which the navigation guard refuses.

When the hook refuses a request it also emits a `new-window-blocked` event to the webview with the scheme and host of the address (nothing else); the app does not listen to it. The packaged `Desktop UI` test registers a listener, runs `window.open(...)` and clicks a real `target="_blank"` link, waits for the event after each, and asserts that the session still has exactly one window handle, the same handle and an app URL. The event, not the handle count, is the evidence that the hook is attached: a first version of this test that only counted handles also passed on a build with the hook removed (a throwaway CI run on Linux and Windows), because the WebDriver session does not list a window that the engine opens by itself. The event proves that the hook ran and answered Deny; that a denied request opens nothing is the documented contract of `NewWindowResponse::Deny`, not something the test observes. The test runs on Linux and Windows, where the external `tauri-driver` WebDriver is available; macOS has no WebDriver step in CI (see Validation), so on macOS the guard is covered by the Rust unit tests and by the package and recovery jobs, which prove the window is still created from code and loads the app.

Not covered by the policy or by either guard: resource hints (`preconnect`, `dns-prefetch`). They can leak a host name but not content.

### Future changes that touch the policy

- If the app switches Windows to `useHttpsScheme`, the IPC origin becomes `https://ipc.localhost` and `connect-src` must list it (the navigation guard already accepts `https://tauri.localhost`).
- If pdf.js is ever pointed at a WebAssembly decoder through `wasmUrl`, `script-src` would need `'wasm-unsafe-eval'` (WebAssembly compilation only, not `eval`). The current bundle does not use it and the test fails if it appears.

### Development policy

`app.security.devCsp` is used by `tauri dev` and differs in only three ways that Vite needs: `'unsafe-inline'` for scripts and styles (the React refresh preamble is an inline module script and Vite injects `<style>` elements), `blob:` workers, and `ws://127.0.0.1:1420` and `ws://localhost:1420` for hot reload. It is never used in a packaged build. Tauri may not apply it to a page loaded from `devUrl`; the unit test only guarantees that it stays strict elsewhere (`object-src`, `base-uri`, `form-action`, `frame-ancestors`, no `eval`).

### How it is tested

- `src/test/tauri-csp.test.ts` parses the policy from `tauri.conf.json` and fails on `unsafe-eval`, `unsafe-inline` in `script-src`, a missing `object-src 'none'`, a wildcard or non-loopback host in `connect-src`, or the cloud gateway origin.
- `tests/e2e/csp.spec.ts` (the `csp` Playwright project) builds the production bundle into `dist-csp/`, serves it with `vite preview` and the exact policy from `tauri.conf.json` as the `Content-Security-Policy` header, and runs the core flows: create a course, import text with formulas (KaTeX and its fonts), Settings with the loopback services, search, chat with and without the local model, Study, and previews of PDF, image, audio and document sources. It fails on any `securitypolicyviolation` event or console report, and a canary test confirms that `eval`, remote scripts, remote requests and inline scripts are actually blocked. The PDF fixture has text in a standard font and the test checks that glyphs are painted; another test loads the bundled audio worklet with `addModule`. The project only exists when requested, so the default `npm run test:e2e` does not pay for a second production build: run it with `npm run test:e2e:csp` (CI runs it as a separate step of the `e2e` job).
- `src-tauri/src/navigation.rs` has Rust unit tests for the navigation allow decision and the new-window decision, run by `npm run desktop:test`.
- The packaged `Desktop UI` and `Desktop package` jobs run the real webview with the policy.

When a feature needs a new origin, add it to the narrowest directive, update this section and the test, and do not widen `script-src`.

## Validation

The GitHub Actions quality job runs both `npm run desktop:check` and `npm run desktop:test` in addition to the frontend typecheck, benchmark adapter checks, unit tests, and production build. Browser workflow coverage remains available through `npm run test:e2e`. The dedicated `desktop-ui` job also builds the debug binary and drives the packaged Tauri window through external `tauri-driver` WebDriver on Linux and Windows.

The CI matrix builds unsigned packages on Ubuntu, Windows, and macOS. Each package job launches the packaged debug executable, force-stops it after 30 seconds, relaunches it for 15 seconds across ten recovery cycles, and verifies that the same workspace database remains present with a frontend-generated snapshot, valid lesson data, and `PRAGMA integrity_check` returning `ok` after every cycle. Ubuntu runs under Xvfb and uses isolated data directories; Windows resolves its platform-known application-data location without changing the hosted profile. The workspace database is initialized before the Tauri event loop, so persistence setup does not depend on WebView readiness. This verifies packaged startup, frontend-to-native persistence, repeated native database recovery, and configured sidecar supervision on all three desktop platforms. The dedicated manual workflow extends this same check to 30 cycles on all three platforms; run [33290586153](https://github.com/Shoko-official/StudentLLM/actions/runs/33290586153) passed on 2026-08-30.

The manual `Desktop recovery soak` workflow runs the same packaged checks on Ubuntu, Windows, and macOS with a configurable cycle count. The default is 30 cycles; the observed run [33290586153](https://github.com/Shoko-official/StudentLLM/actions/runs/33290586153) passed all three matrix jobs. Trigger another campaign from GitHub Actions or with `gh workflow run "Desktop recovery soak" -f recovery_cycles=30` when a fresh soak is needed.

The packaged desktop UI test is available locally with `npm run test:desktop-ui` after `npm run desktop:build` and `tauri-driver` are installed. It creates a course through the actual window controls, reloads the native runtime to verify persistence, opens Full Studio, creates a Quick summary artifact, reloads again, and verifies that the artifact remains visible. This flow passed on Linux and Windows in PR run [33300930318](https://github.com/Shoko-official/StudentLLM/actions/runs/33300930318), and the post-merge `main` run [33301608926](https://github.com/Shoko-official/StudentLLM/actions/runs/33301608926) passed the full matrix. Linux and Windows use external `tauri-driver` WebDriver. macOS remains covered by the package and recovery jobs because the external driver path does not provide a native macOS WebKit driver.

## Releases

Pushing a tag that matches the app version, for example `v0.1.0` for `src-tauri/tauri.conf.json` version `0.1.0`, runs the `Release` workflow. It builds unsigned installers on Ubuntu (`.deb`), Windows (NSIS `-setup.exe`), and macOS on Apple Silicon (`.dmg`; no Intel build), then attaches them and a `SHA256SUMS-<OS>.txt` file for each platform to a draft GitHub release. The release stays a draft until a maintainer reviews and publishes it.

Before tagging, bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (the workflow refuses a tag that disagrees with any of them, so pre-release suffixes must appear in all three), move the `Unreleased` changelog entries under the new version, and wait for a green CI run on `main`.

Known limits of these builds: they are not code signed, so Windows SmartScreen and macOS Gatekeeper warn on first launch, and they do not bundle the optional Python ASR and document services. Recording and text import work without them; see [local-asr.md](./local-asr.md) and [local-documents.md](./local-documents.md) for the services.
