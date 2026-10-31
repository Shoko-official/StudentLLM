// Account module: account, export, deletion, terms, devices, login-method linking, provider sets, consent.
// OWNER: auth/account. Provides the `checkTermsAndStatus` pipeline hook from `createAccountHooks`.
//
// This file exports exactly the four functions every module exports (a test checks it); the work is in the
// files next to it: account-routes.ts, devices.ts, link.ts, consent.ts, deletion.ts, hooks.ts, seams.ts,
// provider-sets.ts.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { acceptTermsHandler, deleteAccountHandler, exportAccountHandler, getAccountHandler } from "./account-routes";
import { listProviderSetsHandler, recordConsentHandler } from "./consent";
import { createAccountDeps as buildAccountDeps, type AccountDeps } from "./deps";
import { createDeletionRetryTask } from "./deletion";
import { listDevicesHandler, revokeDeviceHandler } from "./devices";
import { checkTermsAndStatusStep } from "./hooks";
import { linkLoginMethodHandler, unlinkLoginMethodHandler } from "./link";

export type { AccountDeps } from "./deps";

export function createAccountDeps(core: CoreDeps, overrides: Partial<AccountDeps> = {}): AccountDeps {
  return buildAccountDeps(core, overrides);
}

export function createAccountHooks(deps: Deps): Partial<PipelineHooks> {
  return { checkTermsAndStatus: checkTermsAndStatusStep(deps) };
}

/** Cron work of this module (see src/scheduled.ts): the account-deletion retry job. */
export function createAccountScheduledTasks(deps: Deps): ScheduledTask[] {
  return [createDeletionRetryTask(deps)];
}

export function registerAccountRoutes(router: Router, deps: Deps): void {
  const json = { kind: "json", limit: "small" } as const;
  // Data-rights routes are exempt from terms_required / account_suspended.
  const exempt = { gate: "exempt" } as const;
  const deviceAuth = { auth: "bearer_or_manage", ...exempt } as const;
  router.add("GET", "/v1/devices", listDevicesHandler(deps), routeMeta({ operationId: "listDevices", ...deviceAuth }));
  router.add("DELETE", "/v1/devices/{device_id}", revokeDeviceHandler(deps), routeMeta({ operationId: "revokeDevice", ...deviceAuth }));
  router.add("GET", "/v1/account", getAccountHandler(deps), routeMeta({ operationId: "getAccount", ...exempt }));
  router.add("DELETE", "/v1/account", deleteAccountHandler(deps), routeMeta({ operationId: "deleteAccount", ...exempt, freshAuth: true }));
  router.add("GET", "/v1/account/export", exportAccountHandler(deps), routeMeta({ operationId: "exportAccount", ...exempt, freshAuth: true }));
  router.add("POST", "/v1/account/terms", acceptTermsHandler(deps), routeMeta({ operationId: "acceptTerms", ...exempt, body: json }));
  router.add("POST", "/v1/account/link", linkLoginMethodHandler(deps), routeMeta({ operationId: "linkLoginMethod", freshAuth: true, body: json }));
  router.add("DELETE", "/v1/account/login-methods/{method}", unlinkLoginMethodHandler(deps), routeMeta({ operationId: "unlinkLoginMethod", freshAuth: true }));
  router.add("GET", "/v1/provider-sets", listProviderSetsHandler(deps), routeMeta({ operationId: "listProviderSets" }));
  router.add("POST", "/v1/consent", recordConsentHandler(deps), routeMeta({ operationId: "recordConsent", body: json }));
}
