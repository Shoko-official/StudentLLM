import { describe, expect, it } from "vitest";
import { runAuthStoreContract } from "../../testing/auth-store-contract";
import { chaosStores, runStoreContract } from "../../testing/store-contract";
import { createInMemoryStores } from "./index";

// The same behavior suite runs against the plain stores and against stores whose every call is wrapped in
// random yields. The Durable Object / D1 adapters will add their own `runStoreContract(...)` line.
runStoreContract("in-memory", () => createInMemoryStores());
runStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));
runAuthStoreContract("in-memory", () => createInMemoryStores());
runAuthStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));

describe("chaosStores", () => {
  it("returns the same results and keeps every store method asynchronous", async () => {
    const stores = chaosStores(createInMemoryStores(), 7);
    const created = await stores.accounts.create({ accountId: "a", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v1", now: 1 });
    expect(created.ok).toBe(true);
    expect((await stores.accounts.getByEmail("a@example.invalid"))!.accountId).toBe("a");
  });

  it("does reorder concurrent callers (so the suite is not passing by lucky scheduling)", async () => {
    const stores = chaosStores(createInMemoryStores(), 11);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        stores.switches.addSpend("day:2026-11-01", 1).then(() => void order.push(i)),
      ),
    );
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
  });
});
