// Test-only: a Paddle fake, event builders, a webhook signer and an app wired for the billing tests.
// No network: the fake replaces the Paddle client and the app's fetch still throws.

import { hmacSha256Hex } from "../crypto/hash";
import { loadConfig } from "../config";
import type { CoreDeps } from "../deps";
import { createBillingDeps, type BillingDeps, type BillingOverrides } from "../modules/billing";
import type { BillingNotifier, OperatorAlert } from "../modules/billing/notifier";
import { PaddleError, type PaddleClient, type PaddleFailure, type PaddleSubscription } from "../modules/billing/paddle-client";
import type { ExecutionContext } from "../platform";
import { createInMemoryStores, type AccountRecord, type PlanRecord, type Stores } from "../storage";
import { accessPrincipal, fakeAuthenticate, fakeExecutionContext, makeTestApp, ManualClock, testEnv, type TestApp, type TestAppOptions } from "./test-app";

export const PRICE_MONTHLY = "pri_monthly_test";
export const PRICE_SEMESTER = "pri_semester_test";
export const WEBHOOK_SECRET = "whsec_test_current_0123456789abcdef0123456789abcdef";
export const WEBHOOK_SECRET_PREVIOUS = "whsec_test_previous_0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------------------------------------------
// The fake Paddle
// ---------------------------------------------------------------------------------------------------------------

export class FakePaddle implements PaddleClient {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly subscriptions = new Map<string, PaddleSubscription>();
  /** Failures to throw, consumed one per call of the named method. */
  private readonly failures: Array<{ method: string; failure: PaddleFailure }> = [];
  private n = 0;

  failNext(method: "createTransaction" | "createPortalSession" | "getSubscription" | "cancelSubscription", failure: PaddleFailure = "unavailable", times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ method, failure });
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const i = this.failures.findIndex((f) => f.method === method);
    if (i >= 0) throw new PaddleError(this.failures.splice(i, 1)[0]!.failure);
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  async createTransaction(input: { priceId: string; accountId: string; customerId: string | null }) {
    this.record("createTransaction", [input]);
    this.n++;
    return { transactionId: `txn_fake_${this.n}`, checkoutUrl: `https://checkout.paddle.example.invalid/pay?_ptxn=txn_fake_${this.n}` };
  }

  async createPortalSession(input: { customerId: string; subscriptionId: string | null }) {
    this.record("createPortalSession", [input]);
    return { url: `https://portal.paddle.example.invalid/${input.customerId}`, expiresAt: null };
  }

  async getSubscription(subscriptionId: string) {
    this.record("getSubscription", [subscriptionId]);
    const s = this.subscriptions.get(subscriptionId);
    if (!s) throw new PaddleError("not_found");
    return { ...s };
  }

  async cancelSubscription(subscriptionId: string, effectiveFrom: "next_billing_period" | "immediately") {
    this.record("cancelSubscription", [subscriptionId, effectiveFrom]);
    const s = this.subscriptions.get(subscriptionId) ?? { id: subscriptionId, status: "active", customerId: null, periodStart: null, periodEnd: null, cancelScheduled: false };
    if (s.status === "canceled") throw new PaddleError("conflict");
    const next = effectiveFrom === "immediately" ? { ...s, status: "canceled", cancelScheduled: false } : { ...s, cancelScheduled: true };
    this.subscriptions.set(subscriptionId, next);
    return { ...next };
  }
}

export class FakeNotifier implements BillingNotifier {
  readonly cancellations: Array<{ accountId: string; when: "period_end" | "now"; effectiveAt: number | null }> = [];
  readonly alerts: OperatorAlert[] = [];
  async subscriptionCancelled(input: { accountId: string; when: "period_end" | "now"; effectiveAt: number | null }) {
    this.cancellations.push(input);
  }
  async alertOperator(alert: OperatorAlert) {
    this.alerts.push(alert);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signing and events
// ---------------------------------------------------------------------------------------------------------------

/** `ts=<seconds>;h1=<hex>` over `<ts>:<body>`. Pass several secrets for a header with several h1 values. */
export async function paddleSignature(secrets: string | string[], body: string | Uint8Array, atMs: number): Promise<string> {
  const ts = Math.floor(atMs / 1000);
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const prefix = new TextEncoder().encode(`${ts}:`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const digests = await Promise.all(list.map((s) => hmacSha256Hex(s, signed)));
  return `ts=${ts};${digests.map((d) => `h1=${d}`).join(";")}`;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

let eventCounter = 0;
export const nextEventId = (): string => `evt_test_${String(++eventCounter).padStart(6, "0")}`;

interface Common {
  eventId?: string;
  occurredAt: number;
  accountId?: string | null;
  customerId?: string;
  /** Extra personal fields a real payload carries; the gateway must drop them. */
  noise?: boolean;
}

const NOISE = {
  customer: { name: "Jane Doe", email: "jane@example.invalid" },
  address: { first_line: "1 Rue Exemple", city: "Paris", postal_code: "75001", country_code: "FR" },
  payments: [{ method_details: { type: "card", card: { last4: "4242", holder_name: "Jane Doe" } } }],
  business: { name: "Doe SARL", tax_identifier: "FR12345678901" },
};

export function subscriptionEvent(
  input: Common & {
    type?: string;
    subscriptionId: string;
    status?: string;
    periodStart?: number;
    periodEnd?: number;
    /** undefined: omit the key; null: no scheduled change; "cancel": cancel at the period end. */
    scheduled?: null | "cancel" | "pause";
    priceId?: string | null;
  },
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: input.subscriptionId,
    status: input.status ?? "active",
    customer_id: input.customerId ?? "ctm_test_1",
    currency_code: "EUR",
    custom_data: input.accountId === null ? null : { account_id: input.accountId ?? "acc_test" },
    items: input.priceId === null ? [] : [{ status: "active", quantity: 1, price: { id: input.priceId ?? PRICE_MONTHLY, name: "Plus monthly" } }],
    ...(input.noise ? NOISE : {}),
  };
  if (input.periodStart !== undefined && input.periodEnd !== undefined) {
    data.current_billing_period = { starts_at: iso(input.periodStart), ends_at: iso(input.periodEnd) };
  }
  if (input.scheduled !== undefined) data.scheduled_change = input.scheduled === null ? null : { action: input.scheduled, effective_at: iso(input.periodEnd ?? input.occurredAt) };
  return { event_id: input.eventId ?? nextEventId(), event_type: input.type ?? "subscription.updated", occurred_at: iso(input.occurredAt), notification_id: "ntf_x", data };
}

export function transactionEvent(
  input: Common & { transactionId: string; subscriptionId?: string | null; periodStart?: number; periodEnd?: number; priceId?: string; type?: string },
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: input.transactionId,
    status: "completed",
    customer_id: input.customerId ?? "ctm_test_1",
    subscription_id: input.subscriptionId ?? null,
    currency_code: "EUR",
    custom_data: input.accountId === null ? null : { account_id: input.accountId ?? "acc_test" },
    items: [{ quantity: 1, price: { id: input.priceId ?? (input.subscriptionId ? PRICE_MONTHLY : PRICE_SEMESTER) } }],
    ...(input.noise ? NOISE : {}),
  };
  if (input.periodStart !== undefined && input.periodEnd !== undefined) data.billing_period = { starts_at: iso(input.periodStart), ends_at: iso(input.periodEnd) };
  return { event_id: input.eventId ?? nextEventId(), event_type: input.type ?? "transaction.completed", occurred_at: iso(input.occurredAt), notification_id: "ntf_x", data };
}

export function adjustmentEvent(input: Common & { adjustmentId?: string; transactionId?: string | null; subscriptionId?: string; action?: string; status?: string; type?: string }): Record<string, unknown> {
  return {
    event_id: input.eventId ?? nextEventId(),
    event_type: input.type ?? "adjustment.updated",
    occurred_at: iso(input.occurredAt),
    notification_id: "ntf_x",
    data: {
      id: input.adjustmentId ?? "adj_test_1",
      action: input.action ?? "refund",
      status: input.status ?? "approved",
      transaction_id: input.transactionId === undefined ? "txn_test_1" : input.transactionId,
      subscription_id: input.subscriptionId ?? null,
      customer_id: input.customerId ?? "ctm_test_1",
      currency_code: "EUR",
      ...(input.noise ? NOISE : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

export const ACCOUNT_ID = "acc_test";

export interface BillingTestApp {
  t: TestApp;
  stores: Stores;
  clock: ManualClock;
  paddle: FakePaddle;
  notifier: FakeNotifier;
  billing: BillingDeps;
  /** The last execution context: `await exec.settled()` waits for the work that runs after the response. */
  exec: ExecutionContext & { settled(): Promise<void> };
  /** Creates the account (and optionally a plan) the events and requests refer to. */
  createAccount(id?: string, email?: string): Promise<AccountRecord>;
  /** Posts a signed webhook. Pass `signAs`/`body`/`header` to forge or damage it. */
  webhook(event: unknown, options?: { signWith?: string | string[]; at?: number; header?: string | null; rawBody?: string | Uint8Array; headers?: Record<string, string> }): Promise<Response>;
  plan(id?: string): Promise<PlanRecord | null>;
  /** An authenticated request as `accountId` (the principal comes from a fake authenticate hook). */
  as(request: string, init?: RequestInit): Promise<Response>;
}

export interface BillingTestOptions extends Omit<TestAppOptions, "deps"> {
  overrides?: BillingOverrides;
  accountId?: string;
}

export function makeBillingTestApp(options: BillingTestOptions = {}): BillingTestApp {
  const clock = options.clock ?? new ManualClock();
  const stores = options.stores ?? createInMemoryStores();
  const env = testEnv({
    PADDLE_PRICE_PLUS_MONTHLY: PRICE_MONTHLY,
    PADDLE_PRICE_PLUS_SEMESTER: PRICE_SEMESTER,
    PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PADDLE_WEBHOOK_SECRET_PREVIOUS: WEBHOOK_SECRET_PREVIOUS,
    ...options.env,
  });
  const config = options.config ?? loadConfig(env);
  const paddle = new FakePaddle();
  const notifier = new FakeNotifier();
  const core: CoreDeps = {
    config,
    clock,
    stores,
    ids: { requestId: () => "req_core" },
    fetch: () => {
      throw new Error("network access is not allowed in tests");
    },
    log: { request: () => undefined },
  };
  const billing = createBillingDeps(core, { paddle, notifier, ...options.overrides });
  const accountId = options.accountId ?? ACCOUNT_ID;
  const t = makeTestApp({
    ...options,
    env,
    config,
    clock,
    stores,
    deps: { billing },
    allowMissingHooks: options.allowMissingHooks ?? true,
    hooks: { authenticate: fakeAuthenticate(accessPrincipal({ accountId })), ...options.hooks },
  });
  const state = { exec: fakeExecutionContext() };
  const app: BillingTestApp = {
    t,
    stores,
    clock,
    paddle,
    notifier,
    billing,
    get exec() {
      return state.exec;
    },
    async createAccount(id = accountId, email = `${id}@example.invalid`) {
      const r = await stores.accounts.create({ accountId: id, email, googleSubject: null, loginMethods: ["email"], termsVersion: "2026-11-01", now: clock.now() });
      if (!r.ok) throw new Error("account setup failed");
      return r.account;
    },
    async webhook(event, o = {}) {
      const raw = o.rawBody ?? JSON.stringify(event);
      const header = o.header !== undefined ? o.header : await paddleSignature(o.signWith ?? WEBHOOK_SECRET, raw, o.at ?? clock.now());
      const headers: Record<string, string> = { "Content-Type": "application/json", ...o.headers };
      if (header !== null) headers["Paddle-Signature"] = header;
      state.exec = fakeExecutionContext();
      const response = await t.app.handle(new Request("https://api.example.invalid/webhooks/paddle", { method: "POST", headers, body: raw as BodyInit }), state.exec);
      await state.exec.settled();
      return response;
    },
    plan: (id = accountId) => stores.accounts.getPlan(id),
    async as(request, init) {
      state.exec = fakeExecutionContext();
      const response = await t.app.handle(new Request(new URL(request, "https://api.example.invalid"), init), state.exec);
      await state.exec.settled();
      return response;
    },
  };
  return app;
}
