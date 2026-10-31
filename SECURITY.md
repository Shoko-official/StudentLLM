# Security

## Credential handling

- Provider credentials are supplied by the process environment or the operating system credential manager.
- `NVIDIA_API_KEY` is read from the Windows User environment and is never read from a repository file.
- Credential values are not written to logs, fixtures, screenshots, or benchmark artifacts.
- Local mode does not make an implicit network request.
- The desktop webview enforces a Content Security Policy: no remote or inline script and no `eval`, and script cannot make `fetch`, XHR, WebSocket, beacon, image, font, frame or form requests to hosts other than the app, Tauri IPC, `127.0.0.1` and `localhost`. A Content Security Policy does not cover top-level navigation, so a separate navigation guard in the Rust shell keeps the webview on the app's own origins; new-window requests (`window.open`, `target="_blank"`) are not yet blocked. See [docs/desktop.md](docs/desktop.md#content-security-policy).
- Course data is private by default.

## Reporting a vulnerability

Do not publish credentials or exploitable details in a public issue. Contact the maintainers through the repository's private GitHub security channel with a concise description, minimal reproduction, and observed impact.

Reports are handled before a fix is published so user data and affected deployments can be protected.
