// The `checkPlan` pipeline hook (step 4 of the order of checks): `plan_required` for a content route when the
// account has no running budget window.
//
// Entitlement is "a window that is not revoked contains now", because the window is what the budget is drawn
// from: a monthly period, a pass month, a past-due subscription's last paid window (it runs to its end), a
// canceled subscription's remaining paid period, and a complimentary grant all qualify; a free account, a lapsed
// plan, a refund and a chargeback do not. This is the check by the clock, so a plan that lapsed at its period
// end stops at that instant without waiting for any webhook.

import type { Step } from "../../http/context";
import { ApiError } from "../../http/envelope";
import { envFromDeps } from "./env";
import { syncWindows } from "./plan-store";
import { periodAt } from "./windows";

export const checkPlan: Step = async (ctx) => {
  const accountId = ctx.principal?.accountId;
  if (!accountId) {
    if (ctx.isStub) return; // a route nobody has implemented yet has no principal to check
    throw new Error("checkPlan reached without a principal"); // fail closed
  }
  const env = envFromDeps(ctx.deps);
  const now = env.clock.now();
  const { ledger } = env.stores;

  if (await ledger.getCurrentWindow(accountId, now)) return;

  // The plan says a paid period is running but its window is missing: a crash between the plan write and the
  // window write, or a window that was never created. Repair it (idempotent) instead of refusing a paying user.
  const plan = ctx.plan ?? null;
  if (plan && periodAt(plan.paidPeriods, now)) {
    await syncWindows(env, accountId, plan);
    if (await ledger.getCurrentWindow(accountId, now)) return;
  }
  throw new ApiError("plan_required");
};
