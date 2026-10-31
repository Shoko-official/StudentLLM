// POST /v1/billing/checkout and GET /v1/billing/portal (operationIds createCheckout, getPortal).

import type { RequestContext } from "../../http/context";
import { requirePrincipal } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { CheckoutResponse, PortalResponse } from "../../types";
import { envFromDeps } from "./env";
import { PaddleError } from "./paddle-client";
import { checkoutEligibility, type PaidPlanId } from "./plan-model";
import { ensureCustomerOnPlan } from "./plan-store";

const PLANS: readonly PaidPlanId[] = ["plus_monthly", "plus_semester"];

/** `{ "plan": "plus_monthly" | "plus_semester" }` and nothing else: the client never supplies a price or custom data. */
export function parseCheckoutRequest(body: unknown): PaidPlanId {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalid_request");
  const keys = Object.keys(body);
  const plan = (body as Record<string, unknown>).plan;
  if (keys.length !== 1 || keys[0] !== "plan" || typeof plan !== "string" || !PLANS.includes(plan as PaidPlanId)) {
    throw new ApiError("invalid_request");
  }
  return plan as PaidPlanId;
}

const CHECKOUT_LOCK_MS = 15_000;

/** An https URL on one of the configured hosts (any https URL when none is configured: development only). */
export function allowedCheckoutUrl(url: string, hosts: readonly string[] | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
  return hosts === null || hosts.includes(parsed.hostname.toLowerCase());
}

const rfc3339 = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/** A failed Paddle call is a temporary condition for the client, never a detail of Paddle's answer. */
function paddleUnavailable(error: unknown): never {
  if (error instanceof PaddleError) throw new ApiError("provider_unavailable", { message: "Billing is temporarily unavailable.", retryAfterSeconds: 30 });
  throw error;
}

export async function handleCheckout(ctx: RequestContext): Promise<Response> {
  const principal = requirePrincipal(ctx);
  if (principal.kind !== "access") throw new ApiError("insufficient_scope");
  const env = envFromDeps(ctx.deps);
  const requested = parseCheckoutRequest(await ctx.body.json());

  // `already_subscribed`: an active plan exists (see checkoutEligibility). A grant never counts.
  const now = env.clock.now();
  if (!checkoutEligibility(ctx.plan ?? null, requested, now).ok) throw new ApiError("already_subscribed");

  const priceId = env.settings.prices[requested];
  if (priceId === null) throw new Error(`no Paddle price configured for ${requested}`); // 500: a deployment error, not the client's
  if (!ctx.account) throw new Error("checkout reached without an account");

  // A short per-account lock narrows the parallel-checkout race (two customers, two transactions, two subscriptions).
  // It is not the guarantee (the webhook is: a duplicate subscription is quarantined and canceled), only a cheap
  // reduction of how often that happens. The key is not an account id, so it never counts against inference's slots.
  const lock = await env.stores.concurrency.acquire(`billing:checkout:${principal.accountId}`, 1, CHECKOUT_LOCK_MS, now);
  if (!lock) throw new ApiError("concurrency_limit", { retryAfterSeconds: 5 });
  let checkoutUrl: string;
  try {
    // The Paddle customer is created on the server from the verified sign-in email and ALWAYS passed to the
    // transaction, so the first webhook can be checked against it. A parallel checkout that stored one first wins.
    let customerId = ctx.plan?.paddleCustomerId ?? null;
    if (customerId === null) {
      const created = (await env.paddle.createCustomer({ email: ctx.account.email, accountId: principal.accountId })).customerId;
      customerId = (await ensureCustomerOnPlan(env, principal.accountId, created)) ?? created;
    }
    // The server decides the price and the custom data.
    ({ checkoutUrl } = await env.paddle.createTransaction({ priceId, accountId: principal.accountId, customerId }));
  } catch (error) {
    return paddleUnavailable(error);
  } finally {
    await env.stores.concurrency.release(lock);
  }
  if (!allowedCheckoutUrl(checkoutUrl, env.settings.checkoutHosts)) {
    // Not an answer we can trust: never hand it to the client.
    throw new ApiError("provider_unavailable", { message: "Billing is temporarily unavailable.", retryAfterSeconds: 30 });
  }
  const body: CheckoutResponse = { checkout_url: checkoutUrl, expires_at: rfc3339(now + env.settings.checkoutTtlMs) };
  return jsonResponse(body, ctx.requestId);
}

export async function handlePortal(ctx: RequestContext): Promise<Response> {
  const principal = requirePrincipal(ctx);
  if (principal.kind !== "access") throw new ApiError("insufficient_scope");
  const env = envFromDeps(ctx.deps);
  const plan = ctx.plan ?? null;
  // No Paddle customer yet (nothing was ever bought): there is no portal to open.
  if (!plan?.paddleCustomerId) throw new ApiError("not_found", { message: "There is no billing account yet." });

  const now = env.clock.now();
  let session: { url: string; expiresAt: number | null };
  try {
    session = await env.paddle.createPortalSession({ customerId: plan.paddleCustomerId, subscriptionId: plan.paddleSubscriptionId });
  } catch (error) {
    return paddleUnavailable(error);
  }
  const body: PortalResponse = { url: session.url, expires_at: rfc3339(session.expiresAt ?? now + env.settings.portalTtlMs) };
  return jsonResponse(body, ctx.requestId);
}
