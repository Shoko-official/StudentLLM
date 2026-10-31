import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../crypto/hash";
import { ACCOUNT_ID, completion, dumpStores, makeInferenceHarness, SECRET_PROMPT } from "../../testing/inference-harness";
import { createInferenceScheduledTasks } from ".";
import { dayPeriod, monthPeriod } from "./availability";
import { sweepAccount } from "./sweeper";

const cron = (h: ReturnType<typeof makeInferenceHarness>) => h.t.app.scheduled({ scheduledTime: h.clock.now(), cron: "* * * * *" });
const key = async (k: string) => ({ accountId: ACCOUNT_ID, route: "/v1/chat/completions", keyHash: await sha256Hex(k) });
const body = { model: "studentllm-large", messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }] };

/** A request that reserved and forwarded but whose gateway died: a reservation nobody will settle. */
async function strand(h: ReturnType<typeof makeInferenceHarness>, id: string, opts: { forwarded: boolean; keyText: string; credits?: number }) {
  await h.stores.ledger.ensureWindow(ACCOUNT_ID, { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), limit: 15000 });
  const k = await key(opts.keyText);
  await h.stores.idempotency.begin(k, id, h.clock.now());
  await h.stores.ledger.reserve(ACCOUNT_ID, {
    requestId: id,
    feature: "chat",
    logicalModelId: "studentllm-large",
    credits: opts.credits ?? 25,
    now: h.clock.now(),
    expiresAt: h.clock.now() + 180_000,
    idempotency: { route: k.route, keyHash: k.keyHash },
  });
  if (opts.forwarded) await h.stores.ledger.markForwarded(ACCOUNT_ID, id);
  return k;
}

describe("the scheduled reconciler", () => {
  it("settles an expired forwarded reservation at the full amount and releases one that never reached the provider", async () => {
    const h = makeInferenceHarness();
    await h.get("/v1/usage"); // makes sure the account exists in the stores
    const fwd = await strand(h, "req_forwarded", { forwarded: true, keyText: "f", credits: 25 });
    const idle = await strand(h, "req_idle", { forwarded: false, keyText: "i", credits: 40 });

    await cron(h); // nothing is due yet
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_forwarded"))!.state).toBe("reserved");

    h.clock.advance(181_000);
    await cron(h);
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_forwarded"))!.state).toBe("settled");
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_idle"))!.state).toBe("released");
    // A real ledger row: the logical model id was stored with the reservation.
    expect(await h.stores.ledger.getLedgerEntry(ACCOUNT_ID, "req_forwarded")).toMatchObject({ credits: 25, logicalModelId: "studentllm-large", feature: "chat" });
    expect(await h.stores.idempotency.get(fwd, h.clock.now())).toMatchObject({ state: "settled", creditsCharged: 25 });
    expect(await h.stores.idempotency.get(idle, h.clock.now())).toMatchObject({ state: "failed_no_usage", creditsCharged: 0 });
    // The credits swept as unknown outcomes are real spend.
    expect(await h.stores.switches.getSpend(dayPeriod(h.clock.now()))).toBe(25);
    expect(await h.stores.switches.getSpend(monthPeriod(h.clock.now()))).toBe(25);
    // The window is whole again except for the settled charge.
    expect(await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now())).toMatchObject({ used: 25, reserved: 0 });
    // The schedule is clear: a second run does nothing.
    expect(await h.stores.sweeps.due(h.clock.now(), 10)).toEqual([]);
    await cron(h);
    expect(await h.stores.switches.getSpend(dayPeriod(h.clock.now()))).toBe(25);
  });

  it("is safe to run repeatedly and in parallel with a request's own settlement", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 10, completion: 5 }) });
    await h.chat(body);
    await Promise.all([cron(h), cron(h), sweepAccount(h.t.deps, ACCOUNT_ID)]);
    expect(await h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now())).toMatchObject({ used: 1, reserved: 0, requests: 1 });
  });

  it("sweeps only the accounts that are due", async () => {
    const h = makeInferenceHarness();
    await h.get("/v1/usage");
    await strand(h, "req_mine", { forwarded: true, keyText: "m" });
    await h.stores.ledger.ensureWindow("acc_other", { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), limit: 100 });
    await h.stores.ledger.reserve("acc_other", { requestId: "req_theirs", feature: "chat", logicalModelId: "m", credits: 5, now: h.clock.now(), expiresAt: h.clock.now() + 10 * 60 * 60_000, idempotency: null });
    h.clock.advance(181_000);
    await cron(h);
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_mine"))!.state).toBe("settled");
    expect((await h.stores.ledger.getReservation("acc_other", "req_theirs"))!.state).toBe("reserved");
  });

  it("keeps going when one account's sweep fails, naming no account in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = makeInferenceHarness();
    await h.get("/v1/usage");
    await strand(h, "req_a", { forwarded: true, keyText: "a" });
    await h.stores.ledger.ensureWindow("acc_b", { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), limit: 100 });
    await h.stores.ledger.reserve("acc_b", { requestId: "req_b", feature: "chat", logicalModelId: "m", credits: 5, now: h.clock.now(), expiresAt: h.clock.now() + 1000, idempotency: null });
    const realSweep = h.stores.ledger.sweep.bind(h.stores.ledger);
    h.stores.ledger.sweep = async (accountId, now) => {
      if (accountId === "acc_b") throw new Error(`boom for ${accountId}`);
      return realSweep(accountId, now);
    };
    h.clock.advance(181_000);
    await cron(h);
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_a"))!.state).toBe("settled");
    const printed = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("inference-sweep failed");
    expect(printed).not.toContain("acc_b");
    spy.mockRestore();
  });

  it("also removes expired idempotency records and old rate-limit windows", async () => {
    const h = makeInferenceHarness();
    const k = h.key();
    await h.chat(body, { "Idempotency-Key": k });
    const hash = await sha256Hex(k);
    expect(dumpStores(h.stores)).toContain(hash);
    expect(dumpStores(h.stores)).toContain(`acct:${ACCOUNT_ID}:content`);
    h.clock.advance(25 * 3_600_000);
    await cron(h);
    expect(dumpStores(h.stores)).not.toContain(hash);
    expect(dumpStores(h.stores)).not.toContain(`acct:${ACCOUNT_ID}:content`);
  });

  it("exposes its two tasks by stable name", () => {
    const h = makeInferenceHarness();
    expect(createInferenceScheduledTasks(h.t.deps).map((t) => t.name)).toEqual(["inference-sweep", "inference-expire"]);
  });
});

describe("InferenceSeam", () => {
  it("is wired in deps: other modules call deps.inference.usageSnapshot and purgeLedger", async () => {
    const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 900, completion: 120 }) });
    expect(await h.t.deps.inference.usageSnapshot(ACCOUNT_ID)).toEqual({ creditsUsed: 0, windowStart: null, windowEnd: null });
    await h.chat(body);
    await h.chat(body);
    expect(await h.t.deps.inference.usageSnapshot(ACCOUNT_ID)).toEqual({ creditsUsed: 6, windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-12-01T00:00:00Z" });
    expect(await h.t.deps.inference.usageSnapshot("acc_nobody")).toEqual({ creditsUsed: 0, windowStart: null, windowEnd: null });
  });

  it("purges every record of the account that this module owns, and only that account's", async () => {
    const h = makeInferenceHarness();
    const mine = await strand(h, "req_mine", { forwarded: false, keyText: "mine" });
    await h.chat(body);
    await h.stores.concurrency.acquire(ACCOUNT_ID, 5, 60_000, h.clock.now());
    await h.stores.ledger.ensureWindow("acc_other", { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1), limit: 100 });
    await h.stores.rateLimits.hitAccount("acc_other", "content", 5, 60_000, h.clock.now());
    await h.stores.idempotency.begin({ accountId: "acc_other", route: "/v1/chat/completions", keyHash: "k" }, "r", h.clock.now());

    await h.t.deps.inference.purgeLedger(ACCOUNT_ID);
    expect(await h.stores.ledger.listWindows(ACCOUNT_ID)).toEqual([]);
    expect(await h.stores.ledger.getReservation(ACCOUNT_ID, "req_mine")).toBeNull();
    expect(await h.stores.idempotency.get(mine, h.clock.now())).toBeNull();
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
    expect((await h.stores.rateLimits.hitAccount(ACCOUNT_ID, "content", 1, 60_000, h.clock.now())).allowed).toBe(true); // fresh window
    expect(await h.stores.sweeps.due(h.clock.now() + 10 * 86_400_000, 10)).toEqual([]); // the schedule of the account is cleared too
    expect((await h.stores.ledger.listWindows("acc_other")).length).toBe(1);
    expect((await h.stores.rateLimits.hitAccount("acc_other", "content", 5, 60_000, h.clock.now())).remaining).toBe(3);
    expect(await h.stores.idempotency.get({ accountId: "acc_other", route: "/v1/chat/completions", keyHash: "k" }, h.clock.now())).not.toBeNull();
    // Idempotent.
    await h.t.deps.inference.purgeLedger(ACCOUNT_ID);
  });
});
