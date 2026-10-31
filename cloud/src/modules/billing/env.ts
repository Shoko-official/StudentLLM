// What the billing functions need, as one small object: stores, clock and the billing services. The seam is built
// from CoreDeps (before the full Deps exist); routes, hooks and tasks build it from Deps. Same shape either way.

import type { Clock, CoreDeps, Deps } from "../../deps";
import type { Stores } from "../../storage";
import type { BillingNotifier } from "./notifier";
import type { PaddleClient } from "./paddle-client";
import type { BillingSettings } from "./settings";

export interface BillingEnv {
  stores: Stores;
  clock: Clock;
  settings: BillingSettings;
  paddle: PaddleClient;
  notifier: BillingNotifier;
}

export function envFromDeps(deps: Deps): BillingEnv {
  return { stores: deps.stores, clock: deps.clock, settings: deps.billing.settings, paddle: deps.billing.paddle, notifier: deps.billing.notifier };
}

export function envFromCore(core: Pick<CoreDeps, "stores" | "clock">, parts: Pick<BillingEnv, "settings" | "paddle" | "notifier">): BillingEnv {
  return { stores: core.stores, clock: core.clock, ...parts };
}
