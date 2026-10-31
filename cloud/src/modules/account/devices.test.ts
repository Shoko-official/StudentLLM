import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../crypto/hash";
import { createInMemoryStores } from "../../storage";
import { expectFixtureConformance, loadFixture } from "../../testing";
import { bearer, makeAuthApp, pkcePair, type AuthHarness } from "../../testing/auth-app";
import { chaosStores } from "../../testing/store-contract";
import type { TokenResponse } from "../../types";
import { emailLookupHash } from "../auth/codes";
import { REFRESH_IDLE_MS } from "../auth/constants";

const ADDRESS = "student@example.invalid";
const code = async (res: Response) => (await res.json()).error.code as string;

/** Three devices, then a fourth email sign-in that stops at the limit. Returns what the client keeps. */
async function atTheLimit(t: AuthHarness) {
  const devices: TokenResponse[] = [];
  for (const label of ["Windows laptop", "MacBook", "Linux desktop"]) devices.push(await t.signedIn(ADDRESS, { deviceLabel: label }));
  t.clock.advance(61_000);
  const pkce = await pkcePair();
  await t.post("/auth/email/request", { email: ADDRESS, code_challenge: pkce.challenge, code_challenge_method: "S256", terms_version: t.deps.config.termsVersion, device_label: "Fourth" });
  const typed = t.email.lastCode(ADDRESS)!;
  const verifyBody = { email: ADDRESS, code: typed, code_verifier: pkce.verifier };
  const res = await t.post("/auth/email/verify", verifyBody);
  return { devices, verifyBody, res, pkce };
}

describe("the device limit", () => {
  it("answers 409 with a manage token in the dedicated schema, leaving the code unconsumed and uncounted", async () => {
    const t = await makeAuthApp();
    const { res, devices } = await atTheLimit(t);
    expect(res.status).toBe(409);
    await expectFixtureConformance(res.clone(), loadFixture("auth-email-verify.device_limit_reached"));
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "device_limit_reached" });
    expect(body.error.details).toBeUndefined();
    expect(body.manage_token).toMatch(/^mt_[A-Za-z0-9_-]{43}$/);
    expect(body.manage_token_expires_in).toBe(300);

    // The token is stored hashed, for 5 minutes, for this account, and tied to the code that produced it.
    const hash = await sha256Hex(body.manage_token);
    const record = (await t.stores.devices.getManageToken(hash, t.clock.now()))!;
    expect(record).toMatchObject({ accountId: devices[0]!.account.account_id, expiresAt: t.clock.now() + 300_000, uses: 0 });
    expect(JSON.stringify(record)).not.toContain(body.manage_token);

    // The code was neither consumed nor counted as an attempt.
    const pending = await t.stores.authChallenges.getByEmailHash(await emailLookupHash(t.env.CODE_HMAC_KEY!, ADDRESS), t.clock.now());
    expect(pending).toMatchObject({ attempts: 0 });
    expect((await t.stores.devices.list(devices[0]!.account.account_id)).length).toBe(3);
  });

  it("lets the user list the devices with the token (current is false for all), revoke one, and retry the same code", async () => {
    const t = await makeAuthApp();
    const { res, verifyBody, devices } = await atTheLimit(t);
    const manage = (await res.json()).manage_token as string;

    const list = await t.get("/v1/devices", bearer(manage));
    await expectFixtureConformance(list.clone(), loadFixture("devices.list.with_manage_token"));
    const listed = (await list.json()).devices as Array<{ device_id: string; current: boolean; label: string }>;
    expect(listed.map((d) => d.label)).toEqual(["Windows laptop", "MacBook", "Linux desktop"]);
    expect(listed.every((d) => d.current === false)).toBe(true);

    const victim = devices[2]!;
    const removed = await t.del(`/v1/devices/${victim.device_id}`, bearer(manage));
    await expectFixtureConformance(removed, loadFixture("devices.revoke.with_manage_token"));
    // The revoked device is out immediately, on its access token and its refresh token.
    expect(await code(await t.get("/v1/account", bearer(victim.access_token)))).toBe("session_revoked");
    expect(await code(await t.post("/auth/refresh", { refresh_token: victim.refresh_token, device_id: victim.device_id }))).toBe("session_revoked");
    // The account is told, at its own address, and the message carries no token.
    const notices = t.email.ofKind("device_revoked");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ to: ADDRESS, deviceLabel: "Linux desktop" });

    // Same code, same verifier: now it signs the fourth device in.
    const retry = await t.post("/auth/email/verify", verifyBody);
    expect(retry.status).toBe(200);
    const fourth = (await retry.json()) as TokenResponse;
    expect(fourth.account.account_id).toBe(victim.account.account_id);
    expect((await t.stores.devices.list(victim.account.account_id)).map((d) => d.label).sort()).toEqual(["Fourth", "MacBook", "Windows laptop"]);

    // The code is spent now, and so is the manage token (it only exists to get through the limit).
    expect(await code(await t.post("/auth/email/verify", verifyBody))).toBe("invalid_code");
    expect(await code(await t.get("/v1/devices", bearer(manage)))).toBe("invalid_token");
  });

  it("mints at most 3 manage tokens per code", async () => {
    const t = await makeAuthApp();
    const { res, verifyBody } = await atTheLimit(t);
    const tokens = [(await res.json()).manage_token as string];
    for (let i = 0; i < 2; i++) tokens.push((await (await t.post("/auth/email/verify", verifyBody)).json()).manage_token);
    expect(new Set(tokens).size).toBe(3);
    const fourth = await t.post("/auth/email/verify", verifyBody);
    expect(fourth.status).toBe(409);
    const body = await fourth.json();
    expect(body.error.code).toBe("device_limit_reached");
    expect(body.manage_token).toBeUndefined();
  });

  it("frees a slot when an old device's session expired (30 days idle)", async () => {
    const t = await makeAuthApp();
    for (const label of ["one", "two", "three"]) await t.signedIn(ADDRESS, { deviceLabel: label });
    t.clock.advance(REFRESH_IDLE_MS + 1000);
    const res = await t.emailSignIn(ADDRESS, { deviceLabel: "four" });
    expect(res.status).toBe(200);
    const account = (await t.stores.accounts.getByEmail(ADDRESS))!;
    expect((await t.stores.devices.list(account.accountId)).map((d) => d.label)).toEqual(["four"]);
  });

  it("takes the last slot atomically: parallel completions of different codes cannot all succeed (chaos)", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 77) });
    const id = { sub: "google-sub-9", email: "parallel@example.invalid" };
    // Two devices through Google, then four fresh authorization codes for the account.
    for (let i = 0; i < 2; i++) expect((await t.googleSignIn(id)).status).toBe(200);
    const exchanges: Array<() => Promise<Response>> = [];
    for (let i = 0; i < 4; i++) {
      const pkce = await pkcePair();
      const start = await t.get(
        `/auth/start?${new URLSearchParams({
          client_id: "studentllm-desktop", redirect_uri: "http://127.0.0.1:50321/callback", response_type: "code", state: `state-${i}-0123456789abcdef`,
          code_challenge: pkce.challenge, code_challenge_method: "S256", provider: "google", terms_version: t.deps.config.termsVersion,
        })}`,
      );
      const granted = t.google.authorize(start.headers.get("Location")!, id);
      const back = new URL((await t.get(`/auth/callback?${granted.query}`)).headers.get("Location")!);
      exchanges.push(() =>
        t.post("/auth/token", {
          grant_type: "authorization_code", code: back.searchParams.get("code"), code_verifier: pkce.verifier,
          redirect_uri: "http://127.0.0.1:50321/callback", client_id: "studentllm-desktop",
        }),
      );
    }
    const results = await Promise.all(exchanges.map((go) => go()));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const account = (await t.stores.accounts.getByEmail(id.email))!;
    expect(await t.stores.devices.list(account.accountId)).toHaveLength(3);
  });
});

describe("GET /v1/devices", () => {
  it("marks the caller's own device as current when called with an access token", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(ADDRESS, { deviceLabel: "A" });
    const b = await t.signedIn(ADDRESS, { deviceLabel: "B" });
    const body = await (await t.get("/v1/devices", bearer(b.access_token))).json();
    expect(body.devices).toHaveLength(2);
    expect(body.devices.find((d: { device_id: string }) => d.device_id === b.device_id).current).toBe(true);
    expect(body.devices.find((d: { device_id: string }) => d.device_id === a.device_id).current).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/rt_|hash/i);
  });

  it("lists only the caller's account", async () => {
    const t = await makeAuthApp();
    const mine = await t.signedIn(ADDRESS);
    await t.signedIn("other@example.invalid");
    const body = await (await t.get("/v1/devices", bearer(mine.access_token))).json();
    expect(body.devices).toHaveLength(1);
  });
});

describe("DELETE /v1/devices/{device_id}", () => {
  it("revokes a device of the account with an access token, taking effect on the very next request", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(ADDRESS, { deviceLabel: "A" });
    const b = await t.signedIn(ADDRESS, { deviceLabel: "B" });
    const res = await t.del(`/v1/devices/${a.device_id}`, bearer(b.access_token));
    expect(res.status).toBe(204);
    expect(await code(await t.get("/v1/account", bearer(a.access_token)))).toBe("session_revoked");
    expect((await t.get("/v1/account", bearer(b.access_token))).status).toBe(200);
    // With an access token no notification is sent (only the manage-token flow mails).
    expect(t.email.ofKind("device_revoked")).toHaveLength(0);
  });

  it("answers not_found for another account's device and for an unknown id, revealing nothing", async () => {
    const t = await makeAuthApp();
    const mine = await t.signedIn(ADDRESS);
    const theirs = await t.signedIn("other@example.invalid");
    for (const id of [theirs.device_id, "dev_unknown"]) {
      const res = await t.del(`/v1/devices/${id}`, bearer(mine.access_token));
      expect(res.status).toBe(404);
      expect(await code(res)).toBe("not_found");
    }
    expect((await t.get("/v1/account", bearer(theirs.access_token))).status).toBe(200);
  });

  it("can revoke the device it is called from", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(ADDRESS);
    expect((await t.del(`/v1/devices/${a.device_id}`, bearer(a.access_token))).status).toBe(204);
    expect(await code(await t.get("/v1/devices", bearer(a.access_token)))).toBe("session_revoked");
  });
});
