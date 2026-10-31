// Account module: account, export, deletion, terms, devices, login-method linking, provider sets, consent.
// OWNER: auth/account. Provides the `checkTermsAndStatus` pipeline hook from `createAccountHooks`.
//
// This file exports exactly the four functions every module exports (a test checks it); the work is in the
// files next to it: account-routes.ts, devices.ts, link.ts, consent.ts, deletion.ts, hooks.ts, seams.ts,
// provider-sets.ts.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta, type Handler } from "../../http/context";
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
import { withAccountWindow } from "./rate-limit";

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
  // The rate-limit window is a decision, not a default. `rateLimit: "account"` would run the inference module's
  // per-account window, which chat requests spend; delete, export, devices and consent must not be throttled by
  // an exhausted chat window. So every account route opts out of that hook (`rateLimit: "none"`) and its handler
  // is wrapped in the account module's own window (`withAccountWindow`, key `acct:<id>:account-api`).
  const own = { rateLimit: "none" } as const;
  const limited = (handler: Handler): Handler => withAccountWindow(deps, handler);
  router.add("GET", "/v1/devices", limited(listDevicesHandler(deps)), routeMeta({ operationId: "listDevices", ...deviceAuth, ...own }));
  router.add("DELETE", "/v1/devices/{device_id}", limited(revokeDeviceHandler(deps)), routeMeta({ operationId: "revokeDevice", ...deviceAuth, ...own }));
  router.add("GET", "/v1/account", limited(getAccountHandler(deps)), routeMeta({ operationId: "getAccount", ...exempt, ...own }));
  router.add("DELETE", "/v1/account", limited(deleteAccountHandler(deps)), routeMeta({ operationId: "deleteAccount", ...exempt, ...own, freshAuth: true }));
  router.add("GET", "/v1/account/export", limited(exportAccountHandler(deps)), routeMeta({ operationId: "exportAccount", ...exempt, ...own, freshAuth: true }));
  router.add("POST", "/v1/account/terms", limited(acceptTermsHandler(deps)), routeMeta({ operationId: "acceptTerms", ...exempt, ...own, body: json }));
  router.add("POST", "/v1/account/link", limited(linkLoginMethodHandler(deps)), routeMeta({ operationId: "linkLoginMethod", ...own, freshAuth: true, body: json }));
  router.add("DELETE", "/v1/account/login-methods/{method}", limited(unlinkLoginMethodHandler(deps)), routeMeta({ operationId: "unlinkLoginMethod", ...own, freshAuth: true }));
  router.add("GET", "/v1/provider-sets", limited(listProviderSetsHandler(deps)), routeMeta({ operationId: "listProviderSets", ...own }));
  // Exempt from the gating so that a withdrawal always works; the handler gates a grant itself (see hooks.ts).
  router.add("POST", "/v1/consent", limited(recordConsentHandler(deps)), routeMeta({ operationId: "recordConsent", ...exempt, ...own, body: json }));
}
