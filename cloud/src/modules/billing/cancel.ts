// Cancelling a subscription at Paddle: the implementation behind `BillingSeam.cancelSubscription` and the retry
// of a cancellation Paddle did not confirm (docs/cloud-plan.md, "Payments", item 5).
//
// States of the answer:
//   cancelled  Paddle confirmed (or the subscription was already canceled / scheduled to be): the plan is updated.
//   pending    Paddle did not confirm. The plan keeps a visible `pendingCancel` (attempts, next try), the scheduled
//              task retries with backoff, and the operator is alerted once after repeated failures. Nothing that
//              lets the account be purged is released: the Paddle ids stay in the plan and the tombstone.
//   none       There is no subscription to cancel (a free account, a pass, one that already ended).
//
// The call is idempotent: the deletion flow may call it again on each of its own retries.
//
// Which subscriptions: the plan's current one (`when` decides period end or now) and, when the request is `now`,
// also every EXTRA one the account has (a duplicate bought by a parallel checkout, a replaced one whose cancel was
// pending): they are always canceled immediately, are retried by the same task, and the answer is `pending` while any
// of them is. So deleting an account cancels everything it ever subscribed to before the records are purged.

import type { ExtraCancel, PendingCancel, PlanRecord } from "../../storage";
import type { BillingEnv } from "./env";
import { PaddleError, type PaddleSubscription } from "./paddle-client";
import { applyConfirmedCancel, removeExtraCancel } from "./plan-model";
import { syncWindows, updatePlan } from "./plan-store";
import { lastEnd } from "./windows";

export type CancelWhen = "period_end" | "now";
export type CancelState = "cancelled" | "pending" | "none";

/**
 * Two requests for the same subscription can disagree (a retry of a period-end cancel, then a deletion that wants it
 * now). The STRONGER one wins and a weaker request never downgrades what is already pending: `now` beats `period_end`.
 * So `pendingCancel.when` only ever moves from `period_end` to `now` while it waits, never back.
 */
const stronger = (a: CancelWhen, b: CancelWhen): CancelWhen => (a === "now" || b === "now" ? "now" : "period_end");

export function retryDelayMs(env: BillingEnv, attempts: number): number {
  const { baseDelayMs, maxDelayMs } = env.settings.cancel;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
}

function confirms(snapshot: PaddleSubscription, when: CancelWhen): boolean {
  if (snapshot.status === "canceled") return true;
  return when === "period_end" && snapshot.cancelScheduled;
}

/** Whether Paddle accepted the request, treating "already canceled / already scheduled" as success after a re-fetch. */
async function askPaddle(env: BillingEnv, subscriptionId: string, when: CancelWhen): Promise<boolean> {
  try {
    const snapshot = await env.paddle.cancelSubscription(subscriptionId, when === "now" ? "immediately" : "next_billing_period");
    return confirms(snapshot, when) || snapshot.status === "canceled";
  } catch (error) {
    // Paddle refuses to cancel something already canceled or locked: look at the subscription itself.
    if (error instanceof PaddleError && (error.failure === "conflict" || error.failure === "rejected")) {
      try {
        return confirms(await env.paddle.getSubscription(subscriptionId), when);
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function recordPending(env: BillingEnv, accountId: string, subscriptionId: string, when: CancelWhen, now: number): Promise<void> {
  let attemptsNow = 0;
  let alertNow = false;
  const updated = await updatePlan(env, accountId, (plan) => {
    const previous = plan.pendingCancel ?? null;
    const attempts = (previous?.attempts ?? 0) + 1;
    attemptsNow = attempts;
    const reached = attempts >= env.settings.cancel.alertAfterAttempts;
    alertNow = reached && !(previous?.alerted ?? false);
    const pending: PendingCancel = {
      when: previous ? stronger(previous.when, when) : when,
      requestedAt: previous?.requestedAt ?? now,
      attempts,
      nextAttemptAt: now + retryDelayMs(env, attempts),
      alerted: (previous?.alerted ?? false) || reached,
    };
    return { ...plan, pendingCancel: pending };
  });
  if (updated && alertNow) await env.notifier.alertOperator({ kind: "cancel_failing", accountId, attempts: attemptsNow, subscriptionId });
}

async function cancelMain(env: BillingEnv, accountId: string, plan: PlanRecord | null, subscriptionId: string | null, when: CancelWhen): Promise<CancelState> {
  if (subscriptionId === null) return "none";
  if (plan && !plan.pendingCancel) {
    // Already over at Paddle as far as we know, or already scheduled for what is asked.
    if (plan.status === "canceled" || plan.status === "none") return "none";
    if (plan.status === "revoked") return "none";
    if (when === "period_end" && plan.cancelAtPeriodEnd) return "cancelled";
  }

  const now = env.clock.now();
  const effective = plan?.pendingCancel ? stronger(plan.pendingCancel.when, when) : when;
  if (!(await askPaddle(env, subscriptionId, effective))) {
    await recordPending(env, accountId, subscriptionId, effective, now);
    return "pending";
  }

  const confirmed = await updatePlan(env, accountId, (current: PlanRecord) => applyConfirmedCancel(current, effective, now));
  if (confirmed) {
    const cuts = await syncWindows(env, accountId, confirmed);
    if (cuts.length > 0) await env.notifier.grantCut({ accountId, cuts });
    const account = await env.stores.accounts.getById(accountId);
    // The deletion flow sends its own mail; a notification of the cancellation on top would be noise.
    if (account && account.status !== "deleting") {
      const end = effective === "period_end" ? lastEnd(confirmed.paidPeriods, "subscription") : now;
      await env.notifier.subscriptionCancelled({ accountId, when: effective, effectiveAt: end });
    }
  }
  return "cancelled";
}

/** Cancels one extra subscription now; on success the entry is removed, on failure its attempts and next try are recorded. */
async function cancelExtra(env: BillingEnv, accountId: string, extra: ExtraCancel): Promise<CancelState> {
  const now = env.clock.now();
  if (await askPaddle(env, extra.subscriptionId, "now")) {
    await updatePlan(env, accountId, (plan) => removeExtraCancel(plan, extra.subscriptionId));
    return "cancelled";
  }
  let alertNow = false;
  let attemptsNow = 0;
  const updated = await updatePlan(env, accountId, (plan) => {
    const list = (plan.extraCancels ?? []).map((e) => {
      if (e.subscriptionId !== extra.subscriptionId) return e;
      const attempts = e.attempts + 1;
      attemptsNow = attempts;
      const reached = attempts >= env.settings.cancel.alertAfterAttempts;
      alertNow = reached && !e.alerted;
      return { ...e, attempts, nextAttemptAt: now + retryDelayMs(env, attempts), alerted: e.alerted || reached };
    });
    return { ...plan, extraCancels: list };
  });
  if (updated && alertNow) await env.notifier.alertOperator({ kind: "cancel_failing", accountId, attempts: attemptsNow, subscriptionId: extra.subscriptionId });
  return "pending";
}

export async function cancelSubscription(env: BillingEnv, accountId: string, when: CancelWhen): Promise<{ state: CancelState }> {
  const { accounts } = env.stores;
  const plan = await accounts.getPlan(accountId);
  const tombstone = await accounts.getTombstone(accountId);
  const states: CancelState[] = [];

  if (plan === null && tombstone !== null) {
    // The plan row is gone but the tombstone kept every id: cancel them all now, nothing to record the retry on.
    const ids = new Set([...(tombstone.paddleSubscriptionIds ?? []), ...(tombstone.paddleSubscriptionId ? [tombstone.paddleSubscriptionId] : [])]);
    for (const id of ids) states.push((await askPaddle(env, id, "now")) ? "cancelled" : "pending");
  } else {
    states.push(await cancelMain(env, accountId, plan, plan?.paddleSubscriptionId ?? tombstone?.paddleSubscriptionId ?? null, when));
    // Extra subscriptions are always canceled now, whatever the main request is.
    if (when === "now") {
      for (const extra of plan?.extraCancels ?? []) states.push(await cancelExtra(env, accountId, extra));
    }
  }
  if (states.includes("pending")) return { state: "pending" };
  return { state: states.includes("cancelled") ? "cancelled" : "none" };
}

/** Tries the cancellations recorded on the plan once (right after a refund recorded one, or from the retry task). */
export async function attemptPendingCancel(env: BillingEnv, accountId: string, options: { onlyDue?: boolean } = {}): Promise<void> {
  const plan = await env.stores.accounts.getPlan(accountId);
  if (!plan) return;
  const now = env.clock.now();
  if (plan.pendingCancel && (!options.onlyDue || plan.pendingCancel.nextAttemptAt <= now)) {
    await cancelMain(env, accountId, plan, plan.paddleSubscriptionId, plan.pendingCancel.when);
  }
  for (const extra of plan.extraCancels ?? []) {
    if (!options.onlyDue || extra.nextAttemptAt <= now) await cancelExtra(env, accountId, extra);
  }
}

/** One pass of the scheduled retry: every cancellation whose next attempt is due. Returns how many accounts were tried. */
export async function retryPendingCancels(env: BillingEnv): Promise<number> {
  const now = env.clock.now();
  const due = await env.stores.accounts.listPendingCancels(now, env.settings.cancel.batch);
  let tried = 0;
  for (const accountId of due) {
    tried++;
    try {
      await attemptPendingCancel(env, accountId, { onlyDue: true });
    } catch {
      // One account failing must not stop the others; its pending state and next attempt are already recorded.
      console.error("billing: cancel retry failed");
    }
  }
  return tried;
}
