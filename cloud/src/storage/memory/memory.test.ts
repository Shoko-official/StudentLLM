import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_TTL_MS,
  MAX_DEVICES,
  type IdempotencyKey,
  type PlanRecord,
  type SessionRecord,
} from "../interfaces";
import { assertAllowlistedFields, createInMemoryStores } from "./index";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

async function accountWith(stores = createInMemoryStores(), id = "acc_1", email = "a@example.invalid") {
  const r = await stores.accounts.create({ accountId: id, email, googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
  if (!r.ok) throw new Error("setup failed");
  return { stores, account: r.account };
}

describe("AccountStore", () => {
  it("creates, looks up by id, email and Google subject, and returns copies", async () => {
    const { stores, account } = await accountWith();
    account.email = "mutated";
    expect((await stores.accounts.getById("acc_1"))!.email).toBe("a@example.invalid");
    expect((await stores.accounts.getByEmail("A@Example.Invalid"))!.accountId).toBe("acc_1");
    const g = await stores.accounts.create({ accountId: "acc_2", email: "g@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
    expect(g.ok).toBe(true);
    expect((await stores.accounts.getByGoogleSubject("sub_1"))!.accountId).toBe("acc_2");
  });

  it("refuses a second account with the same email or subject", async () => {
    const { stores } = await accountWith();
    expect(await stores.accounts.create({ accountId: "acc_x", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 })).toEqual({ ok: false, conflict: "email" });
    await stores.accounts.create({ accountId: "acc_2", email: "b@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
    expect(await stores.accounts.create({ accountId: "acc_3", email: "c@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 })).toEqual({ ok: false, conflict: "google_subject" });
  });

  it("links and unlinks methods but never removes the last one", async () => {
    const { stores } = await accountWith();
    expect((await stores.accounts.addLoginMethod("acc_1", "email")).ok).toBe(false);
    const linked = await stores.accounts.addLoginMethod("acc_1", "google", "sub_9");
    expect(linked.ok && linked.account.loginMethods).toEqual(["email", "google"]);
    expect(await stores.accounts.removeLoginMethod("acc_1", "google")).toMatchObject({ ok: true });
    expect((await stores.accounts.getByGoogleSubject("sub_9"))).toBeNull();
    expect(await stores.accounts.removeLoginMethod("acc_1", "email")).toEqual({ ok: false, reason: "last_method" });
    expect(await stores.accounts.removeLoginMethod("acc_1", "google")).toEqual({ ok: false, reason: "not_linked" });
  });

  it("refuses to link a Google subject that belongs to another account", async () => {
    const { stores } = await accountWith();
    await stores.accounts.create({ accountId: "acc_2", email: "g@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
    expect(await stores.accounts.addLoginMethod("acc_1", "google", "sub_1")).toEqual({ ok: false, reason: "subject_taken" });
  });

  it("bumps the plan version when the plan is saved and maps Paddle ids back to the account", async () => {
    const { stores } = await accountWith();
    const plan: PlanRecord = {
      accountId: "acc_1",
      planId: "plus_monthly",
      status: "active",
      paidPeriods: [{ start: T0, end: T0 + 30 * DAY }],
      cancelAtPeriodEnd: false,
      paddleCustomerId: "ctm_1",
      paddleSubscriptionId: "sub_p1",
      lastEventAt: T0,
    };
    expect(await stores.accounts.savePlan(plan)).toBe(1);
    expect(await stores.accounts.savePlan({ ...plan, cancelAtPeriodEnd: true })).toBe(2);
    expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(2);
    expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_p1")).toBe("acc_1");
    expect(await stores.accounts.findAccountIdByPaddleCustomer("ctm_1")).toBe("acc_1");
    expect(await stores.accounts.findAccountIdByPaddleSubscription("nope")).toBeNull();
  });

  it("keeps only the Paddle ids in a deleting tombstone and purges everything", async () => {
    const { stores } = await accountWith();
    await stores.accounts.savePlan({ accountId: "acc_1", planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_p1", lastEventAt: null });
    const t = await stores.accounts.markDeleting("acc_1", T0);
    expect(t).toEqual({ accountId: "acc_1", paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_p1", createdAt: T0 });
    expect((await stores.accounts.getById("acc_1"))!.status).toBe("deleting");
    expect(await stores.accounts.markDeleting("acc_1", T0 + 5)).toEqual(t); // naturally idempotent
    await stores.accounts.purgeAccount("acc_1");
    expect(await stores.accounts.getById("acc_1")).toBeNull();
    expect(await stores.accounts.getByEmail("a@example.invalid")).toBeNull();
    expect(await stores.accounts.getTombstone("acc_1")).toBeNull();
    expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_p1")).toBeNull();
  });
});

describe("SessionStore", () => {
  const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    familyId: "fam_1",
    accountId: "acc_1",
    deviceId: "dev_1",
    currentHash: "h1",
    prevHash: null,
    rotatedAt: null,
    graceSuccessor: null,
    authTime: 100,
    createdAt: T0,
    lastUsedAt: T0,
    idleExpiresAt: T0 + 30 * DAY,
    absoluteExpiresAt: T0 + 180 * DAY,
    revokedAt: null,
    ...over,
  });

  it("rotates with compare-and-set and finds the previous token as `previous`", async () => {
    const { sessions } = createInMemoryStores();
    await sessions.create(session());
    const rotated = await sessions.rotate("fam_1", "h1", { newHash: "h2", graceSuccessor: "enc", now: T0 + 1000, idleExpiresAt: T0 + 31 * DAY });
    expect(rotated).toMatchObject({ currentHash: "h2", prevHash: "h1", rotatedAt: T0 + 1000, graceSuccessor: "enc", authTime: 100 });
    expect((await sessions.findByTokenHash("h2"))!.match).toBe("current");
    expect((await sessions.findByTokenHash("h1"))!.match).toBe("previous");
    // A second rotation from the stale token fails: only one of two racing refreshes wins.
    expect(await sessions.rotate("fam_1", "h1", { newHash: "h3", graceSuccessor: null, now: T0 + 2000, idleExpiresAt: T0 })).toBeNull();
    await sessions.clearGrace("fam_1");
    expect((await sessions.getByFamily("fam_1"))!.graceSuccessor).toBeNull();
  });

  it("refuses to rotate a revoked family and revokes by device and by account", async () => {
    const { sessions } = createInMemoryStores();
    await sessions.create(session());
    await sessions.create(session({ familyId: "fam_2", deviceId: "dev_2", currentHash: "x1" }));
    expect(await sessions.revokeByDevice("acc_1", "dev_1", T0)).toBe(1);
    expect(await sessions.rotate("fam_1", "h1", { newHash: "h2", graceSuccessor: null, now: T0, idleExpiresAt: T0 })).toBeNull();
    expect(await sessions.listActiveByAccount("acc_1", T0)).toHaveLength(1);
    expect(await sessions.revokeAllForAccount("acc_1", T0)).toBe(1);
    expect(await sessions.revokeFamily("fam_1", T0)).toBe(false);
  });

  it("deletes expired and revoked sessions and lists only live ones", async () => {
    const { sessions } = createInMemoryStores();
    await sessions.create(session({ idleExpiresAt: T0 + 10 }));
    await sessions.create(session({ familyId: "fam_2", currentHash: "x1" }));
    expect(await sessions.listActiveByAccount("acc_1", T0 + 20)).toHaveLength(1);
    expect(await sessions.deleteExpired(T0 + 20)).toBe(1);
    expect(await sessions.getByFamily("fam_1")).toBeNull();
    await sessions.purgeAccount("acc_1");
    expect(await sessions.getByFamily("fam_2")).toBeNull();
    expect(await sessions.findByTokenHash("x1")).toBeNull();
  });

  it("rejects a duplicate family or token hash", async () => {
    const { sessions } = createInMemoryStores();
    await sessions.create(session());
    await expect(sessions.create(session())).rejects.toThrow();
    await expect(sessions.create(session({ familyId: "fam_2" }))).rejects.toThrow();
  });
});

describe("DeviceStore", () => {
  it("allows at most three devices per account", async () => {
    const { devices } = createInMemoryStores();
    for (const id of ["d1", "d2", "d3"]) expect((await devices.register({ accountId: "a", deviceId: id, label: id, now: T0 })).ok).toBe(true);
    expect(await devices.register({ accountId: "a", deviceId: "d4", label: "d4", now: T0 })).toEqual({ ok: false, reason: "device_limit_reached" });
    expect(MAX_DEVICES).toBe(3);
    // Another account has its own slots.
    expect((await devices.register({ accountId: "b", deviceId: "d9", label: "x", now: T0 })).ok).toBe(true);
  });

  it("is atomic: parallel sign-ins cannot both take the last slot", async () => {
    const { devices } = createInMemoryStores();
    await devices.register({ accountId: "a", deviceId: "d1", label: "1", now: T0 });
    await devices.register({ accountId: "a", deviceId: "d2", label: "2", now: T0 });
    const results = await Promise.all(["d3", "d4", "d5", "d6"].map((id) => devices.register({ accountId: "a", deviceId: id, label: id, now: T0 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await devices.list("a")).toHaveLength(3);
  });

  it("honors a device id only for its own account and does not use a slot for a known device", async () => {
    const { devices } = createInMemoryStores();
    for (const id of ["d1", "d2", "d3"]) await devices.register({ accountId: "a", deviceId: id, label: id, now: T0 });
    const again = await devices.register({ accountId: "a", deviceId: "d2", label: "2", now: T0 + 5 });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(await devices.register({ accountId: "b", deviceId: "d2", label: "x", now: T0 })).toEqual({ ok: false, reason: "device_id_taken" });
  });

  it("applies a revocation to the very next check", async () => {
    const { devices } = createInMemoryStores();
    await devices.register({ accountId: "a", deviceId: "d1", label: "1", now: T0 });
    expect(await devices.isActive("a", "d1")).toBe(true);
    expect(await devices.revoke("b", "d1")).toBe(false);
    expect(await devices.revoke("a", "d1")).toBe(true);
    expect(await devices.isActive("a", "d1")).toBe(false);
    expect(await devices.register({ accountId: "a", deviceId: "d9", label: "9", now: T0 })).toMatchObject({ ok: true });
  });

  it("counts new sessions per day and prunes old days", async () => {
    const { devices } = createInMemoryStores();
    expect(await devices.incrementNewSessions("a", "2026-11-01")).toBe(1);
    expect(await devices.incrementNewSessions("a", "2026-11-01")).toBe(2);
    await devices.incrementNewSessions("a", "2026-12-15");
    expect(await devices.getNewSessions("a", "2026-11-01")).toBe(2);
    expect(await devices.pruneNewSessions("2026-12-01")).toBe(1);
    expect(await devices.getNewSessions("a", "2026-11-01")).toBe(0);
  });

  it("mints at most three manage tokens per sign-in code, which expire after 5 minutes", async () => {
    const { devices } = createInMemoryStores();
    const mk = (n: number) => ({ tokenHash: `th${n}`, accountId: "a", expiresAt: T0 + 5 * 60_000, codeId: "code_1" });
    expect(await devices.mintManageToken(mk(1), T0)).toBe(true);
    expect(await devices.mintManageToken(mk(2), T0)).toBe(true);
    expect(await devices.mintManageToken(mk(3), T0)).toBe(true);
    expect(await devices.mintManageToken(mk(4), T0)).toBe(false);
    expect(await devices.getManageToken("th1", T0 + 1000)).toMatchObject({ accountId: "a", uses: 0 });
    await devices.recordManageTokenUse("th1");
    expect((await devices.getManageToken("th1", T0 + 1000))!.uses).toBe(1);
    expect(await devices.getManageToken("th1", T0 + 5 * 60_000)).toBeNull();
    expect(await devices.deleteExpiredManageTokens(T0 + 5 * 60_000)).toBe(3);
  });
});

describe("ConsentStore (append-only)", () => {
  const grant = (id: string, over = {}) => ({
    consentId: id, accountId: "a", providerSetId: "ps1", providerSetVersion: 1, features: ["chat" as const], textVersion: "t1", granted: true, ...over,
  });

  it("keeps one active record per provider set and a full history", async () => {
    const { consents } = createInMemoryStores();
    const first = await consents.record(grant("c1"), T0);
    expect(first.created).toBe(true);
    const replaced = await consents.record(grant("c2", { providerSetVersion: 2 }), T0 + 1);
    expect(replaced.created).toBe(true);
    expect((await consents.getActive("a", "ps1"))!.consentId).toBe("c2");
    expect((await consents.getById("a", "c1"))!.consentId).toBe("c1"); // the replaced record is still provable
    await consents.record(grant("c3", { granted: false, providerSetVersion: 2 }), T0 + 2);
    expect(await consents.getActive("a", "ps1")).toBeNull();
    expect((await consents.listAll("a")).map((r) => r.consentId)).toEqual(["c1", "c2", "c3"]);
    expect(await consents.listActive("a")).toEqual([]);
  });

  it("returns the existing record for an identical grant instead of appending", async () => {
    const { consents } = createInMemoryStores();
    await consents.record(grant("c1"), T0);
    const again = await consents.record(grant("c9"), T0 + 5);
    expect(again.created).toBe(false);
    expect(again.row.consentId).toBe("c1");
    expect(await consents.listAll("a")).toHaveLength(1);
  });

  it("scopes records to the account and lists one active record per set", async () => {
    const { consents } = createInMemoryStores();
    await consents.record(grant("c1"), T0);
    await consents.record(grant("c2", { providerSetId: "ps2" }), T0);
    await consents.record(grant("c3", { accountId: "other" }), T0);
    expect((await consents.listActive("a")).map((r) => r.consentId).sort()).toEqual(["c1", "c2"]);
    expect(await consents.getById("other", "c1")).toBeNull();
    await consents.purgeAccount("a");
    expect(await consents.listAll("a")).toEqual([]);
    expect(await consents.listAll("other")).toHaveLength(1);
  });
});

describe("LedgerStore", () => {
  const win = { accountId: "a", start: T0, end: T0 + 30 * DAY, limit: 100 };
  const reserve = (requestId: string, credits: number, now = T0 + 1000) =>
    ({ requestId, accountId: "a", feature: "chat" as const, credits, now, expiresAt: now + 120_000 });

  it("reserves against the remaining budget and refuses an overspend", async () => {
    const { ledger } = createInMemoryStores();
    expect(await ledger.reserve(reserve("r0", 10))).toEqual({ ok: false, reason: "no_window" });
    await ledger.ensureWindow(win);
    const r1 = await ledger.reserve(reserve("r1", 60));
    expect(r1).toMatchObject({ ok: true, remaining: 40, resetsAt: win.end });
    expect(await ledger.reserve(reserve("r2", 41))).toEqual({ ok: false, reason: "budget_exhausted", remaining: 40, resetsAt: win.end });
    expect(await ledger.reserve(reserve("r1", 1))).toEqual({ ok: false, reason: "duplicate_request" });
  });

  it("cannot overspend under parallel reservations", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.reserve(reserve(`r${i}`, 30))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it("settles at actual usage, releases the difference and caps the charge at the reservation", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await ledger.reserve(reserve("r1", 50));
    const settled = await ledger.settle({ requestId: "r1", credits: 42, logicalModelId: "studentllm-large", now: T0 + 2000 });
    expect(settled).toMatchObject({ settled: true, charged: 42 });
    const w = (await ledger.getCurrentWindow("a", T0 + 3000))!;
    expect(w).toMatchObject({ used: 42, reserved: 0, requests: 1, byFeature: { chat: 42, transcription: 0, ocr: 0 } });

    await ledger.reserve(reserve("r2", 10));
    const capped = await ledger.settle({ requestId: "r2", credits: 999, logicalModelId: "m", now: T0 + 3000 });
    expect(capped).toMatchObject({ settled: true, charged: 10 });
  });

  it("lets the first settlement win and counts the later ones", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await ledger.reserve(reserve("r1", 50));
    await ledger.settle({ requestId: "r1", credits: 20, logicalModelId: "m", now: T0 + 1 });
    expect(await ledger.settle({ requestId: "r1", credits: 50, logicalModelId: "m", now: T0 + 2 })).toEqual({ settled: false, reason: "duplicate" });
    expect(await ledger.doubleSettlementCount("a")).toBe(1);
    expect((await ledger.getCurrentWindow("a", T0 + 5))!.used).toBe(20);
    expect(await ledger.settle({ requestId: "ghost", credits: 1, logicalModelId: "m", now: T0 })).toEqual({ settled: false, reason: "unknown" });
  });

  it("releases a reservation with zero charge and refuses to settle it afterwards", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await ledger.reserve(reserve("r1", 50));
    expect(await ledger.release("r1")).toBe(true);
    expect(await ledger.release("r1")).toBe(false);
    expect(await ledger.settle({ requestId: "r1", credits: 5, logicalModelId: "m", now: T0 })).toEqual({ settled: false, reason: "released" });
    expect(await ledger.getCurrentWindow("a", T0)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("finds expired reservations for the reconciler and extends a live stream's reservation", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await ledger.reserve(reserve("r1", 10));
    await ledger.reserve(reserve("r2", 10));
    await ledger.markForwarded("r2");
    expect(await ledger.findExpiredReservations(T0 + 1000)).toEqual([]);
    await ledger.extendReservation("r1", T0 + 500_000);
    const expired = await ledger.findExpiredReservations(T0 + 200_000);
    expect(expired.map((r) => [r.requestId, r.forwarded])).toEqual([["r2", true]]);
  });

  it("never resets used credits when a window is ensured again, and revokes current and future windows", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await ledger.reserve(reserve("r1", 30));
    await ledger.settle({ requestId: "r1", credits: 30, logicalModelId: "m", now: T0 + 5 });
    expect((await ledger.ensureWindow(win)).used).toBe(30); // a replayed webhook
    const next = { ...win, start: win.end, end: win.end + 30 * DAY };
    await ledger.ensureWindow(next);
    expect(await ledger.revokeWindows("a", T0 + DAY)).toBe(2);
    expect(await ledger.getCurrentWindow("a", T0 + DAY)).toBeNull();
    expect(await ledger.reserve(reserve("r2", 1, T0 + DAY))).toEqual({ ok: false, reason: "no_window" });
  });

  it("rejects non-integer credit amounts and prunes old ledger rows", async () => {
    const { ledger } = createInMemoryStores();
    await ledger.ensureWindow(win);
    await expect(ledger.reserve(reserve("r1", 1.5))).rejects.toThrow(RangeError);
    await expect(ledger.reserve(reserve("r1", 0))).rejects.toThrow(RangeError);
    await ledger.reserve(reserve("r1", 5));
    await ledger.settle({ requestId: "r1", credits: 5, logicalModelId: "m", now: T0 });
    expect(await ledger.pruneLedger(T0 + DAY)).toBe(1);
    expect(await ledger.getLedgerEntry("r1")).toBeNull();
    expect((await ledger.getCurrentWindow("a", T0 + 10))!.used).toBe(5); // totals survive
  });
});

describe("IdempotencyStore", () => {
  const key: IdempotencyKey = { accountId: "a", route: "/v1/chat/completions", keyHash: "k1" };

  it("starts a new key, then reports in_progress for a retry while in flight", async () => {
    const { idempotency } = createInMemoryStores();
    expect((await idempotency.begin(key, "r1", T0)).outcome).toBe("started");
    const again = await idempotency.begin(key, "r2", T0 + 1);
    expect(again).toMatchObject({ outcome: "conflict", state: "in_progress" });
    expect(again.record.requestId).toBe("r1");
  });

  it("scopes keys per account and route", async () => {
    const { idempotency } = createInMemoryStores();
    await idempotency.begin(key, "r1", T0);
    expect((await idempotency.begin({ ...key, accountId: "b" }, "r2", T0)).outcome).toBe("started");
    expect((await idempotency.begin({ ...key, route: "/v1/ocr" }, "r3", T0)).outcome).toBe("started");
  });

  it("reports settled with the original request id and credits", async () => {
    const { idempotency } = createInMemoryStores();
    await idempotency.begin(key, "r1", T0);
    await idempotency.transition(key, ["in_flight"], "settled", T0 + 1, { creditsCharged: 42 });
    const again = await idempotency.begin(key, "r2", T0 + 2);
    expect(again).toMatchObject({ outcome: "conflict", state: "settled" });
    expect(again.record).toMatchObject({ requestId: "r1", creditsCharged: 42 });
  });

  it("allows a same-key retry after failed_before_forward (same request id, so the reservation is reused)", async () => {
    const { idempotency } = createInMemoryStores();
    await idempotency.begin(key, "r1", T0);
    await idempotency.transition(key, ["in_flight"], "failed_before_forward", T0 + 1);
    const retry = await idempotency.begin(key, "r2", T0 + 2);
    expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
    expect(retry.record).toMatchObject({ requestId: "r1", state: "in_flight" });
  });

  it("allows a retry after failed_no_usage with a new request id and counts the event per hour", async () => {
    const { idempotency } = createInMemoryStores();
    await idempotency.begin(key, "r1", T0);
    await idempotency.transition(key, ["in_flight"], "failed_no_usage", T0 + 1);
    expect(await idempotency.failedNoUsageCount("a", Math.floor(T0 / 3_600_000))).toBe(1);
    const retry = await idempotency.begin(key, "r2", T0 + 2);
    expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_no_usage" });
    expect(retry.record.requestId).toBe("r2");
  });

  it("only transitions from the expected states", async () => {
    const { idempotency } = createInMemoryStores();
    expect(await idempotency.transition(key, ["in_flight"], "settled", T0)).toBeNull();
    await idempotency.begin(key, "r1", T0);
    await idempotency.transition(key, ["in_flight"], "settled", T0 + 1);
    expect(await idempotency.transition(key, ["in_flight"], "failed_no_usage", T0 + 2)).toBeNull();
  });

  it("forgets a key after 24 hours", async () => {
    const { idempotency } = createInMemoryStores();
    await idempotency.begin(key, "r1", T0);
    await idempotency.transition(key, ["in_flight"], "settled", T0 + 1, { creditsCharged: 1 });
    expect((await idempotency.begin(key, "r2", T0 + IDEMPOTENCY_TTL_MS)).outcome).toBe("started");
    expect(await idempotency.deleteExpired(T0 + 2 * IDEMPOTENCY_TTL_MS)).toBe(1);
  });

  it("stores nothing derived from content", async () => {
    const { idempotency } = createInMemoryStores();
    const { record } = await idempotency.begin(key, "r1", T0);
    expect(Object.keys(record).sort()).toEqual(["accountId", "createdAt", "creditsCharged", "expiresAt", "keyHash", "requestId", "route", "state"]);
  });
});

describe("AuthChallengeStore", () => {
  const pending = (over = {}) => ({
    id: "p1", kind: "email" as const, stateHash: null, emailHash: "eh", codeChallenge: "cc", redirectType: null, termsVersion: "v1",
    linkTicketId: null, codeHash: "ch", accountId: null, attempts: 0, resends: 0, createdAt: T0, expiresAt: T0 + 600_000, ...over,
  });

  it("invalidates earlier codes when a new one is requested for the same address", async () => {
    const { authChallenges } = createInMemoryStores();
    await authChallenges.replaceForEmail(pending());
    await authChallenges.replaceForEmail(pending({ id: "p2", codeHash: "ch2" }));
    expect(await authChallenges.getByCodeHash("ch", T0)).toBeNull();
    expect((await authChallenges.getByEmailHash("eh", T0))!.id).toBe("p2");
  });

  it("expires pending sign-ins after 10 minutes and counts wrong attempts", async () => {
    const { authChallenges } = createInMemoryStores();
    await authChallenges.put(pending());
    expect(await authChallenges.incrementAttempts("p1")).toBe(1);
    expect(await authChallenges.incrementAttempts("p1")).toBe(2);
    expect(await authChallenges.getByEmailHash("eh", T0 + 599_999)).not.toBeNull();
    expect(await authChallenges.getByEmailHash("eh", T0 + 600_000)).toBeNull();
    expect(await authChallenges.incrementAttempts("nope")).toBeNull();
  });

  it("consumes a pending sign-in exactly once", async () => {
    const { authChallenges } = createInMemoryStores();
    await authChallenges.put(pending({ kind: "google", stateHash: "sh", emailHash: null }));
    expect((await authChallenges.getByStateHash("sh", T0))!.kind).toBe("google");
    const results = await Promise.all([authChallenges.consume("p1", T0), authChallenges.consume("p1", T0)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("makes a link ticket single use and short lived", async () => {
    const { authChallenges } = createInMemoryStores();
    const ticket = { ticketHash: "th", accountId: "a", method: "google" as const, createdAt: T0, expiresAt: T0 + 300_000, used: false };
    await authChallenges.putLinkTicket(ticket);
    const both = await Promise.all([authChallenges.consumeLinkTicket("th", T0 + 1), authChallenges.consumeLinkTicket("th", T0 + 1)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    await authChallenges.putLinkTicket({ ...ticket, ticketHash: "old" });
    expect(await authChallenges.consumeLinkTicket("old", T0 + 300_000)).toBeNull();
  });

  it("keeps expiring counters keyed by salted hashes", async () => {
    const { authChallenges } = createInMemoryStores();
    expect(await authChallenges.incrementCounter("k", T0, DAY)).toBe(1);
    expect(await authChallenges.incrementCounter("k", T0 + 10, DAY)).toBe(2);
    expect(await authChallenges.getCounter("k", T0 + 20)).toBe(2);
    expect(await authChallenges.getCounter("k", T0 + DAY)).toBe(0);
    expect(await authChallenges.incrementCounter("k", T0 + DAY, DAY)).toBe(1);
  });
});

describe("WebhookEventStore", () => {
  const ev = { eventId: "evt_1", eventType: "subscription.updated", occurredAt: T0 };

  it("claims an event id atomically: of parallel deliveries exactly one wins", async () => {
    const { webhookEvents } = createInMemoryStores();
    const claims = await Promise.all([1, 2, 3, 4, 5].map(() => webhookEvents.claim(ev, T0, 60_000)));
    expect(claims.filter((c) => c.outcome === "claimed")).toHaveLength(1);
    expect(claims.filter((c) => c.outcome === "in_progress")).toHaveLength(4);
  });

  it("answers a duplicate after completion, and quarantines unknown events", async () => {
    const { webhookEvents } = createInMemoryStores();
    await webhookEvents.claim(ev, T0, 60_000);
    await webhookEvents.complete("evt_1", "processed", { subscription_id: "sub_1", status: "active" }, T0 + 1);
    expect((await webhookEvents.claim(ev, T0 + 2, 60_000)).outcome).toBe("duplicate");
    await webhookEvents.claim({ ...ev, eventId: "evt_2" }, T0, 60_000);
    await webhookEvents.complete("evt_2", "quarantined", { subscription_id: "unknown" }, T0 + 1);
    expect((await webhookEvents.listQuarantined()).map((e) => e.eventId)).toEqual(["evt_2"]);
  });

  it("takes over a stale claim and lets a failed processing release it", async () => {
    const { webhookEvents } = createInMemoryStores();
    await webhookEvents.claim(ev, T0, 60_000);
    expect((await webhookEvents.claim(ev, T0 + 59_999, 60_000)).outcome).toBe("in_progress");
    expect((await webhookEvents.claim(ev, T0 + 60_000, 60_000)).outcome).toBe("taken_over");
    expect(await webhookEvents.release("evt_1")).toBe(true);
    expect((await webhookEvents.claim(ev, T0 + 70_000, 60_000)).outcome).toBe("claimed");
  });

  it("stores only short scalar allowlisted fields", async () => {
    const { webhookEvents } = createInMemoryStores();
    await webhookEvents.claim(ev, T0, 60_000);
    await expect(webhookEvents.complete("evt_1", "processed", { customer: { name: "x" } } as never, T0)).rejects.toThrow(TypeError);
    await expect(webhookEvents.complete("evt_1", "processed", { note: "x".repeat(200) }, T0)).rejects.toThrow(TypeError);
    expect(() => assertAllowlistedFields({ "Bad Name": 1 })).toThrow(TypeError);
    expect(() => assertAllowlistedFields({ price_id: "pri_1", amount: 5, ok: true, none: null })).not.toThrow();
  });
});

describe("account purge removes every account-keyed record", () => {
  it("leaves nothing behind in any store", async () => {
    const { stores } = await accountWith();
    await stores.devices.register({ accountId: "acc_1", deviceId: "d1", label: "x", now: T0 });
    await stores.consents.record({ consentId: "c1", accountId: "acc_1", providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "t", granted: true }, T0);
    await stores.ledger.ensureWindow({ accountId: "acc_1", start: T0, end: T0 + DAY, limit: 10 });
    await stores.idempotency.begin({ accountId: "acc_1", route: "/r", keyHash: "k" }, "r1", T0);
    await stores.sessions.create({ familyId: "f", accountId: "acc_1", deviceId: "d1", currentHash: "h", prevHash: null, rotatedAt: null, graceSuccessor: null, authTime: 1, createdAt: T0, lastUsedAt: T0, idleExpiresAt: T0 + DAY, absoluteExpiresAt: T0 + DAY, revokedAt: null });
    for (const s of [stores.accounts, stores.sessions, stores.devices, stores.consents, stores.ledger, stores.idempotency, stores.authChallenges]) {
      await s.purgeAccount("acc_1");
    }
    expect(await stores.accounts.getById("acc_1")).toBeNull();
    expect(await stores.devices.list("acc_1")).toEqual([]);
    expect(await stores.consents.listAll("acc_1")).toEqual([]);
    expect(await stores.ledger.listWindows("acc_1")).toEqual([]);
    expect(await stores.idempotency.get({ accountId: "acc_1", route: "/r", keyHash: "k" }, T0)).toBeNull();
    expect(await stores.sessions.getByFamily("f")).toBeNull();
  });
});
