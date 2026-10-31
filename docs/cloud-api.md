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
| `X-StudentLLM-Client: studentllm-desktop/<semver>` | All client requests | Client name and version, for the minimum-client handshake |
| `X-StudentLLM-Consent: <consent id>` | **Only the POST content routes** (chat, transcription, OCR) | The active consent record id for the provider set of the routed model |
| `Idempotency-Key: <uuid>` | **Only the POST content routes** | Client-chosen key, scoped per account and route |
| `X-Request-Id` (response) | All | Server-generated id, same as `error.request_id` |
| `X-StudentLLM-Min-Client` (response) | Status and `client_outdated` | Minimum supported client version. The app has no updater |
| `X-StudentLLM-Credits-Remaining`, `-Limit`, `-Reset`, `-Charged` (response) | Inference routes (`Charged` for non-streaming) | Credit meter. The charge is rounded up to a whole credit per request |
| `X-StudentLLM-Plan-Version` (response) | Authenticated routes | Integer that changes whenever plan state changes; the client refetches the account only when it differs from its cached value |
| `RateLimit-*`, `Retry-After` (response) | As relevant | Rate limit state and back-off |

Other routes (checkout, consent, account deletion) carry no consent or idempotency headers. `POST /v1/consent` is idempotent by construction (posting an identical grant while it is active returns the existing record); checkout is protected by `already_subscribed`; account deletion is naturally idempotent (a repeated call while `deleting` returns the same 202).

### Order of checks on the content routes

1. client version (`client_outdated`),
2. access token and session (`invalid_token`, `session_revoked`),
3. terms acceptance (`terms_required`), then account status (`account_suspended`),
4. plan (`plan_required`),
5. consent (`consent_outdated`),
6. rate and concurrency limits (`rate_limited`, `concurrency_limit`),
7. budget (`budget_exhausted`).

Body validation (`invalid_request`, `payload_too_large`) happens while the body streams in, so an oversized body is cut off early. The terms check is an addition to the agreed order; it comes right after authentication so that nothing else is evaluated for an account that has not accepted the current terms.

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
| Devices | `GET /v1/devices`, `DELETE /v1/devices/{device_id}` | Bearer or `manage_token` | At most 3 devices |
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

Every non-2xx response, and every mid-stream error, uses one envelope (`Error` in the YAML): `error.code`, `error.message`, `error.request_id`, optional `error.retry_after_seconds` (with a `Retry-After` header) and optional `error.details`. Messages are English, short, and never contain content, secrets or provider text; provider errors are mapped to a code.

| Code | HTTP | Meaning | Client behavior |
| --- | --- | --- | --- |
| `budget_exhausted` | 429 | Remaining credits are below the reservation | Fall back to local, show the reset time (`details.resets_at`) |
| `rate_limited` | 429 | Short-window limit (also sign-in limits) | Back off for `Retry-After` |
| `concurrency_limit` | 429 | Too many concurrent requests | Retry after `Retry-After` |
| `payload_too_large` | 413 | Body, image or audio exceeds a cap | Reduce or chunk; do not resend unchanged |
| `plan_required` | 403 | Needs Plus | Show the plan screen |
| `account_suspended` | 403 | Account suspended (abuse, chargeback) | Fall back to local; show the support route |
| `terms_required` | 403 | Terms not accepted or outdated; `details.terms_version` has the current one | Show the bundled terms and accept, then retry |
| `consent_outdated` | 409 | The consent id is not the active record, was withdrawn, or the model needs another provider set | Do not send content; ask for consent or use local |
| `idempotency_conflict` | 409 | Key already used: `details.state` is `in_progress` or `settled` | `in_progress`: wait and do not resend. `settled`: use a new key to regenerate |
| `identity_conflict` | 409 | The email belongs to another account, or a link would give an account two emails | Sign in with the existing method and link from the account screen |
| `device_limit_reached` | 409 | 3 devices already; `details.manage_token` allows listing and revoking only | Revoke a device, then sign in again |
| `already_subscribed` | 409 | An active subscription exists | Open the customer portal |
| `session_revoked` | 401 | Session or device revoked, expired (30 days idle, 180 absolute) or account deleted | Clear tokens, return to signed-out |
| `refresh_reuse` | 401 | A rotated refresh token was reused outside the grace window; the family is revoked | Clear tokens, ask the user to sign in |
| `provider_unavailable` | 503 | Every provider in the consented set failed | Fall back to local |
| `kill_switch` | 503 | A kill switch or the global spend cap disabled this | Fall back to local |
| `invalid_request` | 400 / 415 | Malformed or unknown field | Fix the client |
| `invalid_token` | 401 | Missing, malformed, expired or wrongly signed access token | Refresh once |
| `invalid_code` | 400 | Wrong, expired, used or over-attempted code (one generic message) | Ask again |
| `reauth_required` | 401 | A fresh sign-in is needed | Run sign-in |
| `not_found` | 404 | | |
| `client_outdated` | 426 | Below the minimum client version | Stop using cloud; tell the user to install a newer build |
| `internal_error` | 500 | | Retry with the same key if the route allows |

## Authentication behaviors

- **Terms first.** The app shows the bundled terms and privacy notice and requires an explicit accept before calling `/auth/start` or `/auth/email/request`, and passes `terms_version`. Without it the call returns `terms_required` and nothing is created.
- **Google.** `/auth/start` redirects to Google with `openid email` and no offline access. The gateway requires `email_verified=true` and discards Google tokens after verification. `/auth/callback` redirects to the app with a single-use code (about 60 seconds) and the app's `state`. The app exchanges it with the PKCE verifier at `/auth/token`.
- **Email code.** `/auth/email/request` always answers the same way. The email carries an 8-character code and no link, says to enter it only in StudentLLM on the requesting device, and a new request invalidates earlier codes. `/auth/email/verify` checks the code (10 minutes, single use, 5 attempts, bound to the `code_challenge`) and returns tokens.
- **Loopback redirect.** Match scheme `http`, host `127.0.0.1` and the exact path; the port is ignored (RFC 8252). The listener stays open until a request with the right `state` arrives or a timeout; wrong or missing `state` is answered with an error and ignored. Deep links are a fallback only: on Windows and Linux any local app can claim the same custom scheme, so PKCE, `state`, the 60-second single-use code and a preference for loopback are the mitigations.
- **Identity.** One verified email per account. Lookup is by Google subject id first, then by email; a conflict returns `identity_conflict` and never merges accounts. When Google's email changes the account is kept and the stored email is not updated. Linking needs a fresh sign-in and a single-use ticket; unlinking never removes the last method. Link, unlink and deletion send a notification email to the account address.
- **Access token.** EdDSA (algorithm pinned; `none` or any other `alg` is rejected), fixed `iss` and `aud`, `kid` from the JWKS, about 15 minutes. Claims are in `AccessTokenClaims`: `sub` (account id), `sid`, `did`, `auth_time`, `iat`, `exp`, `jti`. No email, plan or budget. A `manage_token` is an access token with `scope: devices` and a short lifetime.
- **Refresh.** Rotated on every use. The previous token presented again within about 30 seconds, before its successor was used, returns the same successor (the successor is stored encrypted under a key derived from the previous token and erased afterwards); this window is a documented residual risk. Any other reuse revokes the family (`refresh_reuse`). `auth_time` is unchanged by refresh. Idle lifetime 30 days, absolute lifetime 180 days.
- **Devices and revocation.** A client-supplied `device_id` is honored only if it belongs to the authenticated account. At most 3 devices. Revocations are written to the account's Durable Object and apply to the very next inference request.
- **Re-authentication** means a fresh sign-in, which sets a new `auth_time`. Account deletion, linking, unlinking and export require `auth_time` within 5 minutes, otherwise `reauth_required`.

## Idempotency

Applies to the POST content routes only. The key is scoped per account and route and lives 24 hours. The record has one of three states: `in_flight`, `failed_before_forward`, `settled`.

- Retry while `in_flight`: `idempotency_conflict` with `details.state = "in_progress"`.
- Retry after `failed_before_forward`: allowed; the reservation may be reused.
- A forwarded attempt is always settled at actual usage or at the full reservation.
- Retry after `settled`: `idempotency_conflict` with `details.state = "settled"`, the original `request_id` and `credits_charged`. The answer is not stored and cannot be replayed; use a new key to regenerate.
- There is no body-fingerprint check, because nothing derived from content is stored. A key identifies an attempt; clients use a fresh key for each logical request.
- Reservations expire after the route's maximum duration plus 60 seconds (heartbeat extension for streams). A forwarded request whose settlement never arrives is settled at the full reservation. The first settlement wins; later ones are ignored and counted.
- Clients retry only on network errors, `429` and `503`, honoring `Retry-After`, with the same key.

## Streaming

With `stream: true` the response is `text/event-stream`: unnamed OpenAI-format `data:` chunks, then one named `event: usage` (schema `UsageEvent`), then `data: [DONE]`. A failure after the first byte cannot change the HTTP status, so the gateway sends one `event: error` whose data is the standard envelope and closes the stream without `[DONE]`; the request is settled at the full reservation if no usage chunk arrived. A stream that ends with neither `[DONE]` nor an `error` event is a network failure. Failures before the first byte use the normal HTTP status and envelope. Plain OpenAI clients ignore the named events. See the two SSE fixtures.

## Content routes

- **Chat** accepts only the allowlisted fields of `ChatRequest`. Images are `data:` URLs only. `tools`, `tool_choice`, `functions`, `n` above 1, `logit_bias`, `user` and `stream_options` are rejected. `max_tokens` is clamped, `model` is a logical id rewritten from the routing table. The gateway sets the upstream `user` to a per-account HMAC pseudonym.
- **Transcription** takes one chunk per request. The reservation is `max(declared duration, a bound from the byte size)` and settlement uses the provider-reported duration. The client splits longer recordings, gives each chunk its own idempotency key, and applies timestamp offsets when merging. No `prompt` field is accepted.
- **OCR** takes an image and returns text and blocks. The response schema is provisional until the OCR provider is chosen.

## Billing and webhooks

Checkout is created server-side with the account id in `custom_data`; the client never sends a price. `already_subscribed` is returned when an active subscription exists, including one set to cancel at period end. The webhook route verifies the HMAC over the raw bytes with a timestamp tolerance and a constant-time compare (two secrets accepted during rotation, sandbox and live separate), claims the event id atomically, applies events by `occurred_at` or by re-fetching the subscription, maps events after the first by the stored subscription or customer id, quarantines unknown ones with a 200, persists and logs only allowlisted fields, and responds fast. Signature header and event names must be verified against Paddle's current documentation.

## Fixtures

[cloud-api-fixtures/](./cloud-api-fixtures/) holds JSON examples that the gateway and the client are both tested against: each has an `operation` (an `operationId` of the YAML), a `request`, a `response` and the `response_schema` that the response body must satisfy. They include a success and an error for the main routes and the cases that matter most: `consent_outdated`, both `idempotency_conflict` states, `budget_exhausted`, `device_limit_reached`, `already_subscribed` and the two streaming outcomes. `index.json` lists them. All values are examples; none is a real token, address or key. When the YAML changes, the fixtures must still validate (the bodies were validated against the schemas with a JSON Schema 2020-12 validator when they were written).

## Notes for implementers

- The gateway never returns a stored request or answer; no route does.
- Gateway logs hold request id, account id, route, status, credits and latency only.
- Changing a route, field or code means changing the YAML, this file, the fixtures and, when it alters a decision, [cloud-plan.md](./cloud-plan.md) together.
