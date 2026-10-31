import type { ErrorCode, ErrorEnvelope, DeviceLimitResponse } from "../types";

/**
 * HTTP status of every error code. Source: the error table in docs/cloud-api.md; a test checks the key set
 * against the `ErrorCode` enum of the OpenAPI file and the statuses against that table.
 */
export const ERROR_STATUS = {
  budget_exhausted: 429,
  rate_limited: 429,
  concurrency_limit: 429,
  payload_too_large: 413,
  plan_required: 403,
  account_suspended: 403,
  insufficient_scope: 403,
  terms_required: 403,
  consent_outdated: 409,
  idempotency_conflict: 409,
  identity_conflict: 409,
  device_limit_reached: 409,
  already_subscribed: 409,
  session_revoked: 401,
  refresh_reuse: 401,
  invalid_token: 401,
  reauth_required: 401,
  provider_unavailable: 503,
  kill_switch: 503,
  invalid_request: 400,
  invalid_code: 400,
  unsupported_media_type: 415,
  not_found: 404,
  client_outdated: 426,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>;

/** English, short, never containing content, secrets or provider text. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  budget_exhausted: "The credit budget is used up.",
  rate_limited: "Too many requests. Try again later.",
  concurrency_limit: "Too many concurrent requests. Try again shortly.",
  payload_too_large: "The request is too large.",
  plan_required: "This feature needs a Plus plan.",
  account_suspended: "This account is suspended.",
  insufficient_scope: "This token cannot be used for this route.",
  terms_required: "The current terms must be accepted first.",
  consent_outdated: "Consent for this provider set is missing, withdrawn or outdated.",
  idempotency_conflict: "This idempotency key was already used.",
  identity_conflict: "This sign-in identity conflicts with an existing account.",
  device_limit_reached: "This account already has 3 devices. Revoke one to continue.",
  already_subscribed: "An active plan already exists.",
  session_revoked: "The session is no longer valid.",
  refresh_reuse: "The refresh token was already used. Sign in again.",
  invalid_token: "The access token is missing, malformed, expired or invalid.",
  reauth_required: "A fresh sign-in is required.",
  provider_unavailable: "The provider is unavailable.",
  kill_switch: "This feature is temporarily disabled.",
  invalid_request: "The request is invalid.",
  invalid_code: "The code is invalid or expired.",
  unsupported_media_type: "This media type is not supported.",
  not_found: "Not found.",
  client_outdated: "This version of the app is too old for cloud features.",
  internal_error: "Internal error.",
};

/** Keys that must never appear in `error.details` (same list as scripts/validate-cloud-contract.py). */
export const FORBIDDEN_DETAIL_KEYS = ["manage_token", "refresh_token", "access_token", "code", "code_verifier"] as const;

export type ErrorDetails = Record<string, unknown>;

export interface ErrorOptions {
  message?: string;
  retryAfterSeconds?: number;
  details?: ErrorDetails;
  /** Extra response headers, for example X-StudentLLM-Min-Client. */
  headers?: Record<string, string>;
}

/** Throw this from a step or a handler; the app turns it into the contract's error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly options: ErrorOptions;

  constructor(code: ErrorCode, options: ErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = "ApiError";
    this.code = code;
    this.options = options;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function statusForCode(errorCode: ErrorCode): number {
  return ERROR_STATUS[errorCode];
}

function assertSafeDetails(details: ErrorDetails | undefined): void {
  if (!details) return;
  for (const key of Object.keys(details)) {
    if ((FORBIDDEN_DETAIL_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`error.details must not carry "${key}"`);
    }
  }
}

export function buildEnvelope(errorCode: ErrorCode, requestId: string, options: ErrorOptions = {}): ErrorEnvelope {
  assertSafeDetails(options.details);
  const error: ErrorEnvelope["error"] = {
    code: errorCode,
    message: options.message ?? DEFAULT_MESSAGES[errorCode],
    request_id: requestId,
  };
  if (options.retryAfterSeconds !== undefined) error.retry_after_seconds = options.retryAfterSeconds;
  if (options.details !== undefined) error.details = options.details;
  return { error };
}

function baseHeaders(requestId: string, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);
  return headers;
}

/** The one error response: envelope body, contract status, `X-Request-Id`, and `Retry-After` when set. */
export function errorResponse(errorCode: ErrorCode, requestId: string, options: ErrorOptions = {}): Response {
  const headers = baseHeaders(requestId, options.headers);
  if (options.retryAfterSeconds !== undefined) headers.set("Retry-After", String(options.retryAfterSeconds));
  return new Response(JSON.stringify(buildEnvelope(errorCode, requestId, options)), {
    status: ERROR_STATUS[errorCode],
    headers,
  });
}

/** Converts anything thrown into an envelope. Unknown errors become `internal_error` with no detail. */
export function errorResponseFrom(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) return errorResponse(error.code, requestId, error.options);
  return errorResponse("internal_error", requestId);
}

/**
 * Stub response for routes that exist in the contract but are not built yet. The contract has no
 * `not_implemented` code, so this reuses `internal_error` with HTTP 501. It is the only response that
 * deviates from ERROR_STATUS, and it disappears as modules replace their stubs.
 */
export function notImplementedResponse(requestId: string): Response {
  return new Response(
    JSON.stringify(buildEnvelope("internal_error", requestId, { message: "This endpoint is not implemented yet." })),
    { status: 501, headers: baseHeaders(requestId) },
  );
}

export function jsonResponse(body: unknown, requestId: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: baseHeaders(requestId, init.headers),
  });
}

/**
 * `DeviceLimitResponse` (409 of /auth/email/verify). The manage token lives in its own schema, never in
 * `error.details`, and must never be logged.
 */
export function deviceLimitResponse(requestId: string, manageToken: string): Response {
  const body: DeviceLimitResponse = {
    error: { code: "device_limit_reached", message: DEFAULT_MESSAGES.device_limit_reached, request_id: requestId },
    manage_token: manageToken,
    manage_token_expires_in: 300,
  };
  return jsonResponse(body, requestId, { status: ERROR_STATUS.device_limit_reached });
}

/** One SSE `event: error` frame carrying the standard envelope (a failure after the first byte). */
export function sseErrorEvent(errorCode: ErrorCode, requestId: string, options: ErrorOptions = {}): string {
  return `event: error\ndata: ${JSON.stringify(buildEnvelope(errorCode, requestId, options))}\n\n`;
}
