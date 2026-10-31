// The pipeline hooks of the auth module: `authenticate` (access token or manage token) and
// `checkAuthRateLimit` (the per-connection window of the unauthenticated routes).

import type { Deps } from "../../deps";
import { assertTokenScope, classifyBearer, parseBearer } from "../../http/bearer";
import type { Step } from "../../http/context";
import { ApiError } from "../../http/envelope";
import type { PipelineHooks } from "../../http/pipeline";
import { rotatingKeyedHash } from "../../crypto/keyed-hash";
import { tokenHash } from "./codes";
import { CONNECTION_REQUESTS_PER_MINUTE, MINUTE_MS } from "./constants";
import { verifyAccessToken } from "./tokens";

/**
 * Verifies `Authorization: Bearer` and sets `ctx.principal`. The built-in steps that follow load the account and
 * plan once. Order, as the contract has it:
 *   - no bearer token: `invalid_token`;
 *   - an `mt_` token is a manage token and is checked first: on any route other than the two device routes it is
 *     `insufficient_scope`, whether or not it is a real token (nothing about it is looked up);
 *   - anything else is parsed as a JWT with the algorithm pinned to EdDSA: a bad one is `invalid_token`;
 *   - the session must exist, belong to the account and device in the token, not be revoked or expired, and its
 *     device must still be registered: otherwise `session_revoked` (a revocation applies to the very next request).
 */
export function authenticateStep(deps: Deps): Step {
  return async (ctx) => {
    const token = parseBearer(ctx.request);
    if (token === null) throw new ApiError("invalid_token");
    const now = deps.clock.now();
    const kind = classifyBearer(token);
    assertTokenScope(kind, ctx.meta);

    if (kind === "manage") {
      const hash = await tokenHash(token);
      const record = await deps.stores.devices.getManageToken(hash, now);
      if (!record) throw new ApiError("invalid_token");
      await deps.stores.devices.recordManageTokenUse(hash);
      ctx.principal = { kind: "manage", accountId: record.accountId, tokenHash: hash };
      return;
    }

    const keys = await deps.auth.keys();
    const claims = await verifyAccessToken(keys, token, {
      issuer: deps.config.issuer,
      audience: deps.config.audience,
      nowSeconds: Math.floor(now / 1000),
    });
    if (!claims) throw new ApiError("invalid_token");
    const session = await deps.stores.sessions.getByFamily(claims.sid);
    if (
      !session ||
      session.revokedAt !== null ||
      session.accountId !== claims.sub ||
      session.deviceId !== claims.did ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      !(await deps.stores.devices.isActive(claims.sub, claims.did))
    ) {
      throw new ApiError("session_revoked");
    }
    ctx.principal = {
      kind: "access",
      accountId: claims.sub,
      sessionId: claims.sid,
      deviceId: claims.did,
      authTime: claims.auth_time,
      tokenId: claims.jti,
    };
  };
}

/** The connection address as the platform reports it. Only ever hashed; never stored or logged. */
export function connectionAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/** A purpose-separated, rotating-salt hash of the connection address. */
export async function connectionKey(deps: Deps, request: Request, purpose: string, now: number) {
  const salt = deps.config.secret("RATE_LIMIT_SALT_KEY").reveal();
  return (await rotatingKeyedHash(salt, purpose, connectionAddress(request), now)).hash;
}

/** A purpose-separated, rotating-salt hash of any other value (a normalized email address). */
export async function valueKey(deps: Deps, purpose: string, value: string, now: number) {
  const salt = deps.config.secret("RATE_LIMIT_SALT_KEY").reveal();
  return (await rotatingKeyedHash(salt, purpose, value, now)).hash;
}

/** Throws `rate_limited` with `Retry-After` when the window is full; otherwise sets the `RateLimit-*` headers. */
export function checkAuthRateLimitStep(deps: Deps): Step {
  return async (ctx) => {
    const now = deps.clock.now();
    // One window per route and connection, so a noisy refresh loop cannot starve a sign-in.
    const key = await connectionKey(deps, ctx.request, `conn-${ctx.meta.operationId.toLowerCase()}`, now);
    const result = await deps.stores.rateLimits.hit(key, CONNECTION_REQUESTS_PER_MINUTE, MINUTE_MS, now);
    if (!result.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds ?? 1 });
    ctx.responseHeaders.set("RateLimit-Limit", String(result.limit));
    ctx.responseHeaders.set("RateLimit-Remaining", String(result.remaining));
    ctx.responseHeaders.set("RateLimit-Reset", String(result.resetAfterSeconds));
  };
}

export function createAuthHookSet(deps: Deps): Partial<PipelineHooks> {
  return { authenticate: authenticateStep(deps), checkAuthRateLimit: checkAuthRateLimitStep(deps) };
}
