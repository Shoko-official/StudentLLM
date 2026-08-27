# Security

## Credential handling

- Provider credentials are supplied by the process environment or the operating system credential manager.
- `NVIDIA_API_KEY` is read from the Windows User environment and is never read from a repository file.
- Credential values are not written to logs, fixtures, screenshots, or benchmark artifacts.
- Local mode does not make an implicit network request.
- Course data is private by default.

## Reporting a vulnerability

Do not publish credentials or exploitable details in a public issue. Contact the maintainers through the repository's private GitHub security channel with a concise description, minimal reproduction, and observed impact.

Reports are handled before a fix is published so user data and affected deployments can be protected.
