import { describe, expect, it } from "vitest";
import { expectFixtureConformance, loadFixture, validateAgainst } from "../../testing";
import { createInMemoryStores } from "../../storage";
import { bearer, makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { chaosStores } from "../../testing/store-contract";
import type { TokenResponse } from "../../types";

const EMAIL = "student@example.invalid";
const code = async (res: Response) => (await res.json()).error.code as string;
const REDIRECT = "http://127.0.0.1:50321/callback";

const link = (t: AuthHarness, token: string, method: string) =>
  t.request("/v1/account/link", { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify({ method }) });
const unlink = (t: AuthHarness, token: string, method: string) => t.del(`/v1/account/login-methods/${method}`, bearer(token));

/** An account that signed up with email. */
async function emailAccount(t: AuthHarness) {
  return t.signedIn(EMAIL);
}
/** An account that signed up with Google. */
async function googleAccount(t: AuthHarness, identity = { sub: "google-sub-1", email: EMAIL }) {
  const res = await t.googleSignIn(identity);
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

async function ticketFor(t: AuthHarness, tokens: TokenResponse, method: "google" | "email") {
  const res = await link(t, tokens.access_token, method);
  expect(res.status).toBe(200);
  return (await res.json()).link_ticket as string;
}

async function emailLinkVerify(t: AuthHarness, ticket: string, address: string, deviceId?: string) {
  const pkce = await pkcePair();
  t.clock.advance(61_000);
  const asked = await t.post("/auth/email/request", {
    email: address, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket: ticket,
  });
  expect(asked.status).toBe(202);
  return t.post("/auth/email/verify", { email: address, code: t.email.lastCode(address)!, code_verifier: pkce.verifier, ...(deviceId ? { device_id: deviceId } : {}) });
}

async function googleLinkLeg(t: AuthHarness, ticket: string, identity: { sub: string; email: string }) {
  const pkce = await pkcePair();
  const start = await t.get(
    `/auth/start?${new URLSearchParams({
      client_id: "studentllm-desktop", redirect_uri: REDIRECT, response_type: "code", state: "app-state-0123456789abcdef",
      code_challenge: pkce.challenge, code_challenge_method: "S256", provider: "google", terms_version: t.deps.config.termsVersion, link_ticket: ticket,
    })}`,
  );
  if (start.status !== 302) return { start };
  const granted = t.google.authorize(start.headers.get("Location")!, identity);
  const callback = await t.get(`/auth/callback?${granted.query}`);
  const back = new URL(callback.headers.get("Location")!);
  const exchange = back.searchParams.get("code")
    ? await t.post("/auth/token", {
        grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: pkce.verifier, redirect_uri: REDIRECT, client_id: "studentllm-desktop",
      })
    : undefined;
  return { start, back, exchange };
}

describe("POST /v1/account/link", () => {
  it("issues a single-use ticket for 5 minutes (fixture)", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const res = await link(t, tokens.access_token, "google");
    await expectFixtureConformance(res.clone(), loadFixture("account-link.ticket.success"));
    const body = await res.json();
    expect(body.link_ticket).toMatch(/^lt_/);
    expect(body.expires_in).toBe(300);
  });

  it("needs a fresh sign-in; a refresh does not make a session fresh (fixture)", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    t.clock.advance(5 * 60_000 + 1000);
    const stale = await link(t, tokens.access_token, "google");
    await expectFixtureConformance(stale.clone(), loadFixture("account-link.reauth_required"));
    expect(stale.status).toBe(401);
    const refreshed = (await (await t.post("/auth/refresh", { refresh_token: tokens.refresh_token, device_id: tokens.device_id })).json()) as TokenResponse;
    expect(await code(await link(t, refreshed.access_token, "google"))).toBe("reauth_required");
    // A new sign-in is what makes it fresh.
    const again = await t.signedIn(EMAIL, { deviceId: tokens.device_id });
    expect((await link(t, again.access_token, "google")).status).toBe(200);
  });

  it("answers identity_conflict when the method is already linked, and rejects bad bodies", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const res = await link(t, tokens.access_token, "email");
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("identity_conflict");
    expect((await link(t, tokens.access_token, "sms")).status).toBe(400);
    expect((await t.get("/v1/account/link")).status).toBe(404);
    expect((await t.request("/v1/account/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("expires the ticket after 5 minutes", async () => {
    const t = await makeAuthApp();
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    t.clock.advance(5 * 60_000);
    const pkce = await pkcePair();
    const res = await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket: ticket });
    expect(res.status).toBe(400);
  });
});

describe("linking email to a Google account", () => {
  it("completes with a LinkResult and no new session, mails the account, and then allows email sign-in", async () => {
    const t = await makeAuthApp();
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    const res = await emailLinkVerify(t, ticket, EMAIL, tokens.device_id);
    await expectFixtureConformance(res.clone(), loadFixture("auth-email-verify.link_completed"));
    const body = await res.json();
    expect(body).toEqual({ linked: true, method: "email", login_methods: ["google", "email"] });
    expect(body.access_token).toBeUndefined();
    // The client keeps its own session and device.
    expect((await t.get("/v1/account", bearer(tokens.access_token))).status).toBe(200);
    const account = (await t.stores.accounts.getByEmail(EMAIL))!;
    expect(await t.stores.devices.list(account.accountId)).toHaveLength(1);
    expect(await t.stores.sessions.listActiveByAccount(account.accountId, t.clock.now())).toHaveLength(1);
    expect(t.email.ofKind("login_method_linked")).toEqual([{ kind: "login_method_linked", to: EMAIL, method: "email" }]);
    // Now the email method signs in.
    expect((await t.emailSignIn(EMAIL)).status).toBe(200);
  });

  it("completes exactly once when the same code and ticket are redeemed in parallel (chaos)", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 13) });
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    const pkce = await pkcePair();
    t.clock.advance(61_000);
    await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket: ticket });
    const body = { email: EMAIL, code: t.email.lastCode(EMAIL)!, code_verifier: pkce.verifier };
    const results = await Promise.all(Array.from({ length: 8 }, () => t.post("/auth/email/verify", body)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await t.stores.accounts.getByEmail(EMAIL))!.loginMethods).toEqual(["google", "email"]);
    expect(t.email.ofKind("login_method_linked")).toHaveLength(1);
  });

  it("spends the ticket: it cannot be used for a second completion", async () => {
    const t = await makeAuthApp();
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    expect((await emailLinkVerify(t, ticket, EMAIL)).status).toBe(200);
    const pkce = await pkcePair();
    t.clock.advance(61_000);
    const again = await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket: ticket });
    expect(again.status).toBe(400);
  });

  it("answers identity_conflict when the email differs from the account's, and leaves the account alone (fixture)", async () => {
    const t = await makeAuthApp();
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    const res = await emailLinkVerify(t, ticket, "other@example.invalid");
    expect(res.status).toBe(409);
    await expectFixtureConformance(res, loadFixture("auth-email-verify.identity_conflict"));
    expect((await t.stores.accounts.getByEmail(EMAIL))!.loginMethods).toEqual(["google"]);
    expect(await t.stores.accounts.getByEmail("other@example.invalid")).toBeNull();
    expect(t.email.ofKind("login_method_linked")).toHaveLength(0);
  });

  it("answers identity_conflict when the address belongs to another account", async () => {
    const t = await makeAuthApp();
    await t.signedIn("taken@example.invalid");
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    const res = await emailLinkVerify(t, ticket, "taken@example.invalid");
    expect(await code(res)).toBe("identity_conflict");
    expect((await t.stores.accounts.getByEmail("taken@example.invalid"))!.loginMethods).toEqual(["email"]);
  });

  it("refuses a ticket of another method, an invented ticket and a ticket on the wrong route", async () => {
    const t = await makeAuthApp();
    const tokens = await googleAccount(t);
    // A Google account cannot ask for a Google ticket: it is already linked.
    const res = await link(t, tokens.access_token, "google");
    expect(res.status).toBe(409);
    const pkce = await pkcePair();
    for (const link_ticket of ["lt_invented", "x".repeat(300)]) {
      const r = await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, link_ticket });
      expect(r.status).toBe(400);
    }
    // An email ticket does not start a Google flow.
    const emailTicket = await ticketFor(t, tokens, "email");
    const start = await t.get(
      `/auth/start?${new URLSearchParams({ client_id: "studentllm-desktop", redirect_uri: REDIRECT, response_type: "code", state: "app-state-0123456789abcdef", code_challenge: pkce.challenge, code_challenge_method: "S256", provider: "google", terms_version: t.deps.config.termsVersion, link_ticket: emailTicket })}`,
    );
    expect(start.status).toBe(400);
  });

  it("does not let a ticket of one account link into another", async () => {
    const t = await makeAuthApp();
    const a = await googleAccount(t, { sub: "ga", email: "a@example.invalid" });
    await googleAccount(t, { sub: "gb", email: "b@example.invalid" });
    const ticket = await ticketFor(t, a, "email");
    // Account A's ticket with B's address: conflict, and B is untouched.
    const res = await emailLinkVerify(t, ticket, "b@example.invalid");
    expect(await code(res)).toBe("identity_conflict");
    expect((await t.stores.accounts.getByEmail("b@example.invalid"))!.loginMethods).toEqual(["google"]);
  });
});

describe("linking Google to an email account", () => {
  it("completes through the browser flow with a LinkResult, and mails the account", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const ticket = await ticketFor(t, tokens, "google");
    const { back, exchange } = await googleLinkLeg(t, ticket, { sub: "google-sub-7", email: EMAIL });
    expect(back!.searchParams.get("code")).toBeTruthy();
    expect(exchange!.status).toBe(200);
    const body = await exchange!.json();
    expect(validateAgainst("LinkResult", body)).toEqual([]);
    expect(body).toEqual({ linked: true, method: "google", login_methods: ["email", "google"] });
    const account = (await t.stores.accounts.getByEmail(EMAIL))!;
    expect(account).toMatchObject({ googleSubject: "google-sub-7", loginMethods: ["email", "google"] });
    expect(t.email.ofKind("login_method_linked")).toEqual([{ kind: "login_method_linked", to: EMAIL, method: "google" }]);
    // The same session is still the only one, and Google now signs in to this same account.
    expect(await t.stores.sessions.listActiveByAccount(account.accountId, t.clock.now())).toHaveLength(1);
    const viaGoogle = (await (await t.googleSignIn({ sub: "google-sub-7", email: EMAIL })).json()) as TokenResponse;
    expect(viaGoogle.account.account_id).toBe(account.accountId);
  });

  it("redirects with identity_conflict when Google's email differs from the account's", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const ticket = await ticketFor(t, tokens, "google");
    const { back, exchange } = await googleLinkLeg(t, ticket, { sub: "google-sub-8", email: "different@example.invalid" });
    expect(back!.searchParams.get("error")).toBe("identity_conflict");
    expect(back!.searchParams.get("state")).toBe("app-state-0123456789abcdef");
    expect(exchange).toBeUndefined();
    expect((await t.stores.accounts.getByEmail(EMAIL))!.loginMethods).toEqual(["email"]);
    expect(t.email.ofKind("login_method_linked")).toHaveLength(0);
  });

  it("redirects with identity_conflict when the Google identity already belongs to another account", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn({ sub: "google-sub-9", email: "owner@example.invalid" });
    const tokens = await emailAccount(t);
    const ticket = await ticketFor(t, tokens, "google");
    const { back } = await googleLinkLeg(t, ticket, { sub: "google-sub-9", email: EMAIL });
    expect(back!.searchParams.get("error")).toBe("identity_conflict");
    expect((await t.stores.accounts.getByEmail(EMAIL))!.googleSubject).toBeNull();
  });

  it("spends the ticket at the callback", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const ticket = await ticketFor(t, tokens, "google");
    expect((await googleLinkLeg(t, ticket, { sub: "google-sub-7", email: EMAIL })).exchange!.status).toBe(200);
    const again = await googleLinkLeg(t, ticket, { sub: "google-sub-7", email: EMAIL });
    expect(again.start.status).toBe(400); // spent: the start no longer finds it
    expect(again.start.headers.get("Location")).toBeNull();
  });
});

describe("DELETE /v1/account/login-methods/{method}", () => {
  async function both(t: AuthHarness) {
    const tokens = await googleAccount(t);
    const ticket = await ticketFor(t, tokens, "email");
    expect((await emailLinkVerify(t, ticket, EMAIL)).status).toBe(200);
    t.email.sent.length = 0;
    return tokens;
  }

  it("unlinks a method, answers 204 (fixture) and mails the account", async () => {
    const t = await makeAuthApp();
    const tokens = await both(t);
    const res = await unlink(t, tokens.access_token, "google");
    await expectFixtureConformance(res, loadFixture("account-login-methods.unlink.success"));
    const account = (await t.stores.accounts.getByEmail(EMAIL))!;
    expect(account.loginMethods).toEqual(["email"]);
    expect(account.googleSubject).toBeNull();
    expect(t.email.ofKind("login_method_unlinked")).toEqual([{ kind: "login_method_unlinked", to: EMAIL, method: "google" }]);
  });

  it("never removes the last method, and rejects unknown or unlinked methods", async () => {
    const t = await makeAuthApp();
    const tokens = await emailAccount(t);
    const last = await unlink(t, tokens.access_token, "email");
    expect(last.status).toBe(400);
    expect(await code(last)).toBe("invalid_request");
    expect((await unlink(t, tokens.access_token, "google")).status).toBe(400); // not linked
    expect((await unlink(t, tokens.access_token, "sms")).status).toBe(400);
    expect((await t.stores.accounts.getByEmail(EMAIL))!.loginMethods).toEqual(["email"]);
    expect(t.email.ofKind("login_method_unlinked")).toHaveLength(0);
  });

  it("needs a fresh sign-in", async () => {
    const t = await makeAuthApp();
    const tokens = await both(t);
    t.clock.advance(5 * 60_000 + 1000);
    expect(await code(await unlink(t, tokens.access_token, "google"))).toBe("reauth_required");
    expect((await t.stores.accounts.getByEmail(EMAIL))!.loginMethods).toEqual(["google", "email"]);
  });

  it("makes sign-in with the removed method fail: identity_conflict for Google, invalid_code for email", async () => {
    const t = await makeAuthApp();
    const tokens = await both(t);
    expect((await unlink(t, tokens.access_token, "google")).status).toBe(204);
    const google = await t.googleSignIn({ sub: "google-sub-1", email: EMAIL });
    // The callback redirected with an error, so the helper returned the callback response itself.
    expect(google.status).toBe(302);
    expect(new URL(google.headers.get("Location")!).searchParams.get("error")).toBe("identity_conflict");

    // And the other way round, after unlinking email from a two-method account.
    const t2 = await makeAuthApp();
    const tokens2 = await both(t2);
    expect((await unlink(t2, tokens2.access_token, "email")).status).toBe(204);
    const pkce = await pkcePair();
    t2.clock.advance(61_000);
    await t2.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t2.deps.config.termsVersion });
    expect(t2.email.lastCode(EMAIL)).toBeUndefined(); // nothing is sent for a method the account no longer has
    const res = await t2.post("/auth/email/verify", { email: EMAIL, code: "AAAAAAAA", code_verifier: pkce.verifier });
    expect(await code(res)).toBe("invalid_code");
  });
});
