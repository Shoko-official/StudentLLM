// Billing module: Paddle checkout, customer portal, webhook receiver.
// OWNER: billing. Also provide the `checkPlan` pipeline hook from `createBillingHooks`.
// The webhook route verifies the HMAC over the raw bytes (`ctx.body.bytes()`) before parsing anything.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { notImplemented } from "../../http/stub";

export interface BillingDeps {}

export function createBillingDeps(_core: CoreDeps): BillingDeps {
  return {};
}

export function createBillingHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

/** Cron work of this module (see src/scheduled.ts). */
export function createBillingScheduledTasks(_deps: Deps): ScheduledTask[] {
  return [];
}

export function registerBillingRoutes(router: Router, _deps: Deps): void {
  router.add(
    "POST",
    "/v1/billing/checkout",
    notImplemented,
    routeMeta({ operationId: "createCheckout", body: { kind: "json", limit: "small" } }),
  );
  router.add("GET", "/v1/billing/portal", notImplemented, routeMeta({ operationId: "getPortal", gate: "exempt" }));
  router.add(
    "POST",
    "/webhooks/paddle",
    notImplemented,
    routeMeta({ operationId: "paddleWebhook", auth: "none", rateLimit: "none", body: { kind: "json", limit: "webhook" } }),
  );
}
