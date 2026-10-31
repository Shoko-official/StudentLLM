// Test-only: the behavior every `Stores` implementation must have, as a reusable suite.
//
//   runStoreContract("in-memory", () => createInMemoryStores());
//   runStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));
//
// The Durable Object and D1 adapters run the same suite against their own factory. `chaosStores` wraps every
// store method so it yields to the event loop a random number of times before and after the call, which
// reorders concurrent callers without ever splitting a call: it proves the tests do not depend on lucky
// scheduling and that "atomic" operations stay atomic when callers interleave.

import { describe, expect, it } from "vitest";
import type { SaltedHash, StableHash } from "../crypto/keyed-hash";
import {
  IDEMPOTENCY_TTL_MS,
  MAX_DEVICES,
  type IdempotencyKey,
  type PendingSignIn,
  type PlanRecord,
  type SessionRecord,
  type Stores,
} from "../storage";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

export type StoreFactory = () => Stores;

// ---------------------------------------------------------------------------------------------------
// Chaos wrapper
// ---------------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wraps every method of every store with random yields before and after the call. Deterministic per seed. */
export function chaosStores(stores: Stores, seed = 20261101): Stores {
  const random = mulberry32(seed);
  const wobble = async (): Promise<void> => {
    const microtasks = Math.floor(random() * 4);
    for (let i = 0; i < microtasks; i++) await Promise.resolve();
    if (random() < 0.3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const wrap = <T extends object>(store: T): T =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await wobble();
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          await wobble();
          return result;
        };
      },
    });
  return Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, wrap(store as object)])) as unknown as Stores;
}

// ---------------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------------

export function runStoreContract(label: string, factory: StoreFactory): void {
  async function accountWith(stores: Stores = factory(), id = "acc_1", email = "a@example.invalid") {
    const r = await stores.accounts.create({ accountId: id, email, googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 });
    if (!r.ok) throw new Error("setup failed");
    return { stores, account: r.account };
  }

  describe(`${label}: AccountStore`, () => {
    it("creates, looks up by id, email and Google subject, and returns copies", async () => {
      const { stores, account } = await accountWith();
      account.email = "mutated";
      expect((await stores.accounts.getById("acc_1"))!.email).toBe("a@example.invalid");
      expect((await stores.accounts.getByEmail("A@Example.Invalid"))!.accountId).toBe("acc_1");
      const g = await stores.accounts.create({ accountId: "acc_2", email: "g@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
      expect(g.ok).toBe(true);
      expect((await stores.accounts.getByGoogleSubject("sub_1"))!.accountId).toBe("acc_2");
    });

    it("refuses a second account with the same email or subject, also under parallel creation", async () => {
      const { stores } = await accountWith();
      expect(await stores.accounts.create({ accountId: "acc_x", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 })).toEqual({ ok: false, conflict: "email" });
      await stores.accounts.create({ accountId: "acc_2", email: "b@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
      expect(await stores.accounts.create({ accountId: "acc_3", email: "c@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 })).toEqual({ ok: false, conflict: "google_subject" });
      const race = await Promise.all(["p1", "p2", "p3", "p4"].map((id) => stores.accounts.create({ accountId: id, email: "race@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: T0 })));
      expect(race.filter((r) => r.ok)).toHaveLength(1);
    });

    it("links and unlinks methods but never removes the last one", async () => {
      const { stores } = await accountWith();
      expect((await stores.accounts.addLoginMethod("acc_1", "email")).ok).toBe(false);
      const linked = await stores.accounts.addLoginMethod("acc_1", "google", "sub_9");
      expect(linked.ok && linked.account.loginMethods).toEqual(["email", "google"]);
      expect(await stores.accounts.removeLoginMethod("acc_1", "google")).toMatchObject({ ok: true });
      expect(await stores.accounts.getByGoogleSubject("sub_9")).toBeNull();
      expect(await stores.accounts.removeLoginMethod("acc_1", "email")).toEqual({ ok: false, reason: "last_method" });
      expect(await stores.accounts.removeLoginMethod("acc_1", "google")).toEqual({ ok: false, reason: "not_linked" });
    });

    it("refuses to link a Google subject that belongs to another account", async () => {
      const { stores } = await accountWith();
      await stores.accounts.create({ accountId: "acc_2", email: "g@example.invalid", googleSubject: "sub_1", loginMethods: ["google"], termsVersion: "v1", now: T0 });
      expect(await stores.accounts.addLoginMethod("acc_1", "google", "sub_1")).toEqual({ ok: false, reason: "subject_taken" });
    });

    it("records activity at day granularity only", async () => {
      const { stores } = await accountWith();
      expect(await stores.accounts.touchLastRequest("acc_1", T0 + 1000)).toBe(true);
      expect(await stores.accounts.touchLastRequest("acc_1", T0 + 5000)).toBe(false); // same UTC day
      expect((await stores.accounts.getById("acc_1"))!.lastRequestAt).toBe(T0 + 1000);
      expect(await stores.accounts.touchLastRequest("acc_1", T0 + DAY + 5)).toBe(true);
      expect(await stores.accounts.touchLastRequest("nope", T0)).toBe(false);
    });

    const basePlan = (over: Partial<PlanRecord> = {}): PlanRecord => ({
      accountId: "acc_1",
      planId: "plus_monthly",
      status: "active",
      paidPeriods: [{ start: T0, end: T0 + 30 * DAY }],
      cancelAtPeriodEnd: false,
      paddleCustomerId: "ctm_1",
      paddleSubscriptionId: "sub_p1",
      lastEventAt: T0,
      ...over,
    });

    it("saves the plan with compare-and-set on the plan version: a stale read-modify-write conflicts", async () => {
      const { stores } = await accountWith();
      expect(await stores.accounts.savePlan(basePlan(), { expectedPlanVersion: 0 })).toEqual({ ok: true, planVersion: 1 });
      // Two writers both read version 1; only the first wins.
      const results = await Promise.all([
        stores.accounts.savePlan(basePlan({ cancelAtPeriodEnd: true }), { expectedPlanVersion: 1 }),
        stores.accounts.savePlan(basePlan({ status: "past_due" }), { expectedPlanVersion: 1 }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "conflict", currentPlanVersion: 2 });
      expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(2);
      expect(await stores.accounts.savePlan(basePlan({ accountId: "ghost" }), { expectedPlanVersion: 0 })).toEqual({ ok: false, reason: "not_found" });
    });

    it("applies billing events atomically and drops older ones, whatever order they arrive in", async () => {
      const { stores } = await accountWith();
      // 20 events with distinct times, delivered in a scrambled order and in parallel.
      const times = Array.from({ length: 20 }, (_, i) => T0 + (i + 1) * 1000);
      const scrambled = [...times].sort((a, b) => ((a / 1000) * 7919) % 31 - ((b / 1000) * 7919) % 31);
      const outcomes = await Promise.all(
        scrambled.map((at) =>
          stores.accounts.applyPlanEvent("acc_1", at, (current) => ({
            ...(current ?? basePlan({ paidPeriods: [] })),
            // The marker records which event wrote the plan last.
            paddleCustomerId: `ctm_at_${at}`,
          })),
        ),
      );
      const applied = outcomes.filter((o) => o.applied);
      const lastTime = Math.max(...times);
      const plan = (await stores.accounts.getPlan("acc_1"))!;
      expect(plan.lastEventAt).toBe(lastTime);
      expect(plan.paddleCustomerId).toBe(`ctm_at_${lastTime}`); // the newest event wins, not the last to arrive
      expect((await stores.accounts.getById("acc_1"))!.planVersion).toBe(applied.length);
      expect(outcomes.filter((o) => !o.applied && o.reason === "stale").length).toBe(times.length - applied.length);
    });

    it("treats an event at the same time as applicable, an older one as stale, and a missing account as not_found", async () => {
      const { stores } = await accountWith();
      const reduce = (over: Partial<PlanRecord>) => (cur: PlanRecord | null) => ({ ...(cur ?? basePlan()), ...over });
      expect((await stores.accounts.applyPlanEvent("acc_1", T0 + 10, reduce({ status: "active" }))).applied).toBe(true);
      expect((await stores.accounts.applyPlanEvent("acc_1", T0 + 10, reduce({ status: "past_due" }))).applied).toBe(true);
      expect(await stores.accounts.applyPlanEvent("acc_1", T0 + 9, reduce({ status: "canceled" }))).toEqual({ applied: false, reason: "stale" });
      expect((await stores.accounts.getPlan("acc_1"))!.status).toBe("past_due");
      expect(await stores.accounts.applyPlanEvent("ghost", T0, reduce({}))).toEqual({ applied: false, reason: "not_found" });
      await expect(stores.accounts.applyPlanEvent("acc_1", T0 + 20, () => basePlan({ accountId: "other" }))).rejects.toThrow();
    });

    it("maps Paddle ids back to the account and moves them when the plan changes", async () => {
      const { stores } = await accountWith();
      await stores.accounts.savePlan(basePlan(), { expectedPlanVersion: 0 });
      expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_p1")).toBe("acc_1");
      expect(await stores.accounts.findAccountIdByPaddleCustomer("ctm_1")).toBe("acc_1");
      expect(await stores.accounts.findAccountIdByPaddleSubscription("nope")).toBeNull();
    });

    it("erases the account at once, keeps only the Paddle ids in the tombstone, and purges everything", async () => {
      const { stores } = await accountWith();
      await stores.accounts.savePlan(basePlan({ paidPeriods: [] }), { expectedPlanVersion: 0 });
      const t = await stores.accounts.markDeleting("acc_1", T0);
      expect(t).toEqual({ accountId: "acc_1", paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_p1", createdAt: T0 });
      expect(await stores.accounts.getById("acc_1")).toBeNull(); // erased at tombstone creation
      expect(await stores.accounts.getByEmail("a@example.invalid")).toBeNull();
      expect(await stores.accounts.getPlan("acc_1")).toBeNull();
      expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_p1")).toBe("acc_1"); // webhooks still resolve to the tombstone
      expect(await stores.accounts.markDeleting("acc_1", T0 + 5)).toEqual(t); // naturally idempotent
      await stores.accounts.purgeAccount("acc_1");
      expect(await stores.accounts.getById("acc_1")).toBeNull();
      expect(await stores.accounts.getByEmail("a@example.invalid")).toBeNull();
      expect(await stores.accounts.getTombstone("acc_1")).toBeNull();
      expect(await stores.accounts.findAccountIdByPaddleSubscription("sub_p1")).toBeNull();
    });
  });

  describe(`${label}: SessionStore`, () => {
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
      const { sessions } = factory();
      await sessions.create(session());
      const rotated = await sessions.rotate("fam_1", "h1", { newHash: "h2", graceSuccessor: "enc", now: T0 + 1000, idleExpiresAt: T0 + 31 * DAY });
      expect(rotated).toMatchObject({ currentHash: "h2", prevHash: "h1", rotatedAt: T0 + 1000, graceSuccessor: "enc", authTime: 100 });
      expect((await sessions.findByTokenHash("h2"))!.match).toBe("current");
      expect((await sessions.findByTokenHash("h1"))!.match).toBe("previous");
      expect(await sessions.rotate("fam_1", "h1", { newHash: "h3", graceSuccessor: null, now: T0 + 2000, idleExpiresAt: T0 })).toBeNull();
      await sessions.clearGrace("fam_1");
      expect((await sessions.getByFamily("fam_1"))!.graceSuccessor).toBeNull();
    });

    it("lets exactly one of two racing refreshes rotate", async () => {
      const { sessions } = factory();
      await sessions.create(session());
      const results = await Promise.all(
        ["n1", "n2", "n3"].map((newHash) => sessions.rotate("fam_1", "h1", { newHash, graceSuccessor: null, now: T0 + 1, idleExpiresAt: T0 + DAY })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("refuses to rotate a revoked family and revokes by device and by account", async () => {
      const { sessions } = factory();
      await sessions.create(session());
      await sessions.create(session({ familyId: "fam_2", deviceId: "dev_2", currentHash: "x1" }));
      expect(await sessions.revokeByDevice("acc_1", "dev_1", T0)).toBe(1);
      expect(await sessions.rotate("fam_1", "h1", { newHash: "h2", graceSuccessor: null, now: T0, idleExpiresAt: T0 })).toBeNull();
      expect(await sessions.listActiveByAccount("acc_1", T0)).toHaveLength(1);
      expect(await sessions.revokeAllForAccount("acc_1", T0)).toBe(1);
      expect(await sessions.revokeFamily("fam_1", T0)).toBe(false);
    });

    it("deletes expired and revoked sessions and lists only live ones", async () => {
      const { sessions } = factory();
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
      const { sessions } = factory();
      await sessions.create(session());
      await expect(sessions.create(session())).rejects.toThrow();
      await expect(sessions.create(session({ familyId: "fam_2" }))).rejects.toThrow();
    });
  });

  describe(`${label}: DeviceStore`, () => {
    it("allows at most three devices per account", async () => {
      const { devices } = factory();
      for (const id of ["d1", "d2", "d3"]) expect((await devices.register({ accountId: "a", deviceId: id, label: id, now: T0 })).ok).toBe(true);
      expect(await devices.register({ accountId: "a", deviceId: "d4", label: "d4", now: T0 })).toEqual({ ok: false, reason: "device_limit_reached" });
      expect(MAX_DEVICES).toBe(3);
      expect((await devices.register({ accountId: "b", deviceId: "d9", label: "x", now: T0 })).ok).toBe(true);
    });

    it("is atomic: parallel sign-ins cannot both take the last slot", async () => {
      const { devices } = factory();
      await devices.register({ accountId: "a", deviceId: "d1", label: "1", now: T0 });
      await devices.register({ accountId: "a", deviceId: "d2", label: "2", now: T0 });
      const results = await Promise.all(["d3", "d4", "d5", "d6"].map((id) => devices.register({ accountId: "a", deviceId: id, label: id, now: T0 })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await devices.list("a")).toHaveLength(3);
    });

    it("honors a device id only for its own account and does not use a slot for a known device", async () => {
      const { devices } = factory();
      for (const id of ["d1", "d2", "d3"]) await devices.register({ accountId: "a", deviceId: id, label: id, now: T0 });
      expect(await devices.register({ accountId: "a", deviceId: "d2", label: "2", now: T0 + 5 })).toMatchObject({ ok: true, created: false });
      expect(await devices.register({ accountId: "b", deviceId: "d2", label: "x", now: T0 })).toEqual({ ok: false, reason: "device_id_taken" });
    });

    it("applies a revocation to the very next check", async () => {
      const { devices } = factory();
      await devices.register({ accountId: "a", deviceId: "d1", label: "1", now: T0 });
      expect(await devices.isActive("a", "d1")).toBe(true);
      expect(await devices.revoke("b", "d1")).toBe(false);
      expect(await devices.revoke("a", "d1")).toBe(true);
      expect(await devices.isActive("a", "d1")).toBe(false);
      expect(await devices.register({ accountId: "a", deviceId: "d9", label: "9", now: T0 })).toMatchObject({ ok: true });
    });

    it("counts new sessions per day and prunes old days", async () => {
      const { devices } = factory();
      expect(await devices.incrementNewSessions("a", "2026-11-01")).toBe(1);
      expect(await devices.incrementNewSessions("a", "2026-11-01")).toBe(2);
      await devices.incrementNewSessions("a", "2026-12-15");
      expect(await devices.getNewSessions("a", "2026-11-01")).toBe(2);
      expect(await devices.pruneNewSessions("2026-12-01")).toBe(1);
      expect(await devices.getNewSessions("a", "2026-11-01")).toBe(0);
    });

    it("mints at most three manage tokens per sign-in code, which expire after 5 minutes", async () => {
      const { devices } = factory();
      const mk = (n: number) => ({ tokenHash: `th${n}`, accountId: "a", expiresAt: T0 + 5 * 60_000, codeId: "code_1" });
      const minted = await Promise.all([1, 2, 3, 4, 5].map((n) => devices.mintManageToken(mk(n), T0)));
      expect(minted.filter(Boolean)).toHaveLength(3);
      const live = (["th1", "th2", "th3", "th4", "th5"] as const)[minted.indexOf(true)]!;
      expect(await devices.getManageToken(live, T0 + 1000)).toMatchObject({ accountId: "a", uses: 0 });
      await devices.recordManageTokenUse(live);
      expect((await devices.getManageToken(live, T0 + 1000))!.uses).toBe(1);
      expect(await devices.getManageToken(live, T0 + 5 * 60_000)).toBeNull();
      expect(await devices.deleteExpiredManageTokens(T0 + 5 * 60_000)).toBe(3);
    });
  });

  describe(`${label}: ConsentStore (append-only)`, () => {
    const grant = (id: string, over = {}) => ({
      consentId: id, accountId: "a", providerSetId: "ps1", providerSetVersion: 1, features: ["chat" as const], textVersion: "t1", granted: true, ...over,
    });

    it("keeps one active record per provider set and a full history", async () => {
      const { consents } = factory();
      expect((await consents.record(grant("c1"), T0)).created).toBe(true);
      expect((await consents.record(grant("c2", { providerSetVersion: 2 }), T0 + 1)).created).toBe(true);
      expect((await consents.getActive("a", "ps1"))!.consentId).toBe("c2");
      expect((await consents.getById("a", "c1"))!.consentId).toBe("c1");
      await consents.record(grant("c3", { granted: false, providerSetVersion: 2 }), T0 + 2);
      expect(await consents.getActive("a", "ps1")).toBeNull();
      expect((await consents.listAll("a")).map((r) => r.consentId)).toEqual(["c1", "c2", "c3"]);
      expect(await consents.listActive("a")).toEqual([]);
    });

    it("returns the existing record for an identical grant instead of appending", async () => {
      const { consents } = factory();
      await consents.record(grant("c1"), T0);
      const again = await consents.record(grant("c9"), T0 + 5);
      expect(again.created).toBe(false);
      expect(again.row.consentId).toBe("c1");
      expect(await consents.listAll("a")).toHaveLength(1);
    });

    it("scopes records to the account and lists one active record per set", async () => {
      const { consents } = factory();
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

  describe(`${label}: LedgerStore`, () => {
    const win = { start: T0, end: T0 + 30 * DAY, limit: 100 };
    const reserve = (requestId: string, credits: number, now = T0 + 1000, idempotency: { route: string; keyHash: string } | null = null) =>
      ({ requestId, feature: "chat" as const, credits, now, expiresAt: now + 120_000, idempotency });

    it("reserves against the remaining budget and refuses an overspend", async () => {
      const { ledger } = factory();
      expect(await ledger.reserve("a", reserve("r0", 10))).toEqual({ ok: false, reason: "no_window" });
      await ledger.ensureWindow("a", win);
      expect(await ledger.reserve("a", reserve("r1", 60))).toMatchObject({ ok: true, remaining: 40, resetsAt: win.end });
      expect(await ledger.reserve("a", reserve("r2", 41))).toEqual({ ok: false, reason: "budget_exhausted", remaining: 40, resetsAt: win.end });
      expect(await ledger.reserve("a", reserve("r1", 1))).toEqual({ ok: false, reason: "duplicate_request" });
    });

    it("cannot overspend under parallel reservations", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.reserve("a", reserve(`r${i}`, 30))));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
    });

    it("keeps accounts apart: the same request id and window never cross accounts", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.ensureWindow("b", { ...win, limit: 10 });
      expect((await ledger.reserve("a", reserve("same", 50))).ok).toBe(true);
      expect((await ledger.reserve("b", reserve("same", 5))).ok).toBe(true);
      expect(await ledger.getReservation("b", "same")).toMatchObject({ credits: 5, accountId: "b" });
      expect(await ledger.settle("b", { requestId: "ghost-of-a", credits: 1, logicalModelId: "m", now: T0 })).toEqual({ settled: false, reason: "unknown" });
      expect(await ledger.release("a", "same", T0)).toBe(true);
      expect((await ledger.getReservation("b", "same"))!.state).toBe("reserved");
      await ledger.purgeAccount("a");
      expect(await ledger.getReservation("b", "same")).not.toBeNull();
    });

    it("settles at actual usage, releases the difference and caps the charge at the reservation", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 50));
      expect(await ledger.settle("a", { requestId: "r1", credits: 42, logicalModelId: "studentllm-large", now: T0 + 2000 })).toMatchObject({ settled: true, charged: 42 });
      expect(await ledger.getCurrentWindow("a", T0 + 3000)).toMatchObject({ used: 42, reserved: 0, requests: 1, byFeature: { chat: 42, transcription: 0, ocr: 0 } });
      await ledger.reserve("a", reserve("r2", 10));
      expect(await ledger.settle("a", { requestId: "r2", credits: 999, logicalModelId: "m", now: T0 + 3000 })).toMatchObject({ settled: true, charged: 10 });
    });

    it("lets the first settlement win and counts the later ones, also when they race", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 50));
      const results = await Promise.all([20, 30, 40].map((credits) => ledger.settle("a", { requestId: "r1", credits, logicalModelId: "m", now: T0 + 1 })));
      expect(results.filter((r) => r.settled)).toHaveLength(1);
      expect(await ledger.doubleSettlementCount("a")).toBe(2);
      const winner = results.find((r) => r.settled)!;
      expect((await ledger.getCurrentWindow("a", T0 + 5))!.used).toBe(winner.settled ? winner.charged : -1);
      expect(await ledger.settle("a", { requestId: "ghost", credits: 1, logicalModelId: "m", now: T0 })).toEqual({ settled: false, reason: "unknown" });
    });

    it("releases a reservation with zero charge and refuses to settle it afterwards", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 50));
      expect(await ledger.release("a", "r1", T0)).toBe(true);
      expect(await ledger.release("a", "r1", T0)).toBe(false);
      expect(await ledger.settle("a", { requestId: "r1", credits: 5, logicalModelId: "m", now: T0 })).toEqual({ settled: false, reason: "released" });
      expect(await ledger.getCurrentWindow("a", T0)).toMatchObject({ used: 0, reserved: 0 });
    });

    it("never resets used credits when a window is ensured again, and revokes current and future windows", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 30));
      await ledger.settle("a", { requestId: "r1", credits: 30, logicalModelId: "m", now: T0 + 5 });
      expect((await ledger.ensureWindow("a", win)).used).toBe(30);
      await ledger.ensureWindow("a", { ...win, start: win.end, end: win.end + 30 * DAY });
      expect(await ledger.revokeWindows("a", T0 + DAY)).toBe(2);
      expect(await ledger.getCurrentWindow("a", T0 + DAY)).toBeNull();
      expect(await ledger.reserve("a", reserve("r2", 1, T0 + DAY))).toEqual({ ok: false, reason: "no_window" });
    });

    it("rejects non-integer credit amounts and prunes old ledger rows per account", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.ensureWindow("b", win);
      await expect(ledger.reserve("a", reserve("r1", 1.5))).rejects.toThrow(RangeError);
      await expect(ledger.reserve("a", reserve("r1", 0))).rejects.toThrow(RangeError);
      await ledger.reserve("a", reserve("r1", 5));
      await ledger.settle("a", { requestId: "r1", credits: 5, logicalModelId: "m", now: T0 });
      await ledger.reserve("b", reserve("r1", 5));
      await ledger.settle("b", { requestId: "r1", credits: 5, logicalModelId: "m", now: T0 });
      expect(await ledger.pruneLedger("a", T0 + DAY)).toBe(1);
      expect(await ledger.getLedgerEntry("a", "r1")).toBeNull();
      expect(await ledger.getLedgerEntry("b", "r1")).not.toBeNull(); // another account is untouched
      expect((await ledger.getCurrentWindow("a", T0 + 10))!.used).toBe(5); // totals survive
    });

    describe("idempotency coupling", () => {
      const key = (keyHash = "k1"): IdempotencyKey => ({ accountId: "a", route: "/v1/chat/completions", keyHash });
      const ref = (keyHash = "k1") => ({ route: "/v1/chat/completions", keyHash });

      it("settle moves the idempotency record to settled with the charge, in the same call", async () => {
        const stores = factory();
        await stores.ledger.ensureWindow("a", win);
        await stores.idempotency.begin(key(), "r1", T0);
        await stores.ledger.reserve("a", reserve("r1", 50, T0 + 1, ref()));
        await stores.ledger.settle("a", { requestId: "r1", credits: 42, logicalModelId: "m", now: T0 + 2 });
        expect(await stores.idempotency.get(key(), T0 + 3)).toMatchObject({ state: "settled", creditsCharged: 42 });
        expect(await stores.idempotency.begin(key(), "r2", T0 + 4)).toMatchObject({ outcome: "conflict", state: "settled" });
      });

      it("release moves it to failed_no_usage with zero charge, and a same-key retry gets a new reservation", async () => {
        const stores = factory();
        await stores.ledger.ensureWindow("a", win);
        await stores.idempotency.begin(key(), "r1", T0);
        await stores.ledger.reserve("a", reserve("r1", 50, T0 + 1, ref()));
        await stores.ledger.release("a", "r1", T0 + 2);
        expect(await stores.idempotency.get(key(), T0 + 3)).toMatchObject({ state: "failed_no_usage", creditsCharged: 0 });
        expect(await stores.idempotency.failedNoUsageCount("a", Math.floor((T0 + 2) / 3_600_000))).toBe(1);
        const retry = await stores.idempotency.begin(key(), "r2", T0 + 4);
        expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_no_usage" });
        expect((await stores.ledger.reserve("a", reserve("r2", 50, T0 + 5, ref()))).ok).toBe(true);
      });

      it("markFailedBeforeForward keeps the reservation so the same-key retry reuses it", async () => {
        const stores = factory();
        await stores.ledger.ensureWindow("a", win);
        await stores.idempotency.begin(key(), "r1", T0);
        await stores.ledger.reserve("a", reserve("r1", 50, T0 + 1, ref()));
        expect(await stores.ledger.markFailedBeforeForward("a", "r1", T0 + 2)).toBe(true);
        expect((await stores.idempotency.get(key(), T0 + 3))!.state).toBe("failed_before_forward");
        expect((await stores.ledger.getReservation("a", "r1"))!.state).toBe("reserved");
        const retry = await stores.idempotency.begin(key(), "r9", T0 + 4);
        expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
        expect(retry.record.requestId).toBe("r1"); // the reservation owner
        await stores.ledger.markForwarded("a", "r1");
        expect(await stores.ledger.markFailedBeforeForward("a", "r1", T0 + 5)).toBe(false); // too late once forwarded
      });
    });

    describe("per-account sweep", () => {
      it("settles forwarded expired reservations at the full amount and releases the others", async () => {
        const stores = factory();
        const { ledger, idempotency, sweeps } = stores;
        await ledger.ensureWindow("a", win);
        const k = (h: string): IdempotencyKey => ({ accountId: "a", route: "/r", keyHash: h });
        await idempotency.begin(k("fwd"), "fwd", T0);
        await idempotency.begin(k("idle"), "idle", T0);
        await ledger.reserve("a", reserve("fwd", 30, T0 + 1000, { route: "/r", keyHash: "fwd" }));
        await ledger.reserve("a", reserve("idle", 20, T0 + 1000, { route: "/r", keyHash: "idle" }));
        await ledger.reserve("a", { ...reserve("live", 10, T0 + 1000), expiresAt: T0 + 10 * DAY });
        await ledger.markForwarded("a", "fwd");

        expect(await sweeps.due(T0 + 500_000, 10)).toEqual(["a"]);
        expect(await ledger.sweep("a", T0 + 500)).toMatchObject({ settled: 0, released: 0 }); // nothing expired yet
        const swept = await ledger.sweep("a", T0 + 500_000);
        expect(swept).toEqual({ settled: 1, released: 1, nextDueAt: T0 + 10 * DAY });

        expect(await ledger.getReservation("a", "fwd")).toMatchObject({ state: "settled" });
        expect(await ledger.getReservation("a", "idle")).toMatchObject({ state: "released" });
        expect(await ledger.getReservation("a", "live")).toMatchObject({ state: "reserved" });
        expect(await ledger.getCurrentWindow("a", T0 + 500_000)).toMatchObject({ used: 30, reserved: 10 });
        expect(await idempotency.get(k("fwd"), T0 + 500_001)).toMatchObject({ state: "settled", creditsCharged: 30 });
        expect(await idempotency.get(k("idle"), T0 + 500_001)).toMatchObject({ state: "failed_no_usage", creditsCharged: 0 });
        expect(await idempotency.failedNoUsageCount("a", Math.floor((T0 + 500_000) / 3_600_000))).toBe(0); // not an anomaly
        expect(await sweeps.due(T0 + 500_000, 10)).toEqual([]); // re-scheduled for the live reservation
        expect(await sweeps.due(T0 + 10 * DAY, 10)).toEqual(["a"]);

        // Repeating the sweep is harmless.
        expect(await ledger.sweep("a", T0 + 500_000)).toEqual({ settled: 0, released: 0, nextDueAt: T0 + 10 * DAY });
        expect(await ledger.getLedgerEntry("a", "fwd")).toMatchObject({ credits: 30, logicalModelId: "unknown_outcome" });
      });

      it("only touches the swept account and clears the registry when nothing is left", async () => {
        const { ledger, sweeps } = factory();
        await ledger.ensureWindow("a", win);
        await ledger.ensureWindow("b", win);
        await ledger.reserve("a", reserve("ra", 5));
        await ledger.reserve("b", reserve("rb", 5));
        expect((await sweeps.due(T0 + DAY, 10)).sort()).toEqual(["a", "b"]);
        expect(await ledger.sweep("a", T0 + DAY)).toEqual({ settled: 0, released: 1, nextDueAt: null });
        expect(await sweeps.due(T0 + DAY, 10)).toEqual(["b"]);
        expect((await ledger.getReservation("b", "rb"))!.state).toBe("reserved");
        expect(await sweeps.due(T0 + DAY, 0)).toEqual([]);
      });

      it("a heartbeat extension keeps a live stream's reservation out of the sweep", async () => {
        const { ledger } = factory();
        await ledger.ensureWindow("a", win);
        await ledger.reserve("a", reserve("r1", 10));
        await ledger.extendReservation("a", "r1", T0 + 900_000);
        expect(await ledger.sweep("a", T0 + 200_000)).toMatchObject({ settled: 0, released: 0, nextDueAt: T0 + 900_000 });
      });
    });
  });

  describe(`${label}: IdempotencyStore`, () => {
    const key: IdempotencyKey = { accountId: "a", route: "/v1/chat/completions", keyHash: "k1" };

    it("starts a new key, then reports in_progress for a retry while in flight", async () => {
      const { idempotency } = factory();
      expect((await idempotency.begin(key, "r1", T0)).outcome).toBe("started");
      const again = await idempotency.begin(key, "r2", T0 + 1);
      expect(again).toMatchObject({ outcome: "conflict", state: "in_progress" });
      expect(again.record.requestId).toBe("r1");
    });

    it("lets exactly one of several parallel first requests start", async () => {
      const { idempotency } = factory();
      const results = await Promise.all(["r1", "r2", "r3", "r4"].map((id) => idempotency.begin(key, id, T0)));
      expect(results.filter((r) => r.outcome === "started")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "conflict")).toHaveLength(3);
    });

    it("scopes keys per account and route", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key, "r1", T0);
      expect((await idempotency.begin({ ...key, accountId: "b" }, "r2", T0)).outcome).toBe("started");
      expect((await idempotency.begin({ ...key, route: "/v1/ocr" }, "r3", T0)).outcome).toBe("started");
    });

    it("reports settled with the original request id and credits", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key, "r1", T0);
      await idempotency.transition(key, ["in_flight"], "settled", T0 + 1, { creditsCharged: 42 });
      const again = await idempotency.begin(key, "r2", T0 + 2);
      expect(again).toMatchObject({ outcome: "conflict", state: "settled" });
      expect(again.record).toMatchObject({ requestId: "r1", creditsCharged: 42 });
    });

    it("allows a same-key retry after failed_before_forward (same request id, so the reservation is reused)", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key, "r1", T0);
      await idempotency.transition(key, ["in_flight"], "failed_before_forward", T0 + 1);
      const retry = await idempotency.begin(key, "r2", T0 + 2);
      expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
      expect(retry.record).toMatchObject({ requestId: "r1", state: "in_flight" });
    });

    it("allows a retry after failed_no_usage with a new request id and counts the event per hour", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key, "r1", T0);
      await idempotency.transition(key, ["in_flight"], "failed_no_usage", T0 + 1);
      expect(await idempotency.failedNoUsageCount("a", Math.floor(T0 / 3_600_000))).toBe(1);
      const retry = await idempotency.begin(key, "r2", T0 + 2);
      expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_no_usage" });
      expect(retry.record.requestId).toBe("r2");
    });

    it("only transitions from the expected states", async () => {
      const { idempotency } = factory();
      expect(await idempotency.transition(key, ["in_flight"], "settled", T0)).toBeNull();
      await idempotency.begin(key, "r1", T0);
      await idempotency.transition(key, ["in_flight"], "settled", T0 + 1);
      expect(await idempotency.transition(key, ["in_flight"], "failed_no_usage", T0 + 2)).toBeNull();
    });

    it("forgets a key after 24 hours", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key, "r1", T0);
      await idempotency.transition(key, ["in_flight"], "settled", T0 + 1, { creditsCharged: 1 });
      expect((await idempotency.begin(key, "r2", T0 + IDEMPOTENCY_TTL_MS)).outcome).toBe("started");
      expect(await idempotency.deleteExpired(T0 + 2 * IDEMPOTENCY_TTL_MS)).toBe(1);
    });

    it("stores nothing derived from content", async () => {
      const { idempotency } = factory();
      const { record } = await idempotency.begin(key, "r1", T0);
      expect(Object.keys(record).sort()).toEqual(["accountId", "createdAt", "creditsCharged", "expiresAt", "keyHash", "requestId", "route", "state"]);
    });
  });

  describe(`${label}: AuthChallengeStore`, () => {
    const EH = "eh" as StableHash;
    const pending = (over: Partial<PendingSignIn> = {}): PendingSignIn => ({
      id: "p1", kind: "email", stateHash: null, emailHash: EH, codeChallenge: "cc", redirectType: null, termsVersion: "v1",
      linkTicketId: null, redirectUri: null, appState: null, deviceLabel: null, googleSubject: null, googleEmail: null, codeHash: "right", accountId: null, attempts: 0, resends: 0, createdAt: T0, expiresAt: T0 + 600_000, ...over,
    });
    const verify = (candidateCodeHash: string, over: { consume?: boolean; maxAttempts?: number; now?: number } = {}) =>
      factoryStores!.authChallenges.verifyEmailCode({ emailHash: EH, candidateCodeHash, maxAttempts: over.maxAttempts ?? 5, consume: over.consume ?? true, now: over.now ?? T0 });
    let factoryStores: Stores | undefined;
    const fresh = () => (factoryStores = factory());

    it("invalidates earlier codes when a new one is requested for the same address", async () => {
      const { authChallenges } = fresh();
      await authChallenges.replaceForEmail(pending());
      await authChallenges.replaceForEmail(pending({ id: "p2", codeHash: "right2" }));
      expect(await verify("right")).toMatchObject({ outcome: "wrong" });
      expect((await authChallenges.getByEmailHash(EH, T0))!.id).toBe("p2");
    });

    it("expires pending sign-ins after 10 minutes", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending());
      expect(await authChallenges.getByEmailHash(EH, T0 + 599_999)).not.toBeNull();
      expect(await authChallenges.getByEmailHash(EH, T0 + 600_000)).toBeNull();
      expect(await verify("right", { now: T0 + 600_000 })).toEqual({ outcome: "gone" });
    });

    it("compares the code inside the store: right is ok and single use, wrong counts, unknown address is gone", async () => {
      const { authChallenges } = fresh();
      expect(await verify("right")).toEqual({ outcome: "gone" });
      await authChallenges.put(pending());
      expect(await verify("nope")).toEqual({ outcome: "wrong", attempts: 1 });
      expect(await verify("nope2")).toEqual({ outcome: "wrong", attempts: 2 });
      const ok = await verify("right");
      expect(ok).toMatchObject({ outcome: "ok", pending: { id: "p1" } });
      expect(await verify("right")).toEqual({ outcome: "gone" }); // consumed
    });

    it("locks after the cap: the right code stops working", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending());
      for (let i = 1; i <= 5; i++) expect(await verify(`g${i}`)).toEqual({ outcome: "wrong", attempts: i });
      expect(await verify("right")).toEqual({ outcome: "locked" });
      expect(await verify("g6")).toEqual({ outcome: "locked" });
    });

    it("holds the cap of 5 against 200 parallel guesses, and the right code cannot slip in afterwards", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending());
      const guesses = await Promise.all(Array.from({ length: 200 }, (_, i) => verify(`guess-${i}`)));
      expect(guesses.filter((g) => g.outcome === "wrong")).toHaveLength(5);
      expect(guesses.filter((g) => g.outcome === "locked")).toHaveLength(195);
      expect(guesses.some((g) => g.outcome === "ok")).toBe(false);
      expect(await verify("right")).toEqual({ outcome: "locked" });
    });

    it("lets the right code through only once when it is sent in parallel", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending());
      const results = await Promise.all(Array.from({ length: 20 }, () => verify("right")));
      expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
    });

    it("with consume false a right code is neither counted nor consumed, but a wrong one still counts", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending());
      for (let i = 0; i < 3; i++) expect(await verify("right", { consume: false })).toMatchObject({ outcome: "ok" });
      expect(await verify("bad", { consume: false })).toEqual({ outcome: "wrong", attempts: 1 });
      expect(await verify("right")).toMatchObject({ outcome: "ok" }); // still there, then consumed
      expect(await verify("right")).toEqual({ outcome: "gone" });
    });

    it("keeps Google single-use codes on getByCodeHash and consumes a pending sign-in exactly once", async () => {
      const { authChallenges } = fresh();
      await authChallenges.put(pending({ id: "g1", kind: "google", stateHash: "sh", emailHash: null, codeHash: "gcode" }));
      expect((await authChallenges.getByStateHash("sh", T0))!.kind).toBe("google");
      expect((await authChallenges.getByCodeHash("gcode", T0))!.id).toBe("g1");
      const results = await Promise.all([authChallenges.consume("g1", T0), authChallenges.consume("g1", T0)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("makes a link ticket single use and short lived", async () => {
      const { authChallenges } = fresh();
      const ticket = { ticketHash: "th", accountId: "a", method: "google" as const, createdAt: T0, expiresAt: T0 + 300_000, used: false };
      await authChallenges.putLinkTicket(ticket);
      const both = await Promise.all([authChallenges.consumeLinkTicket("th", T0 + 1), authChallenges.consumeLinkTicket("th", T0 + 1)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      await authChallenges.putLinkTicket({ ...ticket, ticketHash: "old" });
      expect(await authChallenges.consumeLinkTicket("old", T0 + 300_000)).toBeNull();
    });

    it("keeps expiring counters keyed by salted hashes", async () => {
      const { authChallenges } = fresh();
      const k = "k" as SaltedHash;
      expect(await authChallenges.incrementCounter(k, T0, DAY)).toBe(1);
      expect(await authChallenges.incrementCounter(k, T0 + 10, DAY)).toBe(2);
      expect(await authChallenges.getCounter(k, T0 + 20)).toBe(2);
      expect(await authChallenges.getCounter(k, T0 + DAY)).toBe(0);
      expect(await authChallenges.incrementCounter(k, T0 + DAY, DAY)).toBe(1);
    });
  });

  describe(`${label}: WebhookEventStore`, () => {
    const ev = { eventId: "evt_1", eventType: "subscription.updated", occurredAt: T0 };

    it("claims an event id atomically: of parallel deliveries exactly one wins", async () => {
      const { webhookEvents } = factory();
      const claims = await Promise.all([1, 2, 3, 4, 5].map(() => webhookEvents.claim(ev, T0, 60_000)));
      expect(claims.filter((c) => c.outcome === "claimed")).toHaveLength(1);
      expect(claims.filter((c) => c.outcome === "in_progress")).toHaveLength(4);
    });

    it("answers a duplicate after completion, and quarantines unknown events", async () => {
      const { webhookEvents } = factory();
      const claim = await webhookEvents.claim(ev, T0, 60_000);
      await webhookEvents.complete("evt_1", claim.record.attempt, "processed", { subscription_id: "sub_1", status: "active" }, T0 + 1);
      expect((await webhookEvents.claim(ev, T0 + 2, 60_000)).outcome).toBe("duplicate");
      const q = await webhookEvents.claim({ ...ev, eventId: "evt_2" }, T0, 60_000);
      await webhookEvents.complete("evt_2", q.record.attempt, "quarantined", { subscription_id: "unknown" }, T0 + 1);
      expect((await webhookEvents.listQuarantined()).map((e) => e.eventId)).toEqual(["evt_2"]);
    });

    it("hands out a fencing token: a stale holder cannot complete or release after a takeover", async () => {
      const { webhookEvents } = factory();
      const first = await webhookEvents.claim(ev, T0, 60_000);
      expect(first.record.attempt).toBe(1);
      expect((await webhookEvents.claim(ev, T0 + 59_999, 60_000)).outcome).toBe("in_progress");
      const second = await webhookEvents.claim(ev, T0 + 60_000, 60_000);
      expect(second.outcome).toBe("taken_over");
      expect(second.record.attempt).toBe(2);
      // The slow first worker wakes up with its old token.
      expect(await webhookEvents.complete("evt_1", 1, "processed", { status: "active" }, T0 + 61_000)).toBeNull();
      expect(await webhookEvents.release("evt_1", 1)).toBe(false);
      expect((await webhookEvents.get("evt_1"))!.state).toBe("processing");
      expect(await webhookEvents.complete("evt_1", 2, "processed", { status: "active" }, T0 + 62_000)).toMatchObject({ state: "processed", attempt: 2 });
    });

    it("never reuses a fencing token after a release", async () => {
      const { webhookEvents } = factory();
      const a = await webhookEvents.claim(ev, T0, 60_000);
      expect(await webhookEvents.release("evt_1", a.record.attempt)).toBe(true);
      const b = await webhookEvents.claim(ev, T0 + 10, 60_000);
      expect(b.outcome).toBe("claimed");
      expect(b.record.attempt).toBe(2);
      expect(await webhookEvents.complete("evt_1", a.record.attempt, "processed", {}, T0 + 20)).toBeNull();
    });

    it("stores only allowlisted field names with short scalar values", async () => {
      const { webhookEvents } = factory();
      const c = await webhookEvents.claim(ev, T0, 60_000);
      await expect(webhookEvents.complete("evt_1", c.record.attempt, "processed", { customer_name: "x" } as never, T0)).rejects.toThrow(TypeError);
      await expect(webhookEvents.complete("evt_1", c.record.attempt, "processed", { status: { nested: 1 } } as never, T0)).rejects.toThrow(TypeError);
      await expect(webhookEvents.complete("evt_1", c.record.attempt, "processed", { status: "x".repeat(200) }, T0)).rejects.toThrow(TypeError);
      const ok = await webhookEvents.complete("evt_1", c.record.attempt, "processed", { price_id: "pri_1", period_end: 5, cancel_at_period_end: false, currency: null }, T0);
      expect(ok).toMatchObject({ state: "processed" });
    });
  });

  describe(`${label}: RateLimitStore`, () => {
    it("allows up to the limit inside the window, then denies with a retry time", async () => {
      const { rateLimits } = factory();
      for (let i = 1; i <= 3; i++) {
        expect(await rateLimits.hit("acct:a", 3, 60_000, T0 + i * 1000)).toMatchObject({ allowed: true, remaining: 3 - i, retryAfterSeconds: null });
      }
      const denied = await rateLimits.hit("acct:a", 3, 60_000, T0 + 4000);
      expect(denied).toMatchObject({ allowed: false, remaining: 0, limit: 3 });
      expect(denied.retryAfterSeconds).toBe(57); // the first hit (T0 + 1s) leaves the window at T0 + 61s
    });

    it("slides: old hits expire one by one, and a denied hit is not recorded", async () => {
      const { rateLimits } = factory();
      await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0);
      await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0 + 5000);
      expect((await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0 + 9000)).allowed).toBe(false);
      expect((await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0 + 10_000)).allowed).toBe(true); // the T0 hit slid out
      expect((await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0 + 10_001)).allowed).toBe(false); // the denied one at +9000 did not count
      expect((await rateLimits.hit("k" as SaltedHash, 2, 10_000, T0 + 15_000)).allowed).toBe(true); // +5000 slid out
    });

    it("keeps keys apart and holds the limit under parallel hits", async () => {
      const { rateLimits } = factory();
      const results = await Promise.all(Array.from({ length: 50 }, () => rateLimits.hit("acct:a", 10, 60_000, T0)));
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
      expect((await rateLimits.hit("acct:b", 10, 60_000, T0)).allowed).toBe(true);
    });

    it("rejects nonsense limits and cleans up expired keys", async () => {
      const { rateLimits } = factory();
      await expect(rateLimits.hit("k" as SaltedHash, 0, 1000, T0)).rejects.toThrow(RangeError);
      await expect(rateLimits.hit("k" as SaltedHash, 1, 0, T0)).rejects.toThrow(RangeError);
      await rateLimits.hit("k" as SaltedHash, 1, 1000, T0);
      expect(await rateLimits.deleteExpired(T0 + 500)).toBe(0);
      expect(await rateLimits.deleteExpired(T0 + 2000)).toBe(1);
    });
  });

  describe(`${label}: ConcurrencyStore`, () => {
    it("hands out at most `max` leases per account, and null beyond", async () => {
      const { concurrency } = factory();
      const a = await concurrency.acquire("a", 2, 60_000, T0);
      const b = await concurrency.acquire("a", 2, 60_000, T0);
      expect(a && b).toBeTruthy();
      expect(await concurrency.acquire("a", 2, 60_000, T0)).toBeNull();
      expect((await concurrency.acquire("other", 2, 60_000, T0))).not.toBeNull();
      expect(await concurrency.activeCount("a", T0)).toBe(2);
    });

    it("is atomic: parallel acquires never exceed the limit", async () => {
      const { concurrency } = factory();
      const leases = await Promise.all(Array.from({ length: 20 }, () => concurrency.acquire("a", 2, 60_000, T0)));
      expect(leases.filter(Boolean)).toHaveLength(2);
    });

    it("frees a slot on release, and a crashed request's lease expires by itself", async () => {
      const { concurrency } = factory();
      const a = (await concurrency.acquire("a", 1, 30_000, T0))!;
      expect(await concurrency.acquire("a", 1, 30_000, T0 + 1)).toBeNull();
      expect(await concurrency.release(a)).toBe(true);
      expect(await concurrency.release(a)).toBe(false); // idempotent
      const b = (await concurrency.acquire("a", 1, 30_000, T0 + 2))!;
      expect(b).not.toBeNull();
      expect(await concurrency.acquire("a", 1, 30_000, T0 + 30_001)).toBeNull(); // b still holds it at +30_001
      expect(await concurrency.acquire("a", 1, 30_000, T0 + 30_002)).not.toBeNull(); // b expired at +30_002
    });

    it("renews a live lease and refuses to renew an expired one", async () => {
      const { concurrency } = factory();
      const l = (await concurrency.acquire("a", 1, 10_000, T0))!;
      const renewed = await concurrency.renew(l, 10_000, T0 + 9000);
      expect(renewed!.expiresAt).toBe(T0 + 19_000);
      expect(await concurrency.acquire("a", 1, 10_000, T0 + 12_000)).toBeNull();
      expect(await concurrency.renew(l, 10_000, T0 + 20_000)).toBeNull();
    });
  });

  describe(`${label}: SwitchStore`, () => {
    it("reports the first disabled switch that applies: global, then feature, then provider", async () => {
      const { switches } = factory();
      expect(await switches.findDisabled({ provider: "groq", feature: "chat" })).toBeNull();
      await switches.setDisabled({ scope: "provider", name: "groq" }, true, T0);
      await switches.setDisabled({ scope: "feature", name: "ocr" }, true, T0);
      expect(await switches.findDisabled({ provider: "groq", feature: "chat" })).toEqual({ scope: "provider", name: "groq" });
      expect(await switches.findDisabled({ provider: "other", feature: "ocr" })).toEqual({ scope: "feature", name: "ocr" });
      expect(await switches.findDisabled({ provider: "other", feature: "chat" })).toBeNull();
      await switches.setDisabled({ scope: "global" }, true, T0 + 1);
      expect(await switches.findDisabled({ provider: "other", feature: "chat" })).toEqual({ scope: "global" });
      expect((await switches.listDisabled()).map((t) => t.scope).sort()).toEqual(["feature", "global", "provider"]);
      await switches.setDisabled({ scope: "global" }, false, T0 + 2);
      expect(await switches.findDisabled({ provider: "other", feature: "chat" })).toBeNull();
    });

    it("adds to the global spend counters atomically", async () => {
      const { switches } = factory();
      const totals = await Promise.all(Array.from({ length: 10 }, () => switches.addSpend("day:2026-11-01", 5)));
      expect(Math.max(...totals)).toBe(50);
      expect(new Set(totals).size).toBe(10); // every caller saw its own running total
      expect(await switches.getSpend("day:2026-11-01")).toBe(50);
      expect(await switches.getSpend("month:2026-11")).toBe(0);
      await expect(switches.addSpend("month:2026-11", -1)).rejects.toThrow(RangeError);
    });
  });

  describe(`${label}: account purge`, () => {
    it("removes every account-keyed record from every store", async () => {
      const { stores } = await accountWith();
      await stores.devices.register({ accountId: "acc_1", deviceId: "d1", label: "x", now: T0 });
      await stores.consents.record({ consentId: "c1", accountId: "acc_1", providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "t", granted: true }, T0);
      await stores.ledger.ensureWindow("acc_1", { start: T0, end: T0 + DAY, limit: 10 });
      await stores.ledger.reserve("acc_1", { requestId: "r", feature: "chat", credits: 1, now: T0, expiresAt: T0 + 1000, idempotency: null });
      await stores.idempotency.begin({ accountId: "acc_1", route: "/r", keyHash: "k" }, "r1", T0);
      await stores.concurrency.acquire("acc_1", 2, 1000, T0);
      await stores.sessions.create({ familyId: "f", accountId: "acc_1", deviceId: "d1", currentHash: "h", prevHash: null, rotatedAt: null, graceSuccessor: null, authTime: 1, createdAt: T0, lastUsedAt: T0, idleExpiresAt: T0 + DAY, absoluteExpiresAt: T0 + DAY, revokedAt: null });
      for (const s of [stores.accounts, stores.sessions, stores.devices, stores.consents, stores.ledger, stores.idempotency, stores.authChallenges, stores.concurrency]) {
        await s.purgeAccount("acc_1");
      }
      expect(await stores.accounts.getById("acc_1")).toBeNull();
      expect(await stores.devices.list("acc_1")).toEqual([]);
      expect(await stores.consents.listAll("acc_1")).toEqual([]);
      expect(await stores.ledger.listWindows("acc_1")).toEqual([]);
      expect(await stores.ledger.getReservation("acc_1", "r")).toBeNull();
      expect(await stores.idempotency.get({ accountId: "acc_1", route: "/r", keyHash: "k" }, T0)).toBeNull();
      expect(await stores.concurrency.activeCount("acc_1", T0)).toBe(0);
      expect(await stores.sessions.getByFamily("f")).toBeNull();
      expect(await stores.sweeps.due(T0 + DAY, 10)).toEqual([]);
    });
  });
}
