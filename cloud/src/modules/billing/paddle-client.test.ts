import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../config";
import { testEnv } from "../../testing";
import { createHttpPaddleClient, PaddleError } from "./paddle-client";
import { assertApiKeyMatchesEnvironment, DEFAULT_WINDOW_CREDITS, loadBillingSettings } from "./settings";

const KEY = "pdl_sdbx_apikey_test_0123456789abcdef0123456789abcdef";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    seen.push(entry);
    return respond(entry);
  }) as typeof fetch;
  return { fetch: f, seen };
}

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });

function client(f: typeof fetch, environment: "sandbox" | "live" = "sandbox", apiKey = KEY) {
  return createHttpPaddleClient({ fetch: f, environment, apiKey: () => apiKey });
}

describe("the Paddle HTTP client", () => {
  it("creates the customer on the server from the email and returns its id", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ id: "ctm_01abcdefghij" }));
    expect(await client(fetch).createCustomer({ email: "student@example.invalid", accountId: "acc_1" })).toEqual({ customerId: "ctm_01abcdefghij" });
    expect(seen[0]).toMatchObject({ url: "https://sandbox-api.paddle.com/customers", method: "POST", body: { email: "student@example.invalid", custom_data: { account_id: "acc_1" } } });
    expect(seen[0]!.url).not.toContain("student"); // the address is in the body, never in a URL
  });

  it("reuses the customer Paddle already has for that email (the id is read by a strict pattern, nothing else is kept)", async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: { code: "conflict", detail: "customer email conflicts with customer of id ctm_01zzzzzzzzzz; Jane Doe" } }), { status: 409 }));
    expect(await client(fetch).createCustomer({ email: "a@example.invalid", accountId: "acc_1" })).toEqual({ customerId: "ctm_01zzzzzzzzzz" });
    const none = fakeFetch(() => new Response("{}", { status: 409 }));
    const error = await client(none.fetch).createCustomer({ email: "a@example.invalid", accountId: "acc_1" }).catch((e: unknown) => e);
    expect((error as PaddleError).failure).toBe("conflict");
    expect((error as PaddleError).existingId).toBeUndefined();
  });

  it("creates a transaction with the price, the account id as the only custom data, and the account's customer", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ id: "txn_1", checkout: { url: "https://pay.example.invalid/checkout?x=1" } }));
    const result = await client(fetch).createTransaction({ priceId: "pri_1", accountId: "acc_1", customerId: "ctm_1" });
    expect(result).toEqual({ transactionId: "txn_1", checkoutUrl: "https://pay.example.invalid/checkout?x=1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://sandbox-api.paddle.com/transactions", method: "POST", redirect: "manual" });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toEqual({ items: [{ price_id: "pri_1", quantity: 1 }], collection_mode: "automatic", custom_data: { account_id: "acc_1" }, customer_id: "ctm_1" });
  });

  it("uses the live host only for the live environment", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ id: "sub_1", status: "active" }));
    await client(fetch, "live", "pdl_live_apikey_test_0123456789abcdef0123456789abcdef").getSubscription("sub_1");
    expect(seen[0]!.url).toBe("https://api.paddle.com/subscriptions/sub_1");
  });

  it("refuses an API key of the other environment before any call", async () => {
    const { fetch, seen } = fakeFetch(() => ok({}));
    await expect(client(fetch, "live", KEY).getSubscription("sub_1")).rejects.toThrow(ConfigError);
    await expect(client(fetch, "sandbox", "pdl_live_apikey_x").getSubscription("sub_1")).rejects.toThrow(ConfigError);
    expect(seen).toEqual([]);
    expect(() => assertApiKeyMatchesEnvironment("some-test-key", "live")).not.toThrow(); // no known prefix: tests, format changes
  });

  it("reads a subscription down to ids, status, period and the scheduled cancel", async () => {
    const { fetch } = fakeFetch(() =>
      ok({
        id: "sub_1",
        status: "active",
        customer_id: "ctm_1",
        current_billing_period: { starts_at: "2026-11-01T09:30:00Z", ends_at: "2026-12-01T09:30:00Z" },
        scheduled_change: { action: "cancel", effective_at: "2026-12-01T09:30:00Z" },
        address: { city: "Paris" },
        name: "Jane Doe",
      }),
    );
    const sub = await client(fetch).getSubscription("sub_1");
    expect(sub).toEqual({ id: "sub_1", status: "active", customerId: "ctm_1", periodStart: Date.UTC(2026, 10, 1, 9, 30), periodEnd: Date.UTC(2026, 11, 1, 9, 30), cancelScheduled: true });
    expect(JSON.stringify(sub)).not.toMatch(/Paris|Jane/);
  });

  it("cancels with the effective_from Paddle expects", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ id: "sub_1", status: "active", scheduled_change: { action: "cancel" } }));
    await client(fetch).cancelSubscription("sub_1", "next_billing_period");
    await client(fetch).cancelSubscription("sub_1", "immediately");
    expect(seen.map((s) => [s.url, s.method, s.body])).toEqual([
      ["https://sandbox-api.paddle.com/subscriptions/sub_1/cancel", "POST", { effective_from: "next_billing_period" }],
      ["https://sandbox-api.paddle.com/subscriptions/sub_1/cancel", "POST", { effective_from: "immediately" }],
    ]);
  });

  it("opens a portal session for the customer and only https URLs are accepted", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ urls: { general: { overview: "https://portal.example.invalid/overview" } }, expires_at: "2026-11-01T10:30:00Z" }));
    expect(await client(fetch).createPortalSession({ customerId: "ctm_1", subscriptionId: "sub_1" })).toEqual({ url: "https://portal.example.invalid/overview", expiresAt: Date.UTC(2026, 10, 1, 10, 30) });
    expect(seen[0]).toMatchObject({ url: "https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions", body: { subscription_ids: ["sub_1"] } });
    const bad = fakeFetch(() => ok({ urls: { general: { overview: "javascript:alert(1)" } } }));
    await expect(client(bad.fetch).createPortalSession({ customerId: "ctm_1", subscriptionId: null })).rejects.toBeInstanceOf(PaddleError);
    const badCheckout = fakeFetch(() => ok({ id: "txn_1", checkout: { url: "http://insecure.example.invalid/" } }));
    await expect(client(badCheckout.fetch).createTransaction({ priceId: "p", accountId: "a", customerId: "ctm_1" })).rejects.toBeInstanceOf(PaddleError);
  });

  it("maps statuses to fixed failures and never carries Paddle's error text", async () => {
    const cases: Array<[number, string]> = [[401, "unauthorized"], [403, "unauthorized"], [404, "not_found"], [409, "conflict"], [400, "rejected"], [422, "rejected"], [429, "unavailable"], [500, "unavailable"], [503, "unavailable"]];
    for (const [status, failure] of cases) {
      const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: { detail: "Jane Doe 4242 jane@example.invalid" } }), { status }));
      const error = await client(fetch).getSubscription("sub_1").catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(PaddleError);
      expect((error as PaddleError).failure).toBe(failure);
      expect(String((error as Error).message) + JSON.stringify(error)).not.toMatch(/Jane|4242|jane@/);
    }
  });

  it("treats a network failure, a bad body and a missing field as unavailable", async () => {
    for (const respond of [
      () => {
        throw new TypeError("fetch failed: https://sandbox-api.paddle.com/?token=secret");
      },
      () => new Response("<html>", { status: 200 }),
      () => ok({ nothing: true }),
      () => ok({ id: "sub_1" }), // no status
    ]) {
      const { fetch } = fakeFetch(respond);
      const error = await client(fetch).getSubscription("sub_1").catch((e: unknown) => e);
      expect((error as PaddleError).failure).toBe("unavailable");
      expect(String((error as Error).message)).not.toMatch(/token|secret/);
    }
  });

  it("will not put an id with a path character into the URL", async () => {
    const { fetch, seen } = fakeFetch(() => ok({ id: "x", status: "active" }));
    for (const id of ["../customers", "sub_1/cancel", "sub 1", "", "sub_1?x=1"]) {
      await expect(client(fetch).getSubscription(id)).rejects.toBeInstanceOf(PaddleError);
    }
    expect(seen).toEqual([]);
  });

  it("reads the API key at call time, so a missing key fails the call and not the Worker", async () => {
    const { fetch } = fakeFetch(() => ok({ id: "sub_1", status: "active" }));
    const c = createHttpPaddleClient({
      fetch,
      environment: "sandbox",
      apiKey: () => {
        throw new ConfigError("missing secret PADDLE_API_KEY");
      },
    });
    await expect(c.getSubscription("sub_1")).rejects.toThrow(ConfigError);
  });
});

describe("loadBillingSettings", () => {
  const config = (env: Record<string, string | undefined> = {}) => loadConfig(testEnv(env));

  it("reads the price ids and the window budgets, with the placeholder budget as default", () => {
    const s = loadBillingSettings(config({ PADDLE_PRICE_PLUS_MONTHLY: "pri_m", PADDLE_PRICE_PLUS_SEMESTER: "pri_s" }));
    expect(s.prices).toEqual({ plus_monthly: "pri_m", plus_semester: "pri_s" });
    expect(s.windowCredits).toEqual({ plus_monthly: DEFAULT_WINDOW_CREDITS, plus_semester: DEFAULT_WINDOW_CREDITS });
    expect(s.environment).toBe("sandbox");
    const custom = loadBillingSettings(config({ PLUS_MONTHLY_WINDOW_CREDITS: "9000", PLUS_SEMESTER_WINDOW_CREDITS: "7000" }));
    expect(custom.windowCredits).toEqual({ plus_monthly: 9000, plus_semester: 7000 });
  });

  it("rejects a budget that is not a positive whole number", () => {
    for (const bad of ["0", "-5", "12.5", "1e4", "abc", "01", "1234567890"]) {
      expect(() => loadBillingSettings(config({ PLUS_MONTHLY_WINDOW_CREDITS: bad })), bad).toThrow(ConfigError);
    }
  });

  it("allows missing prices in development but not in staging or production, and never a template value", () => {
    expect(loadBillingSettings(config()).prices).toEqual({ plus_monthly: null, plus_semester: null });
    for (const environment of ["staging", "production"]) {
      const env = { ENVIRONMENT: environment, GATEWAY_ISSUER: "https://api.studentllm.example", TERMS_VERSION: "2026-11-01", GOOGLE_CLIENT_ID: "client", PADDLE_CHECKOUT_HOSTS: "pay.studentllm.example" };
      expect(() => loadBillingSettings(config({ ...env, PADDLE_CHECKOUT_HOSTS: undefined }))).toThrow(/PADDLE_CHECKOUT_HOSTS/);
      expect(() => loadBillingSettings(config({ ...env, PADDLE_CHECKOUT_HOSTS: "PLACEHOLDER-host" }))).toThrow(/PADDLE_CHECKOUT_HOSTS/);
      expect(() => loadBillingSettings(config(env))).toThrow(/PADDLE_PRICE_PLUS_MONTHLY/);
      expect(() => loadBillingSettings(config({ ...env, PADDLE_PRICE_PLUS_MONTHLY: "pri_m" }))).toThrow(/PADDLE_PRICE_PLUS_SEMESTER/);
      expect(() => loadBillingSettings(config({ ...env, PADDLE_PRICE_PLUS_MONTHLY: "PLACEHOLDER-price", PADDLE_PRICE_PLUS_SEMESTER: "pri_s" }))).toThrow(ConfigError);
      expect(() => loadBillingSettings(config({ ...env, PADDLE_PRICE_PLUS_MONTHLY: "pri_same", PADDLE_PRICE_PLUS_SEMESTER: "pri_same" }))).toThrow(/differ/);
      expect(loadBillingSettings(config({ ...env, PADDLE_PRICE_PLUS_MONTHLY: "pri_m", PADDLE_PRICE_PLUS_SEMESTER: "pri_s" })).prices.plus_monthly).toBe("pri_m");
    }
  });

  it("reads the checkout hosts as a lower-case list, and refuses something that is not a host name", () => {
    expect(loadBillingSettings(config({ PADDLE_CHECKOUT_HOSTS: " Pay.Example.Invalid , buy.example.invalid " })).checkoutHosts).toEqual(["pay.example.invalid", "buy.example.invalid"]);
    expect(loadBillingSettings(config()).checkoutHosts).toBeNull();
    expect(() => loadBillingSettings(config({ PADDLE_CHECKOUT_HOSTS: "https://pay.example.invalid/path" }))).toThrow(ConfigError);
  });

  it("is refused at start when the API key belongs to the other environment", () => {
    // createBillingDeps checks the key's own prefix against PADDLE_ENVIRONMENT (see the billing module tests).
    expect(() => assertApiKeyMatchesEnvironment("pdl_sdbx_apikey_x", "live")).toThrow(ConfigError);
  });

  it("has a short signature tolerance and conservative defaults", () => {
    const s = loadBillingSettings(config());
    expect(s.signatureToleranceMs).toBeLessThanOrEqual(5 * 60_000);
    expect(s.claimStaleAfterMs).toBeGreaterThan(0);
    expect(s.cancel.alertAfterAttempts).toBeGreaterThan(1);
  });
});
