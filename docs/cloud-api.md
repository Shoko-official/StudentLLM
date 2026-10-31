# StudentLLM Cloud API contract

Status: planned, not implemented. The source of truth is the OpenAPI 3.1 file [cloud-api.openapi.yaml](./cloud-api.openapi.yaml): every endpoint, request and response schema and the error envelope are defined there as JSON Schema. This document explains it: the conventions, the behaviors that a schema cannot express, and how the pieces fit. Shared conformance examples are in [cloud-api-fixtures/](./cloud-api-fixtures/). The decisions behind the contract are in [cloud-plan.md](./cloud-plan.md); where this file, the YAML and the plan differ, fix them in the same change. Endpoint and field names are proposals for review until phase 1 closes.

## Versioning

- The `/v1` prefix is stable. Additive changes are allowed inside `/v1`: new optional request fields, new response fields, new endpoints, new error codes and new enum values. Clients must ignore unknown response fields and treat an unknown error `code` as a generic failure of its HTTP class.
- A breaking change (removing or renaming a field, changing a type or the meaning of a field, making an optional field required, tightening a limit below what the contract promised) bumps the prefix to `/v2`. `/v1` remains available for a documented period and `GET /v1/status` reports the minimum client version.
- The contract version is in `info.version` of the YAML. Request bodies reject unknown fields (`additionalProperties: false`), which is why a new request field is announced by a version of the contract and tested through the fixtures.

## Pagination

No list endpoint is paginated today because every list is small and bounded: `GET /v1/devices` (at most 3), `GET /v1/models`, `GET /v1/provider-sets`. Any future list that can grow uses cursor pagination in the same shape: request parameters `limit` (default 50, maximum 200) and `cursor` (opaque); response fields `data` and `next_cursor` (`null` on the last page). Clients must not assume an unpaginated list stays complete without checking `next_cursor`. Offset pagination is not used.

## Conventions

- Base URL `https://[PLACEHOLDER: api domain]`. TLS only, HSTS. Bodies are UTF-8 JSON, except multipart for audio and OCR uploads. Times are RFC 3339 UTC. Credit amounts are integers.
- No cookies and no CORS: the only first-party client is the native Rust side of the desktop app.
- Unknown request fields are rejected with `invalid_request`.

### Headers

| Header | Where | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <access token>` | Every route except the `security: []` ones in the YAML | Short-lived access token |
| `X-StudentLLM-Client: studentllm-desktop/<semver>` | Content routes (chat, transcription, OCR) and `GET /v1/status` only | Client name and strict semantic version (no leading zeros), for the minimum-client handshake. A missing or malformed value is `invalid_request` (400) |
| `X-StudentLLM-Consent: <consent id>` | **Only the POST content routes** (chat, transcription, OCR) | The active consent record id for the provider set of the routed model. A missing or invalid value is `consent_outdated` (409) |
| `Idempotency-Key: <uuid>` | **Only the POST content routes** | Client-chosen key, scoped per account and route. A missing or invalid value (not a UUID) is `invalid_request` (400) |
| `X-Request-Id` (response) | All | Server-generated id, same as `error.request_id` |
| `X-StudentLLM-Min-Client` (response) | Status and `client_outdated` | Minimum supported client version. The app has no updater |
| `X-StudentLLM-Credits-Remaining`, `-Limit`, `-Reset`, `-Charged` (response) | Inference routes (`Charged` for non-streaming) | Credit meter. The charge is rounded up to a whole credit per request |
| `X-StudentLLM-Plan-Version` (response) | Authenticated routes | Integer that changes whenever plan state changes; the client refetches the account only when it differs from its cached value |
| `RateLimit-*`, `Retry-After` (response) | As relevant | Rate limit state and back-off |

Other routes (checkout, consent, account deletion) carry no consent or idempotency headers. `POST /v1/consent` is idempotent by construction (posting an identical grant while it is active returns the existing record); checkout is protected by `already_subscribed`; account deletion is naturally idempotent (a repeated call while `deleting` returns the same 202).

### Order of checks on the content routes

Header-only checks run before the request body is read:

1. client version (`client_outdated`),
2. access token and session (`invalid_token`, `session_revoked`; a `manage_token` gets `insufficient_scope`),
3. terms acceptance (`terms_required`) and account status (`account_suspended`),
4. plan (`plan_required`),
5. consent (`consent_outdated`),
6. the rate-limit window (`rate_limited`).

Then:

7. the idempotency lookup (`idempotency_conflict`); a conflict returns immediately and never consumes a concurrency slot,
8. the concurrency slot (`concurrency_limit`),
9. body validation, while the body streams in (`invalid_request`, `unsupported_media_type`, `payload_too_large`),
10. the budget reservation (`budget_exhausted`).

The terms and account-status check is an addition to the agreed order; it comes right after authentication so that nothing else is evaluated for an account that has not accepted the current terms.

### Gating exceptions and fresh sign-in

- `terms_required` and `account_suspended` never block, and are never returned by, `GET /v1/account`, `GET /v1/account/export`, `DELETE /v1/account`, `POST /auth/refresh`, `POST /auth/logout`, `GET /v1/devices`, `DELETE /v1/devices/{device_id}`, `GET /v1/billing/portal`, `POST /v1/account/terms` and **`POST /v1/consent`**. Data-rights routes therefore always work, and so does withdrawing consent. `POST /v1/consent` is exempt only for a withdrawal (`granted: false`): a grant is gated like any other gated route and answers `account_suspended` or `terms_required` for a suspended account or one with outdated terms.
- Sign-in routes (`/auth/start`, `/auth/callback`, `/auth/token`, `/auth/email/request`, `/auth/email/verify`) succeed for suspended accounts: the account gets an access token that is usable only on the exempt routes, and every other route returns `account_suspended`.
- Account export, linking a login method, unlinking a login method and deleting the account all require `auth_time` within 5 minutes and otherwise return `reauth_required`.
- A `manage_token` works only on `GET /v1/devices` and `DELETE /v1/devices/{device_id}`; any other route rejects it with `insufficient_scope` (403). The gateway tells a manage token from an access token on `Authorization: Bearer` by the `mt_` prefix, which is checked first. A token without that prefix is parsed as a JWT, and a malformed one gets `invalid_token`; an `mt_` token on any route other than the two device routes gets `insufficient_scope`.

## Endpoint overview

Schemas live in the YAML; this table is a map.

| Group | Route | Auth | Notes |
| --- | --- | --- | --- |
| Auth | `GET /auth/start` | none | Google sign-in; needs the accepted `terms_version` |
| Auth | `GET /auth/callback` | none | Google redirect target; redirects to the app |
| Auth | `POST /auth/token` | none (PKCE) | Exchange the Google code |
| Auth | `POST /auth/email/request` | none | Request a one-time code; needs `terms_version` |
| Auth | `POST /auth/email/verify` | none (PKCE) | Verify the code; returns tokens directly |
| Auth | `POST /auth/refresh` | refresh token | Rotation with a short retry grace |
| Auth | `POST /auth/logout` | refresh token | Revoke this session family |
| Auth | `GET /.well-known/jwks.json` | none | Ed25519 signing keys |
| Devices | `GET /v1/devices`, `DELETE /v1/devices/{device_id}` | Bearer or opaque `manage_token` | At most 3 devices |
| Account | `GET /v1/account`, `DELETE /v1/account` | Bearer | Delete needs a fresh sign-in |
| Account | `GET /v1/account/export` | Bearer | Everything the service holds, no content |
| Account | `POST /v1/account/terms` | Bearer | Accept a newer terms version |
| Account | `POST /v1/account/link`, `DELETE /v1/account/login-methods/{method}` | Bearer, fresh sign-in | Link and unlink login methods |
| Consent | `GET /v1/provider-sets`, `POST /v1/consent` | Bearer | Provider sets and append-only consent |
| Billing | `POST /v1/billing/checkout`, `GET /v1/billing/portal` | Bearer | Server-side Paddle checkout; portal link |
| Billing | `POST /webhooks/paddle` | HMAC signature | Public receiver |
| Inference | `GET /v1/models`, `GET /v1/usage` | Bearer | Models with provider sets; credit meter |
| Inference | `POST /v1/chat/completions` | Bearer | Streaming or not; every text feature |
| Inference | `POST /v1/audio/transcriptions`, `POST /v1/ocr` | Bearer | One chunk per request; OCR schema provisional |
| Ops | `GET /v1/status` | none | Only after sign-in or an explicit click |

## Errors

Beyond the codes each route lists in the YAML, these hold for every route:

- An unknown path, or a known path with an unsupported method, returns 404 `not_found` (there is no 405).
- `/auth/*` and `/webhooks/paddle` read a JSON body, so besides the codes listed in the YAML they can also return `invalid_request` (400, malformed or unknown fields), `unsupported_media_type` (415, wrong `Content-Type`) and `payload_too_large` (413, the body exceeds the route's cap, enforced while it streams in).
- `/auth/refresh` and `/auth/logout` are not subject to `terms_required` or `account_suspended`, as listed under [Gating exceptions](#gating-exceptions-and-fresh-sign-in).

Every non-2xx response, and every mid-stream error, uses one envelope (`Error` in the YAML): `error.code`, `error.message`, `error.request_id`, optional `error.retry_after_seconds` (with a `Retry-After` header) and optional `error.details`. Messages are English, short, and never contain content, secrets or provider text; provider errors are mapped to a code.

| Code | HTTP | Meaning | Client behavior |
| --- | --- | --- | --- |
| `budget_exhausted` | 429 | Remaining credits are below the reservation | Fall back to local, show the reset time (`details.resets_at`) |
| `rate_limited` | 429 | Short-window limit (also sign-in limits) | Back off for `Retry-After` |
| `concurrency_limit` | 429 | Too many concurrent requests | Retry after `Retry-After` |
| `payload_too_large` | 413 | Body, image or audio exceeds a cap | Reduce or chunk; do not resend unchanged |
| `plan_required` | 403 | Needs Plus | Show the plan screen |
| `account_suspended` | 403 | Account suspended (abuse, chargeback); data-rights routes still work | Fall back to local; show the support route |
| `insufficient_scope` | 403 | A `manage_token` was presented to a route other than the two device routes | Use a normal session token |
| `terms_required` | 403 | Terms not accepted or outdated; `details.terms_version` has the current one | Show the bundled terms and accept, then retry |
| `consent_outdated` | 409 | The consent id is not the active record, was withdrawn, or the model needs another provider set | Do not send content; ask for consent or use local |
| `idempotency_conflict` | 409 | Key already used: `details.state` is `in_progress` or `settled` (retries from `failed_before_forward` and `failed_no_usage` are allowed and do not conflict) | `in_progress`: wait and do not resend. `settled`: use a new key to regenerate |
| `identity_conflict` | 409 (or a Google redirect `error=`) | The email belongs to another account, a link would give an account two emails, the method is already linked, or Google sign-in is attempted for an account without Google | Sign in with the existing method and link from the account screen |
| `device_limit_reached` | 409 | 3 devices already. Body is `DeviceLimitResponse`: the error plus an opaque `manage_token` (5 minutes, devices routes only). Email path only; see the Google-only note below | Revoke a device with the manage token, then retry the sign-in |
| `already_subscribed` | 409 | An active plan exists (including a subscription set to cancel at period end, or a subscription requested during a pass) | Open the customer portal |
| `session_revoked` | 401 | Session or device revoked, expired (30 days idle, 180 absolute) or account deleted | Clear tokens, return to signed-out |
| `refresh_reuse` | 401 | A rotated refresh token was reused outside the grace window; the family is revoked | Clear tokens, ask the user to sign in |
| `provider_unavailable` | 503 | Every provider in the consented set failed | Fall back to local |
| `kill_switch` | 503 | A kill switch or the global spend cap disabled this | Fall back to local |
| `invalid_request` | 400 | Malformed request, unknown field, or removing the last login method | Fix the client |
| `unsupported_media_type` | 415 | Audio or image type not allowed | Convert or reject |
| `invalid_token` | 401 | Missing, malformed, expired or wrongly signed access token | Refresh once |
| `invalid_code` | 400 | Wrong, expired, used or over-attempted code (one generic message) | Ask again |
| `reauth_required` | 401 | A fresh sign-in is needed | Run sign-in |
| `not_found` | 404 | Unknown resource | |
| `client_outdated` | 426 | Below the minimum client version | Stop using cloud; tell the user to install a newer build |
| `internal_error` | 500 | | Retry with the same key if the route allows |

## Authentication behaviors

- **Terms first.** The app shows the bundled terms and privacy notice and requires an explicit accept before calling `/auth/start` or `/auth/email/request`, and passes `terms_version`. Without it the call returns `terms_required` and nothing is created.
- **Google.** `/auth/start` redirects to Google with `openid email` and no offline access. The gateway requires `email_verified=true` and discards Google tokens after verification. `/auth/callback` redirects to the app with a single-use code (about 60 seconds) and the app's `state`. The app exchanges it with the PKCE verifier at `/auth/token`.
- **Email code.** `/auth/email/request` always answers the same way. The email carries an 8-character code and no link, says to enter it only in StudentLLM on the requesting device. A request made after the resend interval (`resend_after`, 60 seconds) invalidates earlier codes; a request made INSIDE the interval changes nothing (the earlier code stays valid, no email is sent) and is answered with the same 202, so a stranger who knows an address can neither cancel its owner's code nor tell from the answer whether a code was sent. `/auth/email/verify` checks the code (10 minutes, single use, 5 attempts, bound to the `code_challenge`) and returns tokens. Repeated failures are limited per address AND connection (and per connection alone), never per address alone, so someone who only knows an address cannot lock its owner out from another connection. Residual risk: anyone can still spend the 5 attempts of a live code by guessing, which forces its owner to request a new one after the resend interval; the Google path is the escape.
- **Loopback redirect.** Match scheme `http`, host `127.0.0.1` and the exact path; the port is ignored (RFC 8252). The listener stays open until a request with the right `state` arrives or a timeout; wrong or missing `state` is answered with an error and ignored. Deep links are a fallback only: on Windows and Linux any local app can claim the same custom scheme, so PKCE, `state`, the 60-second single-use code and a preference for loopback are the mitigations.
- **Identity.** One verified email per account. Lookup is by Google subject id first, then by email; a conflict returns `identity_conflict` and never merges accounts. When Google's email changes the account is kept and the stored email is not updated. Linking needs a fresh sign-in and a single-use ticket; unlinking never removes the last method. Link, unlink and deletion send a notification email to the account address.
- **Login methods.** Sign-in succeeds only for a method currently in the account's `login_methods`. Google sign-in for an account without Google returns `identity_conflict`; email sign-in for an account without the email method returns the generic `invalid_code`.
- **Linking.** `POST /v1/account/link` fails at issuance with `reauth_required` or `identity_conflict` (already linked). The second method then completes its own sign-in with the ticket; failures at completion are the Google callback `error=identity_conflict` or a 409 from `/auth/email/verify`. Completion returns `LinkResult`, not a new session: the client passes its current `device_id` and keeps the same device and tokens.
- **Access token.** EdDSA (algorithm pinned; `none` or any other `alg` is rejected), fixed `iss` and `aud`, `kid` from the JWKS, about 15 minutes. Claims are in `AccessTokenClaims`: `sub` (account id), `sid`, `did`, `auth_time`, `iat`, `exp`, `jti`. No email, plan or budget. A `manage_token` is not a JWT (see below).
- **Refresh.** Rotated on every use. The previous token presented again within about 30 seconds, before its successor was used, returns the same successor (the successor is stored encrypted under a key derived from the previous token and erased afterwards); this window is a documented residual risk. Any other reuse of the previous token revokes the family (`refresh_reuse`). Only the previous generation is remembered (one hash), so a token that is two or more generations old is simply unknown and answers `session_revoked` without revoking the family. `auth_time` is unchanged by refresh. Idle lifetime 30 days, absolute lifetime 180 days.
- **Devices and revocation.** A client-supplied `device_id` is honored only if it belongs to the authenticated account. At most 3 devices; the limit check and the device insert are one atomic step in the account's Durable Object. Revocations are written to the same object and apply to the very next inference request.
- **Manage token.** At the limit, `/auth/email/verify` returns 409 `DeviceLimitResponse` with an opaque random `manage_token`: not a JWT, valid 5 minutes, stored hashed, single-purpose (`GET /v1/devices` and `DELETE /v1/devices/{device_id}` only; anything else gets `insufficient_scope`). It sits in its own schema, not in `error.details`, so the error envelope stays free of secrets. It must never be logged. A successful code check at the limit does not count as an attempt, the code stays unconsumed, and at most 3 manage tokens are minted per code. Revoking a device with it sends a notification email. The Google path never issues a manage token: the user revokes a device from another signed-in device, or, if the email method is linked, uses the email path, then retries. A Google-only user (the email method is not linked) at the limit with no other signed-in device cannot self-serve: they wait for the 30-day idle expiry of an old session or contact support. Under a manage token the device list reports `current: false` for every device.
- **Re-authentication** means a fresh sign-in, which sets a new `auth_time`. Account deletion, linking, unlinking and export require `auth_time` within 5 minutes, otherwise `reauth_required`.

## Idempotency

Applies to the POST content routes only. The key is scoped per account and route and lives 24 hours. The record has one of four states: `in_flight`, `failed_before_forward`, `failed_no_usage`, `settled`.

- Retry while `in_flight`: `idempotency_conflict` with `details.state = "in_progress"`. The client waits and does not resend.
- A same-key retry is allowed from `failed_before_forward` (the reservation is reused) and from `failed_no_usage`.
- `failed_no_usage` is terminal and defined strictly: an explicit upstream error response (a definitive error status with no completion), or a connection failure before the request was accepted. The reservation is released and zero credits are charged. `failed_no_usage` events are counted per account per hour as an anomaly signal.
- Every timeout, gateway abort, reset after bytes were sent, or missing response is an unknown outcome and settles at the full reservation, or on counted tokens where available; a same-key retry then returns `idempotency_conflict` with `details.state = "settled"` (see the timeout fixture). Any other forwarded attempt is settled at actual usage. A client abort after the first token and a missing usage chunk are also unknown outcomes. A mid-stream `provider_unavailable` settles on the tokens actually emitted, with the full reservation only as a fallback.
- Retry after `settled`: `idempotency_conflict` with `details.state = "settled"`, the original `request_id` and `credits_charged`. The answer is not stored and cannot be replayed; use a new key to regenerate.
- There is no body-fingerprint check, because nothing derived from content is stored. A key identifies an attempt; clients use a fresh key for each logical request.
- The lookup runs after the token, plan, consent and rate-limit checks and before the budget reservation. A conflict never consumes a concurrency slot.
- Reservations expire after the route's maximum duration plus 60 seconds (heartbeat extension for streams). The first settlement wins; later ones are ignored and counted.
- Clients retry only on network errors, `429` and `503`, honoring `Retry-After`, with the same key.

## Streaming

With `stream: true` the response is `text/event-stream`: unnamed OpenAI-format `data:` chunks, then one named `event: usage` (schema `UsageEvent`), then `data: [DONE]`. A failure after the first byte cannot change the HTTP status, so the gateway sends one `event: error` whose data is the standard envelope and closes the stream without `[DONE]`; the request is settled on the tokens actually emitted, or at the full reservation if they cannot be counted. A stream that ends with neither `[DONE]` nor an `error` event is a network failure. Failures before the first byte use the normal HTTP status and envelope. Plain OpenAI clients ignore the named events. See the two SSE fixtures.

## Content routes

- **Chat** accepts only the allowlisted fields of `ChatRequest`. Images are `data:` URLs only. `tools`, `tool_choice`, `functions`, `n` above 1, `logit_bias`, `user` and `stream_options` are rejected. `max_tokens` is clamped, `model` is a logical id rewritten from the routing table. The gateway sets the upstream `user` to a per-account HMAC pseudonym.
- **Transcription** takes one chunk per request. The reservation is `max(declared duration, a bound from the byte size)` and settlement uses the provider-reported duration. The client splits longer recordings, gives each chunk its own idempotency key, and applies timestamp offsets when merging. No `prompt` field is accepted.
- **OCR** takes an image and returns text and blocks. The response schema is provisional until the OCR provider is chosen.

## Consent

`GET /v1/provider-sets` returns each provider set with its version, provider names, regions and `consent_text_version`; `Model.provider_set_version` (required) tells the app which version a model needs. The consent text is bundled in the app per `text_version`. `POST /v1/consent` with a grant (`granted: true`) whose `text_version` is not the server's current one, or whose `provider_set_version` is not the set's current version, returns 409 `consent_outdated` with `details.consent_text_version` (and `details.provider_set_version`). Bumping the consent text therefore strands builds that bundle the old text: they cannot collect consent, fall back to local and show an "update required" message. That is accepted. A request that is malformed, names a provider set the server does not offer, asks for a feature the set does not offer, or grants no feature is 400 `invalid_request`; the 400 checks come before the 409 ones. **A withdrawal (`granted: false`) is never refused for its versions:** it is accepted whatever `text_version`, `provider_set_version` and `features` the client holds (they are ignored), works for a provider set that was retired from the catalog as long as the account has a record for it (otherwise 400), and is exempt from the terms and suspension gating (see Gating exceptions). The record it appends carries the server's current versions of the set (for a retired set, the versions of the record being withdrawn) and the features of the record being withdrawn, never client-supplied values. Repeating a withdrawal returns the existing record. Consent records are append-only with one active record per provider set; the app sends the active record id in `X-StudentLLM-Consent` on the content routes, and a withdrawn or replaced record gives `consent_outdated`. All text features are the `chat` feature.

## Billing and webhooks

Checkout is created server-side with the account id in `custom_data`; the client never sends a price. `already_subscribed` (an active plan exists) is returned when any plan is active, including a subscription set to cancel at period end and a subscription requested during a pass; a pass bought during a pass is allowed and queues after it. Checkout can also answer 429 `concurrency_limit` (a checkout for the same account is already being created) and 503 `provider_unavailable` (Paddle is not answering, or answered with a checkout URL the gateway does not trust); the portal link can answer 503 `provider_unavailable`. The webhook route verifies the HMAC over the raw bytes with a timestamp tolerance and a constant-time compare (two secrets accepted during rotation, sandbox and live separate), claims the event id atomically, applies events by `occurred_at` or by re-fetching the subscription, maps events after the first by the stored subscription or customer id, quarantines unknown ones with a 200, persists and logs only allowlisted fields, and responds fast. Signature header and event names must be verified against Paddle's current documentation.

## Fixtures

[cloud-api-fixtures/](./cloud-api-fixtures/) holds JSON examples that the gateway and the client are both tested against: each has an `operation` (an `operationId` of the YAML), a `request`, a `response` and the `response_schema` that the response body must satisfy (`null` when there is no body). `index.json` lists them. They include a success and an error for the main routes and the cases that matter most: `consent_outdated` (including the text-version mismatch), both `idempotency_conflict` states, a provider failure with no usage (`failed_no_usage`), a timeout settled at the full reservation, `budget_exhausted`, `terms_required`, `client_outdated`, refresh (success, grace retry, `refresh_reuse`), the device-limit flow with a manage token and the `insufficient_scope` rejection, link and unlink, transcription, a webhook, and the two streaming outcomes. All values are examples; none is a real token, address, signature or key.

## Validating the contract

`scripts/validate-cloud-contract.py` checks, without network access, that the OpenAPI document is valid OpenAPI 3.1, that `index.json` and the fixture files match, and that every fixture uses a real `operationId`, a status code the operation declares, and request, response and SSE payloads that satisfy the contract's JSON Schemas (2020-12). It also fails on an unknown error code or a secret-bearing key in `error.details`.

```bash
python -m pip install -r requirements-cloud-contract.txt
python scripts/validate-cloud-contract.py
```

CI runs the same two commands in the main job. When the YAML changes, regenerate or edit the fixtures until the script passes.

## Notes for implementers

- The gateway never returns a stored request or answer; no route does.
- Gateway logs hold request id, account id, route, status, credits and latency only.
- Changing a route, field or code means changing the YAML, this file, the fixtures and, when it alters a decision, [cloud-plan.md](./cloud-plan.md) together.
