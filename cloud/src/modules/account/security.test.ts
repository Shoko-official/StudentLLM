import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../crypto/hash";
import { bearer, makeAuthApp, pkcePair } from "../../testing/auth-app";
import type { TokenResponse } from "../../types";
import { createAuthDeps } from "../auth";
import { emailLookupHash } from "../auth/codes";
import { createAccountDeps } from "./index";
import { providerSetCatalog } from "./provider-sets";
import { defaultBillingSeam, defaultInferenceSeam, billingSeam, inferenceSeam } from "./seams";

const EMAIL = "student@example.invalid";

afterEach(() => vi.restoreAllMocks());

describe("nothing secret is logged", () => {
  it("keeps tokens, codes, addresses and connection addresses out of every log line, across all flows", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const t = await makeAuthApp();
    const secrets: string[] = [];
    const ip = { "CF-Connecting-IP": "203.0.113.55" };

    // Email sign-in (with the device limit and a manage token), refresh, Google, link, export, delete.
    const devices: TokenResponse[] = [];
    for (const label of ["a", "b", "c"]) devices.push(await t.signedIn(EMAIL, { deviceLabel: label }));
    for (const d of devices) secrets.push(d.access_token, d.refresh_token);
    t.clock.advance(61_000);
    const pkce = await pkcePair();
    await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion }, ip);
    const typed = t.email.lastCode(EMAIL)!;
    secrets.push(typed, pkce.verifier);
    const limit = await t.post("/auth/email/verify", { email: EMAIL, code: typed, code_verifier: pkce.verifier }, ip);
    const manage = (await limit.json()).manage_token as string;
    secrets.push(manage);
    await t.get("/v1/devices", { ...bearer(manage), ...ip });
    await t.get("/v1/account", { ...bearer(manage), ...ip }); // insufficient_scope
    await t.post("/auth/email/verify", { email: EMAIL, code: "AAAAAAAA", code_verifier: pkce.verifier }, ip);
    const refreshed = (await (await t.post("/auth/refresh", { refresh_token: devices[0]!.refresh_token, device_id: devices[0]!.device_id }, ip)).json()) as TokenResponse;
    secrets.push(refreshed.access_token, refreshed.refresh_token);
    await t.post("/auth/refresh", { refresh_token: devices[0]!.refresh_token, device_id: devices[0]!.device_id }, ip);
    t.clock.advance(60_000);
    await t.post("/auth/refresh", { refresh_token: devices[0]!.refresh_token, device_id: devices[0]!.device_id }, ip); // reuse
    const g = (await (await t.googleSignIn({ sub: "g-secret-subject", email: "google@example.invalid" })).json()) as TokenResponse;
    secrets.push(g.access_token, g.refresh_token);
    await t.get("/v1/account/export", bearer(g.access_token));
    await t.del("/v1/account", bearer(g.access_token));
    await t.post("/auth/logout", { refresh_token: devices[1]!.refresh_token }, ip);

    const output = [...lines, JSON.stringify(t.logs)].join("\n");
    for (const secret of secrets) expect(output, secret.slice(0, 8)).not.toContain(secret);
    for (const needle of [EMAIL, "google@example.invalid", "203.0.113.55", "g-secret-subject", "mt_", "rt_", "eyJ", t.signing.pkcs8, t.env.CODE_HMAC_KEY!, "fake-google"]) {
      expect(output, needle).not.toContain(needle);
    }
    // And the structured request log has only the fields the contract names.
    for (const entry of t.logs) expect(Object.keys(entry).sort()).toEqual(["accountId", "creditsCharged", "latencyMs", "method", "requestId", "route", "status"]);
    // The route is the pattern, never the concrete path with a device id in it.
    expect(t.logs.every((l) => !l.route.includes("dev_"))).toBe(true);
  });

  it("never puts a secret in an error envelope", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(EMAIL);
    const responses = [
      await t.post("/auth/refresh", { refresh_token: "rt_bad", device_id: tokens.device_id }),
      await t.post("/auth/email/verify", { email: EMAIL, code: "AAAAAAAA", code_verifier: "v".repeat(43) }),
      await t.get("/v1/account", bearer("mt_secret_looking_token")),
      await t.get("/v1/account", bearer("eyJhbGciOiJub25lIn0.e30.")),
    ];
    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toMatch(/mt_secret|rt_bad|eyJ|AAAAAAAA|v{43}/);
    }
  });
});

describe("secrets in the store are hashed", () => {
  it("holds no plaintext code, refresh token, manage token, link ticket or authorization code", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(EMAIL);
    const ticketRes = await t.request("/v1/account/link", { method: "POST", headers: { ...bearer(tokens.access_token), "Content-Type": "application/json" }, body: JSON.stringify({ method: "google" }) });
    const ticket = (await ticketRes.json()).link_ticket as string;
    const pkce = await pkcePair();
    t.clock.advance(61_000);
    await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion });
    const code = t.email.lastCode(EMAIL)!;
    const session = (await t.stores.sessions.listActiveByAccount(tokens.account.account_id, t.clock.now()))[0]!;
    const dump = JSON.stringify([
      session,
      await t.stores.authChallenges.getLinkTicket(await sha256Hex(ticket), t.clock.now()),
      await t.stores.authChallenges.getByEmailHash(await emailLookupHash(t.env.CODE_HMAC_KEY!, EMAIL), t.clock.now()),
    ]);
    for (const secret of [tokens.refresh_token, ticket, code, EMAIL]) expect(dump).not.toContain(secret);
  });
});

describe("the AuthSeam", () => {
  it("revokeAllSessions ends every session of the account at once", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(EMAIL, { deviceLabel: "A" });
    const b = await t.signedIn(EMAIL, { deviceLabel: "B" });
    const other = await t.signedIn("other@example.invalid");
    await t.deps.auth.revokeAllSessions(a.account.account_id);
    for (const tokens of [a, b]) {
      const res = await t.get("/v1/account", bearer(tokens.access_token));
      expect((await res.json()).error.code).toBe("session_revoked");
      expect((await t.post("/auth/refresh", { refresh_token: tokens.refresh_token, device_id: tokens.device_id })).status).toBe(401);
    }
    expect((await t.get("/v1/account", bearer(other.access_token))).status).toBe(200);
  });

  it("revokeManageTokens kills the manage tokens of the account", async () => {
    const t = await makeAuthApp();
    for (const label of ["a", "b", "c"]) await t.signedIn(EMAIL, { deviceLabel: label });
    const pkce = await pkcePair();
    t.clock.advance(61_000);
    await t.post("/auth/email/request", { email: EMAIL, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion });
    const limit = await t.post("/auth/email/verify", { email: EMAIL, code: t.email.lastCode(EMAIL)!, code_verifier: pkce.verifier });
    const manage = (await limit.json()).manage_token as string;
    expect((await t.get("/v1/devices", bearer(manage))).status).toBe(200);
    const account = (await t.stores.accounts.getByEmail(EMAIL))!;
    await t.deps.auth.revokeManageTokens(account.accountId);
    expect((await t.get("/v1/devices", bearer(manage))).status).toBe(401);
  });

  it("is implemented on the auth deps the other modules reach through Deps", async () => {
    const t = await makeAuthApp();
    expect(typeof t.deps.auth.revokeAllSessions).toBe("function");
    expect(typeof t.deps.auth.revokeManageTokens).toBe("function");
    expect(typeof createAuthDeps(t.core).revokeAllSessions).toBe("function");
  });
});

describe("the other modules' seams", () => {
  it("fall back to inert defaults when a module provides none (the billing and inference modules both do)", async () => {
    const t = await makeAuthApp({ extraDeps: { billing: {} as never, inference: {} as never } });
    expect(billingSeam(t.deps)).toBe(defaultBillingSeam);
    // With the real billing and inference deps the seams are the modules' own.
    const real = await makeAuthApp();
    expect(billingSeam(real.deps)).toBe(real.deps.billing);
    expect(billingSeam(real.deps)).not.toBe(defaultBillingSeam);
    expect(inferenceSeam(t.deps)).toBe(defaultInferenceSeam);
    expect(inferenceSeam(real.deps)).toBe(real.deps.inference);
    expect(inferenceSeam(real.deps)).not.toBe(defaultInferenceSeam);
    expect(await defaultBillingSeam.cancelSubscription("a", "now")).toEqual({ state: "none" });
    expect(await defaultInferenceSeam.usageSnapshot("a")).toEqual({ creditsUsed: 0, windowStart: null, windowEnd: null });
    await expect(defaultInferenceSeam.purgeLedger("a")).resolves.toBeUndefined();
  });

  it("pick up a real implementation as soon as a module has one", async () => {
    const real = { cancelSubscription: async () => ({ state: "cancelled" as const }), usageSnapshot: async () => ({ creditsUsed: 1, windowStart: null, windowEnd: null }), purgeLedger: async () => undefined };
    const t = await makeAuthApp({ extraDeps: { billing: real as never, inference: real as never } });
    expect(billingSeam(t.deps)).toBe(t.deps.billing);
    expect(inferenceSeam(t.deps)).toBe(t.deps.inference);
  });
});

describe("cron cleanup", () => {
  it("removes expired challenges, sessions, manage tokens and rate-limit windows, and keeps the live ones", async () => {
    const t = await makeAuthApp();
    const live = await t.signedIn(EMAIL);
    await t.post("/auth/email/request", { email: "pending@example.invalid", code_challenge: (await pkcePair()).challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion });
    t.clock.advance(11 * 60_000);
    await t.app.scheduled({ scheduledTime: t.clock.now(), cron: "*/5 * * * *" });
    expect(await t.stores.authChallenges.getByEmailHash(await emailLookupHash(t.env.CODE_HMAC_KEY!, "pending@example.invalid"), t.clock.now() - 11 * 60_000)).toBeNull();
    // The live session is untouched (its access token expired, but the session did not).
    const refreshed = await t.post("/auth/refresh", { refresh_token: live.refresh_token, device_id: live.device_id });
    expect(refreshed.status).toBe(200);
  });
});

describe("module wiring", () => {
  it("builds the module deps from the core deps alone, as createDeps does", async () => {
    const t = await makeAuthApp();
    // The provider sets are not stored in the account deps: they come from the inference routing table.
    expect(createAccountDeps(t.core).providerSets).toBeUndefined();
    expect(providerSetCatalog(t.deps).list().map((s) => s.id)).toEqual(["ps1"]);
    expect(typeof createAuthDeps(t.core).keys).toBe("function");
  });
});
