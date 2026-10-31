// Plan writes that do not come from a Paddle event (a cancellation the seam confirmed, a retry bookkeeping
// update) and the reconciliation of the ledger windows with the plan.

import type { PlanRecord } from "../../storage";
import type { BillingEnv } from "./env";
import { kindOf } from "./windows";

const MAX_ATTEMPTS = 6;

/**
 * Read-modify-write of the plan with compare-and-set on the plan version, retried on a concurrent change.
 * `mutate` returns the new plan, or null for "no change". Returns the plan after the call, or null when the
 * account or its plan does not exist. Keeps `lastEventAt`, so it never disturbs the ordering of Paddle events.
 */
export async function updatePlan(env: BillingEnv, accountId: string, mutate: (plan: PlanRecord) => PlanRecord | null): Promise<PlanRecord | null> {
  const { accounts } = env.stores;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const account = await accounts.getById(accountId);
    const plan = await accounts.getPlan(accountId);
    if (!account || !plan) return null;
    const next = mutate(plan);
    if (next === null) return plan;
    const saved = await accounts.savePlan({ ...next, lastEventAt: plan.lastEventAt }, { expectedPlanVersion: account.planVersion });
    if (saved.ok) return next;
    if (saved.reason === "not_found") return null;
  }
  throw new Error("plan update kept conflicting");
}

/**
 * Makes the ledger windows match the plan, idempotently (every call converges to the same state):
 * - a live period without a window gets one, with the plan's budget for its kind;
 * - a window longer than its (truncated) period is cut at the period's end;
 * - a window whose period was revoked is revoked;
 * - COMPLIMENTARY GROUNDWORK: a complimentary (`admin_grant`) window that overlaps a live paid period is cut where the
 *   paid period begins (removed when it starts inside it): a purchase cuts the grant, and budgets never stack.
 * It touches paid windows only by exact start, grant windows only to cut them, and never resets used credits. Safe to
 * run after every event, after a replay, from the lazy check in `checkPlan` and from tests.
 */
export async function syncWindows(env: BillingEnv, accountId: string, plan: PlanRecord): Promise<void> {
  const { ledger } = env.stores;
  // Paid periods take precedence over complimentary windows. Cut first, so a freed start can hold the paid window.
  let all = await ledger.listWindows(accountId);
  let cut = false;
  for (const period of plan.paidPeriods) {
    if (period.revokedAt !== undefined) continue;
    for (const grant of all) {
      if (grant.source !== "admin_grant" || grant.revokedAt !== null) continue;
      if (grant.start < period.end && grant.end > period.start) {
        await ledger.truncateWindows(accountId, period.start, { source: "admin_grant", start: grant.start });
        cut = true;
      }
    }
  }
  if (cut) all = await ledger.listWindows(accountId);
  const existing = new Map(all.filter((w) => w.source === "paddle").map((w) => [w.start, w]));
  for (const period of plan.paidPeriods) {
    const window = existing.get(period.start);
    if (period.revokedAt !== undefined) {
      if (window && window.revokedAt === null) await ledger.revokeWindows(accountId, period.revokedAt, { source: "paddle", start: period.start });
      continue;
    }
    if (!window) {
      const limit = env.settings.windowCredits[kindOf(period) === "pass" ? "plus_semester" : "plus_monthly"];
      await ledger.ensureWindow(accountId, { start: period.start, end: period.end, limit, source: "paddle" });
    } else if (window.revokedAt === null && window.end > period.end) {
      await ledger.truncateWindows(accountId, period.end, { source: "paddle", start: period.start });
    }
  }
}
