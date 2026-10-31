// The outbound side of Paddle: what the gateway asks Paddle to do. An interface, so tests inject a fake and no
// test makes a network call; `createHttpPaddleClient` is the real adapter over the injected `fetch`.
//
// VERIFY BEFORE LAUNCH (docs/cloud-plan.md, "Before phase 3"): every path, field name and status value below
// follows Paddle Billing's API as the plan's authors understood it. Recheck them against Paddle's current
// documentation, in the sandbox, before the first live transaction.

import { ConfigError } from "../../config";
import { assertApiKeyMatchesEnvironment } from "./settings";

/** What a failed Paddle call means for the caller. Provider text never leaves this file. */
export type PaddleFailure = "unavailable" | "rejected" | "not_found" | "conflict" | "unauthorized";

export class PaddleError extends Error {
  readonly failure: PaddleFailure;
  /**
   * Set only on a `conflict` when creating a customer: the id of the customer that already has the email, taken from
   * Paddle's answer by a strict id pattern (nothing else of the answer is kept).
   */
  readonly existingId: string | undefined;
  constructor(failure: PaddleFailure, existingId?: string) {
    // A fixed message: provider error text could carry customer data and must not reach a log.
    super(`paddle call failed: ${failure}`);
    this.name = "PaddleError";
    this.failure = failure;
    this.existingId = existingId;
  }
}

/** The part of a Paddle subscription the gateway reads. Ids, status and period only. */
export interface PaddleSubscription {
  id: string;
  status: string;
  customerId: string | null;
  /** Epoch ms, or null when Paddle reports none. */
  periodStart: number | null;
  periodEnd: number | null;
  /** True when a cancellation is scheduled (`scheduled_change.action` is `cancel`). */
  cancelScheduled: boolean;
}

export interface PaddleClient {
  /**
   * Creates the Paddle customer for an account from its verified sign-in email, on the server, so the customer id
   * is known before any payment. If Paddle already has a customer with that email, that customer's id is returned.
   */
  createCustomer(input: { email: string; accountId: string }): Promise<{ customerId: string }>;
  /** Creates a draft transaction for the account's own customer and returns the hosted checkout URL. */
  createTransaction(input: { priceId: string; accountId: string; customerId: string }): Promise<{ transactionId: string; checkoutUrl: string }>;
  /** Creates an authenticated customer-portal session. `expiresAt` is epoch ms when Paddle reports one. */
  createPortalSession(input: { customerId: string; subscriptionId: string | null }): Promise<{ url: string; expiresAt: number | null }>;
  getSubscription(subscriptionId: string): Promise<PaddleSubscription>;
  /** `next_billing_period` schedules a cancel at the end of the paid period; `immediately` ends it now. */
  cancelSubscription(subscriptionId: string, effectiveFrom: "next_billing_period" | "immediately"): Promise<PaddleSubscription>;
}

const BASE_URL = { sandbox: "https://sandbox-api.paddle.com", live: "https://api.paddle.com" } as const;

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function subscriptionFrom(data: Record<string, unknown>): PaddleSubscription {
  const period = asObject(data.current_billing_period);
  const change = asObject(data.scheduled_change);
  if (typeof data.id !== "string" || typeof data.status !== "string") throw new PaddleError("unavailable");
  return {
    id: data.id,
    status: data.status,
    customerId: typeof data.customer_id === "string" ? data.customer_id : null,
    periodStart: parseTime(period?.starts_at),
    periodEnd: parseTime(period?.ends_at),
    cancelScheduled: change?.action === "cancel",
  };
}

export interface HttpPaddleClientOptions {
  fetch: typeof fetch;
  environment: "sandbox" | "live";
  /** Read at call time, so a missing key fails the call (and is a ConfigError) rather than the whole Worker. */
  apiKey: () => string;
  timeoutMs?: number;
}

/**
 * Paddle over HTTPS. Responses are reduced to the few fields above; error bodies are never read into a
 * message. Redirects are not followed, the host is fixed by the environment and the key never leaves the
 * Authorization header.
 */
export function createHttpPaddleClient(options: HttpPaddleClientOptions): PaddleClient {
  const base = BASE_URL[options.environment];

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const key = options.apiKey();
    assertApiKeyMatchesEnvironment(key, options.environment);
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new PaddleError("unavailable");
    }
    if (response.status === 401 || response.status === 403) throw new PaddleError("unauthorized");
    if (response.status === 404) throw new PaddleError("not_found");
    if (response.status === 409) {
      let existing: string | undefined;
      try {
        existing = /\bctm_[a-z0-9]{10,40}\b/i.exec(await response.text())?.[0];
      } catch {
        existing = undefined;
      }
      throw new PaddleError("conflict", existing);
    }
    if (response.status === 429 || response.status >= 500) throw new PaddleError("unavailable");
    if (response.status < 200 || response.status >= 300) throw new PaddleError("rejected");
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new PaddleError("unavailable");
    }
    const data = asObject(asObject(parsed)?.data);
    if (!data) throw new PaddleError("unavailable");
    return data;
  }

  const segment = (id: string): string => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new PaddleError("rejected");
    return encodeURIComponent(id);
  };

  return {
    async createCustomer({ email, accountId }) {
      try {
        const data = await call("POST", "/customers", { email, custom_data: { account_id: accountId } });
        if (typeof data.id !== "string") throw new PaddleError("unavailable");
        return { customerId: data.id };
      } catch (error) {
        if (error instanceof PaddleError && error.failure === "conflict" && error.existingId) return { customerId: error.existingId };
        throw error;
      }
    },

    async createTransaction({ priceId, accountId, customerId }) {
      const data = await call("POST", "/transactions", {
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        // Only the opaque account id: it identifies the account in the operator's tools and nothing else.
        custom_data: { account_id: accountId },
        customer_id: customerId,
      });
      const checkout = asObject(data.checkout);
      if (typeof data.id !== "string" || typeof checkout?.url !== "string" || !checkout.url.startsWith("https://")) {
        throw new PaddleError("unavailable");
      }
      return { transactionId: data.id, checkoutUrl: checkout.url };
    },

    async createPortalSession({ customerId, subscriptionId }) {
      const data = await call("POST", `/customers/${segment(customerId)}/portal-sessions`, subscriptionId ? { subscription_ids: [subscriptionId] } : {});
      const general = asObject(asObject(data.urls)?.general);
      if (typeof general?.overview !== "string" || !general.overview.startsWith("https://")) throw new PaddleError("unavailable");
      return { url: general.overview, expiresAt: parseTime(data.expires_at) };
    },

    async getSubscription(subscriptionId) {
      return subscriptionFrom(await call("GET", `/subscriptions/${segment(subscriptionId)}`));
    },

    async cancelSubscription(subscriptionId, effectiveFrom) {
      return subscriptionFrom(await call("POST", `/subscriptions/${segment(subscriptionId)}/cancel`, { effective_from: effectiveFrom }));
    },
  };
}
