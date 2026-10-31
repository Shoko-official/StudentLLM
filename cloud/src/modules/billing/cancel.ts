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

import type { PendingCancel, PlanRecord } from "../../storage";
import type { BillingEnv } from "./env";
import { PaddleError, type PaddleSubscription } from "./paddle-client";
import { applyConfirmedCancel } from "./plan-model";
import { syncWindows, updatePlan } from "./plan-store";
import { lastEnd } from "./windows";

export type CancelWhen = "period_end" | "now";
export type CancelState = "cancelled" | "pending" | "none";

/** `now` wins over `period_end`: a stronger request is never weakened by a retry of a weaker one. */
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

async function recordPending(env: BillingEnv, accountId: string, when: CancelWhen, now: number): Promise<void> {
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
  if (updated && alertNow) await env.notifier.alertOperator({ kind: "cancel_failing", accountId, attempts: attemptsNow });
}

export async function cancelSubscription(env: BillingEnv, accountId: string, when: CancelWhen): Promise<{ state: CancelState }> {
  const { accounts } = env.stores;
  const plan = await accounts.getPlan(accountId);
  const tombstone = await accounts.getTombstone(accountId);
  const subscriptionId = plan?.paddleSubscriptionId ?? tombstone?.paddleSubscriptionId ?? null;
  if (subscriptionId === null) return { state: "none" };

  if (plan && !plan.pendingCancel) {
    // Already over at Paddle as far as we know, or already scheduled for what is asked.
    if (plan.status === "canceled" || plan.status === "none") return { state: "none" };
    if (plan.status === "revoked") return { state: "none" };
    if (when === "period_end" && plan.cancelAtPeriodEnd) return { state: "cancelled" };
  }

  const now = env.clock.now();
  const effective = plan?.pendingCancel ? stronger(plan.pendingCancel.when, when) : when;
  if (!(await askPaddle(env, subscriptionId, effective))) {
    await recordPending(env, accountId, effective, now);
    return { state: "pending" };
  }

  const confirmed = await updatePlan(env, accountId, (current: PlanRecord) => applyConfirmedCancel(current, effective, now));
  if (confirmed) {
    await syncWindows(env, accountId, confirmed);
    const account = await accounts.getById(accountId);
    // The deletion flow sends its own mail; a notification of the cancellation on top would be noise.
    if (account && account.status !== "deleting") {
      const end = effective === "period_end" ? lastEnd(confirmed.paidPeriods, "subscription") : now;
      await env.notifier.subscriptionCancelled({ accountId, when: effective, effectiveAt: end });
    }
  }
  return { state: "cancelled" };
}

/** Tries the cancellation recorded on the plan once (right after a refund recorded it, or from the retry task). */
export async function attemptPendingCancel(env: BillingEnv, accountId: string): Promise<void> {
  const plan = await env.stores.accounts.getPlan(accountId);
  if (plan?.pendingCancel) await cancelSubscription(env, accountId, plan.pendingCancel.when);
}

/** One pass of the scheduled retry: every cancellation whose next attempt is due. Returns how many were tried. */
export async function retryPendingCancels(env: BillingEnv): Promise<number> {
  const now = env.clock.now();
  const due = await env.stores.accounts.listPendingCancels(now, env.settings.cancel.batch);
  let tried = 0;
  for (const accountId of due) {
    tried++;
    try {
      await attemptPendingCancel(env, accountId);
    } catch {
      // One account failing must not stop the others; its pending state and next attempt are already recorded.
      console.error("billing: cancel retry failed");
    }
  }
  return tried;
}
