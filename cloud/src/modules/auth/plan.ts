// How the auth and account modules summarize a plan record. The billing module owns plan semantics
// (entitlement, `plan_required`); these helpers only shape what `TokenResponse` and `GET /v1/account` report.

import type { PlanRecord } from "../../storage";
import type { Plan } from "../../types";

function currentPeriod(plan: PlanRecord, now: number): { start: number; end: number } | null {
  return plan.paidPeriods.find((p) => p.start <= now && now < p.end) ?? null;
}

/** `plus` while a paid period contains `now` and the plan is active (or past due: the current window continues). */
export function planLabel(plan: PlanRecord | null, now: number): "free" | "plus" {
  if (!plan || plan.planId === "free") return "free";
  if (plan.status !== "active" && plan.status !== "past_due") return "free";
  return currentPeriod(plan, now) ? "plus" : "free";
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function toIso(ms: number): string {
  return iso(ms);
}

/** The `Plan` object of the account response. A missing plan is a free account with no period. */
export function planObject(plan: PlanRecord | null, now: number): Plan {
  if (!plan) return { id: "free", status: "none", period_start: null, period_end: null, cancel_at_period_end: false };
  const period = currentPeriod(plan, now);
  return {
    id: plan.planId,
    status: plan.status,
    period_start: period ? iso(period.start) : null,
    period_end: period ? iso(period.end) : null,
    cancel_at_period_end: plan.cancelAtPeriodEnd,
  };
}
