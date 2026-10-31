// Two wiring details of the shared layer that the inference module relies on: the hot path skips the activity write
// when it is already today, and the cleanup of a cancelled stream is tied to `waitUntil`.

import { describe, expect, it } from "vitest";
import { accessPrincipal, fakeAuthenticate, fakeExecutionContext, makeTestApp, TEST_START_MS } from "../testing";
import { routeMeta } from "./context";

const DAY = 24 * 60 * 60 * 1000;

async function appWithAccount(lastRequestAt: number | null) {
  const t = makeTestApp({ allowMissingHooks: true, withoutModuleHooks: true, hooks: { authenticate: fakeAuthenticate(accessPrincipal({ accountId: "acc_1" })) } });
  await t.stores.accounts.create({ accountId: "acc_1", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v", now: TEST_START_MS - 90 * DAY });
  if (lastRequestAt !== null) await t.stores.accounts.touchLastRequest("acc_1", lastRequestAt);
  const writes: number[] = [];
  const original = t.stores.accounts.touchLastRequest.bind(t.stores.accounts);
  t.stores.accounts.touchLastRequest = async (id, now) => (writes.push(now), original(id, now));
  t.app.router.add("GET", "/test/me", () => new Response("ok"), routeMeta({ operationId: "me" }));
  return { t, writes };
}

describe("the activity write on the hot path", () => {
  it("does not call the store when the last request was already today", async () => {
    const { t, writes } = await appWithAccount(TEST_START_MS - 60_000);
    for (let i = 0; i < 5; i++) expect((await t.request("/test/me")).status).toBe(200);
    expect(writes).toEqual([]);
  });

  it("writes once on the first request of a new day, and not again that day", async () => {
    const { t, writes } = await appWithAccount(TEST_START_MS - DAY);
    await t.request("/test/me");
    await t.request("/test/me");
    expect(writes).toEqual([TEST_START_MS]);
    expect((await t.stores.accounts.getById("acc_1"))!.lastRequestAt).toBe(TEST_START_MS);
  });

  it("writes for an account that never made a request", async () => {
    const { t, writes } = await appWithAccount(null);
    await t.request("/test/me");
    expect(writes).toEqual([TEST_START_MS]);
  });

  it("uses UTC days: just after midnight is a new day", async () => {
    const midnight = Math.floor(TEST_START_MS / DAY) * DAY;
    const { t, writes } = await appWithAccount(midnight - 1000);
    t.clock.set(midnight + 1000);
    await t.request("/test/me");
    expect(writes).toEqual([midnight + 1000]);
  });
});

describe("cleanup of a streamed response (deferUntilBodyDone)", () => {
  function streamingApp() {
    const t = makeTestApp({ allowMissingHooks: true, withoutModuleHooks: true });
    const released: string[] = [];
    let slowCleanupDone = false;
    t.app.router.add(
      "GET",
      "/test/stream",
      (ctx) => {
        ctx.deferUntilBodyDone(async () => {
          // The slow part of a cleanup: if the runtime dropped the promise, it would never finish.
          await new Promise((resolve) => setTimeout(resolve, 20));
          slowCleanupDone = true;
          released.push("slot");
        });
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
        });
        return new Response(stream);
      },
      routeMeta({ operationId: "stream", auth: "none" }),
    );
    return { t, released, done: () => slowCleanupDone };
  }

  it("keeps the Worker alive for the cleanup when the client cancels, via waitUntil", async () => {
    const { t, released, done } = streamingApp();
    const ectx = fakeExecutionContext();
    const res = await t.app.handle(new Request("https://api.example.invalid/test/stream"), ectx);
    const reader = res.body!.getReader();
    await reader.read();
    const cancelled = reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the cancel reaches the stream
    // The cleanup is registered with waitUntil, so the Worker stays alive until it has run.
    await ectx.settled();
    expect(done()).toBe(true);
    await cancelled;
    expect(released).toEqual(["slot"]);
  });

  it("runs the cleanup once whether the stream ends or is cancelled", async () => {
    const { t, released } = streamingApp();
    const ectx = fakeExecutionContext();
    const res = await t.app.handle(new Request("https://api.example.invalid/test/stream"), ectx);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await reader.cancel().catch(() => undefined);
    await ectx.settled();
    expect(released).toEqual(["slot"]);
  });

  it("does not need an execution context (tests and scripts)", async () => {
    const { t, released } = streamingApp();
    const res = await t.app.handle(new Request("https://api.example.invalid/test/stream"));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(released).toEqual(["slot"]);
  });
});
