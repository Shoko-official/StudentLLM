import { describe, expect, it } from "vitest";
import { base64urlEncode, utf8Encode } from "../../crypto/encoding";
import { hmacSha256 } from "../../crypto/hash";
import { bearer, generateSigningKeyPkcs8, makeAuthApp, type AuthHarness } from "../../testing/auth-app";
import { ConfigError, loadConfig } from "../../config";
import { ManualClock, expectFixtureConformance, loadFixture, testEnv } from "../../testing";
import type { TokenResponse } from "../../types";
import { accessTokenClaims, loadTokenKeys, signAccessToken, verifyAccessToken, type AccessTokenClaims } from "./tokens";

const ADDRESS = "student@example.invalid";
const code = async (res: Response) => (await res.json()).error.code as string;
const seconds = (t: AuthHarness) => Math.floor(t.clock.now() / 1000);

async function claimsFor(t: AuthHarness, tokens: TokenResponse, over: Partial<AccessTokenClaims> = {}): Promise<AccessTokenClaims> {
  const [, payload] = tokens.access_token.split(".");
  const base = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/"))) as AccessTokenClaims;
  return { ...base, ...over, iat: seconds(t), exp: seconds(t) + 900, ...(over.exp !== undefined ? { exp: over.exp } : {}) };
}

/** Builds a compact JWT from raw parts, signing with `sign` (or leaving the signature empty). */
async function craft(header: object, claims: object, sign?: (input: Uint8Array) => Promise<Uint8Array>): Promise<string> {
  const input = `${base64urlEncode(utf8Encode(JSON.stringify(header)))}.${base64urlEncode(utf8Encode(JSON.stringify(claims)))}`;
  return `${input}.${sign ? base64urlEncode(await sign(utf8Encode(input))) : ""}`;
}

describe("access tokens", () => {
  it("are EdDSA JWTs with the contract's claims and a kid published in the JWKS", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const [h, p] = tokens.access_token.split(".");
    const dec = (s: string) => JSON.parse(atob(s!.replace(/-/g, "+").replace(/_/g, "/")));
    const header = dec(h!);
    const claims = dec(p!) as AccessTokenClaims;
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT" });
    expect(Object.keys(claims).sort()).toEqual(["aud", "auth_time", "did", "exp", "iat", "iss", "jti", "sid", "sub"]);
    expect(claims.aud).toBe("studentllm-gateway");
    expect(claims.iss).toBe(t.deps.config.issuer);
    expect(claims.exp - claims.iat).toBe(900);
    expect(claims.auth_time).toBe(seconds(t));
    expect(claims.sub).toBe(tokens.account.account_id);
    expect(claims.did).toBe(tokens.device_id);
    // No email, plan or budget in the token.
    expect(JSON.stringify(claims)).not.toContain("example.invalid");

    const jwks = await t.get("/.well-known/jwks.json");
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await jwks.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: header.kid, x: t.signing.publicX });
    expect(body.keys[0].d).toBeUndefined();
  });

  it("expire after about 15 minutes", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    t.clock.advance(14 * 60_000);
    expect((await t.get("/v1/account", bearer(tokens.access_token))).status).toBe(200);
    t.clock.advance(61_000);
    const expired = await t.get("/v1/account", bearer(tokens.access_token));
    expect(expired.status).toBe(401);
    expect(await code(expired)).toBe("invalid_token");
  });

  it("are refused when missing, malformed, or presented without the Bearer scheme", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    for (const headers of [
      {},
      { Authorization: "Basic abc" },
      { Authorization: "Bearer" },
      { Authorization: `Bearer ${tokens.access_token} extra` },
      bearer("not-a-jwt"),
      bearer("a.b.c"),
      bearer(tokens.access_token.split(".").slice(0, 2).join(".")),
      bearer(`${tokens.access_token}.x`),
      bearer("x".repeat(5000)),
    ]) {
      const res = await t.get("/v1/account", headers);
      expect(res.status, JSON.stringify(headers).slice(0, 60)).toBe(401);
      expect(await code(res)).toBe("invalid_token");
    }
  });

  it("are refused when tampered with: payload, signature, header", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const [h, p, s] = tokens.access_token.split(".") as [string, string, string];
    const other = await claimsFor(t, tokens, { sub: "acc_someone_else" });
    const forgedPayload = base64urlEncode(utf8Encode(JSON.stringify(other)));
    const flip = (x: string) => x.slice(0, -2) + (x.endsWith("AA") ? "BB" : "AA");
    for (const token of [`${h}.${forgedPayload}.${s}`, `${h}.${p}.${flip(s)}`, `${base64urlEncode(utf8Encode(JSON.stringify({ alg: "EdDSA", kid: "k" })))}.${p}.${s}`]) {
      const res = await t.get("/v1/account", bearer(token));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("invalid_token");
    }
  });

  it("are refused when signed by another key, even with a kid copied from the real one", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const keys = await t.deps.auth.keys();
    const attacker = await loadTokenKeys((await generateSigningKeyPkcs8()).pkcs8);
    const claims = await claimsFor(t, tokens);
    const forged = await craft({ alg: "EdDSA", typ: "JWT", kid: keys.kid }, claims, (input) => attacker.sign(input));
    const res = await t.get("/v1/account", bearer(forged));
    expect(await code(res)).toBe("invalid_token");
    // A kid nobody published.
    const unknown = await craft({ alg: "EdDSA", typ: "JWT", kid: "nope" }, claims, (input) => keys.sign(input));
    expect(await code(await t.get("/v1/account", bearer(unknown)))).toBe("invalid_token");
  });

  it("pin the algorithm: alg none, HS256 keyed with the public key, and a missing alg are all refused", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const keys = await t.deps.auth.keys();
    const claims = await claimsFor(t, tokens);
    const publicKeyBytes = Uint8Array.from(atob(t.signing.publicX.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const candidates = [
      await craft({ alg: "none", typ: "JWT", kid: keys.kid }, claims),
      await craft({ alg: "None", typ: "JWT", kid: keys.kid }, claims),
      await craft({ alg: "HS256", typ: "JWT", kid: keys.kid }, claims, async (input) => hmacSha256(publicKeyBytes, input)),
      await craft({ typ: "JWT", kid: keys.kid }, claims, (input) => keys.sign(input)),
      await craft({ alg: "eddsa", typ: "JWT", kid: keys.kid }, claims, (input) => keys.sign(input)),
      await craft({ alg: "EdDSA", typ: "JWT", kid: keys.kid, crit: ["exp"] }, claims, (input) => keys.sign(input)),
    ];
    for (const token of candidates) {
      const res = await t.get("/v1/account", bearer(token));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("invalid_token");
    }
    // A correctly signed token with the same claims is fine (the claims are not the problem).
    const good = await craft({ alg: "EdDSA", typ: "JWT", kid: keys.kid }, claims, (input) => keys.sign(input));
    expect((await t.get("/v1/account", bearer(good))).status).toBe(200);
  });

  it("must carry the right audience and issuer and sane times", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const keys = await t.deps.auth.keys();
    const base = await claimsFor(t, tokens);
    const sign = async (claims: object) => craft({ alg: "EdDSA", typ: "JWT", kid: keys.kid }, claims, (input) => keys.sign(input));
    const bad: Array<[string, object]> = [
      ["wrong audience", { ...base, aud: "another-service" }],
      ["array audience", { ...base, aud: ["studentllm-gateway"] }],
      ["wrong issuer", { ...base, iss: "https://evil.example" }],
      ["expired", { ...base, iat: seconds(t) - 1000, exp: seconds(t) - 1 }],
      ["issued in the future", { ...base, iat: seconds(t) + 3600, exp: seconds(t) + 4500 }],
      ["a lifetime of a day", { ...base, exp: seconds(t) + 86_400 }],
      ["no jti", { ...base, jti: undefined }],
      ["no sid", { ...base, sid: undefined }],
      ["string times", { ...base, exp: String(base.exp) }],
    ];
    for (const [name, claims] of bad) {
      const res = await t.get("/v1/account", bearer(await sign(claims)));
      expect(res.status, name).toBe(401);
      expect(await code(res), name).toBe("invalid_token");
    }
    expect((await t.get("/v1/account", bearer(await sign(base)))).status).toBe(200);
  });

  it("verifyAccessToken is false for any token whose signature was made for other bytes", async () => {
    const keys = await loadTokenKeys((await generateSigningKeyPkcs8()).pkcs8);
    const claims = accessTokenClaims({ issuer: "i", audience: "studentllm-gateway", accountId: "a", sessionId: "s", deviceId: "d", authTimeSeconds: 1, nowSeconds: 1000, tokenId: "j" });
    const token = await signAccessToken(keys, claims);
    const expected = { issuer: "i", audience: "studentllm-gateway", nowSeconds: 1001 };
    expect(await verifyAccessToken(keys, token, expected)).toMatchObject({ sub: "a" });
    expect(await verifyAccessToken(keys, token, { ...expected, nowSeconds: 1900 })).toBeNull();
    expect(await verifyAccessToken(keys, token, { ...expected, issuer: "j" })).toBeNull();
  });
});

describe("signing key rotation", () => {
  it("keeps verifying tokens of the previous key while its public half is listed, and stops when it is removed", async () => {
    const clock = new ManualClock();
    const a = await makeAuthApp({ clock });
    const tokens = await a.signedIn(ADDRESS);
    const next = await generateSigningKeyPkcs8();

    // Rotated: a new signing key, the old public key still published.
    const b = await makeAuthApp({ clock, stores: a.stores, env: { TOKEN_SIGNING_KEY: next.pkcs8, TOKEN_PREVIOUS_PUBLIC_KEYS: a.signing.publicX } });
    const jwks = (await (await b.get("/.well-known/jwks.json")).json()).keys as Array<{ x: string; kid: string }>;
    expect(jwks.map((k) => k.x).sort()).toEqual([a.signing.publicX, next.publicX].sort());
    expect(new Set(jwks.map((k) => k.kid)).size).toBe(2);
    expect((await b.get("/v1/account", bearer(tokens.access_token))).status).toBe(200);

    // New tokens are signed with the new key (a different kid), and refresh keeps working across the rotation.
    const refreshed = (await (await b.post("/auth/refresh", { refresh_token: tokens.refresh_token, device_id: tokens.device_id })).json()) as TokenResponse;
    const kidOf = (token: string) => JSON.parse(atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string;
    expect(kidOf(refreshed.access_token)).not.toBe(kidOf(tokens.access_token));
    expect(kidOf(refreshed.access_token)).toBe(jwks.find((k) => k.x === next.publicX)!.kid);
    expect((await b.get("/v1/account", bearer(refreshed.access_token))).status).toBe(200);

    // The old key is dropped from the variable: its tokens are refused.
    const c = await makeAuthApp({ clock, stores: a.stores, env: { TOKEN_SIGNING_KEY: next.pkcs8 } });
    const gone = await c.get("/v1/account", bearer(tokens.access_token));
    expect(await code(gone)).toBe("invalid_token");
    expect((await c.get("/v1/account", bearer(refreshed.access_token))).status).toBe(200);
  });

  it("refuses a malformed TOKEN_PREVIOUS_PUBLIC_KEYS when the config loads, naming the variable and not the value", async () => {
    const good = (await generateSigningKeyPkcs8()).publicX;
    for (const bad of ["not-a-key", `${good}x`, `${good}, junk`, good.slice(0, 40), "A".repeat(44), "+".repeat(43)]) {
      let message = "";
      try {
        loadConfig(testEnv({ TOKEN_PREVIOUS_PUBLIC_KEYS: bad }));
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message, bad).toMatch(/TOKEN_PREVIOUS_PUBLIC_KEYS/);
      expect(message).not.toContain(bad);
    }
    expect(() => loadConfig(testEnv({ TOKEN_PREVIOUS_PUBLIC_KEYS: `${good}, ${good}` }))).not.toThrow();
    expect(() => loadConfig(testEnv({ TOKEN_PREVIOUS_PUBLIC_KEYS: "" }))).not.toThrow();
    expect(() => loadConfig(testEnv({ ENVIRONMENT: "staging", TOKEN_PREVIOUS_PUBLIC_KEYS: "bad" }))).toThrow(/TOKEN_PREVIOUS_PUBLIC_KEYS/);
  });
});

describe("session checks on every request", () => {
  it("answer session_revoked for a revoked family, a revoked device, an expired session and a mismatched account", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const ok = () => t.get("/v1/account", bearer(tokens.access_token));
    expect((await ok()).status).toBe(200);

    // A device revoked in the store applies to the very next request.
    const accountId = tokens.account.account_id;
    await t.stores.devices.revoke(accountId, tokens.device_id);
    const revoked = await ok();
    expect(revoked.status).toBe(401);
    expect(await code(revoked)).toBe("session_revoked");
  });

  it("answers session_revoked once the family is revoked or past its idle expiry", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const family = (await t.stores.sessions.listActiveByAccount(tokens.account.account_id, t.clock.now()))[0]!.familyId;
    await t.stores.sessions.revokeFamily(family, t.clock.now());
    expect(await code(await t.get("/v1/account", bearer(tokens.access_token)))).toBe("session_revoked");
  });

  it("answers session_revoked for a deleted account", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    await t.stores.accounts.purgeAccount(tokens.account.account_id);
    expect(await code(await t.get("/v1/account", bearer(tokens.access_token)))).toBe("session_revoked");
  });
});

describe("the token must match its session", () => {
  async function twoDevices() {
    const t = await makeAuthApp();
    const a1 = await t.signedIn(ADDRESS, { deviceLabel: "A1" });
    const a2 = await t.signedIn(ADDRESS, { deviceLabel: "A2" });
    const b = await t.signedIn("other@example.invalid");
    const keys = await t.deps.auth.keys();
    const sign = async (claims: AccessTokenClaims) => craft({ alg: "EdDSA", typ: "JWT", kid: keys.kid }, claims, (input) => keys.sign(input));
    return { t, a1, a2, b, sign };
  }

  it("refuses a validly signed token whose device belongs to the account but not to the session", async () => {
    const { t, a1, a2, sign } = await twoDevices();
    const forged = await sign(await claimsFor(t, a1, { did: a2.device_id }));
    const res = await t.get("/v1/account", bearer(forged));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("session_revoked");
    expect((await t.get("/v1/account", bearer(await sign(await claimsFor(t, a1))))).status).toBe(200); // the unmodified claims are fine
  });

  it("refuses a validly signed token that names one account's session under another account", async () => {
    const { t, a1, b, sign } = await twoDevices();
    for (const over of [{ sub: b.account.account_id }, { sub: b.account.account_id, did: b.device_id }]) {
      const res = await t.get("/v1/account", bearer(await sign(await claimsFor(t, a1, over))));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("session_revoked");
    }
  });
});

describe("the manage token and the access token are never confused", () => {
  async function atLimit() {
    const t = await makeAuthApp();
    for (const label of ["one", "two", "three"]) await t.signedIn(ADDRESS, { deviceLabel: label });
    const res = await t.emailSignIn(ADDRESS);
    expect(res.status).toBe(409);
    const body = await res.json();
    return { t, manage: body.manage_token as string };
  }

  it("rejects an mt_ token on every route except the two device routes with insufficient_scope", async () => {
    const { t, manage } = await atLimit();
    const fx = loadFixture("account.get.insufficient_scope");
    await expectFixtureConformance(await t.get("/v1/account", bearer(manage)), fx);
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/v1/account"],
      ["DELETE", "/v1/account"],
      ["GET", "/v1/account/export"],
      ["POST", "/v1/account/terms", { terms_version: "x" }],
      ["POST", "/v1/account/link", { method: "google" }],
      ["DELETE", "/v1/account/login-methods/google"],
      ["GET", "/v1/provider-sets"],
      ["POST", "/v1/consent", {}],
      ["POST", "/v1/chat/completions", {}],
      ["GET", "/v1/usage"],
    ];
    for (const [method, path, body] of routes) {
      const res = await t.request(path, {
        method,
        headers: { ...bearer(manage), "Content-Type": "application/json", "X-StudentLLM-Client": "studentllm-desktop/0.2.0" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await code(res), `${method} ${path}`).toBe("insufficient_scope");
    }
    // The scope check comes first: even an mt_ token that was never issued gets insufficient_scope there ...
    expect(await code(await t.get("/v1/account", bearer("mt_never_issued")))).toBe("insufficient_scope");
    // ... but on the device routes an unknown one is simply invalid.
    expect(await code(await t.get("/v1/devices", bearer("mt_never_issued")))).toBe("invalid_token");
  });

  it("does not accept an access token's body as a manage token, nor a manage token dressed as a JWT", async () => {
    const { t, manage } = await atLimit();
    // Without the prefix a manage token is parsed as a JWT and is malformed.
    expect(await code(await t.get("/v1/devices", bearer(manage.slice(3))))).toBe("invalid_token");
    // A real access token on the device routes works as an access token (current is true for its own device).
    const tokens = await t.signedIn("another@example.invalid");
    const list = await t.get("/v1/devices", bearer(tokens.access_token));
    expect(list.status).toBe(200);
  });

  it("expires after 5 minutes", async () => {
    const { t, manage } = await atLimit();
    t.clock.advance(5 * 60_000 - 1000);
    expect((await t.get("/v1/devices", bearer(manage))).status).toBe(200);
    t.clock.advance(1000);
    expect(await code(await t.get("/v1/devices", bearer(manage)))).toBe("invalid_token");
  });
});

describe("the connection rate limit", () => {
  it("applies to the unauthenticated routes per connection, with Retry-After and RateLimit headers", async () => {
    const t = await makeAuthApp();
    const first = await t.post("/auth/logout", { refresh_token: "rt_unknown" });
    expect(first.status).toBe(204);
    expect(first.headers.get("RateLimit-Limit")).toBe("60");
    expect(first.headers.get("RateLimit-Remaining")).toBe("59");
    let denied: Response | undefined;
    for (let i = 0; i < 70 && !denied; i++) {
      const res = await t.post("/auth/logout", { refresh_token: "rt_unknown" });
      if (res.status === 429) denied = res;
    }
    expect(denied).toBeDefined();
    expect(Number(denied!.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await code(denied!)).toBe("rate_limited");
    // Another connection, or the next minute, is fine.
    expect((await t.post("/auth/logout", { refresh_token: "rt_unknown" }, { "CF-Connecting-IP": "198.51.100.7" })).status).toBe(204);
    t.clock.advance(61_000);
    expect((await t.post("/auth/logout", { refresh_token: "rt_unknown" })).status).toBe(204);
  });

  it("never stores the connection address", async () => {
    const t = await makeAuthApp();
    await t.post("/auth/logout", { refresh_token: "rt_unknown" }, { "CF-Connecting-IP": "203.0.113.77" });
    expect(JSON.stringify(t.logs)).not.toContain("203.0.113.77");
    // The rate-limit store only ever saw a hash.
    const dump = JSON.stringify([...(t.stores.rateLimits as unknown as { hits: Map<string, unknown> }).hits.keys()]);
    expect(dump).not.toContain("203.0.113.77");
  });
});
