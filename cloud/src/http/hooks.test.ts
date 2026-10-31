import { describe, expect, it } from "vitest";
import { composeHooks, createApp } from "../app";
import {
  accessPrincipal,
  fakeAuthenticate,
  fakeExecutionContext,
  makeTestApp,
  TEST_START_MS,
  type TestApp,
} from "../testing";
import { routeMeta, type Handler, type RequestContext, type Step } from "./context";
import { ApiError } from "./envelope";
import { defaultHooks, isMissingHook, mergeHooks, mergeProvidedHooks, type PipelineHooks } from "./pipeline";
import { Router } from "./router";
import { notImplemented } from "./stub";

const UUID = "6f1c1f0e-3a55-4b0c-9f0a-6d9d2f0f6a11";
const CONTENT = {
  "X-StudentLLM-Client": "studentllm-desktop/0.2.0",
  "X-StudentLLM-Consent": "cns_01EXAMPLE",
  "Idempotency-Key": UUID,
  "Content-Type": "application/json",
};

async function code(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

/** Registers a route with a REAL handler (not the stub) and counts how often it ran. */
function addReal(t: TestApp, method: "GET" | "POST" | "DELETE", path: string, meta: Parameters<typeof routeMeta>[0], handler?: Handler) {
  const calls = { n: 0 };
  t.app.router.add(
    method,
    path,
    handler ??
      (() => {
        calls.n++;
        return new Response("handled");
      }),
    routeMeta(meta),
  );
  return calls;
}

describe("hooks fail closed (a real handler never runs behind a missing hook)", () => {
  it("never reaches a content handler without a token when no authenticate hook is installed", async () => {
    const t = makeTestApp({ stubRoutes: true, withoutModuleHooks: true }); // strict: no allowMissingHooks
    const calls = addReal(t, "POST", "/test/content", { operationId: "test_content", client: true, content: true });
    const res = await t.request("/test/content", { method: "POST", headers: CONTENT, body: "{}" });
    expect(res.status).toBe(500);
    expect(await code(res)).toBe("internal_error");
    expect(calls.n).toBe(0);
  });

  it("never reaches the handler when an authenticate hook returns without setting a principal", async () => {
    const t = makeTestApp({ allowMissingHooks: true, hooks: { authenticate: () => undefined } });
    const calls = addReal(t, "POST", "/test/content", { operationId: "test_content", client: true, content: true });
    const res = await t.request("/test/content", { method: "POST", headers: CONTENT, body: "{}" });
    expect(res.status).toBe(500);
    expect(calls.n).toBe(0);
  });

  it("reaches the handler only once every hook that applies is installed", async () => {
    const t = makeTestApp({ hooks: { authenticate: fakeAuthenticate(accessPrincipal(), { account: ACCOUNT, plan: null }), checkPlan: () => undefined }, allowMissingHooks: true });
    const calls = addReal(t, "POST", "/test/content", { operationId: "test_content", client: true, content: true });
    const res = await t.request("/test/content", { method: "POST", headers: CONTENT, body: "{}" });
    expect(res.status).toBe(200);
    expect(calls.n).toBe(1);
  });

  it("lets only the stubs through the default hooks", async () => {
    const t = makeTestApp({ stubRoutes: true, withoutModuleHooks: true });
    const res = await t.request("/v1/chat/completions", { method: "POST", headers: CONTENT, body: "{}" });
    expect(res.status).toBe(501);
  });

  it("fails at startup when a registered real handler lacks a hook", () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const registerRoutes = (router: Router) => {
      router.add("POST", "/real", () => new Response("x"), routeMeta({ operationId: "real", content: true, client: true }));
    };
    expect(() => createApp(t.deps, { registerRoutes, withoutModuleHooks: true })).toThrow(/pipeline hooks are missing[\s\S]*authenticate/);
    // The same wiring is fine when the hooks are provided or the opt-out is explicit.
    const all = Object.fromEntries(Object.keys(defaultHooks()).map((n) => [n, () => undefined])) as unknown as PipelineHooks;
    expect(() => createApp(t.deps, { registerRoutes, withoutModuleHooks: true, hooks: all })).not.toThrow();
    expect(() => createApp(t.deps, { registerRoutes, withoutModuleHooks: true, allowMissingHooks: true })).not.toThrow();
  });

  it("marks default hooks as missing and lets two modules not claim one hook", () => {
    expect(isMissingHook(defaultHooks().authenticate)).toBe(true);
    const step: Step = () => undefined;
    expect(isMissingHook(mergeHooks({ authenticate: step }).authenticate)).toBe(false);
    expect(() => mergeProvidedHooks({ authenticate: step }, { authenticate: step })).toThrow(/two modules/);
  });
});

describe("hook overrides win over module hooks (H6)", () => {
  const trace: string[] = [];
  const fromModule: Step = () => void trace.push("module");
  const override: Step = () => void trace.push("override");

  it("composes { defaults, module hooks, overrides } so an override replaces a module's hook", () => {
    const hooks = composeHooks([{ authenticate: fromModule }, { checkPlan: fromModule }], { authenticate: override }, true);
    expect(hooks.authenticate).toBe(override);
    expect(hooks.checkPlan).toBe(fromModule);
    expect(isMissingHook(hooks.checkConsent)).toBe(false); // allowMissingHooks: pass-through
    expect(isMissingHook(composeHooks([], undefined, false).checkConsent)).toBe(true);
  });

  it("still refuses two modules that both claim a hook, whatever the overrides", () => {
    expect(() => composeHooks([{ authenticate: fromModule }, { authenticate: fromModule }], { authenticate: override }, true)).toThrow(/two modules/);
  });

  it("makeTestApp applies the test's hook", async () => {
    trace.length = 0;
    const t = makeTestApp({ allowMissingHooks: true, hooks: { authenticate: override } });
    await t.request("/v1/account");
    expect(trace).toEqual(["override"]);
  });
});

const ACCOUNT = {
  accountId: "acc_test",
  email: "a@example.invalid",
  googleSubject: null,
  loginMethods: ["email" as const],
  status: "active" as const,
  termsVersion: "2026-11-01",
  termsAcceptedAt: TEST_START_MS,
  planVersion: 7,
  createdAt: TEST_START_MS,
  lastSignInAt: null,
  lastRequestAt: null,
};

describe("fresh sign-in (freshAuthStep)", () => {
  const nowSeconds = Math.floor(TEST_START_MS / 1000);
  const freshRoutes = [
    ["DELETE", "/v1/account", "deleteAccount"],
    ["GET", "/v1/account/export", "exportAccount"],
    ["POST", "/v1/account/link", "linkLoginMethod"],
    ["DELETE", "/v1/account/login-methods/google", "unlinkLoginMethod"],
  ] as const;

  function appWith(authTime: number, extra: Partial<PipelineHooks> = {}) {
    return makeTestApp({
      allowMissingHooks: true,
      stubRoutes: true,
      withoutModuleHooks: true,
      hooks: { authenticate: fakeAuthenticate(accessPrincipal({ authTime }), { account: ACCOUNT, plan: null }), ...extra },
    });
  }

  it("covers delete, export, link and unlink: a sign-in older than 5 minutes gets reauth_required", async () => {
    const t = appWith(nowSeconds - 301);
    for (const [method, path, id] of freshRoutes) {
      const res = await t.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status, id).toBe(401);
      expect(await code(res), id).toBe("reauth_required");
    }
  });

  it("lets a sign-in exactly 300 seconds old through, up to the (stub) handler", async () => {
    const t = appWith(nowSeconds - 300);
    for (const [method, path, id] of freshRoutes) {
      const res = await t.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status, id).toBe(501);
    }
  });

  it("uses the injected clock, so time passing makes a fresh sign-in stale", async () => {
    const t = appWith(nowSeconds);
    expect((await t.request("/v1/account/export")).status).toBe(501);
    t.clock.advance(301_000);
    expect((await t.request("/v1/account/export")).status).toBe(401);
  });

  it("rejects an auth_time from the future beyond clock skew", async () => {
    expect((await appWith(nowSeconds + 3600).request("/v1/account/export")).status).toBe(401);
    expect((await appWith(nowSeconds + 30).request("/v1/account/export")).status).toBe(501);
  });

  it("runs before the terms and suspension hooks, because it comes right after authenticate", async () => {
    const trace: string[] = [];
    const stale = appWith(nowSeconds - 1000, { checkTermsAndStatus: () => void trace.push("terms") });
    const res = await stale.request("/v1/account/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(await code(res)).toBe("reauth_required");
    expect(trace).toEqual([]); // the gate was never consulted
    const fresh = appWith(nowSeconds, { checkTermsAndStatus: () => void trace.push("terms") });
    expect((await fresh.request("/v1/account/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(501);
    expect(trace).toEqual(["terms"]);
  });

  it("applies to an exempt route too: export and delete skip terms gating but not the fresh check", async () => {
    const trace: string[] = [];
    const t = appWith(nowSeconds - 1000, { checkTermsAndStatus: () => void trace.push("terms") });
    expect(await code(await t.request("/v1/account/export"))).toBe("reauth_required");
    expect(await code(await t.request("/v1/account", { method: "DELETE" }))).toBe("reauth_required");
    expect(trace).toEqual([]);
  });

  it("does not apply to routes that are not fresh-auth routes", async () => {
    const t = appWith(nowSeconds - 100_000);
    expect((await t.request("/v1/account")).status).toBe(501);
  });
});

describe("account and plan are loaded once after authentication", () => {
  it("loads them from the stores, sets the Plan-Version header and touches activity once per day", async () => {
    const t = makeTestApp({
      allowMissingHooks: true,
      withoutModuleHooks: true,
      hooks: { authenticate: fakeAuthenticate(accessPrincipal({ accountId: "acc_1" })) },
    });
    await t.stores.accounts.create({ accountId: "acc_1", email: "a@example.invalid", googleSubject: null, loginMethods: ["email"], termsVersion: "v", now: TEST_START_MS });
    await t.stores.accounts.savePlan(
      { accountId: "acc_1", planId: "plus_monthly", status: "active", paidPeriods: [], cancelAtPeriodEnd: false, paddleCustomerId: null, paddleSubscriptionId: null, lastEventAt: null },
      { expectedPlanVersion: 0 },
    );
    let seen: RequestContext | undefined;
    const reads = { n: 0 };
    const original = t.stores.accounts.getById.bind(t.stores.accounts);
    t.stores.accounts.getById = async (id) => (reads.n++, original(id));
    t.app.router.add("GET", "/test/me", (ctx) => ((seen = ctx), new Response("ok")), routeMeta({ operationId: "me" }));
    const res = await t.request("/test/me");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-StudentLLM-Plan-Version")).toBe("1");
    expect(seen!.account!.accountId).toBe("acc_1");
    expect(seen!.plan!.planId).toBe("plus_monthly");
    expect(reads.n).toBe(1);
    expect((await t.stores.accounts.getById("acc_1"))!.lastRequestAt).toBe(TEST_START_MS);
  });

  it("answers session_revoked when the account no longer exists", async () => {
    const t = makeTestApp({ allowMissingHooks: true, hooks: { authenticate: fakeAuthenticate(accessPrincipal({ accountId: "ghost" })) } });
    t.app.router.add("GET", "/test/me", () => new Response("ok"), routeMeta({ operationId: "me" }));
    const res = await t.request("/test/me");
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("session_revoked");
  });
});

describe("content headers", () => {
  const hooks = { authenticate: fakeAuthenticate(accessPrincipal(), { account: ACCOUNT, plan: null }), checkPlan: () => undefined };
  const post = (t: TestApp, headers: Record<string, string>) =>
    t.request("/v1/chat/completions", { method: "POST", headers, body: "{}" });

  it("maps a missing or invalid consent header to consent_outdated (409)", async () => {
    const t = makeTestApp({ allowMissingHooks: true, hooks });
    for (const value of [undefined, "", "bad value with spaces", "x".repeat(129)]) {
      const headers: Record<string, string> = { ...CONTENT };
      if (value === undefined) delete headers["X-StudentLLM-Consent"];
      else headers["X-StudentLLM-Consent"] = value;
      const res = await post(t, headers);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("consent_outdated");
    }
  });

  it("maps a missing or invalid Idempotency-Key to invalid_request (400)", async () => {
    const t = makeTestApp({ allowMissingHooks: true, hooks });
    for (const value of [undefined, "", "not-a-uuid", "6f1c1f0e-3a55-4b0c-9f0a"]) {
      const headers: Record<string, string> = { ...CONTENT };
      if (value === undefined) delete headers["Idempotency-Key"];
      else headers["Idempotency-Key"] = value;
      const res = await post(t, headers);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid_request");
    }
  });

  it("passes the validated values to the hooks", async () => {
    let seen: { consent?: string; key?: string } = {};
    const t = makeTestApp({
      allowMissingHooks: true,
      hooks: { ...hooks, lookupIdempotency: (ctx) => void (seen = { consent: ctx.consentId, key: ctx.idempotencyKey }) },
    });
    await post(t, { ...CONTENT, "Idempotency-Key": UUID.toUpperCase() });
    expect(seen).toEqual({ consent: "cns_01EXAMPLE", key: UUID });
  });

  it("checks the consent header before the rate limit and the idempotency key after it", async () => {
    const trace: string[] = [];
    const t = makeTestApp({
      allowMissingHooks: true,
      hooks: { ...hooks, checkRateLimit: () => void trace.push("rate") },
    });
    const noConsent = { ...CONTENT } as Record<string, string>;
    delete noConsent["X-StudentLLM-Consent"];
    await post(t, noConsent);
    expect(trace).toEqual([]);
    const noKey = { ...CONTENT } as Record<string, string>;
    delete noKey["Idempotency-Key"];
    await post(t, noKey);
    expect(trace).toEqual(["rate"]);
  });
});

describe("hook split: account rate limit and connection rate limit", () => {
  it("uses checkAuthRateLimit for unauthenticated routes and checkRateLimit for authenticated ones", async () => {
    const trace: string[] = [];
    const t = makeTestApp({
      allowMissingHooks: true,
      hooks: {
        authenticate: fakeAuthenticate(accessPrincipal(), { account: ACCOUNT, plan: null }),
        checkRateLimit: () => void trace.push("account"),
        checkAuthRateLimit: () => void trace.push("connection"),
      },
    });
    await t.request("/auth/start");
    await t.request("/v1/usage"); // an inference route: the account routes choose their own window
    await t.request("/webhooks/paddle", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(trace).toEqual(["connection", "account"]); // the webhook route has no rate limit
  });
});

describe("request context", () => {
  it("hands handlers a request without its body; the body is only reachable through ctx.body", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    let usedBody = false;
    t.app.router.add(
      "POST",
      "/test/body",
      async (ctx) => {
        expect(ctx.request.body).toBeNull();
        await expect(ctx.request.text()).resolves.toBe("");
        usedBody = true;
        return Response.json(await ctx.body.json());
      },
      routeMeta({ operationId: "body", auth: "none", body: { kind: "json", limit: "small" } }),
    );
    const res = await t.request("/test/body", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    expect(await res.json()).toEqual({ a: 1 });
    expect(usedBody).toBe(true);
  });

  it("lets a handler pass ctx.body.json around without its `this`", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    t.app.router.add(
      "POST",
      "/test/detached",
      async (ctx) => {
        const { json, text } = ctx.body;
        return Response.json({ viaText: await text() === '{"a":1}', parsed: await json() });
      },
      routeMeta({ operationId: "detached", auth: "none", body: { kind: "json", limit: "small" } }),
    );
    const res = await t.request("/test/detached", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    expect(await res.json()).toEqual({ viaText: true, parsed: { a: 1 } });
  });

  it("collects response headers from ctx.responseHeaders unless the handler set them", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    t.app.router.add(
      "GET",
      "/test/headers",
      (ctx) => {
        ctx.responseHeaders.set("X-StudentLLM-Credits-Remaining", "8123");
        ctx.responseHeaders.set("RateLimit-Limit", "20");
        return new Response("ok", { headers: { "RateLimit-Limit": "99" } });
      },
      routeMeta({ operationId: "headers", auth: "none" }),
    );
    const res = await t.request("/test/headers");
    expect(res.headers.get("X-StudentLLM-Credits-Remaining")).toBe("8123");
    expect(res.headers.get("RateLimit-Limit")).toBe("99");
  });

  it("decorates error responses and responses with immutable headers", async () => {
    const t = makeTestApp({ allowMissingHooks: true, fetch: async () => new Response("up", { headers: { "X-Up": "1" } }) });
    t.app.router.add(
      "GET",
      "/test/immutable",
      async (ctx) => {
        ctx.responseHeaders.set("X-Extra", "yes");
        return Response.redirect("https://api.example.invalid/elsewhere", 302); // redirect responses have immutable headers
      },
      routeMeta({ operationId: "immutable", auth: "none" }),
    );
    const res = await t.request("/test/immutable");
    expect(res.status).toBe(302);
    expect(res.headers.get("X-Request-Id")).toMatch(/^req_test_/);
    expect(res.headers.get("X-Extra")).toBe("yes");
  });

  it("gives each request its own typed locals", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const seen: unknown[] = [];
    t.app.router.add("GET", "/test/locals", (ctx) => (seen.push(ctx.locals), new Response("ok")), routeMeta({ operationId: "locals", auth: "none" }));
    await t.request("/test/locals");
    await t.request("/test/locals");
    expect(seen[0]).toEqual({});
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("streamed responses and cleanup (deferUntilBodyDone)", () => {
  function streamBody(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
        else controller.close();
      },
      cancel: onCancel,
    });
  }

  function addStream(t: TestApp, slot: { released: number; held: boolean }, chunks = ["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"], onCancel?: () => void) {
    t.app.router.add(
      "GET",
      "/test/stream",
      (ctx) => {
        slot.held = true;
        ctx.deferUntilBodyDone(() => void (slot.released++, (slot.held = false)));
        return new Response(streamBody(chunks, onCancel), { headers: { "Content-Type": "text/event-stream" } });
      },
      routeMeta({ operationId: "stream", auth: "none" }),
    );
  }

  it("keeps the slot until the stream has been read to the end", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const slot = { released: 0, held: false };
    addStream(t, slot);
    const res = await t.request("/test/stream");
    expect(res.status).toBe(200);
    expect(slot).toEqual({ released: 0, held: true }); // headers are out, the stream is still open
    const text = await res.text();
    expect(text).toBe("data: a\n\ndata: b\n\ndata: [DONE]\n\n");
    expect(slot).toEqual({ released: 1, held: false });
  });

  it("releases the slot when the client cancels mid-stream, once, and cancels the source", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const slot = { released: 0, held: false };
    let sourceCancelled = false;
    addStream(t, slot, ["data: a\n\n", "data: b\n\n", "data: c\n\n"], () => (sourceCancelled = true));
    const res = await t.request("/test/stream");
    const reader = res.body!.getReader();
    await reader.read();
    expect(slot.released).toBe(0);
    await reader.cancel("client went away");
    expect(slot).toEqual({ released: 1, held: false });
    expect(sourceCancelled).toBe(true);
    await reader.cancel().catch(() => undefined);
    expect(slot.released).toBe(1);
  });

  it("releases the slot when the source stream fails, and passes the error on", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const slot = { released: 0, held: false };
    t.app.router.add(
      "GET",
      "/test/failing",
      (ctx) => {
        ctx.deferUntilBodyDone(() => void slot.released++);
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode("partial"));
              } else controller.error(new Error("upstream reset"));
            },
          }),
        );
      },
      routeMeta({ operationId: "failing", auth: "none" }),
    );
    const res = await t.request("/test/failing");
    await expect(res.text()).rejects.toThrow();
    expect(slot.released).toBe(1);
  });

  it("runs the cleanup at once for a response without a body, and when the handler throws", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const slot = { released: 0 };
    t.app.router.add("GET", "/test/nobody", (ctx) => (ctx.deferUntilBodyDone(() => void slot.released++), new Response(null, { status: 204 })), routeMeta({ operationId: "nobody", auth: "none" }));
    t.app.router.add("GET", "/test/throws", (ctx) => {
      ctx.deferUntilBodyDone(() => void slot.released++);
      throw new ApiError("provider_unavailable");
    }, routeMeta({ operationId: "throws", auth: "none" }));
    expect((await t.request("/test/nobody")).status).toBe(204);
    expect(slot.released).toBe(1);
    const err = await t.request("/test/throws");
    expect(err.status).toBe(503);
    await err.text();
    expect(slot.released).toBe(2);
  });

  it("holds a real concurrency lease across the stream", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    t.app.router.add(
      "GET",
      "/test/leased",
      async (ctx) => {
        const lease = await ctx.deps.stores.concurrency.acquire("acc", 1, 60_000, ctx.deps.clock.now());
        if (!lease) throw new ApiError("concurrency_limit", { retryAfterSeconds: 1 });
        ctx.deferUntilBodyDone(async () => void (await ctx.deps.stores.concurrency.release(lease)));
        return new Response(streamBody(["x", "y"]));
      },
      routeMeta({ operationId: "leased", auth: "none" }),
    );
    const first = await t.request("/test/leased");
    expect((await t.request("/test/leased")).status).toBe(429); // the stream still holds the only slot
    await first.text();
    const third = await t.request("/test/leased");
    expect(third.status).toBe(200);
    await third.text();
  });

  it("ctx.waitUntil forwards to the ExecutionContext and swallows the task's failure", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const done: string[] = [];
    t.app.router.add(
      "GET",
      "/test/bg",
      (ctx) => {
        ctx.waitUntil(Promise.resolve().then(() => void done.push("ok")));
        ctx.waitUntil(Promise.reject(new Error("boom")));
        return new Response("ok");
      },
      routeMeta({ operationId: "bg", auth: "none" }),
    );
    const ectx = fakeExecutionContext();
    const res = await t.app.handle(new Request("https://api.example.invalid/test/bg"), ectx);
    expect(res.status).toBe(200);
    await expect(ectx.settled()).resolves.toBeUndefined();
    expect(done).toEqual(["ok"]);
  });
});

describe("scheduled handler", () => {
  it("is declared on the app and the Worker entry, and survives a failing task", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    await expect(t.app.scheduled({ scheduledTime: TEST_START_MS, cron: "* * * * *" }, fakeExecutionContext())).resolves.toBeUndefined();
    const entry = (await import("../index")).default;
    expect(typeof entry.fetch).toBe("function");
    expect(typeof entry.scheduled).toBe("function");
    const mod = await import("../index");
    expect(typeof mod.AccountObject).toBe("function");
  });

  it("answers fail-closed from the Worker entry when the configuration is invalid", async () => {
    const entry = (await import("../index")).default;
    const res = await entry.fetch(new Request("https://api.example.invalid/v1/status"), { ENVIRONMENT: "production" }, fakeExecutionContext());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal_error");
    await expect(entry.scheduled({ scheduledTime: 0, cron: "" }, { ENVIRONMENT: "production" }, fakeExecutionContext())).resolves.toBeUndefined();
  });
});
