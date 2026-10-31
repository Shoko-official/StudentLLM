// Auth module: Google and email sign-in, tokens, refresh, logout, JWKS.
// OWNER: auth. Provides the `authenticate` and `checkAuthRateLimit` pipeline hooks (see ./hooks.ts) from
// `createAuthHooks`. `authenticate` sets `ctx.principal` only; the account and plan are loaded afterwards by the
// built-in `accountContextStep` (once per request), and the fresh sign-in check by the built-in `freshAuthStep`.
// What this module needs from the environment is declared in ./config.ts.
//
// This file exports exactly the four functions every module exports (a test checks it); the work is in the
// files next to it: tokens.ts (JWT and JWKS), sessions.ts (refresh, logout), signin.ts (device slot and session),
// email-routes.ts, google-routes.ts, session-routes.ts, hooks.ts, google.ts, email.ts.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { REFRESH_GRACE_MS } from "./constants";
import { createAuthDeps as buildAuthDeps, type AuthDeps } from "./deps";
import { emailRequestHandler, emailVerifyHandler } from "./email-routes";
import { authCallbackHandler, authStartHandler, authTokenHandler } from "./google-routes";
import { createAuthHookSet } from "./hooks";
import { jwksHandler, logoutHandler, refreshHandler } from "./session-routes";

export type { AuthDeps } from "./deps";

/** Services the auth module needs beyond the core deps (signing keys, email sender, Google client). */
export function createAuthDeps(core: CoreDeps, overrides: Partial<AuthDeps> = {}): AuthDeps {
  return buildAuthDeps(core, overrides);
}

export function createAuthHooks(deps: Deps): Partial<PipelineHooks> {
  return createAuthHookSet(deps);
}

/** Cron work of this module (see src/scheduled.ts): expiry of challenges, sessions, grace copies and manage tokens. */
export function createAuthScheduledTasks(deps: Deps): ScheduledTask[] {
  return [
    {
      name: "auth-cleanup",
      async run() {
        const { authChallenges, sessions, devices, rateLimits } = deps.stores;
        const now = deps.clock.now();
        await sessions.clearExpiredGrace(now, REFRESH_GRACE_MS);
        await sessions.deleteExpired(now);
        await authChallenges.deleteExpired(now);
        await devices.deleteExpiredManageTokens(now);
        await rateLimits.deleteExpired(now);
        // Daily new-session counts are kept 30 days.
        await devices.pruneNewSessions(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
      },
    },
  ];
}

export function registerAuthRoutes(router: Router, deps: Deps): void {
  const json = { kind: "json", limit: "small" } as const;
  router.add("GET", "/auth/start", authStartHandler(deps), routeMeta({ operationId: "authStart", auth: "none" }));
  router.add("GET", "/auth/callback", authCallbackHandler(deps), routeMeta({ operationId: "authCallback", auth: "none" }));
  router.add("POST", "/auth/token", authTokenHandler(deps), routeMeta({ operationId: "authToken", auth: "none", body: json }));
  router.add("POST", "/auth/email/request", emailRequestHandler(deps), routeMeta({ operationId: "authEmailRequest", auth: "none", body: json }));
  router.add("POST", "/auth/email/verify", emailVerifyHandler(deps), routeMeta({ operationId: "authEmailVerify", auth: "none", body: json }));
  router.add("POST", "/auth/refresh", refreshHandler(deps), routeMeta({ operationId: "authRefresh", auth: "none", body: json }));
  router.add("POST", "/auth/logout", logoutHandler(deps), routeMeta({ operationId: "authLogout", auth: "none", body: json }));
  router.add("GET", "/.well-known/jwks.json", jwksHandler(deps), routeMeta({ operationId: "jwks", auth: "none", rateLimit: "none" }));
}
