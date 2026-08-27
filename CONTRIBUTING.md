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
