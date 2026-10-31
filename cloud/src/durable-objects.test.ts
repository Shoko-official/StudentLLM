// The per-account atomic operations (reserve, settle, idempotency, rate limit, concurrency) must map onto ONE Durable
// Object per account. This drives real requests through proxies around the stores and checks that every call of the
// account-scoped stores names exactly one account, found without parsing any key.

import { describe, expect, it } from "vitest";
import { AccountObject } from "./durable-objects";
import { sseResponse, chunkFrame, DONE_FRAME, usageFrame, completion, errorResponse, makeInferenceHarness, ACCOUNT_ID, SECRET_PROMPT } from "./testing/inference-harness";
import { createInMemoryStores, type Stores } from "./storage";
import { sweepAccount } from "./modules/inference/sweeper";

type Seen = Array<{ store: string; method: string; account: string | null }>;

/** The account a call is routed to, from its arguments alone. null: a global call (cron cleanup, connection keys). */
function routedTo(store: string, method: string, args: unknown[]): string | null | undefined {
  const first = args[0];
  const carried = (first as { accountId?: unknown } | undefined)?.accountId;
  switch (store) {
    case "ledger":
      return typeof first === "string" ? first : undefined;
    case "concurrency":
      return typeof first === "string" ? first : typeof carried === "string" ? carried : undefined;
    case "idempotency":
      if (method === "deleteExpired") return null;
      return typeof first === "string" ? first : typeof carried === "string" ? carried : undefined;
    case "rateLimits":
      if (method === "hitAccount" || method === "purgeAccount") return typeof first === "string" ? first : undefined;
      return null; // `hit(key)` and `deleteExpired` are not per-account
  }
  return undefined;
}

function tracked(stores: Stores): { stores: Stores; seen: Seen } {
  const seen: Seen = [];
  const wrap = <T extends object>(name: string, store: T): T =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          seen.push({ store: name, method: String(prop), account: routedTo(name, String(prop), args) ?? "UNROUTABLE" });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const out = { ...stores } as Stores;
  for (const name of ["ledger", "idempotency", "rateLimits", "concurrency"] as const) (out as unknown as Record<string, object>)[name] = wrap(name, stores[name]);
  return { stores: out, seen };
}

describe("AccountObject shape", () => {
  it("keeps the class name that the wrangler migrations will bind", () => {
    expect(AccountObject.name).toBe("AccountObject");
    expect(typeof AccountObject.prototype.alarm).toBe("function");
  });

  it("routes every call of the account-scoped stores to exactly one account, from a full set of flows", async () => {
    const { stores, seen } = tracked(createInMemoryStores());
    let n = 0;
    const h = makeInferenceHarness({
      stores,
      upstream: () => {
        n++;
        if (n === 1) return completion("ok", { prompt: 10, completion: 5 });
        if (n === 2) return sseResponse([chunkFrame("a"), usageFrame({ prompt: 5, completion: 5 }), DONE_FRAME]);
        if (n === 3) return errorResponse(503);
        return sseResponse([chunkFrame("first token")], { end: "hang", signal: null });
      },
    });
    const msg = { model: "studentllm-large", messages: [{ role: "user", content: `q ${SECRET_PROMPT}` }] };
    await h.chat(msg); // non-streaming success
    await (await h.chat({ ...msg, stream: true })).text(); // streaming success
    await h.chat(msg); // provider failure, released
    const res = await h.chatWith({ ...msg, stream: true }); // a client that leaves
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await h.executionCtx.settled();
    await h.chat({ ...msg, tools: [] }); // refused before the reservation
    await h.get("/v1/usage");
    h.clock.advance(300_000);
    await sweepAccount(h.t.deps, ACCOUNT_ID);
    await h.t.deps.inference.usageSnapshot(ACCOUNT_ID);
    await h.t.deps.inference.purgeLedger(ACCOUNT_ID);

    expect(seen.length).toBeGreaterThan(30);
    expect(seen.filter((s) => s.account === "UNROUTABLE")).toEqual([]);
    const accounts = new Set(seen.map((s) => s.account).filter((a) => a !== null));
    expect([...accounts]).toEqual([ACCOUNT_ID]);
    // The calls that make a reservation, a settlement and a lease are all in there.
    const methods = new Set(seen.map((s) => `${s.store}.${s.method}`));
    for (const expected of ["ledger.reserve", "ledger.settle", "ledger.release", "ledger.sweep", "idempotency.begin", "idempotency.transition", "rateLimits.hitAccount", "concurrency.acquire", "concurrency.release", "ledger.purgeAccount", "rateLimits.purgeAccount"]) {
      expect(methods.has(expected), expected).toBe(true);
    }
    // The inference module never uses the connection-keyed limiter: that is the auth module's global object.
    expect(methods.has("rateLimits.hit")).toBe(false);
  });
});
