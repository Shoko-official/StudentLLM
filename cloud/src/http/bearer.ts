import type { RouteMeta } from "./context";
import { ApiError } from "./envelope";

export type BearerKind = "manage" | "access";

/** Extracts the token of `Authorization: Bearer <token>`, or null when absent or malformed. */
export function parseBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header);
  return m ? m[1]! : null;
}

/**
 * The gateway tells a manage token from an access token by the `mt_` prefix, checked first. A token
 * without that prefix is parsed as a JWT by the auth module (a malformed one gets `invalid_token`).
 */
export function classifyBearer(token: string): BearerKind {
  return token.startsWith("mt_") ? "manage" : "access";
}

/** An `mt_` token on any route other than the two device routes gets `insufficient_scope` (403). */
export function assertTokenScope(kind: BearerKind, meta: RouteMeta): void {
  if (kind === "manage" && meta.auth !== "bearer_or_manage") throw new ApiError("insufficient_scope");
}
