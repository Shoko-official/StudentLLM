# StudentLLM Cloud API contract

Status: planned, not implemented. This is the HTTP contract that the gateway and the desktop Rust client are coded against. It follows the decisions in [cloud-plan.md](./cloud-plan.md); where the two differ, fix the plan or this file in the same change. Schemas are written as tables in a JSON-schema style: `type`, `req` (required) and constraints. Field and endpoint names are proposals for review, except where the plan fixes them (error codes, behaviors).

## Conventions

- Base URL: `https://[PLACEHOLDER: api domain]`. All routes except webhooks and JWKS are under `/v1` or `/auth`. TLS only; HSTS.
- Bodies are UTF-8 JSON unless stated (multipart for audio and OCR uploads, form or JSON for the token endpoint).
- Unknown request fields are rejected with `invalid_request`.
- Times are RFC 3339 UTC strings. Credit amounts are integers.
- No cookies. No CORS: the only first-party client is the native Rust side of the desktop app.

### Common request headers

| Header | Applies to | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <access_token>` | All routes marked "Bearer" | Short-lived access token |
| `X-StudentLLM-Client: studentllm-desktop/<semver>` | All | Client name and version, used by the minimum-client-version handshake |
| `X-StudentLLM-Consent: <consent_id>` | Inference routes | The consent record the client believes is current. The gateway checks it against the account's recorded consent and the provider set of the routed model |
| `Idempotency-Key: <uuid>` | Marked POST routes | Client-chosen key for safe retries (see [Retries and idempotency](#retries-and-idempotency)) |

### Common response headers

| Header | Meaning |
| --- | --- |
| `X-Request-Id` | Server-generated id, also in the error envelope and the logs. Safe to show to the user and to quote in support |
| `X-StudentLLM-Min-Client` | Minimum supported client version. A client below it must stop calling cloud routes and tell the user (the app has no updater and does not self-update) |
| `X-StudentLLM-Credits-Remaining` | Credits left in the current budget window, after this request's reservation. Sent on inference routes and `GET /v1/usage` |
| `X-StudentLLM-Credits-Limit` | Credits in the window |
| `X-StudentLLM-Credits-Reset` | When the window resets (RFC 3339) |
| `X-StudentLLM-Credits-Charged` | Credits settled for this request (non-streaming responses; for streams, see the `usage` event) |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | Short-window rate limit state |
| `Retry-After` | Seconds, on `429`, `503` and where the error table says so |

## Error envelope

Every non-2xx response, and every mid-stream error, uses one shape:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `error.code` | string | yes | Stable machine-readable code from the table below |
| `error.message` | string | yes | Human-readable, English, never contains content, secrets or provider text |
| `error.request_id` | string | yes | Same as `X-Request-Id` |
| `error.retry_after_seconds` | integer | no | Present when `Retry-After` is sent |
| `error.details` | object | no | Small structured hints (for example `{"resets_at": "..."}`), never content |

```json
{ "error": { "code": "budget_exhausted", "message": "The monthly credit budget is used up.", "request_id": "req_01J...", "retry_after_seconds": 864000, "details": { "resets_at": "2026-12-01T00:00:00Z" } } }
```

### Error codes

| Code | HTTP | Meaning | Client behavior |
| --- | --- | --- | --- |
| `budget_exhausted` | 429 | Remaining credits are below the request's reservation | Fall back to the local model, tell the user, show the reset time |
| `rate_limited` | 429 | Short-window rate limit | Back off for `Retry-After` |
| `concurrency_limit` | 429 | Too many concurrent requests for the account | Queue or retry after `Retry-After` |
| `payload_too_large` | 413 | Body, image, or audio exceeds a cap (also when the cap is hit while streaming the body in) | Do not retry unchanged; chunk or reduce |
| `plan_required` | 403 | The route or model needs Plus | Show the plan screen |
| `consent_outdated` | 409 | The consent id sent is not current, or the routed model needs a provider set the account has not consented to | Do not send content; ask for consent or use the local model |
| `session_revoked` | 401 | The session or device was revoked, or the account was deleted | Clear tokens, return to signed-out |
| `refresh_reuse` | 401 | A rotated refresh token was presented again outside the grace window; the session family is revoked | Clear tokens, ask the user to sign in again |
| `provider_unavailable` | 503 | Every provider in the consented set failed or timed out | Fall back to the local model |
| `kill_switch` | 503 | A kill switch or the global spend cap disabled this feature, provider or the whole cloud | Fall back to the local model |

Additional codes: `invalid_request` (400), `invalid_token` (401; missing, malformed, expired or wrongly signed access token, try refresh once), `invalid_code` (400; wrong or expired email code, one generic message for every failure), `reauth_required` (401; a fresh sign-in is needed for this action), `not_found` (404), `idempotency_conflict` (409), `client_outdated` (426; below the minimum client version), `unsupported_media_type` (415), `internal_error` (500).

Provider error text is never forwarded; it is mapped to one of these codes.

## Authentication endpoints

All `/auth` routes are unauthenticated unless stated. Rate limited by a hashed connection identifier and, for email routes, by hashed email. Redirect URI rules for the loopback client: scheme `http`, host `127.0.0.1`, exact path match, **port ignored**, per RFC 8252. A deep-link redirect (`studentllm://auth/callback`) is accepted as a fallback; see the security note in [cloud-plan.md](./cloud-plan.md#authentication) about custom-scheme claims on Windows and Linux.

### `GET /auth/start` (Google sign-in)

Opened by the app in the system browser.

| Query param | Type | Req | Notes |
| --- | --- | --- | --- |
| `client_id` | string | yes | `studentllm-desktop` |
| `redirect_uri` | string | yes | Loopback or deep link, matched as above |
| `response_type` | string | yes | `code` |
| `state` | string | yes | 16 to 128 random characters, echoed back |
| `code_challenge` | string | yes | PKCE S256 challenge |
| `code_challenge_method` | string | yes | `S256` only |
| `provider` | string | yes | `google` |
| `link_ticket` | string | no | Single-use ticket from `POST /v1/account/link`, to link Google to a signed-in account |

Response: `302` to Google's authorization endpoint with scope `openid email`, no offline access, and a gateway-generated `state` and `nonce`. Invalid parameters: `400` rendered as a plain page (no redirect to an unverified URI).

### `GET /auth/callback` (Google)

Called by Google's redirect. Verifies state, exchanges Google's code, verifies the ID token (signature, `iss`, `aud`, `exp`, `nonce`) and requires `email_verified=true`; then discards all Google tokens.

Response: `302` to the app's `redirect_uri` with `code` (single use, about 60 seconds) and the app's `state`; on failure `error=access_denied` or `error=server_error` and the app's `state`, with no detail.

### `POST /auth/token`

Exchanges the authorization code from the Google path. Unauthenticated; PKCE is the proof.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `grant_type` | string | yes | `authorization_code` |
| `code` | string | yes | From the redirect |
| `code_verifier` | string | yes | 43 to 128 characters; must hash to the stored challenge |
| `redirect_uri` | string | yes | Same as at `/auth/start` (port may differ) |
| `client_id` | string | yes | `studentllm-desktop` |
| `device_id` | string | no | Existing device id when re-signing in on a known device |
| `device_label` | string | no | Up to 64 characters, defaults to the platform name |

Response `200`: [Token response](#token-response). Errors: `invalid_request`, `invalid_code` (code unknown, used, expired or verifier mismatch).

### `POST /auth/email/request`

Requests a one-time code. Always answers the same way, whether or not the address exists.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Normalized server-side to lower case; `+` tags and dots are kept |
| `code_challenge` | string | yes | PKCE S256 challenge; the code is bound to it |
| `code_challenge_method` | string | yes | `S256` |
| `device_label` | string | no | Up to 64 characters |
| `link_ticket` | string | no | To link an email to a signed-in account |

Response `202`: `{ "expires_in": 600, "resend_after": 60, "code_length": 8 }`. Errors: `rate_limited`, `invalid_request`. The email carries an 8-character code (alphabet without look-alike characters) and no link.

### `POST /auth/email/verify`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `email` | string | yes | Same address as the request |
| `code` | string | yes | The 8 characters, case-insensitive |
| `code_verifier` | string | yes | Must hash to the challenge the code is bound to |
| `device_id`, `device_label` | string | no | As in `/auth/token` |

Response `200`: [Token response](#token-response). The code is single use, valid 10 minutes, invalidated after 5 wrong attempts. Errors: `invalid_code` (one generic message for wrong, expired, used, over-attempted), `rate_limited`.

### Token response

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `access_token` | string | yes | JWT, about 15 minutes |
| `token_type` | string | yes | `Bearer` |
| `expires_in` | integer | yes | Seconds |
| `refresh_token` | string | yes | Opaque, rotated on every use |
| `device_id` | string | yes | Stable id of this device record |
| `account` | object | yes | `{ "account_id": string, "email": string, "plan": "free" or "plus" }` |

### `POST /auth/refresh`

Called by the Rust side lazily, just before a cloud request.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `refresh_token` | string | yes | The current refresh token |
| `device_id` | string | yes | Must match the token's device |

Response `200`: [Token response](#token-response) with a new refresh token (the old one is invalidated).

Rotation and grace: if a client retries a refresh whose response was lost, presenting the previous token within about 30 seconds of the rotation, and the successor has not been used yet, the gateway returns the same successor again (the successor token is derived, not stored in plaintext). Outside the window, or after the successor was used, the previous token is a reuse: the whole session family is revoked and the response is `refresh_reuse`. Other errors: `session_revoked`, `invalid_request`.

### `POST /auth/logout`

Bearer or refresh token. Body: `{ "refresh_token": string }`. Revokes this session family. Response `204`. Idempotent.

### `GET /v1/devices` (Bearer)

Response `200`: `{ "devices": [ { "device_id": string, "label": string, "created_at": string, "last_used_at": string, "current": boolean } ] }`.

### `DELETE /v1/devices/{device_id}` (Bearer)

Revokes the device's session family. Response `204`. `not_found` if it is not the caller's device.

### `GET /.well-known/jwks.json`

Public, cacheable (`Cache-Control: public, max-age=300`). Response `200`: a JWKS with the current and the previous signing keys (OKP, Ed25519) each with `kid`.

### Access token

A signed JWT. The algorithm is pinned to `EdDSA`: a token whose header `alg` differs, or is `none`, is rejected; `kid` selects the key from the JWKS.

| Claim | Meaning |
| --- | --- |
| `iss` | Fixed issuer, `https://[PLACEHOLDER: api domain]` |
| `aud` | Fixed audience, `studentllm-gateway` |
| `sub` | Internal account id |
| `sid` | Session family id |
| `did` | Device id |
| `auth_time` | Time of the last interactive sign-in of this session (for fresh-auth checks) |
| `iat`, `exp` | Issued at, expiry; lifetime about 15 minutes |
| `jti` | Unique token id |

No email, plan or budget is in the token. Revocation latency: the session state is checked on each request (with the counter state), effective at the next request, target about 60 seconds, bounded in the worst case by the token lifetime.

## Account endpoints (Bearer)

### `GET /v1/account`

Response `200`:

| Field | Type | Notes |
| --- | --- | --- |
| `account_id` | string | Internal id |
| `email` | string | Normalized |
| `login_methods` | array of `"google"`, `"email"` | Linked methods |
| `plan` | object | `{ "id": "free" or "plus_monthly" or "plus_semester", "status": "active" or "past_due" or "canceled" or "none", "period_start": string, "period_end": string, "cancel_at_period_end": boolean }` |
| `budget` | object | Same as `GET /v1/usage` `credits` |
| `consent` | object | The current consent record or `null` (see `POST /v1/consent`) |
| `created_at` | string | |

### `DELETE /v1/account`

Requires `auth_time` within the last 5 minutes (otherwise `reauth_required`) and an `Idempotency-Key`. Cancels the Paddle subscription first, then deletes every record in the data table of the plan. Response `202`: `{ "deletion_id": string, "subscription_canceled": boolean }`; the account is unusable immediately (`session_revoked`). Backup data (phase 6) is deleted with it.

### `GET /v1/account/export`

Returns everything the service holds about the account (the data table), as `application/json` with `Content-Disposition: attachment`. Fields: `account`, `login_methods`, `consent_records`, `plan`, `sessions` (device labels and dates, no tokens), `usage_totals`. It never contains course content because none is stored. Rate limited to a few per day.

### `POST /v1/account/link`

Requires `auth_time` within the last 5 minutes (otherwise `reauth_required`). Body: `{ "method": "google" or "email" }`. Response `200`: `{ "link_ticket": string, "expires_in": 300 }`. The ticket is single use and bound to the account; it must be passed to `/auth/start` or `/auth/email/request`, and the second method must complete its own sign-in with it. Linking never happens from a matching email alone.

### `POST /v1/consent`

Records or withdraws consent. Idempotency key supported.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `provider_set` | string | yes | Provider set id and version shown on the consent screen, for example `ps1` |
| `features` | array of `"chat"`, `"transcription"`, `"ocr"` | yes | The features consented to (empty array with `granted: false` withdraws everything) |
| `text_version` | string | yes | Version of the consent text the user saw |
| `granted` | boolean | yes | `false` withdraws |

Response `200`: `{ "consent_id": string, "provider_set": string, "features": [..], "granted": boolean, "recorded_at": string }`. The `consent_id` is what the client sends in `X-StudentLLM-Consent`. A new provider set or a material text change produces a new id; sending an older id gets `consent_outdated`.

## Billing endpoints

### `POST /v1/billing/checkout` (Bearer, Idempotency-Key)

Creates a Paddle transaction server-side with the account id in `custom_data`. The client never sends a price id.

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `plan` | string | yes | `plus_monthly` or `plus_semester` |

Response `200`: `{ "checkout_url": string, "expires_at": string }`; the app opens the URL in the system browser. Errors: `invalid_request`, `rate_limited`.

### `GET /v1/billing/portal` (Bearer)

Response `200`: `{ "url": string, "expires_at": string }`, a short-lived Paddle customer-portal link. `not_found` if the account has no Paddle customer.

### `POST /webhooks/paddle`

Public route called by Paddle. Not versioned with the client; sandbox and live are separate deployments with separate secrets.

| Aspect | Rule |
| --- | --- |
| Signature header | `Paddle-Signature` (format and algorithm per Paddle's current documentation, verify); HMAC computed over the timestamp and the raw request bytes |
| Verification | Over the raw bytes, with a timestamp tolerance (for example 5 minutes) and a constant-time comparison; two secrets accepted during rotation |
| Order of work | Verify, then atomically claim the event id, then apply, then respond; slow work after the response |
| Events handled | Subscription created, activated, updated, canceled, paused, resumed, past due; transaction completed and payment failed; adjustments (refunds, chargebacks). Exact names to verify |
| Ordering | By the event's `occurred_at`, or by re-fetching the subscription from Paddle |
| Unknown account id | `200`, quarantined, alert; no account is created |
| Persisted and logged | Allowlist only: event id, type, `occurred_at`, subscription and customer ids, status, period, price id, currency |

Responses: `200` `{}` (accepted, duplicate, or quarantined), `401` (bad signature, no detail), `503` (temporary failure; Paddle retries).

## Inference endpoints (Bearer)

All inference routes require the `X-StudentLLM-Consent` header and an `Idempotency-Key`, and return the credit headers.

### `GET /v1/models`

OpenAI-compatible list with extension fields.

| Field | Type | Notes |
| --- | --- | --- |
| `object` | string | `list` |
| `data[].id` | string | Logical model name (for example `studentllm-large`) |
| `data[].object` | string | `model` |
| `data[].features` | array | `chat`, `transcription`, `ocr` |
| `data[].context_window` | integer | Tokens |
| `data[].max_output_tokens` | integer | The clamp |
| `data[].credits_per_1k_input`, `data[].credits_per_1k_output` | number | From the routing table |
| `data[].provider_set` | string | The provider set the model belongs to; the app compares it with the consent |
| `data[].requires_plan` | string | `plus` |
| `data[].available` | boolean | `false` when a kill switch or outage disables it |

### `GET /v1/usage`

| Field | Type | Notes |
| --- | --- | --- |
| `window` | object | `{ "start": string, "end": string }`, the current budget window |
| `credits` | object | `{ "limit": int, "used": int, "reserved": int, "remaining": int, "resets_at": string }` |
| `by_feature` | object | Credits used per `chat`, `transcription`, `ocr` |
| `requests` | integer | Requests in the window |

The app calls it once when the cloud panel opens and otherwise reads the credit headers. There is no polling.

### `POST /v1/chat/completions`

OpenAI-compatible, restricted to an allowlist.

| Field | Type | Req | Constraints |
| --- | --- | --- | --- |
| `model` | string | yes | A logical model id from `/v1/models`; rewritten server-side to the upstream id |
| `messages` | array | yes | Items `{ "role": "system" or "user" or "assistant", "content": string or array }`. Array parts: `{ "type": "text", "text": string }` or `{ "type": "image_url", "image_url": { "url": "data:image/(png|jpeg|webp);base64,..." } }`. Only `data:` URLs; `http(s)` URLs are refused |
| `stream` | boolean | no | Default false |
| `max_tokens` | integer | no | Clamped to the model's `max_output_tokens` |
| `temperature` | number | no | 0 to 2 |
| `top_p` | number | no | 0 to 1 |
| `stop` | string or array | no | Up to 4 entries |
| `response_format` | object | no | `{ "type": "json_object" }` or `{ "type": "json_schema", "json_schema": {..} }`, schema size capped |
| `reasoning_effort` | string | no | `low`, `medium`, `high`, if the model supports it |

Rejected: `tools`, `tool_choice`, `functions`, `function_call`, `n` other than 1, `logit_bias`, `user`, `stream_options`, and any unknown field. The gateway sets `user` (an HMAC pseudonym of the account) and `stream_options.include_usage` itself. Size limits (body, message count, image count and size) are enforced while the body streams in; exceeding any returns `payload_too_large`.

Non-streaming response `200`: an OpenAI-shaped chat completion (`id`, `object`, `created`, `model` set to the logical id, `choices`, `usage`) plus `X-StudentLLM-Credits-*` headers. The gateway adds no provider-identifying text to the body.

### Streaming (SSE)

With `stream: true` the response is `text/event-stream`. Normal chunks are unnamed `data:` events in the OpenAI chunk format, ending with `data: [DONE]`. The gateway adds two named events:

```text
event: usage
data: {"credits_charged": 42, "credits_remaining": 8123, "resets_at": "2026-12-01T00:00:00Z"}

event: error
data: {"error": {"code": "provider_unavailable", "message": "...", "request_id": "req_01J..."}}
```

- `usage` is sent once before `[DONE]` on success.
- A failure after the first byte cannot change the HTTP status. The gateway sends one `error` event with the standard envelope, then closes the stream without `[DONE]`. The client treats a stream that ends without `[DONE]` or an `error` event as a network failure. The gateway settles the request at the full reservation if no usage chunk was received.
- Failures before the first byte use the normal HTTP status and envelope.
- Plain OpenAI clients ignore named events they do not know.

### `POST /v1/audio/transcriptions`

`multipart/form-data`.

| Field | Type | Req | Constraints |
| --- | --- | --- | --- |
| `file` | file | yes | `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/webm`, `audio/ogg`, `audio/flac`; size cap (config, for example 25 MiB) and a duration cap (for example 30 minutes) computed on the server from the container, never from the client |
| `model` | string | yes | Logical transcription model |
| `language` | string | no | ISO 639-1 code |
| `response_format` | string | no | `json` or `verbose_json` (segments with timestamps); default `verbose_json` |

Response `200`: `{ "text": string, "language": string, "duration_seconds": number, "segments": [ { "start": number, "end": number, "text": string } ] }` plus credit headers. Errors: `payload_too_large` (size or duration), `unsupported_media_type`. A file whose duration cannot be determined is refused. No `prompt` field is accepted.

### `POST /v1/ocr`

`multipart/form-data`. The response schema is provisional until the OCR provider is chosen.

| Field | Type | Req | Constraints |
| --- | --- | --- | --- |
| `file` | file | yes | `image/png`, `image/jpeg`, `image/webp`; size and pixel-dimension caps checked on the server |
| `model` | string | yes | Logical OCR model |
| `language` | string | no | Hint |

Response `200`: `{ "text": string, "blocks": [ { "text": string, "bbox": [x0, y0, x1, y1] or null } ] }` plus credit headers. The credit estimate for images uses server-measured dimensions.

## Ops endpoint

### `GET /v1/status`

Unauthenticated or Bearer. Called only when the cloud panel opens (never in the background). Reads `X-StudentLLM-Client`.

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | `ok`, `degraded` or `maintenance` |
| `min_client_version` | string | Same as the `X-StudentLLM-Min-Client` header |
| `features` | object | `{ "chat": bool, "transcription": bool, "ocr": bool }`, reflecting kill switches |
| `server_time` | string | RFC 3339 |

A client below `min_client_version` gets `client_outdated` (426) on cloud routes and must stop using cloud until the user installs a newer build. There is no auto-update.

## Retries and idempotency

- `Idempotency-Key` is a client UUID, valid for 24 hours, required on `POST /v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/ocr`, `/v1/billing/checkout`, `/v1/consent` and `DELETE /v1/account`.
- The key is bound to the request id used for the credit reservation, so settlement is idempotent per request id and credits are never charged twice.
- Because the gateway stores no content, it cannot replay a stored answer. A retry with the same key while the first attempt is unsettled reuses its reservation. A retry after the first attempt settled is refused with `idempotency_conflict` and `details` giving the original `request_id` and `credits_charged`; the client must use a new key to regenerate (and pays for the new answer).
- Same key with a different body: `idempotency_conflict`.
- Clients retry only on network errors, `429`, and `503`, honoring `Retry-After`, with the same key.

## Notes for implementers

- The gateway never returns a stored request or answer; no route does.
- Gateway logs hold request id, account id, route, status, credits and latency only.
- Any change to this file that alters a route, field or code needs a matching change in [cloud-plan.md](./cloud-plan.md) when it changes a decision.
