// Account module: account, export, deletion, terms, devices, login-method linking, provider sets, consent.
// OWNER: auth/account. Also provide the `checkTermsAndStatus` pipeline hook from `createAccountHooks`.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { notImplemented } from "../../http/stub";

export interface AccountDeps {}

export function createAccountDeps(_core: CoreDeps): AccountDeps {
  return {};
}

export function createAccountHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

/** Cron work of this module (see src/scheduled.ts). */
export function createAccountScheduledTasks(_deps: Deps): ScheduledTask[] {
  return [];
}

export function registerAccountRoutes(router: Router, _deps: Deps): void {
  const json = { kind: "json", limit: "small" } as const;
  // Data-rights routes are exempt from terms_required / account_suspended.
  const exempt = { gate: "exempt" } as const;
  const deviceAuth = { auth: "bearer_or_manage", ...exempt } as const;
  router.add("GET", "/v1/devices", notImplemented, routeMeta({ operationId: "listDevices", ...deviceAuth }));
  router.add("DELETE", "/v1/devices/{device_id}", notImplemented, routeMeta({ operationId: "revokeDevice", ...deviceAuth }));
  router.add("GET", "/v1/account", notImplemented, routeMeta({ operationId: "getAccount", ...exempt }));
  router.add("DELETE", "/v1/account", notImplemented, routeMeta({ operationId: "deleteAccount", ...exempt, freshAuth: true }));
  router.add("GET", "/v1/account/export", notImplemented, routeMeta({ operationId: "exportAccount", ...exempt, freshAuth: true }));
  router.add("POST", "/v1/account/terms", notImplemented, routeMeta({ operationId: "acceptTerms", ...exempt, body: json }));
  router.add("POST", "/v1/account/link", notImplemented, routeMeta({ operationId: "linkLoginMethod", freshAuth: true, body: json }));
  router.add("DELETE", "/v1/account/login-methods/{method}", notImplemented, routeMeta({ operationId: "unlinkLoginMethod", freshAuth: true }));
  router.add("GET", "/v1/provider-sets", notImplemented, routeMeta({ operationId: "listProviderSets" }));
  router.add("POST", "/v1/consent", notImplemented, routeMeta({ operationId: "recordConsent", body: json }));
}
