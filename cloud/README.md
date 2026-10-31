# StudentLLM cloud gateway (scaffold)

The optional cloud gateway described in [docs/cloud-plan.md](../docs/cloud-plan.md) and specified by
[docs/cloud-api.md](../docs/cloud-api.md), [docs/cloud-api.openapi.yaml](../docs/cloud-api.openapi.yaml) and
[docs/cloud-api-fixtures/](../docs/cloud-api-fixtures/). This directory is **a separate npm project**: it has its
own `package.json`, lockfile and `tsconfig`, and is not a workspace of the app. The contract is the source of
truth; this code follows it and never changes it.

Status: scaffold only (phase 2 started). Every route in the contract is registered and answers a 501 error
envelope, except the parts that need no accounts: the request id, the client-version handshake, body size limits
enforced while the body streams in, and `Content-Type` checks. Storage has interfaces and in-memory
implementations only; the Durable Object and D1 adapters come later.

## Run the tests

Node 22.13 or newer.

```bash
cd cloud
npm ci
npm run typecheck   # src (Workers-style, no Node types) and tests (Node types)
npm test            # vitest run, no network
```

`npm run types:generate` regenerates `src/types/api.generated.ts` from the OpenAPI file; a test fails when the
committed file is out of date. Wrangler is not a dependency yet (the deploy work pins it). Never commit a
`.dev.vars` file: copy `.dev.vars.example`, which only lists secret names.

Dependencies are few, pinned exactly, and were published at least two weeks before they were added
(`typescript`, `vitest`, `@types/node`, `yaml`; the last is used by tests and the type generator only). The code
uses Web-standard APIs only (`Request`, `Response`, `URL`, `crypto.subtle`, streams), so it runs on Workers and
Node 22.

## Layout and ownership

```
src/index.ts          Worker entry: export default { fetch }; refuses to serve outside development until adapters exist
src/app.ts            createApp(deps) -> { handle, router }; registerRoutes() lists the modules
src/deps.ts           Deps = core services + one deps object per module; createDeps()
src/config.ts         typed config from env bindings; fails closed; secrets are redacted wrappers
src/http/             shared HTTP layer: router, envelope, pipeline, body, client-version, bearer, stub
src/modules/<m>/      one directory per module; each owner edits only its own
  auth/ account/ inference/ billing/ ops/
src/storage/          interfaces.ts (the data tables of the plan) and memory/ (in-memory implementations)
src/crypto/           constant-time compare, SHA-256, HMAC, random tokens, base64url, rotating keyed hash
src/types/            types generated from the OpenAPI file
src/testing/          test-only: makeTestApp(), fixture conformance, contract validator (uses node:fs)
```

Each module's `index.ts` exports four things and nothing else is needed in shared files:

| Export | Purpose |
| --- | --- |
| `registerXRoutes(router, deps)` | register the module's routes |
| `XDeps` and `createXDeps(core)` | the module's own services (signer, email sender, provider client...) |
| `createXHooks(deps)` | the pipeline hooks the module fills in (see below) |

Shared files (`app.ts`, `deps.ts`, `http/*`, `storage/interfaces.ts`) change rarely; if you need to, keep the change
small and say so in your PR.

### Registering routes

```ts
export function registerAccountRoutes(router: Router, deps: Deps): void {
  router.add("GET", "/v1/account", getAccount, routeMeta({ operationId: "getAccount", gate: "exempt" }));
}
```

- The pattern uses the OpenAPI spelling (`/v1/devices/{device_id}`); `ctx.params.device_id` holds the value.
- `routeMeta()` describes the route (auth scheme, gating exemption, content route, fresh sign-in, body kind and
  size limit, rate-limit scope). `src/app.test.ts` checks every route against the OpenAPI file, so a wrong flag fails.
- The module's stubs are already registered with `notImplemented`; replace the handler, keep the meta. Registering
  the same method and path twice throws.
- Authenticated handlers start with `requirePrincipal(ctx)`, which fails closed.
- Throw `new ApiError("code", { details, retryAfterSeconds })` for every error; return `jsonResponse(...)` for
  success. Never build an error body by hand, and never put a secret in `details`.
- Read bodies only through `ctx.body` (`json()`, `bytes()`, `formData()`): the size limit and the `Content-Type`
  check are enforced there while the body streams in.

### Pipeline hooks

`src/http/pipeline.ts` runs the header-only order of the contract: client version, token and session, terms and
account status, plan, consent, rate limit; then the idempotency lookup and the concurrency slot; the body is read
last. The client-version step is real. The others are pass-through hooks, each marked `TODO(owner: ...)`:

| Hook | Owner |
| --- | --- |
| `authenticate` | auth |
| `checkTermsAndStatus` | account |
| `checkPlan` | billing |
| `checkConsent`, `checkRateLimit`, `lookupIdempotency`, `acquireConcurrencySlot` | inference |

A module returns its hooks from `createXHooks(deps)`. Two modules claiming the same hook is an error at startup.
Use `ctx.defer(fn)` to release resources (a concurrency slot); it runs when the handler returns.

### Storage

`src/storage/interfaces.ts` mirrors the data table in the plan and stores no content, no IP address and no
prompt. The in-memory implementations back the tests and local development. When the Durable Object and D1
adapters are written, the account Durable Object must run `DeviceStore.register` (the 3-device limit check and
the insert) as one atomic step, and the settle and reserve operations of the ledger must be atomic too.

### Tests with the app

```ts
import { makeTestApp, loadFixture, fixtureRequest, expectFixtureConformance } from "../testing";

const t = makeTestApp({ hooks: { authenticate: myAuthStep } });
const fx = loadFixture("chat-completions.budget_exhausted");
await expectFixtureConformance(await t.app.handle(fixtureRequest(fx)), fx);
```

`makeTestApp()` wires the in-memory stores, a manual clock, deterministic request ids and a recording logger; its
`fetch` throws, so a test cannot reach the network.

## Choices where the contract is silent

See the PR description for the list. In short: the stub status/code (501 with `internal_error`), a missing or
malformed `X-StudentLLM-Client` (400 `invalid_request`), a wrong method or unknown path (404 `not_found`), and
the extra `login_methods` field on the account record.
