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
import { EventShapeError, ledgerFields, normalizeEvent, type NormalizedEvent } from "./events";
import { emptyPlan, reduceEvent, type Reduction } from "./plan-model";
import { syncWindows } from "./plan-store";
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

async function resolveAccountId(env: BillingEnv, ev: NormalizedEvent): Promise<string | null> {
  const { accounts } = env.stores;
  // After the first event the stored ids decide; `custom_data` can never move a subscription or a customer.
  if (ev.subscriptionId !== null) {
    const bySubscription = await accounts.findAccountIdByPaddleSubscription(ev.subscriptionId);
    if (bySubscription) return bySubscription;
  }
  if (ev.customerId !== null) {
    const byCustomer = await accounts.findAccountIdByPaddleCustomer(ev.customerId);
    if (byCustomer) return byCustomer;
  }
  // The account id bound at checkout identifies the FIRST event of a purchase only.
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

async function quarantine(env: BillingEnv, ev: NormalizedEvent, reason: string): Promise<Outcome> {
  return {
    state: "quarantined",
    fields: ledgerFields(ev),
    after: [() => env.notifier.alertOperator({ kind: "webhook_quarantined", eventId: ev.eventId, reason })],
  };
}

async function processEvent(env: BillingEnv, ev: NormalizedEvent): Promise<Outcome> {
  const { accounts } = env.stores;
  const fields = ledgerFields(ev);
  if (ev.kind === "other") return { state: "processed", fields, after: [] };

  const accountId = await resolveAccountId(env, ev);
  if (accountId === null) return quarantine(env, ev, "unknown_account");
  const account = await accounts.getById(accountId);
  if (!account) return quarantine(env, ev, "unknown_account");

  const options = { accountId, prices: env.settings.prices } as const;
  const before = await accounts.getPlan(accountId);
  const dry = reduceEvent(before, ev, { ...options, mode: "full" });
  if (dry.kind === "conflict") return quarantine(env, ev, dry.reason);

  const after: Array<() => Promise<void>> = [];
  let plan = before;
  let reduction: Reduction = dry;

  if (dry.kind === "applied") {
    const applied = await accounts.applyPlanEvent(accountId, ev.occurredAt, (current) => {
      // Re-run on the plan as the store sees it, atomically: another event may have landed since `before`.
      reduction = reduceEvent(current, ev, { ...options, mode: "full" });
      return reduction.kind === "applied" ? reduction.plan : (current ?? emptyPlan(accountId));
    });
    if (applied.applied) {
      plan = applied.plan;
    } else if (applied.reason === "not_found") {
      return quarantine(env, ev, "unknown_account");
    } else {
      const merged = await applyAdditive(env, accountId, ev);
      plan = merged.plan;
      reduction = merged.reduction;
    }
    if (reduction.kind === "conflict") return quarantine(env, ev, reduction.reason);
    if (reduction.kind === "applied" && reduction.added.length > 0 && account.status === "deleting") {
      after.push(() => env.notifier.alertOperator({ kind: "purchase_while_deleting", accountId }));
    }
    if (before?.paddleCustomerId && plan?.paddleCustomerId && before.paddleCustomerId !== plan.paddleCustomerId) {
      after.push(() => env.notifier.alertOperator({ kind: "customer_changed", accountId }));
    }
  }

  // Windows follow the plan. This also runs for a replay, so a crash between the plan write and the window write
  // is repaired by Paddle's retry. A dying account gets no new windows.
  if (plan && account.status !== "deleting") await syncWindows(env, accountId, plan);
  if (plan?.pendingCancel && plan.pendingCancel.attempts === 0) after.push(() => attemptPendingCancel(env, accountId));
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
