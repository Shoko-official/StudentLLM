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

import type { BudgetWindow, ExtraCancel, PaidPeriod, PlanId, PlanRecord, PlanStatus } from "../../storage";
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** A Paddle billing period longer than this is not a monthly period; the event is refused rather than trusted. */
export const MAX_SUBSCRIPTION_PERIOD_MS = 62 * DAY_MS;
/** Nor is one shorter than this (a billing month is 28 to 31 days): a period like that is refused, not granted. */
export const MIN_SUBSCRIPTION_PERIOD_MS = 25 * DAY_MS;
/** Bound of the remembered id lists of a plan. */
const MAX_REMEMBERED_IDS = 20;

export type { PaidPlanId };

export interface Prices {
  plus_monthly: string | null;
  plus_semester: string | null;
}

export type ConflictReason = "duplicate_subscription" | "plan_conflict" | "unexpected_price" | "malformed" | "customer_mismatch";

export type Reduction =
  | {
      kind: "applied";
      plan: PlanRecord;
      /** Periods this event added (after clipping). */
      added: PaidPeriod[];
      /** True when a refund or chargeback withdrew at least one period. */
      revoked: boolean;
      /** True when the account had no Paddle customer id and adopted the event's (the operator is told). */
      customerAdopted?: boolean;
    }
  /** Nothing to do: an event the model does not use, a replay, or a late event of a replaced subscription. */
  | { kind: "ignored" }
  /** The event is valid but cannot be applied (a second plan, an unknown product): quarantine and alert. */
  | { kind: "conflict"; reason: ConflictReason }
  /** Valid, changes nothing, and a person must look at it (a partial refund is a normal flow, not a revocation). */
  | { kind: "review"; reason: "partial_refund" };

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
    retiredCustomerIds: [],
    extraCancels: [],
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
  // A cancellation Paddle has not confirmed yet (the plan's own, or one of a duplicate or replaced subscription): a
  // subscription may still be billing, and a second one would be paid twice. The user is pointed to the portal.
  if (plan?.pendingCancel && plan.paddleSubscriptionId) return { ok: false, reason: "subscription_active" };
  if ((plan?.extraCancels ?? []).length > 0) return { ok: false, reason: "subscription_active" };
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

/** Adds (or replaces, by subscription id) an extra cancellation to retry; attempts and timing start fresh. */
export function addExtraCancel(plan: PlanRecord, input: { subscriptionId: string; customerId: string | null; reason: ExtraCancel["reason"]; now: number }): void {
  const list = (plan.extraCancels ?? []).filter((e) => e.subscriptionId !== input.subscriptionId);
  list.push({ subscriptionId: input.subscriptionId, customerId: input.customerId, reason: input.reason, requestedAt: input.now, attempts: 0, nextAttemptAt: input.now, alerted: false });
  plan.extraCancels = list.slice(-MAX_REMEMBERED_IDS);
}

/**
 * Remembers the current subscription id as retired (it is about to be replaced or forgotten). A cancellation that
 * was still pending for it moves to the extra cancellations with its attempts, so replacing the subscription
 * never wipes a cancel Paddle has not confirmed.
 */
function retireSubscription(plan: PlanRecord): void {
  const id = plan.paddleSubscriptionId;
  if (id === null) return;
  const ids = plan.retiredSubscriptionIds ?? [];
  if (!ids.includes(id)) ids.push(id);
  plan.retiredSubscriptionIds = ids.slice(-MAX_REMEMBERED_IDS);
  if (plan.pendingCancel) {
    const p = plan.pendingCancel;
    const list = (plan.extraCancels ?? []).filter((e) => e.subscriptionId !== id);
    list.push({ subscriptionId: id, customerId: plan.paddleCustomerId, reason: "retired", requestedAt: p.requestedAt, attempts: p.attempts, nextAttemptAt: p.nextAttemptAt, alerted: p.alerted });
    plan.extraCancels = list.slice(-MAX_REMEMBERED_IDS);
    plan.pendingCancel = null;
  } else if (plan.status === "active" || plan.status === "past_due") {
    // Replaced while Paddle may still hold it alive (a paused subscription, a cancel whose event has not arrived):
    // cancel it now, so a subscription nobody tracks cannot resume billing. Due at once (time 0).
    addExtraCancel(plan, { subscriptionId: id, customerId: plan.paddleCustomerId, reason: "retired", now: 0 });
  }
}

/** Removes a confirmed extra cancellation. */
export function removeExtraCancel(plan: PlanRecord, subscriptionId: string): PlanRecord {
  const next = clonePlan(plan);
  next.extraCancels = (next.extraCancels ?? []).filter((e) => e.subscriptionId !== subscriptionId);
  return next;
}

/** Every subscription id the plan has seen: current, replaced and duplicate. */
export function seenSubscriptionIds(plan: PlanRecord): string[] {
  const ids = new Set<string>();
  for (const id of [plan.paddleSubscriptionId, ...(plan.retiredSubscriptionIds ?? []), ...(plan.extraCancels ?? []).map((e) => e.subscriptionId)]) if (id) ids.add(id);
  return [...ids];
}

/** Adds a period; one whose paying transaction was already refunded is recorded as revoked, buying nothing. */
function addPeriod(plan: PlanRecord, candidate: PaidPeriod, added: PaidPeriod[]): void {
  const result = insertPeriod(plan.paidPeriods, candidate);
  const refunded = (id: string | undefined): boolean => id !== undefined && (plan.revokedPurchaseIds ?? []).includes(id);
  if (result.backfilled) {
    // The period existed without its payment id; now the payment is known, and it may be a refunded one.
    const filled = result.backfilled;
    plan.paidPeriods = result.periods.map((p) => (p.start === filled.start && refunded(filled.purchaseId) && p.revokedAt === undefined ? { ...p, revokedAt: p.start } : p));
    return;
  }
  if (!result.added) return;
  let period = result.added;
  if (refunded(period.purchaseId)) {
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
      // A completed transaction without a single item is not something we sold.
      if (ev.itemCount === 0) return { kind: "conflict", reason: "malformed" };
      return ev.subscriptionId !== null ? reduceSubscription(current, ev, options, "payment") : reducePass(current, ev, options);
    case "adjustment":
      return reduceAdjustment(current, ev, options);
    default:
      return { kind: "ignored" };
  }
}

type CustomerCheck = "ok" | "adopt" | "mismatch";

/**
 * Checkout creates the Paddle customer on the server and always passes it, so the account's customer id is known
 * before the first event. An event with another customer id does not belong to this account's purchase.
 */
function customerCheck(base: PlanRecord, ev: NormalizedEvent): CustomerCheck {
  if (ev.customerId === null) return "ok";
  if (base.paddleCustomerId === null) return "adopt";
  if (ev.customerId === base.paddleCustomerId || (base.retiredCustomerIds ?? []).includes(ev.customerId)) return "ok";
  return "mismatch";
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

  const customer = customerCheck(base, ev);
  if (customer === "mismatch") return { kind: "conflict", reason: "customer_mismatch" };

  if (status === "active" && ev.periodStart !== null && ev.periodEnd !== null) {
    const length = ev.periodEnd - ev.periodStart;
    if (!(length > 0) || length > MAX_SUBSCRIPTION_PERIOD_MS || length < MIN_SUBSCRIPTION_PERIOD_MS) return { kind: "conflict", reason: "malformed" };
  }

  if (!sameSubscription && status === "canceled") {
    // The end of a subscription we asked to cancel (a duplicate, or a replaced one): the retry is done.
    if ((base.extraCancels ?? []).some((e) => e.subscriptionId === ev.subscriptionId)) {
      return { kind: "applied", plan: removeExtraCancel(base, ev.subscriptionId), added: [], revoked: false };
    }
  }

  if ((base.retiredSubscriptionIds ?? []).includes(ev.subscriptionId)) {
    // A late event of a subscription that was replaced. It may carry a payment (a paid period is a fact), but it
    // never takes the plan back to that subscription.
    if (status !== "active" || ev.periodStart === null || ev.periodEnd === null) return { kind: "ignored" };
    const late = clonePlan(base);
    const lateAdded: PaidPeriod[] = [];
    addPeriod(late, { start: ev.periodStart, end: ev.periodEnd, kind: "subscription", ...(via === "payment" && ev.transactionId ? { purchaseId: ev.transactionId } : {}) }, lateAdded);
    return JSON.stringify(late.paidPeriods) === JSON.stringify(base.paidPeriods) ? { kind: "ignored" } : { kind: "applied", plan: late, added: lateAdded, revoked: false };
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
    plan.status = status === "past_due" ? "past_due" : "active";
  } else if (full) {
    if (status === "active") plan.status = "active";
    else if (status === "past_due") plan.status = "past_due";
    else if (status === "canceled") plan.status = "canceled";
    // `paused` is not a cancellation: the subscription still exists at Paddle and can be resumed or canceled later,
    // so the local status is kept and the plan simply stops at the end of the paid period (below).
  }
  plan.planId = "plus_monthly";
  if (customer === "adopt") plan.paddleCustomerId = ev.customerId;

  // A paid period exists only for a payment that went through: an active subscription or a completed transaction.
  // `past_due` starts no new window until the payment succeeds.
  if (status === "active" && ev.periodStart !== null && ev.periodEnd !== null) {
    addPeriod(plan, { start: ev.periodStart, end: ev.periodEnd, kind: "subscription", ...(via === "payment" && ev.transactionId ? { purchaseId: ev.transactionId } : {}) }, added);
  }

  if (full || !sameSubscription) {
    if (status === "canceled") {
      // An immediate cancellation ends the period now; one scheduled for the period end has nothing left to cut.
      if (!(base.cancelAtPeriodEnd || ev.cancelAtPeriodEnd === true)) plan.paidPeriods = truncatePeriods(plan.paidPeriods, ev.occurredAt, "subscription");
      plan.cancelAtPeriodEnd = false;
      plan.pendingCancel = null;
    } else if (status === "paused") {
      plan.cancelAtPeriodEnd = true;
    } else if (ev.cancelAtPeriodEnd !== null) {
      plan.cancelAtPeriodEnd = ev.cancelAtPeriodEnd;
      if (ev.cancelAtPeriodEnd && plan.pendingCancel?.when === "period_end") plan.pendingCancel = null;
    }
  }
  return { kind: "applied", plan, added, revoked: false, ...(customer === "adopt" ? { customerAdopted: true } : {}) };
}

function reducePass(current: PlanRecord | null, ev: NormalizedEvent, options: ReduceOptions): Reduction {
  const price = options.prices.plus_semester;
  if (price === null || !ev.priceIds.includes(price)) return { kind: "ignored" }; // some other one-time payment
  if (ev.priceIds.some((p) => p !== price)) return { kind: "conflict", reason: "unexpected_price" };
  if (ev.transactionId === null) return { kind: "conflict", reason: "malformed" };

  const base = current ?? emptyPlan(options.accountId);
  const customer = customerCheck(base, ev);
  if (customer === "mismatch") return { kind: "conflict", reason: "customer_mismatch" };
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
  // The old subscription (if any) is over; forgetting its id keeps a pass-only plan from looking subscribed. A
  // cancellation that was still pending for it moves to the extra cancellations (see retireSubscription, which
  // reads the status the plan had, so it runs first).
  retireSubscription(plan);
  plan.planId = "plus_semester";
  plan.status = "active";
  plan.cancelAtPeriodEnd = false;
  plan.paddleSubscriptionId = null;
  plan.pendingCancel = null;
  if (customer === "adopt") plan.paddleCustomerId = ev.customerId;
  return { kind: "applied", plan, added, revoked: false, ...(customer === "adopt" ? { customerAdopted: true } : {}) };
}

/**
 * Refunds and chargebacks (docs/cloud-plan.md, "Webhook specification").
 * - Only an APPROVED adjustment acts. A chargeback and a `full` refund withdraw windows; a `partial` refund (a
 *   proportional withdrawal refund is a normal flow, ToS 5.2) changes nothing and asks for a review; a refund whose
 *   type is not stated is treated as partial, because withdrawing on a guess is the worse mistake.
 * - What is withdrawn: the windows the refunded transaction bought; when the event names no transaction, the running
 *   window and all later ones. A refund of one payment never takes the window another payment bought.
 * - A refunded payment is remembered, so a period that is recorded later for it arrives already revoked.
 * - A withdrawn subscription period also asks for the subscription to be canceled now (a refund does not cancel it,
 *   and the renewals would start entitlement again).
 */
function reduceAdjustment(current: PlanRecord | null, ev: NormalizedEvent, _options: ReduceOptions): Reduction {
  if (current === null) return { kind: "ignored" };
  if (ev.status !== "approved") return { kind: "ignored" };
  if (ev.action === "refund" && ev.adjustmentType !== "full") return { kind: "review", reason: "partial_refund" };
  if (ev.action !== "refund" && ev.action !== "chargeback") return { kind: "ignored" };

  const plan = clonePlan(current);
  const at = ev.occurredAt;
  let revoked = false;
  let revokedSubscription = false;
  plan.paidPeriods = plan.paidPeriods.map((p) => {
    if (!isLive(p) || p.end <= at) return p;
    const hit = ev.transactionId !== null ? p.purchaseId === ev.transactionId : true; // no payment named: running and later
    if (!hit) return p;
    revoked = true;
    if (kindOf(p) === "subscription") revokedSubscription = true;
    return { ...p, revokedAt: at };
  });
  // Remember the refunded payment: a period it bought that is recorded later arrives already revoked.
  const newlyRemembered = ev.transactionId !== null && !(plan.revokedPurchaseIds ?? []).includes(ev.transactionId);
  if (newlyRemembered) addRevokedPurchase(plan, ev.transactionId!);
  if (!revoked) return newlyRemembered ? { kind: "applied", plan, added: [], revoked: false } : { kind: "ignored" };
  if (!livePeriods(plan.paidPeriods).some((p) => p.end > at)) {
    plan.status = "revoked";
    plan.cancelAtPeriodEnd = false;
  }
  // Stop the renewals.
  if (revokedSubscription && subscriptionRunning(current, at) && !plan.pendingCancel) {
    plan.pendingCancel = { when: "now", requestedAt: at, attempts: 0, nextAttemptAt: at, alerted: false };
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

/**
 * The plan id a complimentary (admin grant) window is reported as. The public `Plan.id` enum has no complimentary id
 * yet: this stays `free` until the public contract gains `plus_complimentary` (amendment A2, a separate change), and
 * then this one constant changes. Nothing else in the module spells the id.
 */
export const COMPLIMENTARY_PLAN_ID: PublicPlan["id"] = "free";

export interface PublicPlan {
  id: "free" | "plus_monthly" | "plus_semester" | "plus_complimentary";
  status: "none" | "active" | "past_due" | "canceled" | "revoked";
  period_start: string | null;
  period_end: string | null;
  cancel_at_period_end: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/**
 * The `Plan` object of the contract for an instant. The account module may use it for `GET /v1/account`; pass the
 * running budget window (`ledger.getCurrentWindow`) so a complimentary window is reported by its source.
 * - a running paid period: its id and dates (status `past_due` keeps showing the running window);
 * - a revoked plan: `revoked`, no dates;
 * - no running paid period but a running admin_grant window: `COMPLIMENTARY_PLAN_ID`, active, the window's dates;
 * - a subscription that is past due with no running window: `past_due`, no dates;
 * - nothing running: `free` (status `canceled` when a plan existed and ended, `none` when there never was one).
 */
export function toPublicPlan(plan: PlanRecord | null, at: number, window: BudgetWindow | null = null): PublicPlan {
  const free = (status: PublicPlan["status"]): PublicPlan => ({ id: "free", status, period_start: null, period_end: null, cancel_at_period_end: false });
  const running = plan ? periodAt(plan.paidPeriods, at) : undefined;
  if (!running && window && window.source === "admin_grant" && window.revokedAt === null && window.start <= at && at < window.end) {
    return { id: COMPLIMENTARY_PLAN_ID, status: "active", period_start: iso(window.start), period_end: iso(window.end), cancel_at_period_end: false };
  }
  if (!plan) return free("none");
  if (plan.status === "revoked" && !running) {
    return { id: plan.planId, status: "revoked", period_start: null, period_end: null, cancel_at_period_end: false };
  }
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
