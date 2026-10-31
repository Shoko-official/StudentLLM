# StudentLLM cloud gateway (scaffold)

The optional cloud gateway described in [docs/cloud-plan.md](../docs/cloud-plan.md) and specified by
[docs/cloud-api.md](../docs/cloud-api.md), [docs/cloud-api.openapi.yaml](../docs/cloud-api.openapi.yaml) and
[docs/cloud-api-fixtures/](../docs/cloud-api-fixtures/). This directory is **a separate npm project**: it has its
own `package.json`, lockfile and `tsconfig`, and is not a workspace of the app. The contract is the source of
truth; this code follows it and never changes it.

Status: scaffold only (phase 2 started). Every route in the contract is registered and answers a 501 error
envelope (the `notImplemented` stub; the contract has no such code, so the stub reuses `internal_error`). Real
today: the request id, the client-version handshake, body size limits enforced while the body streams in,
`Content-Type` checks, the consent and idempotency header checks, the one-time account load, the fresh sign-in
check, response cleanup for streams, and fail-closed hooks. Storage has interfaces and in-memory
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
`.dev.vars` file: copy `.dev.vars.example`, which lists the secret names and `ENVIRONMENT=development`.

Dependencies are few, pinned exactly, and were published at least two weeks before they were added
(`typescript`, `vitest`, `@types/node`, `yaml`; the last is used by tests and the type generator only). The code
uses Web-standard APIs only (`Request`, `Response`, `URL`, `crypto.subtle`, streams), so it runs on Workers and
Node 22. The few Workers objects it touches (`ExecutionContext`, `ScheduledController`, `DurableObjectState`)
are declared in `src/platform.ts` instead of adding `@cloudflare/workers-types`, which redeclares `Request`,
`Response` and `crypto` and collides with `@types/node` in the test project.

## Layout and ownership

```
src/index.ts          Worker entry: fetch, scheduled, and the Durable Object class exports (settled; add classes here)
src/app.ts            createApp(deps) -> { handle(request, executionCtx), scheduled, router }; registerRoutes()
src/deps.ts           Deps = core services + one deps object per module; createDeps()
src/config.ts         aggregates the modules' config.ts; fails closed; secrets are redacted wrappers
src/config-spec.ts    the shapes a module's config.ts exports
src/platform.ts       local types for ExecutionContext and friends (owner: ops; other modules only import from it)
src/durable-objects.ts  reserved AccountObject class (the per-account object, adapters come later)
src/scheduled.ts      ScheduledTask for the cron handler
src/lazy.ts           lazy() for deps that need await to build
src/http/             shared HTTP layer: router, envelope, pipeline, body, client-version, bearer, stub
src/modules/<m>/      one directory per module; each owner edits only its own files
  auth/ account/ inference/ billing/ ops/        index.ts + config.ts each
src/storage/interfaces/<store>.ts   one file per store (the data tables of the plan), barrel index.ts
src/storage/memory/<store>.ts       in-memory implementations
src/crypto/           constant-time compare, SHA-256, HMAC, random tokens and codes, base64url, keyed hashes
src/types/            types generated from the OpenAPI file
src/testing/          test-only: makeTestApp(), fixtures, contract validator, runStoreContract() (uses node:fs)
```

### What each module owner edits

| Module | Owner | Files | Pipeline hooks to fill | Routes |
| --- | --- | --- | --- | --- |
| auth | auth | `src/modules/auth/index.ts`, `config.ts` | `authenticate`, `checkAuthRateLimit` | `/auth/*`, `/.well-known/jwks.json` |
| account | auth/account | `src/modules/account/index.ts`, `config.ts` | `checkTermsAndStatus` | devices, account, terms, link, provider sets, consent |
| inference | inference | `src/modules/inference/index.ts`, `config.ts` | `checkConsent`, `checkRateLimit`, `lookupIdempotency`, `acquireConcurrencySlot` | models, usage, chat, transcription, OCR |
| billing | billing | `src/modules/billing/index.ts`, `config.ts` | `checkPlan` | checkout, portal, Paddle webhook |
| ops | ops | `src/modules/ops/index.ts`, `config.ts`, `wrangler.toml`, `src/durable-objects.ts`, `src/storage/memory/*` and the adapters | none yet | `/v1/status` |

Each module's `index.ts` exports `registerXRoutes(router, deps)`, `XDeps` and `createXDeps(core)`,
`createXHooks(deps)` and `createXScheduledTasks(deps)`. Its `config.ts` exports `secrets`, `vars` and `limits`:
add a secret, a variable or a body-size cap there, not in `src/config.ts`. A module also owns the store
interface it mostly uses (auth: `auth-challenge`, `session`, `device`; account: `account`, `consent`; inference:
`ledger`, `idempotency`, `rate-limit`, `switch`; billing: `webhook-event`), but a change to an interface goes in
its own commit so the others see it. The shared files (`app.ts`, `deps.ts`, `http/*`, `config.ts`, `index.ts`)
change rarely; say so in the PR when you must touch one.

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
- Authenticated handlers start with `requirePrincipal(ctx)`. `ctx.account` and `ctx.plan` are already loaded.
- Throw `new ApiError("code", { details, retryAfterSeconds })` for every error; return `jsonResponse(...)` for
  success. Never build an error body by hand, and never put a secret in `details` (it is checked recursively).
- Read bodies only through `ctx.body` (`json()`, `bytes()`, `formData()`): the size limit and the `Content-Type`
  check (JSON must be UTF-8) are enforced there while the body streams in. `ctx.request` has no body, and a test
  fails on `ctx.request.json()` and friends under `src/modules`.
- Share typed values between a module's hooks and handlers through `ctx.locals`: extend `RequestLocals` by
  declaration merging in your module (`declare module "../../http/context" { interface RequestLocals { ... } }`).
- Add headers to the response with `ctx.responseHeaders.set(...)` (credit headers, `RateLimit-*`); they apply
  unless the handler set the header itself. `X-StudentLLM-Plan-Version` is added for you.

### The pipeline and its hooks

`src/http/pipeline.ts` runs the header-only order of the contract, then the handler reads the body:

1. client version (built in); 2. `authenticate` (hook) then three built-ins: a principal guard, the one-time
account and plan load (`ctx.account`, `ctx.plan`, `X-StudentLLM-Plan-Version`) and `freshAuthStep` (`auth_time`
within 300 s, else `reauth_required`, for export, link, unlink and delete, whatever the gating says);
3. `checkTermsAndStatus`; 4. `checkPlan`; 5. the consent header (a missing or invalid one is `consent_outdated`)
then `checkConsent`; 6. `checkRateLimit` (per account) or `checkAuthRateLimit` (per connection); 7. the
`Idempotency-Key` header (a missing or invalid one is `invalid_request`) then `lookupIdempotency`;
8. `acquireConcurrencySlot`; 9. body; 10. the budget reservation in the handler.

**Hooks fail closed.** A hook that no module provided passes only for the `notImplemented` stubs; for a route
with a real handler it throws (500 `internal_error`), and `createApp` refuses to start when a registered real
handler lacks a hook. A hook that returns without setting a principal on an authenticated route also stops the
request. So shipping a handler before its hook cannot serve unauthenticated traffic. A test that wants
pass-through hooks says so: `makeTestApp({ allowMissingHooks: true })`. Test hooks override module hooks.
A module returns its hooks from `createXHooks(deps)`; two modules claiming one hook fails at startup.

**Cleanup and streams.** `ctx.defer(fn)` runs when the handler returns. `ctx.deferUntilBodyDone(fn)` runs once
the response body has been fully read or cancelled by the client (or at once for a body-less response), so a
concurrency slot of a streamed completion is released when the stream ends. `ctx.waitUntil(promise)` forwards to
the Worker's `ExecutionContext`. The `scheduled` handler runs every module's `ScheduledTask`s.

### Storage

`src/storage/interfaces/` mirrors the data table in the plan and stores no content, no IP address and no prompt.
The in-memory implementations back the tests and local development.

- Ledger, reservations, rate-limit windows and concurrency leases are per account: every method takes
  `accountId` first, so the adapter can route to that account's Durable Object.
- A reservation stores the idempotency key hash and route; `settle`, `release`, `markFailedBeforeForward` and
  `sweep` move the idempotency record in the same call.
- Reconciliation is per account: `ledger.sweep(accountId, now)`. In a Durable Object an alarm at the earliest
  reservation expiry calls it; the cron safety net asks `stores.sweeps.due(now, limit)` which accounts to sweep.
  Nothing scans all accounts.
- `accounts.applyPlanEvent` applies a billing event atomically and drops stale ones; `savePlan` is
  compare-and-set on the plan version. `authChallenges.verifyEmailCode` compares the code inside the store and
  holds the attempt cap under parallel guesses. `webhookEvents.claim` returns a fencing token that `complete` and
  `release` require.
- The account Durable Object must run `DeviceStore.register` (the 3-device limit check and the insert) as one
  atomic step. `runStoreContract(name, factory)` in `src/testing/store-contract.ts` is the behavior suite; the
  adapters run it against their own factory, and `chaosStores()` wraps any store to reorder concurrent callers.

Hashes have two brands: `SaltedHash` (rotating salt, for expiring counters) and `StableHash` (non-rotating key,
for lookups that must survive a rotation, such as the pending email sign-in).

### Async deps

`createDeps` is synchronous. A dep that needs `await` to build (an imported signing key, a fetched JWKS, a provider
client) is stored as a memoized getter with `lazy()` from `src/lazy.ts`: concurrent callers share one promise and
a rejection is not cached, so the next call retries.

### Tests with the app

```ts
import { makeTestApp, loadFixture, fixtureRequest, expectFixtureConformance, fakeAuthenticate, accessPrincipal } from "../testing";

const t = makeTestApp({
  hooks: { authenticate: fakeAuthenticate(accessPrincipal(), { account, plan: null }) },
  deps: { auth: myAuthDeps },        // partial ModuleDeps
  fetch: myFakeFetch,                // outbound calls; the default throws, so no network
  allowMissingHooks: true,           // explicit opt-out of fail-closed hooks
});
const fx = loadFixture("chat-completions.budget_exhausted");
await expectFixtureConformance(await t.app.handle(fixtureRequest(fx)), fx);
```

`makeTestApp()` wires the in-memory stores, a manual clock (`t.clock`, shareable through `clock`), deterministic
request ids and a recording logger. `fakeExecutionContext()` records `waitUntil` promises.

## Choices where the contract was silent

The gaps found while scaffolding were settled in the contract itself (strict-semver client header and a 400 on
`getStatus`; `consent_outdated` for a bad consent header and `invalid_request` for a bad idempotency key; the
404/400/413/415 behaviors of unknown routes, `/auth/*` and the webhook). The stub's 501 with `internal_error` stays
for the scaffold only and disappears as modules replace their stubs.
