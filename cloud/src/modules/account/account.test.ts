import { describe, expect, it, vi } from "vitest";
import { expectFixtureConformance, loadFixture, validateAgainst } from "../../testing";
import { bearer, makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { dumpStore, dumpStores } from "../../testing/dump-stores";
import { createInMemoryStores } from "../../storage";
import { chaosStores } from "../../testing/store-contract";
import type { TokenResponse } from "../../types";
import type { BillingSeam, InferenceSeam } from "../seams";
import { ALERT_AFTER_ATTEMPTS, DELETION_RETRY_PERIOD_MS, backoffMs } from "./deletion";

const ADDRESS = "student@example.invalid";
const code = async (res: Response) => (await res.json()).error.code as string;
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function signedIn(t: AuthHarness) {
  const tokens = await t.signedIn(ADDRESS);
  return { tokens, auth: bearer(tokens.access_token), accountId: tokens.account.account_id };
}

describe("checkTermsAndStatus", () => {
  // Every route a signed-in client can reach in the auth and account modules, with the ones the contract exempts.
  const EXEMPT: Array<[string, string, unknown?]> = [
    ["GET", "/v1/account"],
    ["GET", "/v1/devices"],
    ["POST", "/v1/account/terms", { terms_version: "2026-11-01" }],
  ];
  const GATED: Array<[string, string, unknown?]> = [
    ["GET", "/v1/provider-sets"],
    // A grant: POST /v1/consent is exempt from the gating for withdrawals, but the handler gates a grant like any gated route.
    ["POST", "/v1/consent", { provider_set: "ps1", provider_set_version: 1, features: ["chat"], text_version: "2026-11-01", granted: true }],
    ["POST", "/v1/account/link", { method: "google" }],
    ["DELETE", "/v1/account/login-methods/google"],
  ];
  const send = (t: AuthHarness, headers: Record<string, string>, [method, path, body]: [string, string, unknown?]) =>
    t.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("blocks the gated routes of a suspended account with account_suspended and never the exempt ones", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.update(accountId, { status: "suspended" });
    for (const route of GATED) {
      const res = await send(t, auth, route);
      expect(res.status, route.join(" ")).toBe(403);
      expect(await code(res), route.join(" ")).toBe("account_suspended");
    }
    for (const route of EXEMPT) {
      const res = await send(t, auth, route);
      expect(res.status, route.join(" ")).toBeLessThan(400);
    }
    // Export and delete are exempt too (fresh sign-in is the only gate they have).
    expect((await t.get("/v1/account/export", auth)).status).toBe(200);
  });

  it("blocks the gated routes of an account with outdated terms with terms_required, details included", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.acceptTerms(accountId, "2025-06-01", t.clock.now());
    for (const route of GATED) {
      const res = await send(t, auth, route);
      expect(res.status, route.join(" ")).toBe(403);
      const body = await res.json();
      expect(body.error.code, route.join(" ")).toBe("terms_required");
      expect(body.error.details).toEqual({ terms_version: "2026-11-01" });
    }
    for (const route of EXEMPT.filter((r) => r[1] !== "/v1/account/terms")) {
      expect((await send(t, auth, route)).status, route.join(" ")).toBe(200);
    }
    expect((await t.get("/v1/account/export", auth)).status).toBe(200);
  });

  it("answers a content route of an account with outdated terms like the fixture, before plan and consent", async () => {
    const t = await makeAuthApp();
    const { tokens, accountId } = await signedIn(t);
    await t.stores.accounts.acceptTerms(accountId, "2025-06-01", t.clock.now());
    const fx = loadFixture("chat-completions.terms_required");
    // The route itself belongs to the inference module (still a stub here); the gate in front of it is ours.
    const res = await t.request(fx.request.path, { method: "POST", headers: { ...fx.request.headers, Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify(fx.request.body) });
    await expectFixtureConformance(res, fx);
  });

  it("checks suspension before terms, so a suspended account is not asked to accept anything", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.acceptTerms(accountId, "2025-06-01", t.clock.now());
    await t.stores.accounts.update(accountId, { status: "suspended" });
    expect(await code(await t.get("/v1/provider-sets", auth))).toBe("account_suspended");
  });

  it("lets the account in again once it accepts the current terms", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.acceptTerms(accountId, "2025-06-01", t.clock.now());
    expect(await code(await t.get("/v1/provider-sets", auth))).toBe("terms_required");
    const accepted = await t.request("/v1/account/terms", { ...json({ terms_version: "2026-11-01" }), headers: { ...auth, "Content-Type": "application/json" } });
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(validateAgainst("TermsAcceptance", body)).toEqual([]);
    expect(body.terms_version).toBe("2026-11-01");
    expect((await t.get("/v1/provider-sets", auth)).status).toBe(200);
  });

  it("refuses to accept a terms version that is not the current one", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const res = await t.request("/v1/account/terms", { ...json({ terms_version: "1999-01-01" }), headers: { ...auth, "Content-Type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("invalid_request");
    expect((await t.request("/v1/account/terms", { ...json({}), headers: { ...auth, "Content-Type": "application/json" } })).status).toBe(400);
  });

  it("treats an account being deleted as gone on gated routes", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.markDeleting(accountId, t.clock.now());
    expect(await code(await t.get("/v1/provider-sets", auth))).toBe("session_revoked");
  });
});

describe("the rate-limit window of the account routes", () => {
  it("is chosen explicitly: no account route runs the per-account chat window", async () => {
    const t = await makeAuthApp();
    const accountRoutes = t.app.router.routes().filter((r) => /^\/v1\/(account|devices|provider-sets|consent)/.test(r.pattern));
    expect(accountRoutes.length).toBe(10);
    for (const route of accountRoutes) expect(route.meta.rateLimit, `${route.method} ${route.pattern}`).toBe("none");
  });

  it("is not throttled by an exhausted chat window: delete, export, devices and consent still work", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    // The window that chat requests spend (the inference module's per-account key) is full.
    for (let i = 0; i < 100; i++) await t.stores.rateLimits.hit(`acct:${accountId}`, 20, 60_000, t.clock.now());
    expect((await t.stores.rateLimits.hit(`acct:${accountId}`, 20, 60_000, t.clock.now())).allowed).toBe(false);
    expect((await t.get("/v1/devices", auth)).status).toBe(200);
    expect((await t.get("/v1/account/export", auth)).status).toBe(200);
    const withdraw = await t.request("/v1/consent", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ provider_set: "ps1", provider_set_version: 1, features: ["chat"], text_version: "2026-11-01", granted: false }),
    });
    expect(withdraw.status).toBe(200);
    expect((await t.del("/v1/account", auth)).status).toBe(202);
  });

  it("has its own generous window that stops a loop, per account", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const other = await t.signedIn("other@example.invalid");
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await t.get("/v1/devices", auth)).status);
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(statuses.slice(60)).toEqual([429, 429]);
    const denied = await t.get("/v1/devices", auth);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await code(denied)).toBe("rate_limited");
    expect((await t.get("/v1/devices", bearer(other.access_token))).status).toBe(200); // another account
    t.clock.advance(61_000);
    expect((await t.get("/v1/devices", auth)).status).toBe(200);
  });
});

describe("GET /v1/account", () => {
  it("answers the fixture's shape, with the plan version header and no plan for a free account", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    const res = await t.get("/v1/account", auth);
    await expectFixtureConformance(res.clone(), loadFixture("account.get.success"));
    expect(res.headers.get("X-StudentLLM-Plan-Version")).toBe("0");
    const body = await res.json();
    expect(body).toMatchObject({
      account_id: accountId,
      email: ADDRESS,
      login_methods: ["email"],
      plan: { id: "free", status: "none", period_start: null, period_end: null, cancel_at_period_end: false },
      plan_version: 0,
      credits: { limit: 0, used: 0, reserved: 0, remaining: 0, resets_at: null },
      consents: [],
      terms_version: "2026-11-01",
    });
  });

  it("reports the plan, the credit window and only the active consents", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    const start = Date.UTC(2026, 10, 1);
    const end = Date.UTC(2026, 11, 1);
    await t.stores.accounts.savePlan(
      { accountId, planId: "plus_monthly", status: "active", paidPeriods: [{ start, end }], cancelAtPeriodEnd: true, paddleCustomerId: null, paddleSubscriptionId: null, lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    await t.stores.ledger.ensureWindow(accountId, { start, end, limit: 12500 });
    await t.stores.ledger.reserve(accountId, { requestId: "r1", feature: "chat", logicalModelId: "studentllm-large", credits: 100, now: t.clock.now(), expiresAt: t.clock.now() + 60_000, idempotency: null });
    await t.stores.consents.record({ consentId: "cns_a", accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted: true }, t.clock.now());
    const res = await t.get("/v1/account", auth);
    expect(res.headers.get("X-StudentLLM-Plan-Version")).toBe("1");
    const body = await res.json();
    expect(validateAgainst("Account", body)).toEqual([]);
    expect(body.plan).toEqual({ id: "plus_monthly", status: "active", period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z", cancel_at_period_end: true });
    expect(body.credits).toEqual({ limit: 12500, used: 0, reserved: 100, remaining: 12400, resets_at: "2026-12-01T00:00:00Z" });
    expect(body.consents.map((c: { consent_id: string }) => c.consent_id)).toEqual(["cns_a"]);
    // The token response reports the same plan as a label.
    t.clock.advance(61_000);
    const again = (await (await t.emailSignIn(ADDRESS)).json()) as TokenResponse;
    expect(again.account.plan).toBe("plus");
  });

  it("needs a token", async () => {
    const t = await makeAuthApp();
    expect((await t.get("/v1/account")).status).toBe(401);
  });
});

async function googleAccount(t: AuthHarness) {
  const res = await t.googleSignIn({ sub: "google-sub-1", email: ADDRESS });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

describe("DELETE /v1/account", () => {
  async function aliveBilling(state: "cancelled" | "pending" | "none" | "throw") {
    const calls: Array<{ accountId: string; when: string }> = [];
    let current = state;
    const billing: BillingSeam = {
      async cancelSubscription(accountId, when) {
        calls.push({ accountId, when });
        if (current === "throw") throw new Error("paddle is down");
        return { state: current };
      },
    };
    return { billing, calls, set: (s: typeof state) => void (current = s) };
  }

  it("needs a fresh sign-in", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    t.clock.advance(5 * 60_000 + 1000);
    const res = await t.del("/v1/account", auth);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("reauth_required");
    expect(await t.stores.accounts.getById(accountId)).not.toBeNull();
  });

  it("cancels the subscription, purges everything, and mails the account address", async () => {
    const seam = await aliveBilling("cancelled");
    const purged: string[] = [];
    const inference: InferenceSeam = { usageSnapshot: async () => ({ creditsUsed: 0, windowStart: null, windowEnd: null }), purgeLedger: async (id) => void purged.push(id) };
    const t = await makeAuthApp({ extraDeps: { billing: seam.billing as never, inference: inference as never } });
    const { tokens, auth, accountId } = await signedIn(t);
    // Give the account something in every store.
    await t.stores.consents.record({ consentId: "cns_a", accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "t", granted: true }, t.clock.now());
    await t.stores.ledger.ensureWindow(accountId, { start: t.clock.now(), end: t.clock.now() + 86_400_000, limit: 10 });
    await t.stores.accounts.savePlan(
      { accountId, planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    await t.stores.authChallenges.putLinkTicket({ ticketHash: "lt", accountId, method: "google", createdAt: t.clock.now(), expiresAt: t.clock.now() + 1e6, used: false });

    const res = await t.del("/v1/account", auth);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(validateAgainst("DeletionResponse", body)).toEqual([]);
    expect(body).toMatchObject({ state: "deleting" });
    expect(body.deletion_id).toMatch(/^del_/);
    expect(seam.calls).toEqual([{ accountId, when: "now" }]);
    expect(purged).toEqual([accountId]);

    // Everything is gone.
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
    expect(await t.stores.accounts.getByEmail(ADDRESS)).toBeNull();
    expect(await t.stores.accounts.getTombstone(accountId)).toBeNull();
    expect(await t.stores.accounts.getPlan(accountId)).toBeNull();
    expect(await t.stores.devices.list(accountId)).toEqual([]);
    expect(await t.stores.consents.listAll(accountId)).toEqual([]);
    expect(await t.stores.ledger.listWindows(accountId)).toEqual([]);
    expect(await t.stores.sessions.listActiveByAccount(accountId, t.clock.now())).toEqual([]);
    expect(await t.stores.authChallenges.getLinkTicket("lt", t.clock.now())).toBeNull();
    expect(await code(await t.get("/v1/account", bearer(tokens.access_token)))).toBe("session_revoked");

    // The notification went to the address that was on the account.
    expect(t.email.ofKind("account_deletion_started")).toEqual([{ kind: "account_deletion_started", to: ADDRESS }]);
    // The address can sign up again as a new account.
    const again = await t.signedIn(ADDRESS);
    expect(again.account.account_id).not.toBe(accountId);
  });

  it("with the default seams (no billing module yet) there is nothing to cancel and the purge completes", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
  });

  it("erases all personal data at once when the cancel is pending, and keeps only the Paddle ids", async () => {
    const seam = await aliveBilling("pending");
    const t = await makeAuthApp({ extraDeps: { billing: seam.billing as never } });
    // A Google account with a second device, a consent, a link ticket, a pending email code and a manage token.
    const google = await googleAccount(t);
    const accountId = google.account.account_id;
    const ticket = await (await t.request("/v1/account/link", { method: "POST", headers: { ...bearer(google.access_token), "Content-Type": "application/json" }, body: JSON.stringify({ method: "email" }) })).json();
    expect((await t.googleSignIn({ sub: "google-sub-1", email: ADDRESS }, { deviceLabel: "Second laptop" })).status).toBe(200);
    await t.stores.accounts.savePlan(
      { accountId, planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    await t.stores.consents.record({ consentId: "cns_a", accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "t", granted: true }, t.clock.now());
    await t.stores.ledger.ensureWindow(accountId, { start: t.clock.now(), end: t.clock.now() + 86_400_000, limit: 10 });
    await t.stores.devices.mintManageToken({ tokenHash: "mgmt-hash", accountId, expiresAt: t.clock.now() + 300_000, codeId: "c1" }, t.clock.now());
    const pkce = await pkcePair();
    t.clock.advance(61_000);
    await t.post("/auth/email/request", { email: ADDRESS, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket: ticket.link_ticket });

    const res = await t.del("/v1/account", bearer(google.access_token));
    expect(res.status).toBe(202);
    const firstBody = await res.json();
    expect(seam.calls).toHaveLength(1);

    // No personal data is left anywhere: not the address, the Google subject, a device label, a token or a ticket.
    const dump = dumpStores(t.stores);
    for (const needle of [ADDRESS, "google-sub-1", "Second laptop", google.refresh_token, google.access_token, "mgmt-hash", "cns_a", ticket.link_ticket]) {
      expect(dump, needle).not.toContain(needle);
    }
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
    expect(await t.stores.accounts.getByEmail(ADDRESS)).toBeNull();
    expect(await t.stores.accounts.getPlan(accountId)).toBeNull();
    expect(await t.stores.devices.list(accountId)).toEqual([]);
    expect(await t.stores.consents.listAll(accountId)).toEqual([]);
    expect(await t.stores.ledger.listWindows(accountId)).toEqual([]);
    expect(await t.stores.sessions.listActiveByAccount(accountId, t.clock.now())).toEqual([]);
    // What stays is the tombstone: the account id and the Paddle ids.
    expect(await t.stores.accounts.getTombstone(accountId)).toEqual({ accountId, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", createdAt: t.clock.now() });

    // A repeated DELETE answers session_revoked (the client treats that as done), and so does everything else.
    const again = await t.del("/v1/account", bearer(google.access_token));
    expect(again.status).toBe(401);
    expect(await code(again)).toBe("session_revoked");
    expect(await code(await t.get("/v1/account", bearer(google.access_token)))).toBe("session_revoked");
    expect(await code(await t.post("/auth/refresh", { refresh_token: google.refresh_token, device_id: google.device_id }))).toBe("session_revoked");
    expect(t.email.ofKind("account_deletion_started")).toHaveLength(1);
    expect(firstBody.state).toBe("deleting");

    // The address and the Google identity can start over at once, as a new account.
    const fresh = await t.googleSignIn({ sub: "google-sub-1", email: ADDRESS });
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as TokenResponse).account.account_id).not.toBe(accountId);
  });

  it("lets the billing seam cancel from the tombstone alone, because the plan is already erased", async () => {
    const cancelled: string[] = [];
    let planWhenCalled: unknown = "unset";
    let tombstoneWhenCalled: unknown = null;
    let t: AuthHarness;
    // A seam that does what the seam documents: it reads ONLY the tombstone (getPlan would find nothing).
    const billing: BillingSeam = {
      async cancelSubscription(accountId) {
        planWhenCalled = await t.stores.accounts.getPlan(accountId);
        const tombstone = await t.stores.accounts.getTombstone(accountId);
        tombstoneWhenCalled = tombstone;
        if (!tombstone) return { state: "none" };
        for (const id of [tombstone.paddleSubscriptionId, tombstone.paddleCustomerId]) if (id) cancelled.push(id);
        return { state: cancelled.length > 0 ? "cancelled" : "none" };
      },
    };
    t = await makeAuthApp({ extraDeps: { billing: billing as never } });
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.savePlan(
      { accountId, planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    expect(planWhenCalled).toBeNull(); // the plan row was erased before the seam ran
    expect(tombstoneWhenCalled).toMatchObject({ paddleSubscriptionId: "sub_1", paddleCustomerId: "ctm_1" });
    expect(cancelled.sort()).toEqual(["ctm_1", "sub_1"]);
    expect(await t.stores.accounts.getTombstone(accountId)).toBeNull(); // purged only because the cancel ran
  });

  it("removes the per-account rate-limit windows with the rest of the account's state", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await t.get("/v1/account/export", auth); // the export window
    await t.get("/v1/devices", auth); // the account-routes window
    await t.stores.rateLimits.hit(`acct:${accountId}`, 20, 60_000, t.clock.now()); // the chat window of the inference module
    expect(dumpStore(t.stores.rateLimits)).toContain(accountId);
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    expect(dumpStore(t.stores.rateLimits)).not.toContain(accountId);
  });

  it("starts the deletion once when two DELETEs arrive together from the same session (chaos)", async () => {
    const seam = await aliveBilling("cancelled");
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 41), extraDeps: { billing: seam.billing as never } });
    const { auth, accountId } = await signedIn(t);
    const results = await Promise.all([t.del("/v1/account", auth), t.del("/v1/account", auth), t.del("/v1/account", auth)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 401, 401]);
    const loser = results.find((r) => r.status === 401)!;
    expect(await code(loser)).toBe("session_revoked"); // answers like a repeat
    expect(seam.calls).toHaveLength(1); // one cancel
    expect(t.email.ofKind("account_deletion_started")).toHaveLength(1); // one email
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
  });

  it("does not wait for a hanging email provider, and logs the failure by name only", async () => {
    const t = await makeAuthApp({ accountDeps: { deletionEmailTimeoutMs: 20 } });
    const { auth, accountId } = await signedIn(t);
    t.deps.auth.email.send = () => new Promise<void>(() => undefined); // never settles
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const started = Date.now();
    const res = await t.del("/v1/account", auth);
    spy.mockRestore();
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
    expect(lines).toEqual(["deletion email failed: timeout"]);
    expect(lines.join(" ")).not.toContain(ADDRESS);
  });

  it("logs a failing email provider by name only", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    t.email.failing = true;
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    spy.mockRestore();
    expect(lines).toEqual(["deletion email failed: error"]);
  });

  it("sends the final email before the address is erased", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const seen: string[] = [];
    const original = t.deps.auth.email.send.bind(t.deps.auth.email);
    t.deps.auth.email.send = async (message) => {
      // At this moment the address must still be on the account.
      seen.push(String(await t.stores.accounts.getByEmail(ADDRESS) !== null));
      return original(message);
    };
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    expect(seen).toEqual(["true"]);
    expect(t.email.ofKind("account_deletion_started")).toEqual([{ kind: "account_deletion_started", to: ADDRESS }]);
  });

  it("retries the cancel with backoff, finishes when it succeeds, and removes the tombstone", async () => {
    const seam = await aliveBilling("pending");
    const t = await makeAuthApp({ extraDeps: { billing: seam.billing as never } });
    const { auth, accountId } = await signedIn(t);
    await t.stores.accounts.savePlan(
      { accountId, planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_1", lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    const cron = () => t.app.scheduled({ scheduledTime: t.clock.now(), cron: "*/5 * * * *" });
    await cron();
    expect(seam.calls).toHaveLength(1); // the backoff is honored
    t.clock.advance(backoffMs(1));
    await cron();
    expect(seam.calls).toHaveLength(2);
    expect(await t.stores.accounts.getTombstone(accountId)).not.toBeNull();
    seam.set("cancelled");
    t.clock.advance(backoffMs(2));
    await cron();
    expect(seam.calls).toHaveLength(3);
    expect(await t.stores.accounts.getTombstone(accountId)).toBeNull();
    expect(await t.stores.accounts.findAccountIdByPaddleSubscription("sub_1")).toBeNull();
  });

  it("repairs a deletion that stopped after the tombstone: the retry job erases what is left", async () => {
    const seam = await aliveBilling("pending");
    const t = await makeAuthApp({ extraDeps: { billing: seam.billing as never } });
    const { accountId } = await signedIn(t);
    await t.stores.accounts.markDeleting(accountId, t.clock.now()); // the process died right here
    expect(await t.stores.devices.list(accountId)).toHaveLength(1);
    await t.app.scheduled({ scheduledTime: t.clock.now(), cron: "*/5 * * * *" });
    expect(await t.stores.devices.list(accountId)).toEqual([]);
    expect(await t.stores.sessions.listActiveByAccount(accountId, t.clock.now())).toEqual([]);
  });

  it("alerts the operator when the cancel keeps failing, and goes to manual review after the retry period", async () => {
    const seam = await aliveBilling("throw");
    const alerts: string[] = [];
    const t = await makeAuthApp({ extraDeps: { billing: seam.billing as never }, accountDeps: { alertOperator: (e) => void alerts.push(e) } });
    const { auth, accountId } = await signedIn(t);
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    const cron = () => t.app.scheduled({ scheduledTime: t.clock.now(), cron: "*/5 * * * *" });
    for (let attempt = 1; attempt < ALERT_AFTER_ATTEMPTS + 2; attempt++) {
      t.clock.advance(backoffMs(attempt));
      await cron();
    }
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a === "deletion_cancel_failing")).toBe(true);
    expect(await t.stores.accounts.getTombstone(accountId)).not.toBeNull();
    expect(backoffMs(30)).toBeLessThanOrEqual(6 * 60 * 60_000);

    // Past the retry period (14 days) the deletion stops retrying and waits for an operator.
    alerts.length = 0;
    t.clock.advance(DELETION_RETRY_PERIOD_MS);
    await cron();
    expect(alerts).toEqual(["deletion_needs_manual_review"]);
    const calls = seam.calls.length;
    t.clock.advance(7 * 24 * 60 * 60_000);
    await cron();
    expect(seam.calls.length).toBe(calls); // no more automatic attempts
    expect(await t.stores.accounts.getTombstone(accountId)).not.toBeNull(); // and the tombstone is kept
  });

  it("leaves no device or session behind when a sign-in races the deletion", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    const accountId = first.account.account_id;
    // The deletion lands between the session being created and the sign-in finishing.
    const original = t.stores.sessions.create.bind(t.stores.sessions);
    t.stores.sessions.create = async (session) => {
      await original(session);
      await t.stores.accounts.markDeleting(accountId, t.clock.now());
      t.stores.sessions.create = original;
    };
    const res = await t.emailSignIn(ADDRESS, { deviceId: first.device_id });
    expect(res.status).toBe(400);
    expect(await t.stores.devices.list(accountId)).toEqual([]);
    expect(await t.stores.sessions.listActiveByAccount(accountId, t.clock.now())).toEqual([]);
    expect(dumpStores(t.stores)).not.toContain(first.device_id);
  });

  it("does not let a failing email provider fail the deletion", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    t.email.failing = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await t.del("/v1/account", auth)).status).toBe(202);
    spy.mockRestore();
    expect(await t.stores.accounts.getById(accountId)).toBeNull();
  });
});

describe("GET /v1/account/export", () => {
  it("needs a fresh sign-in", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    t.clock.advance(6 * 60_000);
    expect(await code(await t.get("/v1/account/export", auth))).toBe("reauth_required");
  });

  it("returns everything the service holds as a JSON attachment, with no secret and no content", async () => {
    const usage: InferenceSeam = { usageSnapshot: async () => ({ creditsUsed: 42, windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-12-01T00:00:00Z" }), purgeLedger: async () => undefined };
    const t = await makeAuthApp({ extraDeps: { inference: usage as never } });
    const { tokens, auth, accountId } = await signedIn(t);
    await t.stores.consents.record({ consentId: "cns_1", accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted: true }, t.clock.now());
    await t.stores.consents.record({ consentId: "cns_2", accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted: false }, t.clock.now() + 1);
    const res = await t.get("/v1/account/export", auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="[\w.-]+\.json"$/);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(validateAgainst("AccountExport", body)).toEqual([]);
    expect(body.account).toMatchObject({ account_id: accountId, email: ADDRESS, status: "active", google_linked: false });
    expect(body.login_methods).toEqual(["email"]);
    // The whole consent history, withdrawn records included.
    expect(body.consent_records.map((c: { consent_id: string; granted: boolean }) => [c.consent_id, c.granted])).toEqual([["cns_1", true], ["cns_2", false]]);
    expect(body.terms_acceptance).toMatchObject({ terms_version: "2026-11-01" });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ device_id: tokens.device_id, active: true });
    expect(body.usage_totals).toEqual([{ credits_used: 42, window_start: "2026-11-01T00:00:00Z", window_end: "2026-12-01T00:00:00Z" }]);
    // Not a token, a hash, a family id or the signing key anywhere.
    for (const secret of [tokens.refresh_token, tokens.access_token, t.env.CODE_HMAC_KEY!, t.signing.pkcs8]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{64}|fam_|jti_|rt_/);
  });

  it("is limited to a few a day", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await t.get("/v1/account/export", auth)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await t.get("/v1/account/export", auth);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("POST /v1/consent and GET /v1/provider-sets", () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    provider_set: "ps1",
    provider_set_version: 1,
    features: ["chat"],
    text_version: "2026-11-01",
    granted: true,
    ...over,
  });
  const post = (t: AuthHarness, auth: Record<string, string>, body: unknown) =>
    t.request("/v1/consent", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("lists the provider sets", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const res = await t.get("/v1/provider-sets", auth);
    expect(res.status).toBe(200);
    await expectFixtureConformance(res.clone(), loadFixture("provider-sets.list.success"));
    expect(validateAgainst("ProviderSetList", await res.json())).toEqual([]);
  });

  it("records a grant (fixture) and returns the same record for an identical grant", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    const res = await post(t, auth, grant());
    await expectFixtureConformance(res.clone(), loadFixture("consent.record.success"));
    const first = await res.json();
    expect(first).toMatchObject({ provider_set: "ps1", granted: true, features: ["chat"] });
    const again = await (await post(t, auth, grant())).json();
    expect(again.consent_id).toBe(first.consent_id);
    expect(await t.stores.consents.listAll(accountId)).toHaveLength(1);
  });

  it("keeps one active record per provider set: a new grant replaces it, a withdrawal ends it, history stays", async () => {
    const wide = { list: () => [{ id: "ps1", version: 1, providers: ["P"], regions: ["R"], consentTextVersion: "2026-11-01", features: ["chat", "transcription", "ocr"] as const }] };
    const t = await makeAuthApp({ accountDeps: { providerSets: wide } });
    const { auth, accountId } = await signedIn(t);
    const a = await (await post(t, auth, grant())).json();
    t.clock.advance(1000);
    const b = await (await post(t, auth, grant({ features: ["chat", "ocr"] }))).json();
    expect(b.consent_id).not.toBe(a.consent_id);
    expect((await t.stores.consents.getActive(accountId, "ps1"))!.consentId).toBe(b.consent_id);
    expect(await t.stores.consents.getById(accountId, a.consent_id)).not.toBeNull(); // replaced, not removed
    t.clock.advance(1000);
    const withdrawn = await post(t, auth, grant({ granted: false }));
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).granted).toBe(false);
    expect(await t.stores.consents.getActive(accountId, "ps1")).toBeNull();
    expect(await t.stores.consents.listAll(accountId)).toHaveLength(3);
    const account = await (await t.get("/v1/account", auth)).json();
    expect(account.consents).toEqual([]);
  });

  it("answers consent_outdated with the current text version when the text version differs (fixture)", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    const res = await post(t, auth, grant({ text_version: "2026-01-01" }));
    expect(res.status).toBe(409);
    await expectFixtureConformance(res, loadFixture("consent.record.text_version_mismatch"));
    expect(await t.stores.consents.listAll(accountId)).toEqual([]);
  });

  it("answers consent_outdated for an outdated provider set version", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    const res = await post(t, auth, grant({ provider_set_version: 7 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.details).toMatchObject({ consent_text_version: "2026-11-01", provider_set_version: 1 });
  });

  it("lets a withdrawal through whatever versions the client holds, recording the server's versions and the withdrawn features", async () => {
    const wide = { list: () => [{ id: "ps1", version: 1, providers: ["P"], regions: ["R"], consentTextVersion: "2026-11-01", features: ["chat", "ocr"] as const }] };
    const t = await makeAuthApp({ accountDeps: { providerSets: wide } });
    const { auth, accountId } = await signedIn(t);
    const granted = await (await post(t, auth, grant({ features: ["chat", "ocr"] }))).json();
    t.clock.advance(1000);
    // The client lies about everything it is allowed to send.
    const res = await post(t, auth, grant({ granted: false, text_version: "2020-01-01", provider_set_version: 99, features: ["chat"] }));
    expect(res.status).toBe(200);
    const record = await res.json();
    expect(record).toMatchObject({ granted: false, provider_set: "ps1", provider_set_version: 1, text_version: "2026-11-01", features: ["chat", "ocr"] });
    expect(record.consent_id).not.toBe(granted.consent_id);
    expect(await t.stores.consents.getActive(accountId, "ps1")).toBeNull();
    // Repeating it is idempotent.
    const again = await (await post(t, auth, grant({ granted: false, text_version: "1999-01-01" }))).json();
    expect(again.consent_id).toBe(record.consent_id);
  });

  it("lets a withdrawal through for a suspended account and for one with outdated terms, but not a grant", async () => {
    const t = await makeAuthApp();
    const { auth, accountId } = await signedIn(t);
    await post(t, auth, grant());
    await t.stores.accounts.update(accountId, { status: "suspended" });
    t.clock.advance(1000);
    const grantRes = await post(t, auth, grant({ features: ["chat"], granted: true, text_version: "2026-11-01" }));
    expect(await code(grantRes)).toBe("account_suspended");
    expect((await post(t, auth, grant({ granted: false }))).status).toBe(200);
    expect(await t.stores.consents.getActive(accountId, "ps1")).toBeNull();

    await t.stores.accounts.update(accountId, { status: "active" });
    await post(t, auth, grant());
    await t.stores.accounts.acceptTerms(accountId, "2025-06-01", t.clock.now());
    t.clock.advance(1000);
    expect(await code(await post(t, auth, grant()))).toBe("terms_required");
    expect((await post(t, auth, grant({ granted: false }))).status).toBe(200);
    expect(await t.stores.consents.getActive(accountId, "ps1")).toBeNull();
  });

  it("lets a withdrawal through for a provider set that was retired, with the versions of the withdrawn record", async () => {
    let sets = [{ id: "ps1", version: 3, providers: ["P"], regions: ["R"], consentTextVersion: "2026-11-01", features: ["chat"] as const }];
    const t = await makeAuthApp({ accountDeps: { providerSets: { list: () => sets } } });
    const { auth, accountId } = await signedIn(t);
    expect((await post(t, auth, grant({ provider_set_version: 3 }))).status).toBe(200);
    sets = [];
    t.clock.advance(1000);
    const res = await post(t, auth, grant({ granted: false, provider_set_version: 1, text_version: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ granted: false, provider_set_version: 3, text_version: "2026-11-01", features: ["chat"] });
    expect(await t.stores.consents.getActive(accountId, "ps1")).toBeNull();
    // A grant for the retired set, or a withdrawal for a set the account never saw, is a 400.
    expect((await post(t, auth, grant({ provider_set_version: 3 }))).status).toBe(400);
    expect((await post(t, auth, grant({ granted: false, provider_set: "never-existed" }))).status).toBe(400);
  });

  it("uses 400 for a malformed or impossible request and 409 only for an outdated text or set version of a grant", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    expect((await post(t, auth, grant({ provider_set: "ps9" }))).status).toBe(400);
    expect((await post(t, auth, grant({ features: ["ocr"] }))).status).toBe(400);
    expect((await post(t, auth, grant({ text_version: "2020-01-01" }))).status).toBe(409);
    expect((await post(t, auth, grant({ provider_set_version: 2 }))).status).toBe(409);
    expect((await post(t, auth, grant({ text_version: "2020-01-01", provider_set: "ps9" }))).status).toBe(400); // the set is checked first
  });

  it("rejects an unknown provider set, an unoffered feature, an empty grant, duplicates and unknown fields", async () => {
    const t = await makeAuthApp();
    const { auth } = await signedIn(t);
    for (const bad of [
      grant({ provider_set: "ps9" }),
      grant({ features: ["ocr"] }),
      grant({ features: [] }),
      grant({ features: ["chat", "chat"] }),
      grant({ features: ["telepathy"] }),
      grant({ granted: "yes" }),
      grant({ provider_set_version: 0 }),
      grant({ extra: 1 }),
      { provider_set: "ps1" },
    ]) {
      const res = await post(t, auth, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await code(res)).toBe("invalid_request");
    }
  });

  it("keeps consent per account", async () => {
    const t = await makeAuthApp();
    const mine = await signedIn(t);
    const other = await t.signedIn("other@example.invalid");
    await post(t, mine.auth, grant());
    expect(await t.stores.consents.listAll(other.account.account_id)).toEqual([]);
  });
});
