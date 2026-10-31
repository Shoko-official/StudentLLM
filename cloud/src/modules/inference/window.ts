// Budget windows (docs/cloud-plan.md, "Budget windows"): one window per paid period. A monthly subscription has
// one window per billing period; a semester pass has five consecutive windows of one month each from its start.
// The billing module owns the plan and its paid periods; this module only derives the window of the current period
// when the ledger has none yet (`LedgerStore.ensureWindow` creates it and never resets an existing one).

import type { Deps } from "../../deps";
import type { PaidPeriod, PlanRecord } from "../../storage";

const DAY = 24 * 60 * 60 * 1000;
/** A period of about this length is one month; a longer one is split into whole months. */
const MONTH_MS = 30.4375 * DAY;

/** `startMs` plus `months` calendar months in UTC, keeping the day and time and clamping to the month's last day. */
export function addMonthsUtc(startMs: number, months: number): number {
  const d = new Date(startMs);
  const target = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(target / 12);
  const month = target % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export interface WindowSpec {
  start: number;
  end: number;
  limit: number;
}

/** Plans that carry no entitlement even when a paid period is on file. */
function entitled(plan: PlanRecord): boolean {
  return plan.status !== "none" && plan.status !== "revoked";
}

function windowOfPeriod(period: PaidPeriod, now: number): { start: number; end: number } | null {
  // The billing module may mark a period revoked (a refund, a cut): it buys nothing any more.
  if ((period as { revokedAt?: number | null }).revokedAt != null) return null;
  if (!(period.start <= now && now < period.end)) return null;
  // One window per month of the period (one for a monthly subscription, five for a semester pass).
  const count = Math.max(1, Math.round((period.end - period.start) / MONTH_MS));
  for (let k = 0; k < count; k++) {
    const start = addMonthsUtc(period.start, k);
    const end = k === count - 1 ? period.end : addMonthsUtc(period.start, k + 1);
    if (start <= now && now < end) return { start, end };
  }
  return null;
}

/**
 * The credits of one window of this plan, from the BILLING module's settings (`windowCredits[plan.planId]`): billing
 * owns the plan and its budget, so the window this module creates lazily (when `reserve` finds none) can never differ
 * from the one the webhook creates. Null for a free account or a plan billing has no budget for.
 */
export function windowLimit(deps: Deps, plan: PlanRecord | null): number | null {
  if (!plan || plan.planId === "free") return null;
  const credits = (deps.billing.settings?.windowCredits as Partial<Record<string, number>> | undefined)?.[plan.planId];
  return typeof credits === "number" && Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}

/** The window to create now for this account (see `windowLimit` and `planWindow`), or null when it has none to spend. */
export function lazyWindowSpec(deps: Deps, plan: PlanRecord | null, now: number): WindowSpec | null {
  const limit = windowLimit(deps, plan);
  return limit === null ? null : planWindow(plan, now, limit);
}

/**
 * The window the current time falls in, or null when the account has no entitled paid period covering it (a free
 * account, a lapsed plan, a refund). `windowCredits` is the budget of one window.
 */
export function planWindow(plan: PlanRecord | null, now: number, windowCredits: number): WindowSpec | null {
  if (!plan || !entitled(plan)) return null;
  for (const period of plan.paidPeriods) {
    const w = windowOfPeriod(period, now);
    if (w) return { ...w, limit: windowCredits };
  }
  return null;
}
