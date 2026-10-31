// Auth module: Google and email sign-in, tokens, refresh, logout, JWKS.
// OWNER: auth. Replace the stubs below with real handlers; keep the route meta aligned with the OpenAPI file.
// Also provide the `authenticate` pipeline hook (see ../../http/pipeline.ts) from `createAuthHooks`.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import { notImplemented } from "../../http/stub";

/** Services the auth module needs beyond the core deps (JWT signer, email sender, Google client...). */
export interface AuthDeps {}

export function createAuthDeps(_core: CoreDeps): AuthDeps {
  return {};
}

export function createAuthHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

export function registerAuthRoutes(router: Router, _deps: Deps): void {
  const json = { kind: "json", limit: "small" } as const;
  router.add("GET", "/auth/start", notImplemented, routeMeta({ operationId: "authStart", auth: "none" }));
  router.add("GET", "/auth/callback", notImplemented, routeMeta({ operationId: "authCallback", auth: "none" }));
  router.add("POST", "/auth/token", notImplemented, routeMeta({ operationId: "authToken", auth: "none", body: json }));
  router.add("POST", "/auth/email/request", notImplemented, routeMeta({ operationId: "authEmailRequest", auth: "none", body: json }));
  router.add("POST", "/auth/email/verify", notImplemented, routeMeta({ operationId: "authEmailVerify", auth: "none", body: json }));
  router.add("POST", "/auth/refresh", notImplemented, routeMeta({ operationId: "authRefresh", auth: "none", body: json }));
  router.add("POST", "/auth/logout", notImplemented, routeMeta({ operationId: "authLogout", auth: "none", body: json }));
  router.add("GET", "/.well-known/jwks.json", notImplemented, routeMeta({ operationId: "jwks", auth: "none", rateLimit: "none" }));
}
