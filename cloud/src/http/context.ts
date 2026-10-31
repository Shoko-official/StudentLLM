import type { BodyLimitKey } from "../config";
import type { Deps } from "../deps";
import type { AccountRecord, PlanRecord } from "../storage";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type BodySpec =
  | { kind: "none" }
  | { kind: "json"; limit: BodyLimitKey }
  | { kind: "multipart"; limit: BodyLimitKey };

/**
 * Declarative description of a route. It mirrors the OpenAPI operation (a test checks it) and tells the
 * pipeline which steps apply. Build it with `routeMeta()`.
 */
export interface RouteMeta {
  /** The `operationId` in docs/cloud-api.openapi.yaml. */
  readonly operationId: string;
  /**
   * `none`: `security: []`. `bearer`: access token. `bearer_or_manage`: also accepts an opaque `mt_`
   * manage token (the two device routes only).
   */
  readonly auth: "none" | "bearer" | "bearer_or_manage";
  /**
   * `exempt`: never returns or is blocked by `terms_required` / `account_suspended` (the data-rights
   * routes). Always `exempt` when `auth` is `none`.
   */
  readonly gate: "gated" | "exempt";
  /** Requires and checks `X-StudentLLM-Client` (content routes and `GET /v1/status`). */
  readonly client: boolean;
  /** POST content route: consent header, idempotency key, concurrency slot and budget reservation apply. */
  readonly content: boolean;
  /** `plan_required` applies (content routes need Plus). */
  readonly requiresPlus: boolean;
  /**
   * Requires `auth_time` within 5 minutes, otherwise `reauth_required`. Enforced by the built-in
   * `freshAuthStep` right after authentication, whatever the gating says.
   */
  readonly freshAuth: boolean;
  readonly body: BodySpec;
  /**
   * Which rate limit applies: per account (the inference module's `checkRateLimit`), per hashed connection
   * identifier (the auth module's `checkAuthRateLimit`), or none.
   */
  readonly rateLimit: "account" | "connection" | "none";
}

export type RouteMetaInput = Partial<Omit<RouteMeta, "operationId">> & Pick<RouteMeta, "operationId">;

/** Fills defaults: authenticated, gated, no body, per-account rate limit (per connection when unauthenticated). */
export function routeMeta(input: RouteMetaInput): RouteMeta {
  const auth = input.auth ?? "bearer";
  return {
    operationId: input.operationId,
    auth,
    gate: auth === "none" ? "exempt" : (input.gate ?? "gated"),
    client: input.client ?? false,
    content: input.content ?? false,
    requiresPlus: input.requiresPlus ?? input.content ?? false,
    freshAuth: input.freshAuth ?? false,
    body: input.body ?? { kind: "none" },
    rateLimit: input.rateLimit ?? (auth === "none" ? "connection" : "account"),
  };
}

/** Who made the request. Filled by the `authenticate` hook (TODO(owner: auth)). */
export type Principal =
  | {
      kind: "access";
      accountId: string;
      sessionId: string;
      deviceId: string;
      /** Seconds since epoch of the last fresh sign-in. */
      authTime: number;
      tokenId: string;
    }
  | { kind: "manage"; accountId: string; tokenHash: string };

export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Per-request scratch space that modules extend by declaration merging, so a module shares typed values
 * between its own hooks and handlers without editing a shared file:
 *
 *   declare module "../../http/context" {
 *     interface RequestLocals { reservationId?: string }
 *   }
 */
export interface RequestLocals {}

export interface BodyReader {
  /** Raw bytes, read once with the size limit enforced while the body streams in. */
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  /** Requires `application/json` (UTF-8); invalid UTF-8 or JSON is `invalid_request`. */
  json(): Promise<unknown>;
  /** Requires `multipart/form-data`; the size limit applies to the whole body while it streams. */
  formData(): Promise<FormData>;
}

export interface RequestContext {
  /**
   * The request WITHOUT its body: method, URL and headers only. Read the body through `ctx.body`, which
   * enforces the size limit and the Content-Type check while it streams in.
   */
  readonly request: Request;
  readonly url: URL;
  /** Server-generated; the client's own X-Request-Id is ignored. */
  readonly requestId: string;
  readonly pattern: string;
  readonly meta: RouteMeta;
  readonly params: Readonly<Record<string, string>>;
  readonly deps: Deps;
  readonly body: BodyReader;
  /** True when the route's handler is the `notImplemented` placeholder. */
  readonly isStub: boolean;
  /** Typed scratch space; see `RequestLocals`. */
  readonly locals: RequestLocals;
  client?: ClientInfo;
  principal?: Principal;
  /** Loaded once after authentication (built-in step); do not reload them in handlers or hooks. */
  account?: AccountRecord;
  plan?: PlanRecord | null;
  /** `X-StudentLLM-Consent` and `Idempotency-Key`, validated by the built-in content-header steps. */
  consentId?: string;
  idempotencyKey?: string;
  /**
   * Headers added to the final response unless the handler already set them: Plan-Version (set by the
   * built-in step), credit headers, RateLimit-*. Hooks and handlers call `.set()`.
   */
  readonly responseHeaders: Headers;
  /** Set by inference handlers for the request log (credits charged). */
  creditsCharged?: number;
  /** Registers cleanup that runs when the handler has returned (before a streamed body is read). */
  defer(fn: () => void | Promise<void>): void;
  /**
   * Registers cleanup that runs after the response body has been fully sent OR cancelled by the client
   * (for example releasing a concurrency slot of a streamed completion). Without a body it runs at once.
   * Runs at most once, and a failure in it is logged by name only.
   */
  deferUntilBodyDone(fn: () => void | Promise<void>): void;
  /** Keeps the Worker alive for background work after the response (`ExecutionContext.waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>;

/** A pipeline step. Return a Response to stop, throw `ApiError` to fail, return nothing to continue. */
export type Step = (ctx: RequestContext) => void | Response | Promise<void | Response>;

/** Handlers of authenticated routes call this first; it fails closed when no hook set a principal. */
export function requirePrincipal(ctx: RequestContext): Principal {
  if (!ctx.principal) throw new Error("authenticated route reached without a principal");
  return ctx.principal;
}
