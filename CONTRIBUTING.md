# Contributing to StudentLLM

## Local development

```bash
npm ci
npm run check
npm run test:run
npm run build
```

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

## Data handling

Do not commit API keys, `.env` files, course audio, student documents, database dumps, or benchmark outputs containing private data.

## Collaboration

- Work on a dedicated branch with a descriptive name and a clear objective.
- Report bugs through [GitHub Issues](https://github.com/Shoko-official/StudentLLM/issues). Include steps to reproduce the problem, the expected and actual behavior, and relevant environment details.
- Add relevant logs when helpful, but remove secrets and private student data before sharing them.
