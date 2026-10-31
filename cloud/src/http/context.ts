import type { BodyLimitKey } from "../config";
import type { Deps } from "../deps";

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
  /** Requires `auth_time` within 5 minutes, otherwise `reauth_required`. */
  readonly freshAuth: boolean;
  readonly body: BodySpec;
  /** Which rate limit applies: per account, per hashed connection identifier, or none. */
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

export interface BodyReader {
  /** Raw bytes, read once with the size limit enforced while the body streams in. */
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  /** Requires `application/json`; invalid UTF-8 or JSON is `invalid_request`. */
  json(): Promise<unknown>;
  /** Requires `multipart/form-data`; the size limit applies to the whole body while it streams. */
  formData(): Promise<FormData>;
}

export interface RequestContext {
  readonly request: Request;
  readonly url: URL;
  /** Server-generated; the client's own X-Request-Id is ignored. */
  readonly requestId: string;
  readonly pattern: string;
  readonly meta: RouteMeta;
  readonly params: Readonly<Record<string, string>>;
  readonly deps: Deps;
  readonly body: BodyReader;
  client?: ClientInfo;
  principal?: Principal;
  /** Set by inference handlers for the request log (credits charged). */
  creditsCharged?: number;
  /** Registers cleanup (for example releasing a concurrency slot) that runs when the handler has returned. */
  defer(fn: () => void | Promise<void>): void;
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>;

/** A pipeline step. Return a Response to stop, throw `ApiError` to fail, return nothing to continue. */
export type Step = (ctx: RequestContext) => void | Response | Promise<void | Response>;

/** Handlers of authenticated routes call this first; it fails closed when no hook set a principal. */
export function requirePrincipal(ctx: RequestContext): Principal {
  if (!ctx.principal) throw new Error("authenticated route reached without a principal");
  return ctx.principal;
}
