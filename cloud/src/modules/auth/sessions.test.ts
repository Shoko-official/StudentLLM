import { describe, expect, it } from "vitest";
import { createInMemoryStores } from "../../storage";
import { chaosStores } from "../../testing/store-contract";
import { bearer, makeAuthApp, type AuthHarness } from "../../testing/auth-app";
import { expectFixtureConformance, loadFixture } from "../../testing";
import type { TokenResponse } from "../../types";
import { REFRESH_ABSOLUTE_MS, REFRESH_GRACE_MS, REFRESH_IDLE_MS } from "./constants";
import { decryptGraceSuccessor, encryptGraceSuccessor } from "./sessions";

const ADDRESS = "student@example.invalid";
const code = async (res: Response) => (await res.json()).error.code as string;
const refresh = (t: AuthHarness, tokens: { refresh_token: string; device_id: string }, over: Record<string, unknown> = {}) =>
  t.post("/auth/refresh", { refresh_token: tokens.refresh_token, device_id: tokens.device_id, ...over });
const sessionOf = async (t: AuthHarness, tokens: TokenResponse) => (await t.stores.sessions.listActiveByAccount(tokens.account.account_id, t.clock.now()))[0]!;

describe("POST /auth/refresh", () => {
  it("rotates the token, keeps auth_time, and answers the fixture's shape", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    const authTime = (await sessionOf(t, first)).authTime;
    t.clock.advance(10 * 60_000);
    const res = await refresh(t, first);
    await expectFixtureConformance(res.clone(), loadFixture("auth-refresh.success"));
    const second = (await res.json()) as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.device_id).toBe(first.device_id);
    expect(second.access_token).not.toBe(first.access_token);
    // auth_time is copied unchanged: a refresh cannot make a session "fresh".
    const claims = JSON.parse(atob(second.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.auth_time).toBe(Math.floor(authTime / 1000));
    expect((await sessionOf(t, second)).authTime).toBe(authTime);
    expect((await t.get("/v1/account", bearer(second.access_token))).status).toBe(200);
  });

  it("stores only hashes of refresh tokens", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const s = await sessionOf(t, tokens);
    expect(s.currentHash).not.toContain(tokens.refresh_token);
    expect(s.currentHash).toMatch(/^[0-9a-f]{64}$/);
    t.clock.advance(1000);
    const next = (await (await refresh(t, tokens)).json()) as TokenResponse;
    const rotated = await sessionOf(t, next);
    expect(JSON.stringify(rotated)).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(rotated)).not.toContain(next.refresh_token);
    expect(rotated.graceSuccessor).not.toBeNull();
    expect(rotated.graceSuccessor).not.toContain(next.refresh_token);
  });

  it("returns the same successor when the previous token is presented again inside the grace window", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    t.clock.advance(1000);
    const second = (await (await refresh(t, first)).json()) as TokenResponse;
    t.clock.advance(REFRESH_GRACE_MS - 2000);
    const retry = await refresh(t, first);
    await expectFixtureConformance(retry.clone(), loadFixture("auth-refresh.grace_retry"));
    const again = (await retry.json()) as TokenResponse;
    expect(again.refresh_token).toBe(second.refresh_token);
    expect(again.access_token).not.toBe(second.access_token);
    // The successor still works, and using it rotates and ends the grace copy.
    t.clock.advance(100);
    const third = (await (await refresh(t, second)).json()) as TokenResponse;
    expect(third.refresh_token).not.toBe(second.refresh_token);
  });

  it("detects reuse after the grace window: refresh_reuse, and the whole family is revoked", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    t.clock.advance(1000);
    const second = (await (await refresh(t, first)).json()) as TokenResponse;
    t.clock.advance(REFRESH_GRACE_MS + 1000);
    const reuse = await refresh(t, first);
    expect(reuse.status).toBe(401);
    await expectFixtureConformance(reuse.clone(), loadFixture("auth-refresh.refresh_reuse"));
    expect(await code(reuse)).toBe("refresh_reuse");
    // The successor is dead too, and so is the access token of the family.
    expect(await code(await refresh(t, second))).toBe("session_revoked");
    expect(await code(await t.get("/v1/account", bearer(second.access_token)))).toBe("session_revoked");
  });

  it("keeps one previous generation: an older token is unknown, the previous one is grace first and reuse later", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    t.clock.advance(1000);
    const second = (await (await refresh(t, first)).json()) as TokenResponse;
    t.clock.advance(1000);
    const third = (await (await refresh(t, second)).json()) as TokenResponse;
    // `first` is two generations old: the session no longer knows it (session_revoked, the family is untouched).
    expect(await code(await refresh(t, first))).toBe("session_revoked");
    expect((await refresh(t, third)).status).toBe(200);
  });

  it("gives parallel refreshes with one token the same successor, and rotates exactly once (chaos)", async () => {
    const t = await makeAuthApp({ stores: chaosStores(createInMemoryStores(), 31) });
    const first = await t.signedIn(ADDRESS);
    t.clock.advance(1000);
    const results = await Promise.all(Array.from({ length: 12 }, () => refresh(t, first)));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as TokenResponse[];
    expect(new Set(bodies.map((b) => b.refresh_token)).size).toBe(1);
    const sessions = await t.stores.sessions.listActiveByAccount(first.account.account_id, t.clock.now());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prevHash).not.toBeNull();
    // The family survived: the successor works.
    expect((await refresh(t, bodies[0]!)).status).toBe(200);
  });

  it("refuses a wrong device id without revoking the family", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    const wrong = await refresh(t, first, { device_id: "dev_other" });
    expect(await code(wrong)).toBe("session_revoked");
    expect((await refresh(t, first)).status).toBe(200);
  });

  it("answers session_revoked for unknown and malformed tokens", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    for (const refresh_token of ["rt_unknown", "garbage", "x".repeat(300)]) {
      expect(await code(await refresh(t, { refresh_token, device_id: first.device_id }))).toBe("session_revoked");
    }
    expect((await refresh(t, first, { extra: true })).status).toBe(400);
    expect((await t.post("/auth/refresh", { refresh_token: first.refresh_token })).status).toBe(400);
  });

  it("revokes after exactly the idle and the absolute lifetime", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(ADDRESS);
    t.clock.advance(REFRESH_IDLE_MS);
    expect(await code(await refresh(t, a))).toBe("session_revoked");

    const t2 = await makeAuthApp();
    let tokens = await t2.signedIn(ADDRESS);
    const start = t2.clock.now();
    while (t2.clock.now() - start < REFRESH_ABSOLUTE_MS - REFRESH_IDLE_MS / 2) {
      t2.clock.advance(REFRESH_IDLE_MS / 2);
      tokens = (await (await refresh(t2, tokens)).json()) as TokenResponse;
    }
    t2.clock.advance(REFRESH_IDLE_MS / 2 + 1000);
    expect(await code(await refresh(t2, tokens))).toBe("session_revoked");
  });

  it("is not blocked by terms or suspension (data-rights routes stay reachable)", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    await t.stores.accounts.update(tokens.account.account_id, { status: "suspended" });
    await t.stores.accounts.acceptTerms(tokens.account.account_id, "1999-01-01", t.clock.now());
    expect((await refresh(t, tokens)).status).toBe(200);
  });

  it("answers session_revoked for an account that is being deleted", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    await t.stores.accounts.markDeleting(tokens.account.account_id, t.clock.now());
    expect(await code(await refresh(t, tokens))).toBe("session_revoked");
  });
});

describe("the grace copy", () => {
  it("opens only with the previous token and the family it was sealed for", async () => {
    const sealed = await encryptGraceSuccessor("rt_previous", "rt_successor", "fam_1");
    expect(await decryptGraceSuccessor("rt_previous", sealed, "fam_1")).toBe("rt_successor");
    expect(await decryptGraceSuccessor("rt_other", sealed, "fam_1")).toBeNull();
    expect(await decryptGraceSuccessor("rt_previous", sealed, "fam_2")).toBeNull();
    expect(await decryptGraceSuccessor("rt_previous", sealed.slice(0, -4) + "AAAA", "fam_1")).toBeNull();
    expect(await decryptGraceSuccessor("rt_previous", "short", "fam_1")).toBeNull();
    expect(await encryptGraceSuccessor("rt_previous", "rt_successor", "fam_1")).not.toBe(sealed); // fresh IV every time
  });

  it("is erased by the cron job once the window is over, after which a replay is reuse", async () => {
    const t = await makeAuthApp();
    const first = await t.signedIn(ADDRESS);
    t.clock.advance(1000);
    await refresh(t, first);
    expect((await sessionOf(t, first)).graceSuccessor).not.toBeNull();
    t.clock.advance(REFRESH_GRACE_MS + 1);
    await t.app.scheduled({ scheduledTime: t.clock.now(), cron: "* * * * *" });
    expect((await sessionOf(t, first)).graceSuccessor).toBeNull();
    expect(await code(await refresh(t, first))).toBe("refresh_reuse");
  });
});

describe("POST /auth/logout", () => {
  it("revokes the family, frees the device, and is idempotent", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    const out = await t.post("/auth/logout", { refresh_token: tokens.refresh_token });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe("");
    expect(await code(await t.get("/v1/account", bearer(tokens.access_token)))).toBe("session_revoked");
    expect(await code(await refresh(t, tokens))).toBe("session_revoked");
    expect(await t.stores.devices.list(tokens.account.account_id)).toEqual([]);
    expect((await t.post("/auth/logout", { refresh_token: tokens.refresh_token })).status).toBe(204);
    expect((await t.post("/auth/logout", { refresh_token: "rt_never_issued" })).status).toBe(204);
  });

  it("works with the previous token of a rotated session and keeps other devices signed in", async () => {
    const t = await makeAuthApp();
    const a = await t.signedIn(ADDRESS, { deviceLabel: "A" });
    const b = await t.signedIn(ADDRESS, { deviceLabel: "B" });
    t.clock.advance(1000);
    const a2 = (await (await refresh(t, a)).json()) as TokenResponse;
    expect((await t.post("/auth/logout", { refresh_token: a.refresh_token })).status).toBe(204);
    expect(await code(await refresh(t, a2))).toBe("session_revoked");
    expect((await t.get("/v1/account", bearer(b.access_token))).status).toBe(200);
    expect(await t.stores.devices.list(a.account.account_id)).toHaveLength(1);
  });

  it("is not blocked by suspension and rejects a malformed body", async () => {
    const t = await makeAuthApp();
    const tokens = await t.signedIn(ADDRESS);
    await t.stores.accounts.update(tokens.account.account_id, { status: "suspended" });
    expect((await t.post("/auth/logout", { refresh_token: tokens.refresh_token })).status).toBe(204);
    expect((await t.post("/auth/logout", {})).status).toBe(400);
    expect((await t.post("/auth/logout", { refresh_token: "x", more: 1 })).status).toBe(400);
  });
});
