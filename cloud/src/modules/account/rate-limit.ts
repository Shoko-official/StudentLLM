// The rate-limit window of the account routes.
//
// `routeMeta.rateLimit: "account"` would run the inference module's `checkRateLimit`, a sliding window per account
// that the chat, transcription and OCR routes spend. A user who exhausted that window with chat requests must still
// be able to delete the account, export the data, list and revoke devices or withdraw consent, so the account
// routes declare `rateLimit: "none"` in `registerAccountRoutes` and apply THIS window instead, under their own key
// (`acct:<id>:account-api`). It is generous: it only stops a loop.

import type { Deps } from "../../deps";
import { requirePrincipal, type Handler } from "../../http/context";
import { ApiError } from "../../http/envelope";

export const ACCOUNT_API_REQUESTS_PER_MINUTE = 60;

export function withAccountWindow(deps: Deps, handler: Handler): Handler {
  return async (ctx) => {
    const principal = requirePrincipal(ctx);
    const result = await deps.stores.rateLimits.hit(`acct:${principal.accountId}:account-api`, ACCOUNT_API_REQUESTS_PER_MINUTE, 60_000, deps.clock.now());
    if (!result.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds ?? 1 });
    ctx.responseHeaders.set("RateLimit-Limit", String(result.limit));
    ctx.responseHeaders.set("RateLimit-Remaining", String(result.remaining));
    ctx.responseHeaders.set("RateLimit-Reset", String(result.resetAfterSeconds));
    return handler(ctx);
  };
}
