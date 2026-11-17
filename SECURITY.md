# Security

## Credential handling

- Provider credentials are supplied by the process environment or the operating system credential manager.
- `NVIDIA_API_KEY` is read from the Windows User environment and is never read from a repository file.
- Credential values are not written to logs, fixtures, screenshots, or benchmark artifacts.
- Local mode does not make an implicit network request.
- The desktop webview enforces a Content Security Policy: no remote or inline script and no `eval`, and script cannot make `fetch`, XHR, WebSocket, beacon, image, font, frame or form requests to hosts other than the app, Tauri IPC, `127.0.0.1` and `localhost`. A Content Security Policy does not cover top-level navigation, so a separate navigation guard in the Rust shell keeps the webview on the app's own origins, and new-window requests (`window.open`, `target="_blank"`) are refused: the main window is built in code with an `on_new_window` hook that denies every request, and the few links the app used to open in a new tab are shown as text to copy. Resource hints (`preconnect`, `dns-prefetch`) are not blocked and can leak a host name but not content. These guards are verified in debug builds on Linux and Windows only, not on macOS or in release builds. The desktop app also tries to run as a single instance per user session, so that a second launch cannot open the same workspace in a second process; this is not a guarantee: on Linux without a D-Bus session bus it starts without the protection, the Windows lock is per logon session (a Remote Desktop session and the console can each run an instance), and on macOS the lock is a socket in the shared `/tmp`, which another local user can occupy to stop the app from starting. See [docs/desktop.md](docs/desktop.md#content-security-policy) and [the single-instance notes](docs/desktop.md#single-instance).
- Course data is private by default.

## Reporting a vulnerability

Do not publish credentials or exploitable details in a public issue. Contact the maintainers through the repository's private GitHub security channel with a concise description, minimal reproduction, and observed impact.

Reports are handled before a fix is published so user data and affected deployments can be protected.
