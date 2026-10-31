import { describe, expect, it } from "vitest";
import { base64urlEncode, utf8Encode } from "../../crypto/encoding";
import { sha256Hex } from "../../crypto/hash";
import { createInMemoryStores } from "../../storage";
import { bearer, makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { chaosStores } from "../../testing/store-contract";
import { FakeGoogle, type FakeIdentity, type TokenOverrides } from "../../testing/fake-google";
import type { TokenResponse } from "../../types";
import { classifyRedirectUri } from "./google-routes";
import { GOOGLE_JWKS_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "./google";

const REDIRECT = "http://127.0.0.1:50321/callback";
const IDENTITY: FakeIdentity = { sub: "google-sub-1", email: "student@example.invalid" };
const code = async (res: Response) => (await res.json()).error.code as string;

function startQuery(t: AuthHarness, over: Record<string, string | undefined> = {}, challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") {
  const params: Record<string, string | undefined> = {
    client_id: "studentllm-desktop",
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "app-state-0123456789abcdef",
    code_challenge: challenge,
    code_challenge_method: "S256",
    provider: "google",
    terms_version: t.deps.config.termsVersion,
    ...over,
  };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  return `/auth/start?${new URLSearchParams(params as Record<string, string>)}`;
}

/** The whole browser leg: start, Google, callback. Returns the redirect back to the app. */
async function browserLeg(t: AuthHarness, identity: FakeIdentity, opts: { start?: Record<string, string | undefined>; token?: TokenOverrides; challenge?: string } = {}) {
  const start = await t.get(startQuery(t, opts.start, opts.challenge));
  expect(start.status).toBe(302);
  const granted = t.google.authorize(start.headers.get("Location")!, identity, opts.token);
  const callback = await t.get(`/auth/callback?${granted.query}`);
  return { start, granted, callback, back: callback.status === 302 ? new URL(callback.headers.get("Location")!) : null };
}

const tokenBody = (c: string, verifier: string, over: Record<string, unknown> = {}) => ({
  grant_type: "authorization_code",
  code: c,
  code_verifier: verifier,
  redirect_uri: REDIRECT,
  client_id: "studentllm-desktop",
  ...over,
});

describe("redirect URIs", () => {
  it("accept the loopback form (any port, exact path) and the deep link, and nothing else", () => {
    expect(classifyRedirectUri("http://127.0.0.1:50321/callback")).toBe("loopback");
    expect(classifyRedirectUri("http://127.0.0.1:1/callback")).toBe("loopback");
    expect(classifyRedirectUri("studentllm://auth/callback")).toBe("deep_link");
    for (const bad of [
      "http://127.0.0.1/callback", // no explicit port
      "http://127.0.0.1:80/callback", // default port is normalized away
      "http://127.0.0.1:50321/other",
      "http://127.0.0.1:50321/callback?x=1",
      "http://127.0.0.1:50321/callback#frag",
      "http://127.0.0.1:50321/callback/",
      "https://127.0.0.1:50321/callback",
      "http://localhost:50321/callback",
      "http://[::1]:50321/callback",
      "http://127.0.0.2:50321/callback",
      "http://user@127.0.0.1:50321/callback",
      "http://127.0.0.1.evil.example:50321/callback",
      "http://evil.example/callback",
      "http://127.0.0.1:99999/callback",
      "studentllm://auth/callback?x=1",
      "studentllm://other/callback",
      "evil://auth/callback",
      "javascript:alert(1)",
      "",
    ]) {
      expect(classifyRedirectUri(bad), bad).toBeNull();
    }
  });
});

describe("GET /auth/start", () => {
  it("redirects to Google with openid email only, S256 PKCE, a state and a nonce, and no offline access", async () => {
    const t = await makeAuthApp();
    const res = await t.get(startQuery(t));
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = location.searchParams;
    expect(p.get("client_id")).toBe(t.google.clientId);
    expect(p.get("scope")).toBe("openid email");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("redirect_uri")).toBe(`${t.deps.config.issuer}/auth/callback`);
    expect(p.has("access_type")).toBe(false);
    // Neither the app's state nor its PKCE challenge goes to Google.
    expect(location.toString()).not.toContain("app-state-0123456789abcdef");
    expect(location.toString()).not.toContain("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(t.google.calls).toHaveLength(0); // start itself makes no Google call
  });

  it("stores the state hashed, with a 10 minute lifetime, and never the state itself", async () => {
    const t = await makeAuthApp();
    const res = await t.get(startQuery(t));
    const googleState = new URL(res.headers.get("Location")!).searchParams.get("state")!;
    expect(await t.stores.authChallenges.getByStateHash(googleState, t.clock.now())).toBeNull(); // the raw state is not the key
    const key = await sha256Hex(`google-state:${googleState}`);
    const pending = (await t.stores.authChallenges.getByStateHash(key, t.clock.now()))!;
    expect(JSON.stringify(pending)).not.toContain(googleState);
    expect(await t.stores.authChallenges.getByStateHash(key, t.clock.now() + 599_000)).not.toBeNull();
    expect(await t.stores.authChallenges.getByStateHash(key, t.clock.now() + 600_000)).toBeNull();
  });

  it("requires the current terms version (terms_required) and creates nothing without it", async () => {
    const t = await makeAuthApp();
    for (const terms_version of [undefined, "1999-01-01"]) {
      const res = await t.get(startQuery(t, { terms_version }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("terms_required");
      expect(body.error.details.terms_version).toBe(t.deps.config.termsVersion);
    }
  });

  it("refuses invalid parameters with a 400 and never redirects to an unverified address", async () => {
    const t = await makeAuthApp();
    const cases: Array<Record<string, string | undefined>> = [
      { client_id: "other" },
      { client_id: undefined },
      { response_type: "token" },
      { code_challenge_method: "plain" },
      { provider: "github" },
      { state: "short" },
      { state: "has spaces in it which is not allowed" },
      { code_challenge: "short" },
      { redirect_uri: "https://evil.example/callback" },
      { redirect_uri: "http://127.0.0.1:5/other" },
      { redirect_uri: undefined },
      { extra: "1" },
    ];
    for (const c of cases) {
      const res = await t.get(startQuery(t, c));
      expect(res.status, JSON.stringify(c)).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
      expect(await code(res)).toBe("invalid_request");
    }
    expect((await t.get(`${startQuery(t)}&state=another-state-0123456789`)).status).toBe(400); // repeated parameter
  });
});

describe("the Google sign-in, end to end", () => {
  it("signs a new user in, creates the account, and discards what Google sent", async () => {
    const t = await makeAuthApp();
    const res = await t.googleSignIn(IDENTITY, { deviceLabel: "Laptop" });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.account).toMatchObject({ email: IDENTITY.email, plan: "free" });
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    expect(account).toMatchObject({ googleSubject: "google-sub-1", loginMethods: ["google"], status: "active" });
    expect((await t.get("/v1/account", bearer(tokens.access_token))).status).toBe(200);
    // Google was asked for exactly one token exchange and one key fetch; no Google token is anywhere in our state.
    expect(t.google.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${GOOGLE_TOKEN_ENDPOINT}`, `GET ${GOOGLE_JWKS_ENDPOINT}`]);
    const everything = JSON.stringify([account, await t.stores.sessions.listActiveByAccount(account.accountId, t.clock.now()), t.logs]);
    expect(everything).not.toContain("fake-google-access-token");
    expect(everything).not.toContain("id_token");
  });

  it("signs the same user in again by subject, even after Google's email changed, without updating the stored email", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn(IDENTITY);
    const res = await t.googleSignIn({ sub: IDENTITY.sub, email: "renamed@example.invalid" });
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.account.email).toBe(IDENTITY.email);
    expect(await t.stores.accounts.getByEmail("renamed@example.invalid")).toBeNull();
  });

  it("answers identity_conflict when the email belongs to another account, and never merges", async () => {
    const t = await makeAuthApp();
    await t.signedIn("student@example.invalid"); // an email-only account
    const { back } = await browserLeg(t, IDENTITY);
    expect(back!.searchParams.get("error")).toBe("identity_conflict");
    expect(back!.searchParams.has("code")).toBe(false);
    expect(back!.searchParams.get("state")).toBe("app-state-0123456789abcdef");
    const account = (await t.stores.accounts.getByEmail("student@example.invalid"))!;
    expect(account.googleSubject).toBeNull();
    expect(account.loginMethods).toEqual(["email"]);
  });

  it("answers identity_conflict for an account that unlinked Google", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn(IDENTITY);
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    await t.stores.accounts.addLoginMethod(account.accountId, "email");
    await t.stores.accounts.removeLoginMethod(account.accountId, "google");
    const { back } = await browserLeg(t, IDENTITY);
    expect(back!.searchParams.get("error")).toBe("identity_conflict");
  });

  it("redirects to the app with the single-use code and the app's state, and nothing more", async () => {
    const t = await makeAuthApp();
    const { back, callback } = await browserLeg(t, IDENTITY);
    expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(`${back!.origin}${back!.pathname}`).toBe(REDIRECT);
    expect([...back!.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(back!.searchParams.get("code")!.length).toBeGreaterThanOrEqual(40);
  });

  it("redirects to a deep link when that is the registered fallback", async () => {
    const t = await makeAuthApp();
    const start = await t.get(startQuery(t, { redirect_uri: "studentllm://auth/callback" }));
    const granted = t.google.authorize(start.headers.get("Location")!, IDENTITY);
    const callback = await t.get(`/auth/callback?${granted.query}`);
    const back = new URL(callback.headers.get("Location")!);
    expect(back.protocol).toBe("studentllm:");
    expect(back.searchParams.get("code")).toBeTruthy();
  });
});

describe("GET /auth/callback", () => {
  it("never redirects for an unknown, replayed or expired state", async () => {
    const t = await makeAuthApp();
    for (const state of ["nonsense", "x".repeat(600)]) {
      const res = await t.get(`/auth/callback?code=abc&state=${state}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
    expect((await t.get("/auth/callback?code=abc")).status).toBe(400);
    // Replay of a state that was already used.
    const start = await t.get(startQuery(t));
    const granted = t.google.authorize(start.headers.get("Location")!, IDENTITY);
    expect((await t.get(`/auth/callback?${granted.query}`)).status).toBe(302);
    const replay = await t.get(`/auth/callback?${granted.query}`);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("Location")).toBeNull();
    // Expired.
    const start2 = await t.get(startQuery(t));
    const granted2 = t.google.authorize(start2.headers.get("Location")!, IDENTITY);
    t.clock.advance(10 * 60_000);
    expect((await t.get(`/auth/callback?${granted2.query}`)).status).toBe(400);
  });

  it("does not accept a state that belongs to another flow's code (state mismatch)", async () => {
    const t = await makeAuthApp();
    const a = await t.get(startQuery(t));
    const b = await t.get(startQuery(t, { state: "second-app-state-0123456789" }));
    const grantA = t.google.authorize(a.headers.get("Location")!, IDENTITY);
    const grantB = t.google.authorize(b.headers.get("Location")!, { sub: "other", email: "other@example.invalid" });
    // A's code with B's state: Google's own PKCE and nonce are bound to the state, so the exchange or the nonce fails.
    const mixed = await t.get(`/auth/callback?code=${encodeURIComponent(grantA.code)}&state=${encodeURIComponent(grantB.state)}`);
    expect(mixed.status).toBe(302);
    const back = new URL(mixed.headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("second-app-state-0123456789");
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("redirects with access_denied when the user refuses or no code arrives", async () => {
    const t = await makeAuthApp();
    const start = await t.get(startQuery(t));
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const res = await t.get(`/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    const back = new URL(res.headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect([...back.searchParams.keys()].sort()).toEqual(["error", "state"]);
  });

  it("redirects with server_error when Google cannot be reached", async () => {
    const t = await makeAuthApp();
    t.google.outage = true;
    const { back } = await browserLeg(t, IDENTITY);
    expect(back!.searchParams.get("error")).toBe("server_error");
  });

  it("redirects with terms_required when the terms changed during the flow", async () => {
    const t = await makeAuthApp();
    const start = await t.get(startQuery(t));
    const granted = t.google.authorize(start.headers.get("Location")!, IDENTITY);
    // The operator publishes new terms while the user is in the browser.
    const t2 = await makeAuthApp({ stores: t.stores, clock: t.clock, env: { TERMS_VERSION: "2027-01-15" } });
    t2.google.authorize(start.headers.get("Location")!, IDENTITY); // keep the fake's bookkeeping simple
    const res = await t2.get(`/auth/callback?${granted.query}`);
    const back = new URL(res.headers.get("Location")!);
    expect(back.searchParams.get("error")).toBe("terms_required");
  });
});

describe("ID token verification", () => {
  const cases: Array<[string, TokenOverrides, string]> = [
    ["email not verified", { claims: { email_verified: false } }, "access_denied"],
    ["email_verified missing", { claims: { email_verified: undefined } }, "access_denied"],
    ["email_verified as a string", { claims: { email_verified: "true" } }, "access_denied"],
    ["wrong audience", { claims: { aud: "someone-elses-client" } }, "access_denied"],
    ["array audience without azp", { claims: { aud: ["test-google-client-id", "other"], azp: undefined } }, "access_denied"],
    ["wrong issuer", { claims: { iss: "https://evil.example" } }, "access_denied"],
    ["expired", { claims: { exp: 1 } }, "access_denied"],
    ["issued in the future", { claims: { iat: 4_102_444_800 } }, "access_denied"],
    ["wrong nonce", { claims: { nonce: "another-nonce" } }, "access_denied"],
    ["missing nonce", { claims: { nonce: undefined } }, "access_denied"],
    ["missing subject", { claims: { sub: undefined } }, "access_denied"],
    ["alg none", { header: { alg: "none" } }, "access_denied"],
    ["alg HS256", { header: { alg: "HS256" } }, "access_denied"],
    ["unknown kid", { header: { kid: "not-google" } }, "access_denied"],
    ["not a JWT", { rawToken: "garbage" }, "access_denied"],
  ];
  for (const [name, overrides, expected] of cases) {
    it(`refuses a token with ${name}`, async () => {
      const t = await makeAuthApp();
      const { back } = await browserLeg(t, IDENTITY, { token: overrides });
      expect(back!.searchParams.get("error"), name).toBe(expected);
      expect(await t.stores.accounts.getByEmail(IDENTITY.email)).toBeNull();
    });
  }

  it("refuses a token signed by another key", async () => {
    const t = await makeAuthApp();
    const { back } = await browserLeg(t, IDENTITY, { token: { signWith: await FakeGoogle.forgeryKey() } });
    expect(back!.searchParams.get("error")).toBe("access_denied");
  });

  it("accepts the audience as an array when azp names this client", async () => {
    const t = await makeAuthApp();
    const { back } = await browserLeg(t, IDENTITY, { token: { claims: { aud: ["test-google-client-id", "other"], azp: "test-google-client-id" } } });
    expect(back!.searchParams.get("code")).toBeTruthy();
  });

  it("caches Google's keys across sign-ins", async () => {
    const t = await makeAuthApp();
    await browserLeg(t, IDENTITY);
    await browserLeg(t, { sub: "g2", email: "two@example.invalid" });
    expect(t.google.calls.filter((c) => c.url === GOOGLE_JWKS_ENDPOINT)).toHaveLength(1);
  });
});

describe("POST /auth/token", () => {
  it("exchanges the code with the PKCE verifier exactly once", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    const c = back!.searchParams.get("code")!;
    const first = await t.post("/auth/token", tokenBody(c, pkce.verifier));
    expect(first.status).toBe(200);
    const replay = await t.post("/auth/token", tokenBody(c, pkce.verifier));
    expect(replay.status).toBe(400);
    expect(await code(replay)).toBe("invalid_code");
  });

  it("expires the code after 60 seconds", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    t.clock.advance(60_000);
    expect(await code(await t.post("/auth/token", tokenBody(back!.searchParams.get("code")!, pkce.verifier)))).toBe("invalid_code");
  });

  it("fails on a wrong verifier and burns the code, so it cannot be tried again", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    const c = back!.searchParams.get("code")!;
    const attacker = await pkcePair();
    expect(await code(await t.post("/auth/token", tokenBody(c, attacker.verifier)))).toBe("invalid_code");
    expect(await code(await t.post("/auth/token", tokenBody(c, pkce.verifier)))).toBe("invalid_code");
  });

  it("fails on another redirect_uri, and burns the code", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    const c = back!.searchParams.get("code")!;
    expect(await code(await t.post("/auth/token", tokenBody(c, pkce.verifier, { redirect_uri: "http://127.0.0.1:50322/callback" })))).toBe("invalid_code");
    expect(await code(await t.post("/auth/token", tokenBody(c, pkce.verifier)))).toBe("invalid_code");
  });

  it("rejects an unknown code, unknown fields, a wrong grant type and another client", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    expect(await code(await t.post("/auth/token", tokenBody("unknown-code-0123456789", pkce.verifier)))).toBe("invalid_code");
    expect((await t.post("/auth/token", { ...tokenBody("unknown-code-0123456789", pkce.verifier), extra: 1 })).status).toBe(400);
    expect((await t.post("/auth/token", tokenBody("unknown-code-0123456789", pkce.verifier, { grant_type: "password" }))).status).toBe(400);
    expect((await t.post("/auth/token", tokenBody("unknown-code-0123456789", pkce.verifier, { client_id: "x" }))).status).toBe(400);
    expect((await t.post("/auth/token", tokenBody("unknown-code-0123456789", "short"))).status).toBe(400);
  });

  it("does not accept an email code or a state as an authorization code", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const start = await t.get(startQuery(t, undefined, pkce.challenge));
    const googleState = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    expect(await code(await t.post("/auth/token", tokenBody(googleState, pkce.verifier)))).toBe("invalid_code");
  });

  it("refuses an account that is being deleted", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn(IDENTITY);
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    await t.stores.accounts.markDeleting(account.accountId, t.clock.now());
    expect(await code(await t.post("/auth/token", tokenBody(back!.searchParams.get("code")!, pkce.verifier)))).toBe("invalid_code");
  });

  it("returns device_limit_reached WITHOUT a manage token on the Google path", async () => {
    const t = await makeAuthApp();
    for (const label of ["one", "two", "three"]) await t.signedIn(IDENTITY.email, { deviceLabel: label });
    // Give the account Google (link) so a Google sign-in is possible, then sign in on a fourth device.
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    await t.stores.accounts.addLoginMethod(account.accountId, "google", IDENTITY.sub);
    const res = await t.googleSignIn(IDENTITY);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("device_limit_reached");
    expect(body.manage_token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("mt_");
  });
});

describe("nothing is created before the PKCE proof", () => {
  it("creates no account at the callback, and creates it at /auth/token with the accepted terms", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    expect(back!.searchParams.get("code")).toBeTruthy();
    expect(await t.stores.accounts.getByEmail(IDENTITY.email)).toBeNull();
    expect(await t.stores.accounts.getByGoogleSubject(IDENTITY.sub)).toBeNull();

    // A wrong verifier burns the code: still no account, ever.
    const attacker = await pkcePair();
    expect(await code(await t.post("/auth/token", tokenBody(back!.searchParams.get("code")!, attacker.verifier)))).toBe("invalid_code");
    expect(await t.stores.accounts.getByEmail(IDENTITY.email)).toBeNull();

    // The right verifier on a fresh flow creates it, with the terms of the flow.
    const pkce2 = await pkcePair();
    const second = await browserLeg(t, IDENTITY, { challenge: pkce2.challenge });
    expect(await t.stores.accounts.getByEmail(IDENTITY.email)).toBeNull();
    const res = await t.post("/auth/token", tokenBody(second.back!.searchParams.get("code")!, pkce2.verifier));
    expect(res.status).toBe(200);
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    expect(account).toMatchObject({ googleSubject: IDENTITY.sub, loginMethods: ["google"], termsVersion: t.deps.config.termsVersion });
  });

  it("does not record the terms of an existing account at the callback either", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn(IDENTITY);
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    await t.stores.accounts.acceptTerms(account.accountId, "2025-01-01", t.clock.now());
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    expect(back!.searchParams.get("code")).toBeTruthy();
    expect((await t.stores.accounts.getById(account.accountId))!.termsVersion).toBe("2025-01-01");
    expect((await t.post("/auth/token", tokenBody(back!.searchParams.get("code")!, pkce.verifier))).status).toBe(200);
    expect((await t.stores.accounts.getById(account.accountId))!.termsVersion).toBe(t.deps.config.termsVersion);
  });

  it("creates the account once when the same code is redeemed in parallel", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 21) });
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    const c = back!.searchParams.get("code")!;
    const results = await Promise.all(Array.from({ length: 6 }, () => t.post("/auth/token", tokenBody(c, pkce.verifier))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    expect(await t.stores.devices.list(account.accountId)).toHaveLength(1);
  });

  it("answers identity_conflict at /auth/token when the address was taken after the callback", async () => {
    const t = await makeAuthApp();
    const pkce = await pkcePair();
    const { back } = await browserLeg(t, IDENTITY, { challenge: pkce.challenge });
    // The same address signs up by email in between.
    await t.stores.accounts.create({ accountId: "acc_other", email: IDENTITY.email, googleSubject: null, loginMethods: ["email"], termsVersion: t.deps.config.termsVersion, now: t.clock.now() });
    const res = await t.post("/auth/token", tokenBody(back!.searchParams.get("code")!, pkce.verifier));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("identity_conflict");
    expect((await t.stores.accounts.getByEmail(IDENTITY.email))!.googleSubject).toBeNull();
  });
});

describe("terms on sign-in", () => {
  it("records the acceptance of the current terms for an existing account with older ones", async () => {
    const t = await makeAuthApp();
    await t.googleSignIn(IDENTITY);
    const account = (await t.stores.accounts.getByEmail(IDENTITY.email))!;
    await t.stores.accounts.acceptTerms(account.accountId, "2025-01-01", t.clock.now());
    t.clock.advance(1000);
    expect((await t.googleSignIn(IDENTITY)).status).toBe(200);
    expect((await t.stores.accounts.getById(account.accountId))!.termsVersion).toBe(t.deps.config.termsVersion);
  });
});

describe("ids are opaque", () => {
  it("never derive an account id from the subject or the email", async () => {
    const t = await makeAuthApp();
    const tokens = (await (await t.googleSignIn(IDENTITY)).json()) as TokenResponse;
    expect(tokens.account.account_id).toMatch(/^acc_[A-Za-z0-9_-]{20,}$/);
    expect(tokens.account.account_id).not.toContain(base64urlEncode(utf8Encode(IDENTITY.sub)));
  });
});
