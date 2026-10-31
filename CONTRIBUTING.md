# Contributing to StudentLLM

## Local development

```bash
npm ci
npm run check
npm run test:run
npm run build
```

The desktop app allows one instance per user session. With a StudentLLM instance running (installed, or left over from `npm run desktop:dev`), a new `npm run desktop:dev`, `npm run test:desktop-ui` or `node scripts/desktop-runtime-smoke.mjs` is handed over to it and exits with code 0 without running its checks. Quit the other instance first (see [docs/desktop.md](docs/desktop.md#single-instance)).

Run browser tests and provider checks when the change touches those areas:

```bash
npm run test:e2e
npm run providers:smoke
```

### Cloud gateway

`cloud/` is a separate npm project (the optional cloud gateway, see [docs/cloud-plan.md](docs/cloud-plan.md)). It has its own lockfile and is not part of the root workspace; the root `npm run check` and `npm run test:run` ignore it. Work on it from its directory:

```bash
cd cloud
npm ci
npm run typecheck
npm test
npm run types:generate   # after a change to docs/cloud-api.openapi.yaml
```

Contract changes go through `docs/cloud-api.openapi.yaml`, `docs/cloud-api.md`, the fixtures and `python scripts/validate-cloud-contract.py` together. Pin new dependencies exactly and use only versions published at least two weeks ago. Layout and module ownership are in [cloud/README.md](cloud/README.md).

## Branches and commits

- `feat/<topic>` for a feature;
- `fix/<topic>` for a bug fix;
- `docs/<topic>` for documentation;
- one logical outcome per commit;
- Conventional Commit messages, for example `feat: add course session shell`.

Keep visual changes, product behavior, and documentation separate when they can be reviewed independently.

## Pull requests

1. Describe the problem and expected outcome.
2. Add or update relevant tests.
3. Include the commands and observed results.
4. Call out any unmeasured metric or known limitation.
5. Wait for green CI.
6. Squash merge into `main` and delete the merged branch.

## Licences

The repository is MIT. A change that adds a dependency, font, icon, model, dataset or copied code must say what its licence is and where that was verified, and must keep the licence policy green:

- `npm run licenses:check` (and `npm run licenses:check:all` with Python and Cargo) fails on strong-copyleft, non-commercial or unknown licences; fix it by choosing another package or, for a justified case, add an entry with its evidence to `scripts/license-policy.json`;
- after changing `package-lock.json` or `src-tauri/Cargo.lock`, run `npm run licenses:notices` and commit `THIRD_PARTY_LICENSES.md`;
- do not add GPL, AGPL or PyMuPDF-style dual licences to a requirements file other than benchmark tooling, and never to the document or speech sidecars;
- do not copy code, icons or fonts from elsewhere without recording their licence in `NOTICE.md`.

See [docs/licensing.md](docs/licensing.md).

## Data handling

Do not commit API keys, `.env` files, course audio, student documents, database dumps, or benchmark outputs containing private data.

## Collaboration

- Work on a dedicated branch with a descriptive name and a clear objective.
- Report bugs through [GitHub Issues](https://github.com/Shoko-official/StudentLLM/issues). Include steps to reproduce the problem, the expected and actual behavior, and relevant environment details.
- Add relevant logs when helpful, but remove secrets and private student data before sharing them.
