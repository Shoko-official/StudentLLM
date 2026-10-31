# StudentLLM cloud gateway (scaffold)

The optional cloud gateway described in [docs/cloud-plan.md](../docs/cloud-plan.md) and specified by
[docs/cloud-api.md](../docs/cloud-api.md), [docs/cloud-api.openapi.yaml](../docs/cloud-api.openapi.yaml) and
[docs/cloud-api-fixtures/](../docs/cloud-api-fixtures/). This directory is **a separate npm project**: it has its
own `package.json`, lockfile and `tsconfig`, and is not a workspace of the app. The contract is the source of
truth; this code follows it and never changes it.

Status: phase 2 in progress (the billing module is described under [The billing module](#the-billing-module)). Every route in the contract is registered. The **auth and account modules are
implemented** (Google and email sign-in, tokens, refresh, devices, account, export, deletion, terms, link and
unlink, provider sets, consent) against the in-memory stores; the **billing module is implemented** (checkout, portal, Paddle webhook, plan windows, cancel seam) against an injected Paddle client; the routes of the inference module and
`GET /v1/status` still answer a 501 error envelope until their modules replace the `notImplemented` stub (the
contract has no such code, so the stub reuses `internal_error`). Real today: the request id, the client-version handshake, body size limits enforced while the body streams in,
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
| billing | billing | `src/modules/billing/**` | `checkPlan` (real) | checkout, portal, Paddle webhook (real) |
| ops | ops | `src/modules/ops/index.ts`, `config.ts`, `wrangler.toml`, `src/durable-objects.ts`, `src/storage/memory/*` and the adapters | none yet | `/v1/status` |

Each module's `index.ts` exports `registerXRoutes(router, deps)`, `XDeps` and `createXDeps(core)`,
`createXHooks(deps)` and `createXScheduledTasks(deps)`. Its `config.ts` exports `secrets`, `vars` and `limits`:
add a secret, a variable or a body-size cap there, not in `src/config.ts`. A module also owns the store
interface it mostly uses (auth: `auth-challenge`, `session`, `device`; account: `account`, `consent`; inference:
`ledger`, `idempotency`, `rate-limit`, `switch`; billing: `webhook-event`), but a change to an interface goes in
its own commit so the others see it. The shared files (`app.ts`, `deps.ts`, `http/*`, `config.ts`, `index.ts`)
change rarely; say so in the PR when you must touch one.

### Cross-module calls (seams)

`src/modules/seams.ts` declares what one module calls on another: `AuthSeam`, `BillingSeam` and `InferenceSeam`.
Each module implements its own and puts it on its deps object, so a caller writes
`deps.billing.cancelSubscription(accountId, "now")`. The billing module implements `BillingSeam`.

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

## Auth and account modules

Where things are (the `index.ts` of each module exports only the four standard functions; the work is next to it):

- `modules/auth/`: `tokens.ts` (Ed25519 JWTs, JWKS, key rotation), `hooks.ts` (`authenticate`, `checkAuthRateLimit`),
  `sessions.ts` (refresh rotation, the encrypted grace copy, reuse detection, logout), `signin.ts` (device slot, code
  single use, session), `email-routes.ts`, `google-routes.ts`, `google.ts` (the OIDC client over an injected `fetch`),
  `email.ts` (the `EmailSender` interface, message templates, no provider yet).
- `modules/account/`: `hooks.ts` (`checkTermsAndStatus`), `account-routes.ts`, `devices.ts`, `link.ts`, `consent.ts`,
  `deletion.ts` (tombstone, retry with backoff, purge), `seams.ts`, `provider-sets.ts` (placeholder catalog, to be
  replaced by the routing table).
- `modules/seams.ts`: `AuthSeam`, `BillingSeam`, `InferenceSeam`. The auth deps implement `AuthSeam`
  (`deps.auth.revokeAllSessions`, `revokeManageTokens`); the account module calls the billing and inference seams through
  `deps` and falls back to inert defaults (cancel returns `none`, usage is zero, the ledger purge is a no-op) until those
  modules provide theirs.

Signing key rotation: set the new private key as `TOKEN_SIGNING_KEY` and the **public** half of the old one (base64url
`x`, comma separated for several) in the optional variable `TOKEN_PREVIOUS_PUBLIC_KEYS`. Both appear in the JWKS and
tokens of either key verify; remove the old entry after at least 20 minutes (the token lifetime plus the JWKS cache).
The `kid` is the RFC 7638 thumbprint of the public key, so it follows the key.

Email: `EmailSender` is injected (`createAuthDeps(core, { email })`). The default sender fails every send, so nothing is
silently treated as sent; a failing send never fails the request. Messages contain the code (sign-in) or nothing secret
at all (notifications), and no link.

Rate limits are constants in `modules/auth/constants.ts` (the plan's example numbers): 60 requests a minute per
connection and route, 5 code requests an hour per address with at least 60 seconds between two, 20 an hour per
connection, and failed code checks counted per address-and-connection pair and per connection (never per address
alone). A code request inside the 60 second window changes nothing and is answered like any other. An IPv6 connection
counts as its /64. A request without a readable `CF-Connecting-IP` shares ONE bucket with much stricter limits (10 a
minute, 5 code requests an hour), so removing the header never earns more allowance. Connection addresses and email
addresses are only ever hashed under the rotating salt.

Known limits: the salted counters reset when the salt rotates (every 24 hours, at UTC midnight), so a window that
straddles it can be used twice; and there is no global cap on the emails the gateway sends (only the per-address and
per-connection ones), which belongs to the email provider setup.

The `auth-cleanup` scheduled task (challenges, sessions, grace copies, manage tokens, windows) and the
`account-deletion-retry` task run from the Worker's `scheduled` handler: ops must add a cron trigger to
`wrangler.toml` (`[triggers] crons = [...]`, for example every 5 minutes); none is configured yet.

Tests drive the real app through `makeAuthApp()` (`src/testing/auth-app.ts`): a fake Google (`fake-google.ts`) and a fake
email sender (`fake-email.ts`) are injected, so no test touches the network. Pipeline tests that want only the route
table can use `makeTestApp({ stubRoutes: true, withoutModuleHooks: true })`.

Until the inference module provides `checkRateLimit` the Worker refuses to start with these real handlers (the strict
startup check of the pipeline, by design); the tests use `allowMissingHooks`.

## The billing module

`src/modules/billing/` implements `POST /v1/billing/checkout`, `GET /v1/billing/portal`, `POST /webhooks/paddle`, the
`checkPlan` hook and `BillingSeam`. It runs against the in-memory stores and an injected Paddle client; no test makes a
network call and no key is real.

| File | What it holds |
| --- | --- |
| `index.ts` | The four module exports and `BillingDeps` (the seam, `settings`, `paddle`, `notifier`); `createBillingDeps(core, overrides)` takes a fake Paddle client and notifier |
| `webhook.ts`, `signature.ts`, `events.ts` | Receiver: HMAC over the raw bytes (current and previous secret, bounded timestamp), claim, apply, quarantine; the allowlist of event fields |
| `plan-model.ts`, `windows.ts` | The plan and window rules as pure functions (UTC instants only): periods, passes, queueing, `already_subscribed`, past_due, refunds, the public `Plan` view |
| `plan-store.ts` | CAS plan updates and `syncWindows`, which makes the ledger windows match the plan (idempotent, so a replay repairs a crash) |
| `checkout.ts`, `hooks.ts` | Checkout and portal handlers; `checkPlan` (`plan_required` unless a window that is not revoked contains now) |
| `cancel.ts`, `tasks.ts` | `cancelSubscription` (`cancelled`, `pending` or `none`), the backoff retry and the ledger pruning, as scheduled tasks |
| `paddle-client.ts`, `notifier.ts`, `settings.ts` | Paddle API adapter (interface plus HTTP adapter), operator alerts and the cancellation mail behind an interface, configuration |
| `grants.ts` | Groundwork for the admin interface: complimentary windows (see below). No route |

How it fits the rest:

- **Order of events.** Each webhook is claimed by event id (the fencing token comes from `WebhookEventStore`), applied through
  `accounts.applyPlanEvent` (an event older than the newest applied one is dropped) and followed by `syncWindows`. An event that
  is older than the newest one still adds what does not depend on order (a paid period, a pass, a refund) through a
  compare-and-set merge, so a late payment event cannot lose a window. Windows are keyed by start; nothing resets used credits.
- **Mapping.** Checkout creates the Paddle customer on the server (from the verified email) and always passes it, so the
  stored customer id is known before the first payment; a first event with another customer id is quarantined. The first
  event of a purchase is bound to its account by `custom_data.account_id`; later events are mapped by the payment they name
  (adjustments), the subscription id, then the customer id; the ids an account ever used keep resolving. Unknown accounts are
  quarantined (200) and the operator is alerted; a refund or chargeback that arrived before its purchase is replayed when the
  purchase is applied (only an adjustment that names a transaction is replayed, found through an index). A deleted
  account has no plan row: `cancelSubscription` cancels every id of its tombstone (billing keeps its retry state there), a
  webhook for it only confirms a cancel, and a subscription paid during the deletion is appended to the tombstone and canceled.
- **Refunds.** A full refund or a chargeback withdraws the windows the refunded payment bought (and cancels the subscription
  now, with a retry record); a partial refund changes nothing and alerts the operator; a chargeback also raises an owner review.
- **Duplicates.** A second subscription is quarantined and canceled at Paddle now (`PlanRecord.extraCancels`, retried by the
  scheduled task); deleting an account cancels every subscription it ever had. A short per-account lock narrows the checkout race.
- **Persisted and logged.** Only `WEBHOOK_FIELD_NAMES` (ids, status, period, price id, currency). The request log has no
  body, no header and no event field. Failures log a fixed line without text from the request.
- **Configuration.** `PADDLE_PRICE_PLUS_MONTHLY`, `PADDLE_PRICE_PLUS_SEMESTER` (required outside development, never a
  `PLACEHOLDER` value), `PLUS_MONTHLY_WINDOW_CREDITS` and `PLUS_SEMESTER_WINDOW_CREDITS` (placeholder default 12500, **verify
  before launch**), and `PADDLE_CHECKOUT_HOSTS` (the checkout URL must be on one of them). `config.variable(name)` reads a non-secret variable. A Paddle API key of the other environment (by its
  prefix) is refused.
- **Cancel seam.** `deps.billing.cancelSubscription(accountId, when)` is idempotent. `pending` leaves a `pendingCancel` on the
  plan (attempts, next try) and the Paddle ids in the plan and the tombstone; the scheduled task retries with backoff and alerts
  the operator once. The deletion flow keeps its tombstone until it gets `cancelled` or `none`. The cancellation mail goes through
  `BillingNotifier` (`defaultNotifier` does nothing yet: TODO(owner: auth), back it with the `EmailSender`).
- **Tests.** `src/testing/billing-test-app.ts` has the fake Paddle, the event builders, the signer and `makeBillingTestApp()`.
  `src/testing/billing-store-contract.ts` is the billing part of the store behavior (`runBillingStoreContract`).
- **Complimentary windows (groundwork).** `grants.ts` has `createGrantWindows`, `shortenGrantWindows`, `revokeGrantWindows` and
  `planGrantWindows` for the admin service of docs/cloud-admin.md: a window with source `admin_grant`, no payment, its own budget.
  A grant never counts as an active plan; a purchase cuts the whole grant (`syncWindows` returns what it cut); billing events revoke only
  `paddle` windows. The windows go in through one conditional ledger insert (all or none, no overlap with a live or queued window), a
  replay with the same `grantId` returns them unchanged, and the ceilings derive from the standard window W (at most W per window, 3W
  per grant). `toPublicPlan(plan, now, window)` reports a grant-only account as `COMPLIMENTARY_PLAN_ID` (`free` until the public
  contract has `plus_complimentary`).

## Choices where the contract was silent

The gaps found while scaffolding were settled in the contract itself (strict-semver client header and a 400 on
`getStatus`; `consent_outdated` for a bad consent header and `invalid_request` for a bad idempotency key; the
404/400/413/415 behaviors of unknown routes, `/auth/*` and the webhook). The stub's 501 with `internal_error` stays
for the scaffold only and disappears as modules replace their stubs.

The auth and account modules settled these gaps conservatively (they are listed with their reasons in the pull request,
under "Contract questions"; none changes the contract):

- The loopback redirect path is `/callback` (any port) and the deep link is `studentllm://auth/callback`; both are
  constants in `modules/auth/constants.ts`. A bad `/auth/start` parameter is a 400 error envelope, never a redirect.
- `terms_version` is required on every `/auth/start` (the account is not known yet). A sign-in that carries the current
  version records the acceptance for an existing account with an older one.
- Suspension is checked before terms.
- **User deletion is implemented as a single pass.** `DELETE /v1/account` claims the deletion (one of several
  parallel calls wins; the others answer `session_revoked`), sends the final email first (bounded by a timeout, a
  failure is logged by name only and does not block), then writes the tombstone atomically with the removal of the
  account row (`AccountStore.markDeleting`: the email and Google indexes and the plan go with it; the tombstone keeps
  the account id, the Paddle ids and the retry bookkeeping), then runs the erase steps (sessions, devices, consents,
  pending records, ledger, idempotency, leases, the per-account rate-limit windows), each idempotent and repeated by
  the `account-deletion-retry` job until the cancel succeeds. A repeated `DELETE /v1/account` answers
  `session_revoked`. There is **no deletion ledger, no outbox, no recorded completion and no retried final email**
  yet (the admin design in docs/cloud-admin.md specifies them, including three attempts for the email within 15
  minutes, which is NOT implemented: one bounded attempt only). Those land with the ops and admin work, and the
  ledger is required before any restore of a database snapshot is accepted, because without it a restore would bring
  an erased account back. The billing seam must read the Paddle ids from `accounts.getTombstone` (the plan row is
  already erased when it runs). The cancel is retried for 14 days (a placeholder in `modules/account/deletion.ts`),
  then waits in manual review.
- A consent withdrawal is accepted whatever versions the client holds, records the server's versions, works for a
  retired provider set and is exempt from the gating; a grant needs the current versions and an open gate
  (`POST /v1/consent` is on the exempt route list for that reason; its handler gates a grant itself).
- The Google link is made at the callback (the pending sign-in has no field for the subject), and the ticket is only
  read at `/auth/start` and `/auth/email/request`; it is spent at completion. A new Google user's account, and the
  acceptance of the terms, are made at `/auth/token`, after the PKCE proof.
- The account routes opt out of the inference module's per-account window (`rateLimit: "none"`) and use their own
  (`modules/account/rate-limit.ts`), so chat requests cannot throttle delete, export, devices or withdrawal.
- Logout also frees the device when no other session uses it. A device whose sessions are all gone is pruned lazily,
  which is how an expired session frees its slot.
- The session keeps one previous token hash (as the plan's data table says), so only that generation can be detected as
  reuse; an older token is `session_revoked` without revoking the family.
