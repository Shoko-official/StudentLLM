// POST /webhooks/paddle (docs/cloud-plan.md, "Webhook specification"; operationId paddleWebhook).
//
// Order, each step before the next can have an effect:
//   1. the signature over the RAW bytes (no parsing before it)      -> 401
//   2. the body as JSON and the envelope fields                      -> 400 / 415
//   3. the atomic claim of the event id, with its fencing token      -> duplicate: 200, in progress: 503
//   4. the effects: plan by `occurred_at` (a late event adds only facts that do not depend on order), windows,
//      quarantine for an unknown account or a conflicting plan
//   5. complete the claim with the allowlisted fields -> 200. A failure releases the claim -> 503 (Paddle retries).
// Slow work (a cancel request to Paddle, alerts) runs after the response through `ctx.waitUntil`.

import type { RequestContext } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { PlanRecord, WebhookFields } from "../../storage";
import { attemptPendingCancel } from "./cancel";
import { envFromDeps, type BillingEnv } from "./env";
import { EventShapeError, eventFromRecord, ledgerFields, normalizeEvent, type NormalizedEvent } from "./events";
import { addExtraCancel, emptyPlan, reduceEvent, type ConflictReason, type Reduction } from "./plan-model";
import { syncWindows, updatePlan } from "./plan-store";
import { verifyPaddleSignature } from "./signature";

const MAX_CAS_ATTEMPTS = 6;

interface Outcome {
  state: "processed" | "quarantined";
  fields: WebhookFields;
  /** Work for after the response. */
  after: Array<() => Promise<void>>;
}

const jsonOk = (requestId: string): Response => jsonResponse({}, requestId);

/** The webhook secrets of this deployment: the current one, and the previous one only during a rotation. */
function webhookSecrets(ctx: RequestContext): string[] {
  const { config } = ctx.deps;
  const secrets = [config.secret("PADDLE_WEBHOOK_SECRET").reveal()];
  if (config.hasSecret("PADDLE_WEBHOOK_SECRET_PREVIOUS")) secrets.push(config.secret("PADDLE_WEBHOOK_SECRET_PREVIOUS").reveal());
  return secrets;
}

const isApprovedChargeback = (ev: NormalizedEvent): boolean => ev.kind === "adjustment" && ev.action === "chargeback" && ev.status === "approved";

/**
 * Which account an event belongs to. After the first event of a purchase the STORED ids decide; `custom_data` can
 * never move a subscription or a customer.
 * - an adjustment or a transaction names its payment: the purchase index first (it survives a change of customer);
 * - then the subscription id, which also resolves a replaced or duplicate subscription;
 * - then the customer id, which also resolves a retired customer id;
 * - only for the first event of a subscription or transaction, the account id bound at checkout.
 */
async function resolveAccountId(env: BillingEnv, ev: NormalizedEvent): Promise<string | null> {
  const { accounts } = env.stores;
  if (ev.transactionId !== null && (ev.kind === "adjustment" || ev.kind === "transaction")) {
    const byPurchase = await accounts.findAccountIdByPurchase(ev.transactionId);
    if (byPurchase) return byPurchase;
  }
  if (ev.subscriptionId !== null) {
    const bySubscription = await accounts.findAccountIdByPaddleSubscription(ev.subscriptionId);
    if (bySubscription) return bySubscription;
  }
  if (ev.customerId !== null) {
    const byCustomer = await accounts.findAccountIdByPaddleCustomer(ev.customerId);
    if (byCustomer) return byCustomer;
  }
  if (ev.accountHint !== null && (ev.kind === "subscription" || ev.kind === "transaction")) {
    const account = await accounts.getById(ev.accountHint);
    if (account) return account.accountId;
  }
  return null;
}

/**
 * A late event (older than the newest applied one) still carries facts that do not depend on order: a paid
 * period, a pass purchase, a refund. Merge those with compare-and-set and leave status, flags and ordering alone.
 */
async function applyAdditive(env: BillingEnv, accountId: string, ev: NormalizedEvent): Promise<{ plan: PlanRecord | null; reduction: Reduction }> {
  const { accounts } = env.stores;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const account = await accounts.getById(accountId);
    const plan = await accounts.getPlan(accountId);
    if (!account) return { plan: null, reduction: { kind: "ignored" } };
    const reduction = reduceEvent(plan, ev, { accountId, prices: env.settings.prices, mode: "additive" });
    if (reduction.kind !== "applied") return { plan, reduction };
    const saved = await accounts.savePlan({ ...reduction.plan, lastEventAt: plan?.lastEventAt ?? null }, { expectedPlanVersion: account.planVersion });
    if (saved.ok) return { plan: reduction.plan, reduction };
    if (saved.reason === "not_found") return { plan: null, reduction: { kind: "ignored" } };
  }
  throw new Error("plan merge kept conflicting");
}

/** Chargebacks are a decision for the owner, whether or not the account could be found. */
function ownerReviews(env: BillingEnv, ev: NormalizedEvent, accountId: string | null): Array<() => Promise<void>> {
  if (!isApprovedChargeback(ev)) return [];
  return [() => env.notifier.requestOwnerReview({ kind: "chargeback", accountId: accountId ?? "unknown", transactionId: ev.transactionId })];
}

async function quarantine(env: BillingEnv, ev: NormalizedEvent, reason: string, accountId: string | null): Promise<Outcome> {
  return {
    state: "quarantined",
    fields: ledgerFields(ev),
    after: [
      () =>
        env.notifier.alertOperator({
          kind: "webhook_quarantined",
          eventId: ev.eventId,
          reason,
          ...(ev.subscriptionId ? { subscriptionId: ev.subscriptionId } : {}),
          ...(ev.customerId ? { customerId: ev.customerId } : {}),
        }),
      ...ownerReviews(env, ev, accountId),
    ],
  };
}

/**
 * A conflicting event that carries a subscription of its own (a duplicate bought by a parallel checkout, a
 * subscription bought during a pass) is quarantined AND that subscription is canceled at Paddle now, with a retry
 * record: the customer paid, the operator refunds, and the subscription must not keep billing. A pass is one-time:
 * nothing to cancel.
 */
async function quarantineConflict(env: BillingEnv, ev: NormalizedEvent, reason: ConflictReason, accountId: string): Promise<Outcome> {
  const outcome = await quarantine(env, ev, reason, accountId);
  const cancels = (reason === "duplicate_subscription" || reason === "plan_conflict") && ev.subscriptionId !== null && ev.kind !== "adjustment";
  if (cancels) {
    const subscriptionId = ev.subscriptionId!;
    const now = env.clock.now();
    const updated = await updatePlan(env, accountId, (plan) => {
      if (plan.paddleSubscriptionId === subscriptionId || (plan.extraCancels ?? []).some((e) => e.subscriptionId === subscriptionId)) return null;
      const next = structuredClone(plan);
      addExtraCancel(next, { subscriptionId, customerId: ev.customerId, reason: "duplicate", now });
      return next;
    });
    if (updated) outcome.after.push(() => attemptPendingCancel(env, accountId));
  }
  return outcome;
}

/**
 * Quarantined refunds and chargebacks are replayable: one that arrived before the purchase it refunds (or before the
 * account had any id to find it by) is applied as soon as a period carrying that payment, or the account's customer
 * or subscription, exists. Each replayed event is marked processed so it is not applied twice.
 */
async function replayQuarantinedAdjustments(env: BillingEnv, accountId: string, plan: PlanRecord): Promise<PlanRecord> {
  const quarantined = await env.stores.webhookEvents.listQuarantined();
  if (quarantined.length === 0) return plan;
  const purchases = new Set(plan.paidPeriods.map((p) => p.purchaseId).filter((id): id is string => id !== undefined));
  let current = plan;
  for (const record of quarantined) {
    const ev = eventFromRecord(record);
    if (!ev) continue;
    const belongs =
      ev.transactionId !== null
        ? purchases.has(ev.transactionId)
        : (ev.subscriptionId !== null && ev.subscriptionId === current.paddleSubscriptionId) || (ev.customerId !== null && ev.customerId === current.paddleCustomerId);
    if (!belongs) continue;
    const merged = await applyAdditive(env, accountId, ev);
    if (merged.plan) current = merged.plan;
    await env.stores.webhookEvents.markReplayed(record.eventId, env.clock.now());
  }
  return current;
}

async function processEvent(env: BillingEnv, ev: NormalizedEvent): Promise<Outcome> {
  const { accounts } = env.stores;
  const fields = ledgerFields(ev);
  if (ev.kind === "other") return { state: "processed", fields, after: [] };

  const accountId = await resolveAccountId(env, ev);
  if (accountId === null) return quarantine(env, ev, "unknown_account", null);
  const account = await accounts.getById(accountId);
  if (!account) return quarantine(env, ev, "unknown_account", null);

  const options = { accountId, prices: env.settings.prices } as const;
  const before = await accounts.getPlan(accountId);
  const dry = reduceEvent(before, ev, { ...options, mode: "full" });
  if (dry.kind === "conflict") return quarantineConflict(env, ev, dry.reason, accountId);

  const after: Array<() => Promise<void>> = [...ownerReviews(env, ev, accountId)];
  if (dry.kind === "review") {
    after.push(() => env.notifier.alertOperator({ kind: "partial_refund", accountId, transactionId: ev.transactionId }));
    return { state: "processed", fields, after };
  }

  let plan = before;
  let reduction: Reduction = dry;

  if (dry.kind === "applied") {
    // Ordering uses the event's time, but never further ahead than the signature tolerance: a wrong far-future
    // `occurred_at` must not freeze the plan against every later (correct) event.
    const orderAt = Math.min(ev.occurredAt, env.clock.now() + env.settings.signatureToleranceMs);
    const applied = await accounts.applyPlanEvent(accountId, orderAt, (current) => {
      // Re-run on the plan as the store sees it, atomically: another event may have landed since `before`.
      reduction = reduceEvent(current, ev, { ...options, mode: "full" });
      return reduction.kind === "applied" ? reduction.plan : (current ?? emptyPlan(accountId));
    });
    if (applied.applied) {
      plan = applied.plan;
    } else if (applied.reason === "not_found") {
      return quarantine(env, ev, "unknown_account", null);
    } else {
      const merged = await applyAdditive(env, accountId, ev);
      plan = merged.plan;
      reduction = merged.reduction;
    }
    if (reduction.kind === "conflict") return quarantineConflict(env, ev, reduction.reason, accountId);
    if (reduction.kind === "applied") {
      if (reduction.added.length > 0 && account.status === "deleting") {
        after.push(() => env.notifier.alertOperator({ kind: "purchase_while_deleting", accountId }));
      }
      if (reduction.customerAdopted && plan?.paddleCustomerId) {
        const customerId = plan.paddleCustomerId;
        after.push(() => env.notifier.alertOperator({ kind: "customer_adopted", accountId, customerId }));
      }
    }
    // A chargeback or refund that arrived before its purchase is waiting in quarantine: apply it now.
    if (plan) plan = await replayQuarantinedAdjustments(env, accountId, plan);
  }

  // Windows follow the plan. This also runs for a replay, so a crash between the plan write and the window write
  // is repaired by Paddle's retry. A dying account gets no new windows.
  if (plan && account.status !== "deleting") {
    const cuts = await syncWindows(env, accountId, plan);
    if (cuts.length > 0) after.push(() => env.notifier.grantCut({ accountId, cuts }));
  }
  if (plan && (plan.pendingCancel?.attempts === 0 || (plan.extraCancels ?? []).some((e) => e.attempts === 0))) {
    after.push(() => attemptPendingCancel(env, accountId));
  }
  return { state: "processed", fields, after };
}

export async function handlePaddleWebhook(ctx: RequestContext): Promise<Response> {
  const env = envFromDeps(ctx.deps);
  const header = ctx.request.headers.get("Paddle-Signature");
  // No signature header: nothing to verify and no reason to read the body.
  if (header === null) throw new ApiError("invalid_token", { message: "Invalid signature." });

  const raw = await ctx.body.bytes(); // size limit enforced while it streams in
  const verdict = await verifyPaddleSignature(header, raw, {
    secrets: webhookSecrets(ctx),
    now: env.clock.now(),
    toleranceMs: env.settings.signatureToleranceMs,
  });
  if (!verdict.ok) throw new ApiError("invalid_token", { message: "Invalid signature." });

  // Only now is the body parsed (the cached bytes, so the signed bytes are the parsed bytes).
  const body = await ctx.body.json();
  let ev: NormalizedEvent;
  try {
    ev = normalizeEvent(body);
  } catch (error) {
    if (error instanceof EventShapeError) throw new ApiError("invalid_request", { message: "The body is not a Paddle event." });
    throw error;
  }

  const claim = await env.stores.webhookEvents.claim({ eventId: ev.eventId, eventType: ev.eventType, occurredAt: ev.occurredAt }, env.clock.now(), env.settings.claimStaleAfterMs);
  if (claim.outcome === "duplicate") return jsonOk(ctx.requestId);
  if (claim.outcome === "in_progress") {
    // Another delivery is working on it. Answering 2xx would lose the event if that worker fails; ask Paddle to retry.
    throw new ApiError("provider_unavailable", { message: "Temporarily unavailable. Retry later.", retryAfterSeconds: 5 });
  }
  const attempt = claim.record.attempt;

  let outcome: Outcome;
  try {
    outcome = await processEvent(env, ev);
  } catch {
    // Name only: an error message could carry event text.
    console.error("billing: webhook processing failed");
    await env.stores.webhookEvents.release(ev.eventId, attempt).catch(() => false);
    throw new ApiError("provider_unavailable", { message: "Temporarily unavailable. Retry later.", retryAfterSeconds: 5 });
  }

  // A stale holder (its claim was taken over) gets null here: the new holder owns the record, our effects were idempotent.
  await env.stores.webhookEvents.complete(ev.eventId, attempt, outcome.state, outcome.fields, env.clock.now());
  for (const task of outcome.after) {
    ctx.waitUntil(task().catch(() => console.error("billing: background task failed")));
  }
  return jsonOk(ctx.requestId);
}
