// Test-only: behavior of the inference module's stores (ledger, idempotency, rate limit, concurrency, switches)
// that the general suite in store-contract.ts does not cover: the reviewer follow-ups (a sweep after
// markFailedBeforeForward, the lease of an in_flight record that owns no reservation, the logical model id on a
// reservation) and the atomic operations under parallel callers. Adapters run it with their own factory, next
// to `runStoreContract`, and with `chaosStores(...)` which reorders concurrent callers.

import { describe, expect, it } from "vitest";
import type { IdempotencyKey } from "../storage";
import type { StoreFactory } from "./store-contract";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const ROUTE = "/v1/chat/completions";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runInferenceStoreContract(label: string, factory: StoreFactory): void {
  const win = { start: T0, end: T0 + 30 * DAY, limit: 100 };
  const key = (keyHash = "k1", accountId = "a"): IdempotencyKey => ({ accountId, route: ROUTE, keyHash });
  const ref = (keyHash = "k1") => ({ route: ROUTE, keyHash });
  const reserve = (requestId: string, credits: number, now = T0 + 1000, idempotency: { route: string; keyHash: string } | null = null) => ({
    requestId,
    feature: "chat" as const,
    logicalModelId: "studentllm-large",
    credits,
    now,
    expiresAt: now + 180_000,
    idempotency,
  });

  describe(`${label}: reviewer follow-ups`, () => {
    it("moves a record from failed_before_forward to failed_no_usage when its kept reservation is swept", async () => {
      const { idempotency, ledger } = factory();
      await ledger.ensureWindow("a", win);
      await idempotency.begin(key(), "r1", T0);
      await ledger.reserve("a", reserve("r1", 50, T0 + 1, ref()));
      await ledger.markFailedBeforeForward("a", "r1", T0 + 2);
      expect((await idempotency.get(key(), T0 + 3))!.state).toBe("failed_before_forward");

      // The retry never came. The reservation expires and is released ...
      expect(await ledger.sweep("a", T0 + 1 + 180_000)).toMatchObject({ released: 1, settled: 0 });
      // ... and the record moves with it, so the next retry is a NEW attempt, not a reuse of a dead reservation.
      expect(await idempotency.get(key(), T0 + 200_000)).toMatchObject({ state: "failed_no_usage", creditsCharged: 0 });
      expect(await idempotency.failedNoUsageCount("a", Math.floor((T0 + 1 + 180_000) / 3_600_000))).toBe(0); // not an anomaly

      const retry = await idempotency.begin(key(), "r2", T0 + 200_001);
      expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_no_usage" });
      expect(retry.record.requestId).toBe("r2");
      expect(await ledger.reserve("a", reserve("r2", 50, T0 + 200_002, ref()))).toMatchObject({ ok: true });
      await ledger.markForwarded("a", "r2");
      expect(await ledger.settle("a", { requestId: "r2", credits: 7, logicalModelId: "studentllm-large", now: T0 + 200_003 })).toMatchObject({ settled: true, charged: 7 });
      expect(await idempotency.begin(key(), "r3", T0 + 200_004)).toMatchObject({ outcome: "conflict", state: "settled" });
    });

    it("without the sweep, the retry after failed_before_forward still reuses the reservation (same request id)", async () => {
      const { idempotency, ledger } = factory();
      await ledger.ensureWindow("a", win);
      await idempotency.begin(key(), "r1", T0);
      await ledger.reserve("a", reserve("r1", 50, T0 + 1, ref()));
      await ledger.markFailedBeforeForward("a", "r1", T0 + 2);
      const retry = await idempotency.begin(key(), "r2", T0 + 3);
      expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
      expect(retry.record.requestId).toBe("r1");
      expect(await ledger.reserve("a", reserve("r1", 50, T0 + 4, ref()))).toEqual({ ok: false, reason: "duplicate_request" });
      expect((await ledger.getReservation("a", "r1"))!.state).toBe("reserved");
    });

    it("gives an in_flight record without a reservation a lease; after it, begin treats it as failed_before_forward", async () => {
      const { idempotency } = factory();
      const lease = 180_000;
      expect((await idempotency.begin(key(), "r1", T0, lease)).outcome).toBe("started");
      expect(await idempotency.begin(key(), "r2", T0 + lease - 1, lease)).toMatchObject({ outcome: "conflict", state: "in_progress" });
      const retry = await idempotency.begin(key(), "r3", T0 + lease, lease);
      expect(retry).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
      expect(retry.record).toMatchObject({ requestId: "r1", state: "in_flight", reserved: false });
      // The retry holds a fresh lease.
      expect(await idempotency.begin(key(), "r4", T0 + lease + 10, lease)).toMatchObject({ outcome: "conflict", state: "in_progress" });
      expect(await idempotency.begin(key(), "r5", T0 + 2 * lease, lease)).toMatchObject({ outcome: "retry", previousState: "failed_before_forward" });
    });

    it("lets exactly one of several parallel callers take over an expired lease", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key(), "r1", T0, 1000);
      const results = await Promise.all(["r2", "r3", "r4", "r5", "r6"].map((id) => idempotency.begin(key(), id, T0 + 1000, 1000)));
      expect(results.filter((r) => r.outcome === "retry")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "conflict")).toHaveLength(4);
    });

    it("does not apply the lease to a record that owns a reservation (the sweep resolves it at the reservation's expiry)", async () => {
      const { idempotency, ledger } = factory();
      await ledger.ensureWindow("a", win);
      await idempotency.begin(key(), "r1", T0, 1000);
      await ledger.reserve("a", { ...reserve("r1", 10, T0 + 1, ref()), expiresAt: T0 + 10 * 60_000 });
      expect((await idempotency.get(key(), T0 + 2))!.reserved).toBe(true);
      expect(await idempotency.begin(key(), "r2", T0 + 5 * 60_000, 1000)).toMatchObject({ outcome: "conflict", state: "in_progress" });
      await ledger.sweep("a", T0 + 10 * 60_000);
      expect(await idempotency.begin(key(), "r3", T0 + 10 * 60_000 + 1, 1000)).toMatchObject({ outcome: "retry", previousState: "failed_no_usage" });
    });

    it("rejects a nonsense lease and reports markReserved for a missing record", async () => {
      const { idempotency } = factory();
      await expect(idempotency.begin(key(), "r1", T0, 0)).rejects.toThrow(RangeError);
      expect(await idempotency.markReserved(key("missing"))).toBe(false);
    });

    it("stores the logical model id on the reservation, so a sweep writes a real ledger row", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", { ...reserve("r1", 20), logicalModelId: "studentllm-fast" });
      expect(await ledger.getReservation("a", "r1")).toMatchObject({ logicalModelId: "studentllm-fast" });
      await ledger.markForwarded("a", "r1");
      expect(await ledger.sweep("a", T0 + 1000 + 180_000)).toMatchObject({ settled: 1, settledCredits: 20 });
      expect(await ledger.getLedgerEntry("a", "r1")).toMatchObject({ logicalModelId: "studentllm-fast", credits: 20 });
    });
  });

  describe(`${label}: atomic operations under parallel callers`, () => {
    it("never overspends a window under parallel reservations of mixed sizes, and the totals add up", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      const next = rng(11);
      const sizes = Array.from({ length: 60 }, () => 1 + Math.floor(next() * 15));
      const results = await Promise.all(sizes.map((credits, i) => ledger.reserve("a", reserve(`r${i}`, credits))));
      const granted = results.flatMap((r, i) => (r.ok ? [{ id: `r${i}`, credits: sizes[i]! }] : []));
      const total = granted.reduce((sum, g) => sum + g.credits, 0);
      expect(total).toBeLessThanOrEqual(win.limit);
      expect(total).toBeGreaterThan(win.limit - 15); // nothing was refused while it still fit
      expect(await ledger.getCurrentWindow("a", T0 + 2000)).toMatchObject({ reserved: total, used: 0 });
      for (const r of results) if (!r.ok) expect(r.reason).toBe("budget_exhausted");

      // Settle some, release others, all in parallel: reserved returns to 0 and used is the sum of the charges.
      const outcomes = await Promise.all(
        granted.map((g, i) =>
          i % 3 === 0
            ? ledger.release("a", g.id, T0 + 3000).then(() => 0)
            : ledger.settle("a", { requestId: g.id, credits: Math.max(1, g.credits - 1), logicalModelId: "m", now: T0 + 3000 }).then((s) => (s.settled ? s.charged : 0)),
        ),
      );
      const used = outcomes.reduce((a, b) => a + b, 0);
      expect(await ledger.getCurrentWindow("a", T0 + 4000)).toMatchObject({ reserved: 0, used });
    });

    it("keeps accounts independent while their reservations interleave", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", { ...win, limit: 30 });
      await ledger.ensureWindow("b", { ...win, limit: 30 });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => ledger.reserve(i % 2 === 0 ? "a" : "b", reserve(`r${i}`, 10))),
      );
      const byAccount = (offset: number) => results.filter((_, i) => i % 2 === offset && results[i]!.ok).length;
      expect(byAccount(0)).toBe(3);
      expect(byAccount(1)).toBe(3);
    });

    it("settles a forwarded reservation exactly once when a settlement races the sweep", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 40));
      await ledger.markForwarded("a", "r1");
      const expiry = T0 + 1000 + 180_000;
      const [settled, swept] = await Promise.all([
        ledger.settle("a", { requestId: "r1", credits: 5, logicalModelId: "m", now: expiry }),
        ledger.sweep("a", expiry),
      ]);
      const window = (await ledger.getCurrentWindow("a", expiry))!;
      expect(window.reserved).toBe(0);
      if (settled.settled) {
        expect(window.used).toBe(5);
        expect(swept.settled).toBe(0);
      } else {
        expect(settled).toEqual({ settled: false, reason: "duplicate" });
        expect(window.used).toBe(40); // the unknown outcome was charged in full, once
        expect(swept.settled).toBe(1);
        expect(await ledger.doubleSettlementCount("a")).toBe(1);
      }
      expect(window.requests).toBe(1);
    });

    it("settles at most once per request under many racing settlements, with the right double-settlement count", async () => {
      const { ledger } = factory();
      await ledger.ensureWindow("a", win);
      await ledger.reserve("a", reserve("r1", 40));
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.settle("a", { requestId: "r1", credits: i + 1, logicalModelId: "m", now: T0 + 5 })));
      expect(results.filter((r) => r.settled)).toHaveLength(1);
      expect(await ledger.doubleSettlementCount("a")).toBe(11);
      expect((await ledger.getCurrentWindow("a", T0 + 6))!.requests).toBe(1);
    });

    it("runs the idempotency state machine: one winner per transition, and settled stays settled", async () => {
      const { idempotency } = factory();
      await idempotency.begin(key(), "r1", T0);
      const moves = await Promise.all([
        idempotency.transition(key(), ["in_flight"], "settled", T0 + 1, { creditsCharged: 3 }),
        idempotency.transition(key(), ["in_flight"], "failed_no_usage", T0 + 1),
        idempotency.transition(key(), ["in_flight"], "failed_before_forward", T0 + 1),
      ]);
      expect(moves.filter(Boolean)).toHaveLength(1);
      const final = (await idempotency.get(key(), T0 + 2))!;
      if (final.state === "settled") {
        const again = await Promise.all(["r2", "r3", "r4"].map((id) => idempotency.begin(key(), id, T0 + 3)));
        expect(again.every((r) => r.outcome === "conflict" && r.state === "settled")).toBe(true);
      }
    });

    it("lets exactly one parallel retry start from failed_no_usage and from failed_before_forward", async () => {
      for (const failure of ["failed_no_usage", "failed_before_forward"] as const) {
        const { idempotency } = factory();
        const k = key(`k-${failure}`);
        await idempotency.begin(k, "r1", T0);
        await idempotency.transition(k, ["in_flight"], failure, T0 + 1);
        const results = await Promise.all(["r2", "r3", "r4", "r5"].map((id) => idempotency.begin(k, id, T0 + 2)));
        expect(results.filter((r) => r.outcome === "retry"), failure).toHaveLength(1);
        expect(results.filter((r) => r.outcome === "conflict" && r.state === "in_progress"), failure).toHaveLength(3);
      }
    });

    it("counts failed_no_usage events per account and hour, also when they race", async () => {
      const { idempotency } = factory();
      const keys = Array.from({ length: 8 }, (_, i) => key(`k${i}`));
      await Promise.all(keys.map((k, i) => idempotency.begin(k, `r${i}`, T0)));
      await Promise.all(keys.map((k) => idempotency.transition(k, ["in_flight"], "failed_no_usage", T0 + 5)));
      expect(await idempotency.failedNoUsageCount("a", Math.floor(T0 / 3_600_000))).toBe(8);
      expect(await idempotency.failedNoUsageCount("b", Math.floor(T0 / 3_600_000))).toBe(0);
    });

    it("never hands out more concurrency leases than the limit, through acquire/release cycles", async () => {
      const { concurrency } = factory();
      let live = 0;
      let peak = 0;
      const worker = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) {
          const lease = await concurrency.acquire("a", 3, 60_000, T0);
          if (!lease) continue;
          live++;
          peak = Math.max(peak, live);
          await Promise.resolve();
          live--;
          await concurrency.release(lease);
        }
      };
      await Promise.all(Array.from({ length: 10 }, worker));
      expect(peak).toBeLessThanOrEqual(3);
      expect(await concurrency.activeCount("a", T0)).toBe(0);
    });

    it("expires a lease exactly at its end and refuses to renew it afterwards, also when renew races the clock", async () => {
      const { concurrency } = factory();
      const lease = (await concurrency.acquire("a", 1, 1000, T0))!;
      expect(await concurrency.renew(lease, 1000, T0 + 999)).not.toBeNull();
      const second = await concurrency.renew(lease, 1000, T0 + 1998);
      expect(second!.expiresAt).toBe(T0 + 2998);
      expect(await concurrency.activeCount("a", T0 + 2997)).toBe(1);
      expect(await concurrency.activeCount("a", T0 + 2998)).toBe(0);
      expect(await concurrency.renew(lease, 1000, T0 + 2998)).toBeNull();
      expect(await concurrency.acquire("a", 1, 1000, T0 + 2998)).not.toBeNull();
    });

    it("limits per-account rate buckets independently and holds the limit under parallel hits", async () => {
      const { rateLimits } = factory();
      const hits = await Promise.all(Array.from({ length: 40 }, () => rateLimits.hitAccount("a", "content", 7, 60_000, T0)));
      expect(hits.filter((h) => h.allowed)).toHaveLength(7);
      expect((await rateLimits.hitAccount("a", "read", 7, 60_000, T0)).allowed).toBe(true); // another bucket
      expect((await rateLimits.hitAccount("b", "content", 7, 60_000, T0)).allowed).toBe(true); // another account
      await rateLimits.purgeAccount("a");
      expect((await rateLimits.hitAccount("a", "content", 1, 60_000, T0 + 1)).allowed).toBe(true);
      expect((await rateLimits.hitAccount("b", "content", 7, 60_000, T0 + 1)).remaining).toBe(5); // b was not purged
    });

    it("adds spend atomically and keeps day and month totals apart", async () => {
      const { switches } = factory();
      await Promise.all(Array.from({ length: 25 }, () => switches.addSpend("day:2026-11-01", 4)));
      await switches.addSpend("month:2026-11", 100);
      expect(await switches.getSpend("day:2026-11-01")).toBe(100);
      expect(await switches.getSpend("month:2026-11")).toBe(100);
      expect(await switches.getSpend("day:2026-11-02")).toBe(0);
    });
  });
}
