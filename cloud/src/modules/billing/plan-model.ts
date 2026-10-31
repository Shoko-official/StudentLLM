// The plan and window model (docs/cloud-plan.md, "Quota design" and "Payments"), as pure functions.
//
// One budget window per paid period. A monthly subscription gets one window per billing period that Paddle
// reports as paid; a semester pass gets five consecutive one-month windows from its start; a pass bought while a
// pass is active queues after it. A subscription cannot be bought while a plan is active and a pass cannot be
// bought while a subscription is; `past_due` starts no new window until a payment succeeds; a refund or chargeback
// withdraws the current and the refunded windows. Nothing here resets a budget: a window is keyed by its start and
// a replayed event finds the period already there.
//
// Everything is a function of (current plan, event) and an instant. No clock, no store, no network.

import type { PaidPeriod, PlanId, PlanRecord, PlanStatus } from "../../storage";
import type { NormalizedEvent } from "./events";
import { SEMESTER_PASS_MONTHS, type PaidPlanId } from "./settings";
import {
  consecutiveMonths,
  hasPeriodAfter,
  hasPurchase,
  insertPeriod,
  isLive,
  kindOf,
  lastEnd,
  livePeriods,
  periodAt,
  truncatePeriods,
} from "./windows";


/** A Paddle billing period longer than this is not a monthly period; the event is refused rather than trusted. */
export const MAX_SUBSCRIPTION_PERIOD_MS = 62 * 24 * 60 * 60 * 1000;
/** Bound of `revokedPurchaseIds` and `retiredSubscriptionIds`. */
const MAX_REMEMBERED_IDS = 20;

export type { PaidPlanId };

export interface Prices {
  plus_monthly: string | null;
  plus_semester: string | null;
}

export type ConflictReason = "duplicate_subscription" | "plan_conflict" | "unexpected_price" | "malformed";

export type Reduction =
  | {
      kind: "applied";
      plan: PlanRecord;
      /** Periods this event added (after clipping). */
      added: PaidPeriod[];
      /** True when a refund or chargeback withdrew at least one period. */
      revoked: boolean;
    }
  /** Nothing to do: an event the model does not use, a replay, or a late event of a replaced subscription. */
  | { kind: "ignored" }
  /** The event is valid but cannot be applied (a second plan, an unknown product): quarantine and alert. */
  | { kind: "conflict"; reason: ConflictReason };

export function emptyPlan(accountId: string): PlanRecord {
  return {
    accountId,
    planId: "free",
    status: "none",
    paidPeriods: [],
    cancelAtPeriodEnd: false,
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    lastEventAt: null,
    pendingCancel: null,
    revokedPurchaseIds: [],
    retiredSubscriptionIds: [],
  };
}

/**
 * True while a subscription is live at Paddle as far as we know: active or past due, including one set to cancel
 * at the end of its period until that period has ended. A past-due subscription still counts, because it may
 * recover and Paddle has not canceled it.
 */
export function subscriptionRunning(plan: PlanRecord | null, at: number): boolean {
  if (!plan || !plan.paddleSubscriptionId) return false;
  if (plan.status !== "active" && plan.status !== "past_due") return false;
  if (plan.cancelAtPeriodEnd) {
    const end = lastEnd(plan.paidPeriods, "subscription");
    return end !== null && end > at;
  }
  return true;
}

/** True while a pass period is running or queued. */
export function passActive(plan: PlanRecord | null, at: number): boolean {
  return plan !== null && hasPeriodAfter(plan.paidPeriods, "pass", at);
}

export type Eligibility = { ok: true } | { ok: false; reason: "subscription_active" | "pass_active" };

/**
 * Whether `requested` may be bought now (the `already_subscribed` rule). An active complimentary grant is not
 * in the plan record and never blocks a purchase (a purchase cuts it). A pass bought during a pass queues.
 */
export function checkoutEligibility(plan: PlanRecord | null, requested: PaidPlanId, at: number): Eligibility {
  if (subscriptionRunning(plan, at)) return { ok: false, reason: "subscription_active" };
  // A cancellation Paddle has not confirmed yet: the old subscription may still be billing, and a second one
  // would be paid twice. The user is pointed to the portal until the cancel is confirmed.
  if (plan?.pendingCancel && plan.paddleSubscriptionId) return { ok: false, reason: "subscription_active" };
  if (requested === "plus_monthly" && passActive(plan, at)) return { ok: false, reason: "pass_active" };
  return { ok: true };
}

function clonePlan(plan: PlanRecord): PlanRecord {
  return structuredClone(plan);
}

function addRevokedPurchase(plan: PlanRecord, id: string): void {
  const ids = plan.revokedPurchaseIds ?? [];
  if (!ids.includes(id)) ids.push(id);
  plan.revokedPurchaseIds = ids.slice(-MAX_REMEMBERED_IDS);
}

/** Remembers the current subscription id as retired (it is about to be replaced or forgotten). */
function retireSubscription(plan: PlanRecord): void {
  const id = plan.paddleSubscriptionId;
  if (id === null) return;
  const ids = plan.retiredSubscriptionIds ?? [];
  if (!ids.includes(id)) ids.push(id);
  plan.retiredSubscriptionIds = ids.slice(-MAX_REMEMBERED_IDS);
}

/** Adds a period; one whose paying transaction was already refunded is recorded as revoked, buying nothing. */
function addPeriod(plan: PlanRecord, candidate: PaidPeriod, added: PaidPeriod[]): void {
  const result = insertPeriod(plan.paidPeriods, candidate);
  if (!result.added) return;
  let period = result.added;
  if (period.purchaseId !== undefined && (plan.revokedPurchaseIds ?? []).includes(period.purchaseId)) {
    period = { ...period, revokedAt: period.start };
    result.periods[result.periods.indexOf(result.added)] = period;
  }
  plan.paidPeriods = result.periods;
  added.push(period);
}

export interface ReduceOptions {
  accountId: string;
  prices: Prices;
  /**
   * `full` applies everything. `additive` is for an event that arrived after a newer one: it may add the periods
   * and revocations it carries (facts that do not depend on order) but changes no status, cancel flag or end.
   */
  mode: "full" | "additive";
}

export function reduceEvent(current: PlanRecord | null, ev: NormalizedEvent, options: ReduceOptions): Reduction {
  switch (ev.kind) {
    case "subscription":
      return reduceSubscription(current, ev, options, "subscription");
    case "transaction":
      return ev.subscriptionId !== null ? reduceSubscription(current, ev, options, "payment") : reducePass(current, ev, options);
    case "adjustment":
      return reduceAdjustment(current, ev, options);
    default:
      return { kind: "ignored" };
  }
}

function reduceSubscription(current: PlanRecord | null, ev: NormalizedEvent, options: ReduceOptions, via: "subscription" | "payment"): Reduction {
  if (ev.subscriptionId === null) return { kind: "conflict", reason: "malformed" };
  const monthly = options.prices.plus_monthly;
  if (monthly !== null && ev.priceIds.some((p) => p !== monthly)) return { kind: "conflict", reason: "unexpected_price" };

  const status = via === "payment" ? "active" : ev.status;
  if (status !== "active" && status !== "past_due" && status !== "canceled" && status !== "paused") return { kind: "ignored" };

  const base = current ?? emptyPlan(options.accountId);
  const sameSubscription = base.paddleSubscriptionId === ev.subscriptionId;
  const full = options.mode === "full";

  if ((base.retiredSubscriptionIds ?? []).includes(ev.subscriptionId)) {
    // A late event of a subscription that was replaced. It may carry a payment (a paid period is a fact), but it
    // never takes the plan back to that subscription.
    if (status !== "active" || ev.periodStart === null || ev.periodEnd === null) return { kind: "ignored" };
    if (!(ev.periodEnd > ev.periodStart) || ev.periodEnd - ev.periodStart > MAX_SUBSCRIPTION_PERIOD_MS) return { kind: "conflict", reason: "malformed" };
    const late = clonePlan(base);
    const lateAdded: PaidPeriod[] = [];
    addPeriod(late, { start: ev.periodStart, end: ev.periodEnd, kind: "subscription", ...(via === "payment" && ev.transactionId ? { purchaseId: ev.transactionId } : {}) }, lateAdded);
    return lateAdded.length === 0 ? { kind: "ignored" } : { kind: "applied", plan: late, added: lateAdded, revoked: false };
  }

  if (!sameSubscription && base.paddleSubscriptionId !== null) {
    // A late event of a subscription that was replaced or ended must not disturb the current one.
    if (status === "canceled" || status === "paused") return { kind: "ignored" };
    if (subscriptionRunning(base, ev.occurredAt)) return { kind: "conflict", reason: "duplicate_subscription" };
  }
  // A refunded or charged-back subscription stays withdrawn: its later events do not bring it back.
  if (sameSubscription && base.status === "revoked") return { kind: "ignored" };
  if (!sameSubscription && status === "active" && hasPeriodAfter(base.paidPeriods, "pass", ev.occurredAt)) {
    return { kind: "conflict", reason: "plan_conflict" };
  }
  if (!sameSubscription && (status === "canceled" || status === "paused")) return { kind: "ignored" }; // never saw it live

  const plan = clonePlan(base);
  const added: PaidPeriod[] = [];

  if (!sameSubscription) {
    retireSubscription(plan);
    plan.paddleSubscriptionId = ev.subscriptionId;
    plan.planId = "plus_monthly";
    plan.cancelAtPeriodEnd = false;
    plan.pendingCancel = null;
    plan.status = status === "past_due" ? "past_due" : "active";
  } else if (full) {
    if (status === "active") plan.status = "active";
    else if (status === "past_due") plan.status = "past_due";
    else plan.status = "canceled";
  }
  plan.planId = "plus_monthly";
  // The customer id is set by the first event of a subscription and never rewritten by its later events.
  if (ev.customerId !== null && (!sameSubscription || plan.paddleCustomerId === null)) plan.paddleCustomerId = ev.customerId;

  // A paid period exists only for a payment that went through: an active subscription or a completed transaction.
  // `past_due` starts no new window until the payment succeeds.
  if (status === "active" && ev.periodStart !== null && ev.periodEnd !== null) {
    if (!(ev.periodEnd > ev.periodStart) || ev.periodEnd - ev.periodStart > MAX_SUBSCRIPTION_PERIOD_MS) {
      return { kind: "conflict", reason: "malformed" };
    }
    addPeriod(plan, { start: ev.periodStart, end: ev.periodEnd, kind: "subscription", ...(via === "payment" && ev.transactionId ? { purchaseId: ev.transactionId } : {}) }, added);
  }

  if (full || !sameSubscription) {
    if (status === "canceled" || status === "paused") {
      // An immediate cancellation ends the period now; one scheduled for the period end has nothing left to cut.
      if (!(base.cancelAtPeriodEnd || ev.cancelAtPeriodEnd === true)) plan.paidPeriods = truncatePeriods(plan.paidPeriods, ev.occurredAt, "subscription");
      plan.cancelAtPeriodEnd = false;
      plan.pendingCancel = null;
    } else if (ev.cancelAtPeriodEnd !== null) {
      plan.cancelAtPeriodEnd = ev.cancelAtPeriodEnd;
      if (ev.cancelAtPeriodEnd && plan.pendingCancel?.when === "period_end") plan.pendingCancel = null;
    }
  }
  return { kind: "applied", plan, added, revoked: false };
}

function reducePass(current: PlanRecord | null, ev: NormalizedEvent, options: ReduceOptions): Reduction {
  const price = options.prices.plus_semester;
  if (price === null || !ev.priceIds.includes(price)) return { kind: "ignored" }; // some other one-time payment
  if (ev.priceIds.some((p) => p !== price)) return { kind: "conflict", reason: "unexpected_price" };
  if (ev.transactionId === null) return { kind: "conflict", reason: "malformed" };

  const base = current ?? emptyPlan(options.accountId);
  if (hasPurchase(base.paidPeriods, ev.transactionId)) return { kind: "ignored" }; // a replay
  if (subscriptionRunning(base, ev.occurredAt)) return { kind: "conflict", reason: "plan_conflict" };

  const plan = clonePlan(base);
  const added: PaidPeriod[] = [];
  // A pass bought while a pass is active queues after the last of its windows; otherwise it starts at the payment.
  const anchor = lastEnd(plan.paidPeriods, "pass");
  const start = anchor !== null && anchor > ev.occurredAt ? anchor : ev.occurredAt;
  for (const month of consecutiveMonths(start, SEMESTER_PASS_MONTHS)) {
    addPeriod(plan, { ...month, kind: "pass", purchaseId: ev.transactionId }, added);
  }
  if (added.length === 0) return { kind: "ignored" };
  plan.planId = "plus_semester";
  plan.status = "active";
  plan.cancelAtPeriodEnd = false;
  // The old subscription (if any) is over; forgetting its id keeps a pass-only plan from looking subscribed.
  retireSubscription(plan);
  plan.paddleSubscriptionId = null;
  plan.pendingCancel = null;
  if (ev.customerId !== null) plan.paddleCustomerId = ev.customerId;
  return { kind: "applied", plan, added, revoked: false };
}

function reduceAdjustment(current: PlanRecord | null, ev: NormalizedEvent, _options: ReduceOptions): Reduction {
  if (current === null) return { kind: "ignored" };
  // Only an approved refund or chargeback withdraws anything (event and status names: verify with Paddle).
  if ((ev.action !== "refund" && ev.action !== "chargeback") || ev.status !== "approved") return { kind: "ignored" };

  const plan = clonePlan(current);
  const at = ev.occurredAt;
  let revoked = false;
  plan.paidPeriods = plan.paidPeriods.map((p) => {
    if (!isLive(p) || p.end <= at) return p;
    // The current window, the windows the refunded payment bought, and (when the event names no payment) all later ones.
    const bought = ev.transactionId !== null && p.purchaseId === ev.transactionId;
    const running = p.start <= at;
    if (!(bought || running || ev.transactionId === null)) return p;
    revoked = true;
    return { ...p, revokedAt: at };
  });
  // Remember the refunded payment: a period it bought that is recorded later arrives already revoked.
  const newlyRemembered = ev.transactionId !== null && !(plan.revokedPurchaseIds ?? []).includes(ev.transactionId);
  if (newlyRemembered) addRevokedPurchase(plan, ev.transactionId!);
  if (!revoked) return newlyRemembered ? { kind: "applied", plan, added: [], revoked: false } : { kind: "ignored" };
  const stillBuying = livePeriods(plan.paidPeriods).some((p) => p.end > at);
  if (!stillBuying) {
    plan.status = "revoked";
    plan.cancelAtPeriodEnd = false;
    // Stop the renewals: a refund does not cancel the subscription by itself.
    if (subscriptionRunning(current, at) && !plan.pendingCancel) {
      plan.pendingCancel = { when: "now", requestedAt: at, attempts: 0, nextAttemptAt: at, alerted: false };
    }
  }
  return { kind: "applied", plan, added: [], revoked: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Local effects of a cancellation Paddle confirmed (the seam and the retry task use these)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Applies a confirmed cancellation to the plan: at the period end it sets the flag (the current window runs to
 * its end and no new one starts); now it ends the subscription's running period at `at`. A second application
 * changes nothing, so the Paddle webhook that reports the same thing is a no-op.
 */
export function applyConfirmedCancel(plan: PlanRecord, when: "period_end" | "now", at: number): PlanRecord {
  const next = clonePlan(plan);
  next.pendingCancel = null;
  if (when === "period_end") {
    if (next.status === "active" || next.status === "past_due") next.cancelAtPeriodEnd = true;
    return next;
  }
  next.paidPeriods = truncatePeriods(next.paidPeriods, at, "subscription");
  next.cancelAtPeriodEnd = false;
  if (next.status === "active" || next.status === "past_due") next.status = "canceled";
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// The public view
// ---------------------------------------------------------------------------------------------------------------

export interface PublicPlan {
  id: "free" | "plus_monthly" | "plus_semester";
  status: "none" | "active" | "past_due" | "canceled" | "revoked";
  period_start: string | null;
  period_end: string | null;
  cancel_at_period_end: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/**
 * The `Plan` object of the contract for an instant. The account module may use it for `GET /v1/account`.
 * - a running period: its id and dates (status `past_due` keeps showing the running window);
 * - a revoked plan: `revoked`, no dates;
 * - a subscription that is past due with no running window: `past_due`, no dates;
 * - nothing running: `free` (status `canceled` when a plan existed and ended, `none` when there never was one).
 * A complimentary grant is not part of the plan record, so an account with only a grant reports `free`
 * (contract question in the pull request); its window is visible in the credits.
 */
export function toPublicPlan(plan: PlanRecord | null, at: number): PublicPlan {
  const free = (status: PublicPlan["status"]): PublicPlan => ({ id: "free", status, period_start: null, period_end: null, cancel_at_period_end: false });
  if (!plan) return free("none");
  if (plan.status === "revoked") {
    const stillRunning = periodAt(plan.paidPeriods, at);
    if (!stillRunning) return { id: plan.planId, status: "revoked", period_start: null, period_end: null, cancel_at_period_end: false };
  }
  const running = periodAt(plan.paidPeriods, at);
  if (running) {
    const status: PlanStatus = plan.status === "past_due" ? "past_due" : "active";
    const id: PlanId = kindOf(running) === "pass" ? "plus_semester" : "plus_monthly";
    return {
      id,
      status,
      period_start: iso(running.start),
      period_end: iso(running.end),
      cancel_at_period_end: kindOf(running) === "subscription" && plan.cancelAtPeriodEnd,
    };
  }
  if (plan.status === "past_due") return { id: plan.planId, status: "past_due", period_start: null, period_end: null, cancel_at_period_end: false };
  const ever = plan.paidPeriods.length > 0 || plan.status !== "none";
  return free(ever ? "canceled" : "none");
}
