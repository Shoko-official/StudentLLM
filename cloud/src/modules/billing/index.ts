// Billing module: Paddle checkout, customer portal, webhook receiver, the plan and window model, the
// `checkPlan` hook, and the `BillingSeam` (cancel a subscription) that the account deletion flow uses.
// OWNER: billing. Everything except these four functions and the types lives in sibling files, so the layout test
// (src/modules/modules.test.ts) keeps seeing the same exports as the other modules.
//
// Callers use the seam through `deps.billing.cancelSubscription(accountId, when)`.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import type { BillingSeam } from "../seams";
import { cancelSubscription } from "./cancel";
import { handleCheckout, handlePortal } from "./checkout";
import { envFromCore } from "./env";
import { checkPlan } from "./hooks";
import { defaultNotifier, type BillingNotifier } from "./notifier";
import { createHttpPaddleClient, type PaddleClient } from "./paddle-client";
import { assertApiKeyMatchesEnvironment, loadBillingSettings, type BillingSettings } from "./settings";
import { billingScheduledTasks } from "./tasks";
import { handlePaddleWebhook } from "./webhook";

export interface BillingDeps extends BillingSeam {
  readonly settings: BillingSettings;
  /** The outbound Paddle API. Tests inject a fake; nothing in the gateway talks to Paddle any other way. */
  readonly paddle: PaddleClient;
  readonly notifier: BillingNotifier;
}

/** What a test (or a different deployment) can replace. */
export interface BillingOverrides {
  paddle?: PaddleClient;
  notifier?: BillingNotifier;
  settings?: Partial<BillingSettings>;
}

export function createBillingDeps(core: CoreDeps, overrides: BillingOverrides = {}): BillingDeps {
  const settings = loadBillingSettings(core.config, overrides.settings);
  // Sandbox and live are never mixed: a key of the other environment stops the Worker at start, not at the first call.
  if (core.config.hasSecret("PADDLE_API_KEY")) assertApiKeyMatchesEnvironment(core.config.secret("PADDLE_API_KEY").reveal(), settings.environment);
  const paddle =
    overrides.paddle ??
    createHttpPaddleClient({
      fetch: core.fetch,
      environment: settings.environment,
      apiKey: () => core.config.secret("PADDLE_API_KEY").reveal(),
    });
  const notifier = overrides.notifier ?? defaultNotifier;
  const env = envFromCore(core, { settings, paddle, notifier });
  return {
    settings,
    paddle,
    notifier,
    cancelSubscription: (accountId, when) => cancelSubscription(env, accountId, when),
  };
}

export function createBillingHooks(_deps: Deps): Partial<PipelineHooks> {
  return { checkPlan };
}

/** Cron work of this module (see src/scheduled.ts). */
export function createBillingScheduledTasks(deps: Deps): ScheduledTask[] {
  return billingScheduledTasks(deps);
}

export function registerBillingRoutes(router: Router, _deps: Deps): void {
  router.add("POST", "/v1/billing/checkout", handleCheckout, routeMeta({ operationId: "createCheckout", body: { kind: "json", limit: "small" } }));
  router.add("GET", "/v1/billing/portal", handlePortal, routeMeta({ operationId: "getPortal", gate: "exempt" }));
  router.add(
    "POST",
    "/webhooks/paddle",
    handlePaddleWebhook,
    routeMeta({ operationId: "paddleWebhook", auth: "none", rateLimit: "none", body: { kind: "json", limit: "webhook" } }),
  );
}
