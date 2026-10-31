import { describe, expect, it } from "vitest";
import { chaosStores } from "../../testing/store-contract";
import { createInMemoryStores } from "../../storage";
import { bearer, makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { expectFixtureConformance, loadFixture } from "../../testing";
import type { TokenResponse } from "../../types";
import { renderEmail } from "./email";
import { normalizeEmail } from "./codes";

const ADDRESS = "student@example.invalid";

async function request(t: AuthHarness, email = ADDRESS, over: Record<string, unknown> = {}) {
  const pkce = await pkcePair();
  const res = await t.post("/auth/email/request", {
    email,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    terms_version: t.deps.config.termsVersion,
    ...over,
  });
  return { res, pkce };
}

const verify = (t: AuthHarness, body: Record<string, unknown>) => t.post("/auth/email/verify", body);
const code = async (res: Response) => (await res.json()).error.code as string;

describe("POST /auth/email/request", () => {
  it("answers the fixture's 202 and sends an 8-character code from the unambiguous alphabet", async () => {
    const t = await makeAuthApp();
    const { res } = await request(t);
    await expectFixtureConformance(res, loadFixture("auth-email-request.success"));
    const sent = t.email.ofKind("sign_in_code");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ADDRESS);
    expect(sent[0]!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("answers identically whether or not the address is known, and for an address that cannot sign in by email", async () => {
    const t = await makeAuthApp();
    await t.signedIn("known@example.invalid");
    // A Google-only account: the email method is not in login_methods.
    await t.googleSignIn({ sub: "g-1", email: "googleonly@example.invalid" });
    const answers: string[] = [];
    for (const address of ["known@example.invalid", "nobody@example.invalid", "googleonly@example.invalid"]) {
      t.clock.advance(61_000);
      const { res } = await request(t, address);
      expect(res.status).toBe(202);
      const { ["X-Request-Id"]: _ignored, ...rest } = Object.fromEntries(res.headers);
      answers.push(JSON.stringify({ body: await res.json(), headers: rest, status: res.status }).replace(/"x-request-id":"[^"]+",?/, ""));
    }
    expect(new Set(answers).size).toBe(1);
    // No code goes to the address that cannot use one; the others get one.
    expect(t.email.lastCode("googleonly@example.invalid")).toBeUndefined();
    expect(t.email.lastCode("nobody@example.invalid")).toBeDefined();
  });

  it("requires the current terms version and creates nothing without it", async () => {
    const t = await makeAuthApp();
    const { res } = await request(t, ADDRESS, { terms_version: "1999-01-01" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("terms_required");
    expect(body.error.details.terms_version).toBe(t.deps.config.termsVersion);
    expect(t.email.sent).toHaveLength(0);
    expect(await t.stores.accounts.getByEmail(ADDRESS)).toBeNull();
  });

  it("rejects unknown fields, a bad method, a malformed challenge and an invalid address", async () => {
    const t = await makeAuthApp();
    expect((await request(t, ADDRESS, { extra: 1 })).res.status).toBe(400);
    expect((await request(t, ADDRESS, { code_challenge_method: "plain" })).res.status).toBe(400);
    expect((await request(t, ADDRESS, { code_challenge: "short" })).res.status).toBe(400);
    for (const bad of ["no-at-sign", "a@b", "a b@example.com", "a@@example.com", "@example.com", "a@192.168.0.1"]) {
      expect((await request(t, bad)).res.status, bad).toBe(400);
    }
    expect(t.email.sent).toHaveLength(0);
  });

  it("asks for a Content-Type of JSON", async () => {
    const t = await makeAuthApp();
    const res = await t.request("/auth/email/request", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("limits requests per address (5 an hour, 1 a minute) and per connection, independently", async () => {
    const t = await makeAuthApp();
    for (let i = 0; i < 5; i++) {
      expect((await request(t)).res.status).toBe(202);
      t.clock.advance(61_000);
    }
    const sixth = (await request(t)).res;
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await sixth.json()).error.code).toBe("rate_limited");


    // The connection counter does not depend on the address: 20 different addresses from one connection, then no more.
    const t3 = await makeAuthApp();
    const ok: number[] = [];
    for (let i = 0; i < 22; i++) ok.push((await request(t3, `user${i}@example.invalid`)).res.status);
    expect(ok.filter((s) => s === 202)).toHaveLength(20);
    expect(ok.slice(20)).toEqual([429, 429]);
    // Another connection is not affected.
    const other = await t3.post("/auth/email/request", {
      email: "fresh@example.invalid", code_challenge: (await pkcePair()).challenge, code_challenge_method: "S256", terms_version: t3.deps.config.termsVersion,
    }, { "CF-Connecting-IP": "203.0.113.9" });
    expect(other.status).toBe(202);
  });

  it("does not fail the request when the email provider is down", async () => {
    const t = await makeAuthApp();
    t.email.failing = true;
    expect((await request(t)).res.status).toBe(202);
  });
});

describe("a request inside the resend window", () => {
  it("is answered like any other but changes nothing: the earlier code stays valid and no mail is sent", async () => {
    const t = await makeAuthApp();
    const first = await request(t);
    const firstCode = t.email.lastCode(ADDRESS)!;
    const firstBody = await first.res.clone().json();
    const stranger = await request(t, ADDRESS, {}); // the same address again, other challenge, 1 ms later
    expect(stranger.res.status).toBe(202);
    expect(await stranger.res.json()).toEqual(firstBody);
    expect(t.email.ofKind("sign_in_code")).toHaveLength(1);
    // The user's code still works with the user's verifier, and not with the stranger's.
    expect(await code(await verify(t, { email: ADDRESS, code: firstCode, code_verifier: stranger.pkce.verifier }))).toBe("invalid_code");
    const ok = await verify(t, { email: ADDRESS, code: firstCode, code_verifier: first.pkce.verifier });
    expect(ok.status).toBe(200);
  });

  it("replaces the code again once the window is over", async () => {
    const t = await makeAuthApp();
    await request(t);
    t.clock.advance(61_000);
    await request(t);
    expect(t.email.ofKind("sign_in_code")).toHaveLength(2);
  });

  it("does not use up the hourly allowance", async () => {
    const t = await makeAuthApp();
    for (let i = 0; i < 20; i++) expect((await request(t)).res.status).toBe(202);
    t.clock.advance(61_000);
    expect((await request(t)).res.status).toBe(202);
  });
});

describe("the email message", () => {
  it("carries the code and no link, and says to enter it only in the app", () => {
    const { subject, text } = renderEmail({ kind: "sign_in_code", to: ADDRESS, code: "K7M2QX9D", purpose: "sign_in" });
    expect(subject).toBeTruthy();
    expect(text).toContain("K7M2QX9D");
    expect(text).not.toMatch(/https?:|www\./i);
    expect(text).toMatch(/only in StudentLLM/);
    expect(text).toMatch(/Nobody from StudentLLM will ever ask/);
  });

  it("keeps every notification free of codes, tokens and links", () => {
    for (const message of [
      { kind: "login_method_linked", to: ADDRESS, method: "google" },
      { kind: "login_method_unlinked", to: ADDRESS, method: "email" },
      { kind: "account_deletion_started", to: ADDRESS },
      { kind: "device_revoked", to: ADDRESS, deviceLabel: "Laptop\r\nBcc: attacker@example.invalid" },
    ] as const) {
      const { text } = renderEmail(message);
      expect(text).not.toMatch(/https?:|mt_|rt_|[A-Z2-9]{8}/);
      expect(text).not.toMatch(/\r|Bcc:\n/);
    }
  });
});

describe("normalizeEmail", () => {
  it("lower-cases, converts the domain to ASCII, and keeps dots and plus tags", () => {
    expect(normalizeEmail("  A.B@Example.COM ")).toBe("a.b@example.com");
    expect(normalizeEmail("ab+c@example.com")).toBe("ab+c@example.com");
    expect(normalizeEmail("a@bücher.de")).toBe("a@xn--bcher-kva.de");
    expect(normalizeEmail("a.b@example.com")).not.toBe(normalizeEmail("ab@example.com"));
    expect(normalizeEmail("x".repeat(65) + "@example.com")).toBeNull();
  });
});

describe("POST /auth/email/verify", () => {
  it("signs a new account in, returns tokens that match the fixture, and creates the account", async () => {
    const t = await makeAuthApp();
    const res = await t.emailSignIn(ADDRESS, { deviceLabel: "Windows laptop" });
    await expectFixtureConformance(res.clone(), loadFixture("auth-email-verify.success"));
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.expires_in).toBe(900);
    expect(tokens.account).toMatchObject({ email: ADDRESS, plan: "free" });
    expect(tokens.refresh_token).toMatch(/^rt_/);
    const account = await t.stores.accounts.getByEmail(ADDRESS);
    expect(account).toMatchObject({ loginMethods: ["email"], status: "active", termsVersion: t.deps.config.termsVersion });
    expect(await t.stores.devices.list(account!.accountId)).toMatchObject([{ deviceId: tokens.device_id, label: "Windows laptop" }]);
    // The token works.
    const me = await t.get("/v1/account", bearer(tokens.access_token));
    expect(me.status).toBe(200);
  });

  it("is case-insensitive for the code and for the address", async () => {
    const t = await makeAuthApp();
    const { pkce } = await request(t, "Mixed.Case@Example.invalid");
    const typed = t.email.lastCode("mixed.case@example.invalid")!.toLowerCase();
    const res = await verify(t, { email: "MIXED.CASE@example.invalid", code: typed, code_verifier: pkce.verifier });
    expect(res.status).toBe(200);
  });

  it("returns the one generic invalid_code for wrong, expired, used and over-attempted codes", async () => {
    const t = await makeAuthApp();
    const fx = loadFixture("auth-email-verify.invalid_code");

    // unknown address
    const pkce = await pkcePair();
    const unknown = await verify(t, { email: "nobody@example.invalid", code: "AAAAAAAA", code_verifier: pkce.verifier });
    await expectFixtureConformance(unknown.clone(), fx);
    const messages = new Set<string>([JSON.stringify((await unknown.json()).error.message)]);

    // wrong code
    const a = await request(t);
    const wrong = await verify(t, { email: ADDRESS, code: "AAAAAAAA", code_verifier: a.pkce.verifier });
    expect(wrong.status).toBe(400);
    messages.add(JSON.stringify((await wrong.json()).error.message));

    // expired
    const good = t.email.lastCode(ADDRESS)!;
    t.clock.advance(10 * 60_000);
    const expired = await verify(t, { email: ADDRESS, code: good, code_verifier: a.pkce.verifier });
    expect(await code(expired.clone())).toBe("invalid_code");
    messages.add(JSON.stringify((await expired.json()).error.message));

    // used
    t.clock.advance(61_000);
    const b = await request(t);
    const goodB = t.email.lastCode(ADDRESS)!;
    expect((await verify(t, { email: ADDRESS, code: goodB, code_verifier: b.pkce.verifier })).status).toBe(200);
    const used = await verify(t, { email: ADDRESS, code: goodB, code_verifier: b.pkce.verifier });
    expect(await code(used.clone())).toBe("invalid_code");
    messages.add(JSON.stringify((await used.json()).error.message));

    // over-attempted
    t.clock.advance(61_000);
    const c = await request(t);
    const goodC = t.email.lastCode(ADDRESS)!;
    for (let i = 0; i < 5; i++) expect((await verify(t, { email: ADDRESS, code: "AAAAAAAA", code_verifier: c.pkce.verifier })).status).toBe(400);
    const locked = await verify(t, { email: ADDRESS, code: goodC, code_verifier: c.pkce.verifier });
    expect(await code(locked.clone())).toBe("invalid_code");
    messages.add(JSON.stringify((await locked.json()).error.message));

    expect(messages.size).toBe(1);
  });

  it("binds the code to the PKCE challenge: the right code with another verifier fails and counts", async () => {
    const t = await makeAuthApp();
    const a = await request(t);
    const typed = t.email.lastCode(ADDRESS)!;
    const attacker = await pkcePair();
    for (let i = 0; i < 5; i++) {
      expect((await verify(t, { email: ADDRESS, code: typed, code_verifier: attacker.verifier })).status).toBe(400);
    }
    // The cap is spent: even the real device can no longer use this code.
    expect(await code(await verify(t, { email: ADDRESS, code: typed, code_verifier: a.pkce.verifier }))).toBe("invalid_code");
  });

  it("invalidates earlier codes when a new one is requested", async () => {
    const t = await makeAuthApp();
    const first = await request(t);
    const firstCode = t.email.lastCode(ADDRESS)!;
    t.clock.advance(61_000);
    const second = await request(t);
    const secondCode = t.email.lastCode(ADDRESS)!;
    expect(secondCode).not.toBe(firstCode);
    expect(await code(await verify(t, { email: ADDRESS, code: firstCode, code_verifier: first.pkce.verifier }))).toBe("invalid_code");
    expect((await verify(t, { email: ADDRESS, code: secondCode, code_verifier: second.pkce.verifier })).status).toBe(200);
  });

  it("holds the attempt cap against parallel guesses, under the chaos wrapper", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 99) });
    const a = await request(t);
    const typed = t.email.lastCode(ADDRESS)!;
    const guesses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => verify(t, { email: ADDRESS, code: `AAAAAA${"ABCDEFGHJKLMNPQRSTUV"[i]}A`, code_verifier: a.pkce.verifier })),
    );
    expect(guesses.every((g) => g.status === 400)).toBe(true);
    // Only 5 of them counted against the code; the right code is locked out afterwards.
    const real = await verify(t, { email: ADDRESS, code: typed, code_verifier: a.pkce.verifier });
    expect(real.status).toBe(400);
  });

  it("lets a code through once when it is redeemed in parallel, and leaves one device", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 5) });
    const a = await request(t);
    const typed = t.email.lastCode(ADDRESS)!;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verify(t, { email: ADDRESS, code: typed, code_verifier: a.pkce.verifier })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const account = await t.stores.accounts.getByEmail(ADDRESS);
    expect(await t.stores.devices.list(account!.accountId)).toHaveLength(1);
    expect(await t.stores.sessions.listActiveByAccount(account!.accountId, t.clock.now())).toHaveLength(1);
  });

  it("limits failed checks per address and connection across codes", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await verify(t, { email: ADDRESS, code: "AAAAAAAA", code_verifier: pkce.verifier });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("does not let someone who only knows the address lock its owner out: the lockout is per connection", async () => {
    const t = await makeAuthApp();
    const owner = await request(t);
    const typed = t.email.lastCode(ADDRESS)!;
    const attacker = { "CF-Connecting-IP": "203.0.113.200" };
    let blocked = 0;
    // The attacker burns their failures (the code itself locks after 5; a new request is not possible inside the window).
    for (let i = 0; i < 40; i++) {
      const res = await t.post("/auth/email/verify", { email: ADDRESS, code: "AAAAAAAA", code_verifier: owner.pkce.verifier }, attacker);
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0); // the attacker's connection is limited ...
    // ... and the owner's connection is not. (The code itself was locked by the 5 wrong tries, as it always could be:
    // the owner asks again after the resend window and signs in.)
    t.clock.advance(61_000);
    const second = await request(t);
    const code2 = t.email.lastCode(ADDRESS)!;
    expect(code2).not.toBe(typed);
    const ok = await verify(t, { email: ADDRESS, code: code2, code_verifier: second.pkce.verifier });
    expect(ok.status).toBe(200);
  });

  it("honors a device id only if it belongs to the account, and signing in again replaces the device's session", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    const again = await t.signedIn(ADDRESS, { deviceId: first.device_id });
    expect(again.device_id).toBe(first.device_id);
    const account = await t.stores.accounts.getByEmail(ADDRESS);
    expect(await t.stores.devices.list(account!.accountId)).toHaveLength(1);
    expect(await t.stores.sessions.listActiveByAccount(account!.accountId, t.clock.now())).toHaveLength(1);
    // The old access token's session is gone.
    expect((await t.get("/v1/account", bearer(first.access_token))).status).toBe(401);

    // Someone else's device id (or an invented one) is not honored: a new id is created.
    const other = await t.signedIn("other@example.invalid");
    const hijack = await t.signedIn(ADDRESS, { deviceId: other.device_id });
    expect(hijack.device_id).not.toBe(other.device_id);
    const invented = await t.signedIn(ADDRESS, { deviceId: "dev_invented" });
    expect(invented.device_id).not.toBe("dev_invented");
  });

  it("succeeds for a suspended account, whose token then works only on the exempt routes", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    await t.stores.accounts.update(first.account.account_id, { status: "suspended" });
    t.clock.advance(61_000);
    const tokens = await t.signedIn(ADDRESS);
    expect((await t.get("/v1/account", bearer(tokens.access_token))).status).toBe(200);
    const blocked = await t.get("/v1/provider-sets", bearer(tokens.access_token));
    expect(blocked.status).toBe(403);
    expect(await code(blocked)).toBe("account_suspended");
  });

  it("answers the generic invalid_code when the email method was removed after the code was requested", async () => {
    const t = await makeAuthApp();
    // A Google account that also has the email method; the code is requested while the method is still linked.
    const tokens = await t.signedIn(ADDRESS);
    const account = (await t.stores.accounts.getByEmail(ADDRESS))!;
    await t.stores.accounts.addLoginMethod(account.accountId, "google", "g-5");
    const { pkce } = await request(t);
    const typed = t.email.lastCode(ADDRESS)!;
    await t.stores.accounts.removeLoginMethod(account.accountId, "email");
    const sessionsBefore = await t.stores.sessions.listActiveByAccount(account.accountId, t.clock.now());
    const res = await verify(t, { email: ADDRESS, code: typed, code_verifier: pkce.verifier });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("invalid_code");
    expect(await t.stores.sessions.listActiveByAccount(account.accountId, t.clock.now())).toHaveLength(sessionsBefore.length);
    expect(await t.stores.devices.list(account.accountId)).toHaveLength(1);
    void tokens;
  });

  it("answers the generic invalid_code when the account no longer has the email method", async () => {
    const t = await makeAuthApp();
    const g = await t.googleSignIn({ sub: "g-9", email: "dual@example.invalid" });
    expect(g.status).toBe(200);
    const account = (await t.stores.accounts.getByEmail("dual@example.invalid"))!;
    expect(account.loginMethods).toEqual(["google"]);
    // The request is answered like any other, but no code is ever sent for a method the account does not have.
    const { res: asked, pkce } = await request(t, "dual@example.invalid");
    expect(asked.status).toBe(202);
    expect(t.email.lastCode("dual@example.invalid")).toBeUndefined();
    const res = await verify(t, { email: "dual@example.invalid", code: "AAAAAAAA", code_verifier: pkce.verifier });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("invalid_code");
  });
});
