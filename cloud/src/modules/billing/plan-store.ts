// Plan writes that do not come from a Paddle event (a cancellation the seam confirmed, a retry bookkeeping
// update) and the reconciliation of the ledger windows with the plan.

import type { PlanRecord } from "../../storage";
import type { BillingEnv } from "./env";
import type { GrantCut } from "./notifier";
import { emptyPlan } from "./plan-model";
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
 * Stores the Paddle customer id of an account that has none yet (checkout creates the customer on the server before
 * the first payment, so the first event can be checked against it). Creates the plan row when there is none. If a
 * customer id was stored meanwhile (a parallel checkout), that one wins and is returned.
 */
export async function ensureCustomerOnPlan(env: BillingEnv, accountId: string, customerId: string): Promise<string | null> {
  const { accounts } = env.stores;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const account = await accounts.getById(accountId);
    if (!account || account.status === "deleting") return null;
    const plan = await accounts.getPlan(accountId);
    if (plan?.paddleCustomerId) return plan.paddleCustomerId;
    const next: PlanRecord = plan ? { ...plan, paddleCustomerId: customerId } : { ...emptyPlan(accountId), paddleCustomerId: customerId };
    const saved = await accounts.savePlan(next, { expectedPlanVersion: account.planVersion });
    if (saved.ok) return customerId;
    if (saved.reason === "not_found") return null;
  }
  throw new Error("plan update kept conflicting");
}

/**
 * Makes the ledger windows match the plan, idempotently (every call converges to the same state):
 * - a live period without a window gets one, with the plan's budget for its kind;
 * - a window longer than its (truncated) period is cut at the period's end;
 * - a window whose period was revoked is revoked;
 * - COMPLIMENTARY GROUNDWORK: a purchase cuts a complimentary grant BY GRANT, not by window: when any window of an
 *   `admin_grant` overlaps a live paid period, the whole grant ends where that period begins (docs/cloud-admin.md:
 *   "the grant is cut at that instant"): its later windows are removed (revoked if they have usage) and the window that
 *   contains the instant is cut. Used credits stay used and budgets never stack.
 * It touches paid windows only by exact start, grant windows only to cut them, and never resets used credits. Safe to
 * run after every event, after a replay, from the lazy check in `checkPlan` and from tests.
 *
 * Returns what the cut took from grants (empty when nothing was cut), so the caller can tell the admin service: the
 * "a refund restores the remainder" rule of the admin design is built on the `remaining` of each entry.
 */
export async function syncWindows(env: BillingEnv, accountId: string, plan: PlanRecord): Promise<GrantCut[]> {
  const { ledger } = env.stores;
  // Paid periods take precedence over complimentary windows. Cut first, so a freed start can hold the paid window.
  let all = await ledger.listWindows(accountId);
  const cutAt = new Map<string, number>();
  for (const period of plan.paidPeriods) {
    if (period.revokedAt !== undefined) continue;
    for (const w of all) {
      if (w.source !== "admin_grant" || w.revokedAt !== null || w.grantId === null) continue;
      if (w.start < period.end && w.end > period.start) cutAt.set(w.grantId, Math.min(cutAt.get(w.grantId) ?? Infinity, period.start));
    }
  }
  const cuts: GrantCut[] = [];
  for (const [grantId, at] of cutAt) {
    const affected = all.filter((w) => w.source === "admin_grant" && w.grantId === grantId && w.revokedAt === null && w.end > at);
    await ledger.truncateWindows(accountId, at, { source: "admin_grant", grantId });
    for (const w of affected) {
      cuts.push({ grantId, windowStart: w.start, previousEnd: w.end, newEnd: w.start < at ? at : null, limit: w.limit, used: w.used, remaining: Math.max(0, w.limit - w.used - w.reserved) });
    }
  }
  if (cuts.length > 0) all = await ledger.listWindows(accountId);
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
  return cuts;
}
