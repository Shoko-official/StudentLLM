// The hooks of the inference module in the order of the contract: consent, rate limit, idempotency, concurrency
// slot, then the body, the kill switches and the budget reservation.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../crypto/hash";
import { ApiError } from "../../http/envelope";
import { expectFixtureConformance, loadFixture } from "../../testing";
import {
  ACCOUNT_ID,
  CONSENT_ID,
  completion,
  makeInferenceHarness,
  PERIOD,
  SECRET_PROMPT,
  sseResponse,
  usageFrame,
  chunkFrame,
  DONE_FRAME,
  type Harness,
} from "../../testing/inference-harness";
import { chaosStores } from "../../testing/store-contract";
import { createInMemoryStores, type IdempotencyKey } from "../../storage";
import { dayPeriod, monthPeriod } from "./availability";
import { DEFAULT_ROUTING, type RoutingConfig } from "./routing";

const ROUTE = "/v1/chat/completions";
const body = (extra: Record<string, unknown> = {}) => ({
  model: "studentllm-large",
  messages: [{ role: "user", content: `Question ${SECRET_PROMPT}` }],
  ...extra,
});
const code = async (res: Response) => (await res.json()).error.code as string;
const windowOf = (h: Harness) => h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now());
const keyOf = async (key: string): Promise<IdempotencyKey> => ({ accountId: ACCOUNT_ID, route: ROUTE, keyHash: await sha256Hex(key) });
const recordOf = async (h: Harness, key: string) => h.stores.idempotency.get(await keyOf(key), h.clock.now());

/** An upstream whose answers are released by hand, to hold requests in flight. */
function gates() {
  const pending: Array<() => void> = [];
  let open = false;
  return {
    upstream: () =>
      open
        ? Promise.resolve(completion("ok", { prompt: 10, completion: 5 }))
        : new Promise<Response>((resolve) => pending.push(() => resolve(completion("ok", { prompt: 10, completion: 5 })))),
    /** Answers the waiting requests; later ones are answered at once. */
    release: () => {
      open = true;
      pending.splice(0).forEach((r) => r());
    },
    count: () => pending.length,
  };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("consent", () => {
  it("answers consent_outdated for an unknown record and points at the provider set the model needs", async () => {
    const fx = loadFixture("chat-completions.consent_outdated");
    const h = makeInferenceHarness();
    const res = await h.chat(fx.request.body, { "X-StudentLLM-Consent": "cns_01OLD" });
    await expectFixtureConformance(res, fx);
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("refuses a withdrawn record, a replaced record and a record of another account", async () => {
    const h = makeInferenceHarness();
    const grant = (consentId: string, granted: boolean, accountId = ACCOUNT_ID) =>
      h.stores.consents.record(
        { consentId, accountId, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted },
        h.clock.now(),
      );
    expect((await h.chat(body())).status).toBe(200); // cns_test is active

    await grant("cns_new", true); // replaces cns_test (one active record per provider set)
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": CONSENT_ID }))).toBe("consent_outdated");
    expect((await h.chat(body(), { "X-StudentLLM-Consent": "cns_new" })).status).toBe(200);

    await grant("cns_off", false); // a withdrawal ends the active record
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": "cns_new" }))).toBe("consent_outdated");
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": "cns_off" }))).toBe("consent_outdated");

    await grant("cns_theirs", true, "acc_other");
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": "cns_theirs" }))).toBe("consent_outdated");
  });

  it("refuses a record of an outdated provider set version, consent text version or feature", async () => {
    for (const row of [
      { providerSetVersion: 2, textVersion: "2026-11-01", features: ["chat" as const] },
      { providerSetVersion: 1, textVersion: "2025-01-01", features: ["chat" as const] },
      { providerSetVersion: 1, textVersion: "2026-11-01", features: ["transcription" as const] },
    ]) {
      const h = makeInferenceHarness({ consent: false });
      await h.stores.consents.record({ consentId: "cns_x", accountId: ACCOUNT_ID, providerSetId: "ps1", granted: true, ...row }, h.clock.now());
      const res = await h.chat(body(), { "X-StudentLLM-Consent": "cns_x" });
      expect(res.status, JSON.stringify(row)).toBe(409);
      expect(await code(res)).toBe("consent_outdated");
    }
  });

  it("refuses a model that needs another provider set than the one consented to, before any budget is touched", async () => {
    const routing: RoutingConfig = {
      providers: [...DEFAULT_ROUTING.providers, { id: "other", displayName: "Other", baseUrl: "https://other.example.invalid/v1", secret: "GROQ_API_KEY" }],
      providerSets: [...DEFAULT_ROUTING.providerSets, { id: "ps2", version: 1, providerIds: ["other"], regions: ["X"], consentTextVersion: "2026-11-01", features: ["chat"] }],
      models: [...DEFAULT_ROUTING.models, { ...DEFAULT_ROUTING.models[0]!, id: "studentllm-other", providerSetId: "ps2", targets: [{ providerId: "other", upstreamModel: "m" }] }],
    };
    const h = makeInferenceHarness({ routing });
    const key = h.key();
    const res = await h.chat(body({ model: "studentllm-other" }), { "Idempotency-Key": key });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("consent_outdated");
    expect(json.error.details).toEqual({ provider_set: "ps2", consent_text_version: "2026-11-01" });
    expect(await windowOf(h)).toBeNull();
    expect(h.upstreamCalls).toHaveLength(0);
    expect((await recordOf(h, key))!.state).toBe("failed_before_forward");
    // The consented set still works.
    expect((await h.chat(body())).status).toBe(200);
  });

  it("maps every text feature to chat: chat, note formatting and study material share one consent", async () => {
    const h = makeInferenceHarness({ consent: false });
    await h.stores.consents.record({ consentId: "cns_chat", accountId: ACCOUNT_ID, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted: true }, h.clock.now());
    expect((await h.chat(body(), { "X-StudentLLM-Consent": "cns_chat" })).status).toBe(200);
  });
});

describe("check order", () => {
  it("runs client version, then the other modules' checks, then consent, rate limit, idempotency and the slot", async () => {
    const h = makeInferenceHarness({ settings: { rate: { content: { limit: 1, windowMs: 60_000 } } } });
    const key = h.key();
    // 1. The client version comes first, even before the token.
    expect((await h.chat(body(), { "X-StudentLLM-Client": "studentllm-desktop/0.0.1", "X-StudentLLM-Consent": "bad" })).status).toBe(426);
    // 5. Consent comes before the rate limit: a refused consent consumes none of the window.
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": "cns_nope", "Idempotency-Key": key }))).toBe("consent_outdated");
    expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200); // the one allowed hit
    // 6. The rate limit comes before the idempotency lookup: the settled key would have been a conflict.
    expect(await code(await h.chat(body(), { "Idempotency-Key": key }))).toBe("rate_limited");
    h.clock.advance(61_000);
    // 7. Now the lookup runs.
    expect(await code(await h.chat(body(), { "Idempotency-Key": key }))).toBe("idempotency_conflict");
  });

  it("answers the plan check of another module before consent", async () => {
    const h = makeInferenceHarness({
      hooks: {
        checkPlan: () => {
          throw new ApiError("plan_required");
        },
      },
    });
    expect(await code(await h.chat(body(), { "X-StudentLLM-Consent": "cns_nope" }))).toBe("plan_required");
  });

  it("rejects a missing Idempotency-Key as invalid_request before the lookup", async () => {
    const h = makeInferenceHarness();
    const res = await h.chat(body(), { "Idempotency-Key": null });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("invalid_request");
  });
});

describe("rate limit", () => {
  it("sets RateLimit-* headers, then answers rate_limited with Retry-After when the window is full", async () => {
    const h = makeInferenceHarness({ settings: { rate: { content: { limit: 3, windowMs: 60_000 } } } });
    const first = await h.chat(body());
    expect(first.headers.get("RateLimit-Limit")).toBe("3");
    expect(first.headers.get("RateLimit-Remaining")).toBe("2");
    expect(first.headers.get("RateLimit-Reset")).toBe("60");
    await h.chat(body());
    await h.chat(body());
    const denied = await h.chat(body());
    expect(denied.status).toBe(429);
    expect(await code(denied.clone())).toBe("rate_limited");
    expect(denied.headers.get("Retry-After")).toBe("60");
    expect(denied.headers.get("RateLimit-Remaining")).toBe("0");
    expect(h.upstreamCalls).toHaveLength(3);
    h.clock.advance(60_001);
    expect((await h.chat(body())).status).toBe(200);
  });

  it("counts reads and content requests in separate windows", async () => {
    const h = makeInferenceHarness({ settings: { rate: { content: { limit: 1, windowMs: 60_000 } } } });
    expect((await h.chat(body())).status).toBe(200);
    expect((await h.chat(body())).status).toBe(429);
    expect((await h.get("/v1/models")).status).toBe(200);
    expect((await h.get("/v1/usage")).status).toBe(200);
  });

  it("keeps the windows of two accounts apart", async () => {
    const h = makeInferenceHarness({ settings: { rate: { content: { limit: 1, windowMs: 60_000 } } } });
    await h.stores.rateLimits.hitAccount("acc_other", "content", 1, 60_000, h.clock.now());
    expect((await h.chat(body())).status).toBe(200);
  });
});

describe("idempotency", () => {
  it("answers in_progress with Retry-After, takes no concurrency slot, and settled with the original request id", async () => {
    const g = gates();
    const h = makeInferenceHarness({ upstream: g.upstream });
    const key = h.key();
    const first = h.chat(body(), { "Idempotency-Key": key });
    while (g.count() === 0) await tick();

    const slots = await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now());
    const retry = await h.chat(body(), { "Idempotency-Key": key });
    await expectFixtureConformance(retry.clone(), loadFixture("chat-completions.idempotency_conflict.in_progress"), { strictHeaders: ["Retry-After"] });
    expect((await retry.json()).error.details.request_id).toBe("req_test_000001");
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(slots); // a conflict never takes a slot

    g.release();
    expect((await first).status).toBe(200);
    const settled = await h.chat(body(), { "Idempotency-Key": key });
    await expectFixtureConformance(settled.clone(), loadFixture("chat-completions.idempotency_conflict.settled"));
    expect((await settled.json()).error.details).toEqual({ state: "settled", request_id: "req_test_000001", credits_charged: 1 });
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it("lets a request through that was refused before the reservation, with the same key", async () => {
    const h = makeInferenceHarness();
    const key = h.key();
    expect((await h.chat({ ...body(), tools: [] }, { "Idempotency-Key": key })).status).toBe(400);
    expect((await recordOf(h, key))!.state).toBe("failed_before_forward");
    expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200);
    expect((await recordOf(h, key))!.state).toBe("settled");
  });

  it("scopes a key to the account and the route", async () => {
    const h = makeInferenceHarness();
    const key = h.key();
    await h.chat(body(), { "Idempotency-Key": key });
    // The same key on another route is another record (the route is part of the scope).
    const other = await h.stores.idempotency.begin({ accountId: ACCOUNT_ID, route: "/v1/ocr", keyHash: await sha256Hex(key) }, "r", h.clock.now());
    expect(other.outcome).toBe("started");
    const otherAccount = await h.stores.idempotency.begin({ accountId: "acc_other", route: ROUTE, keyHash: await sha256Hex(key) }, "r", h.clock.now());
    expect(otherAccount.outcome).toBe("started");
  });

  it("stores the hash of the key and nothing derived from the body", async () => {
    const h = makeInferenceHarness();
    const key = h.key();
    await h.chat(body(), { "Idempotency-Key": key });
    const record = (await recordOf(h, key))!;
    expect(Object.keys(record).sort()).toEqual(["accountId", "createdAt", "creditsCharged", "expiresAt", "keyHash", "leaseExpiresAt", "requestId", "reserved", "route", "state"]);
    expect(record.keyHash).toBe(await sha256Hex(key));
    expect(JSON.stringify(record)).not.toContain(key); // the client's key itself is not kept
  });

  it("treats an in_flight record whose attempt crashed before the reservation as failed_before_forward after the lease", async () => {
    const h = makeInferenceHarness();
    const key = h.key();
    // A crash between `begin` and `reserve`: the record exists, no reservation does.
    await h.stores.idempotency.begin(await keyOf(key), "req_crashed", h.clock.now(), 180_000);
    const early = await h.chat(body(), { "Idempotency-Key": key });
    expect(early.status).toBe(409);
    expect((await early.json()).error.details.state).toBe("in_progress");

    h.clock.advance(180_000); // the route's max duration (120 s) plus 60 s
    const late = await h.chat(body(), { "Idempotency-Key": key });
    expect(late.status).toBe(200);
    // The retry reserved under the original request id (no reservation existed to reuse).
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_crashed"))!.state).toBe("settled");
  });

  describe("a failure between the reservation and the forward keeps the reservation (failed_before_forward)", () => {
    function failingMarkForwardedOnce(h: Harness) {
      const real = h.stores.ledger.markForwarded.bind(h.stores.ledger);
      let failed = false;
      h.stores.ledger.markForwarded = async (accountId, requestId) => {
        if (!failed) {
          failed = true;
          return false;
        }
        return real(accountId, requestId);
      };
    }

    it("reuses the reservation on a same-key retry", async () => {
      const h = makeInferenceHarness();
      failingMarkForwardedOnce(h);
      const key = h.key();
      const first = await h.chat(body({ max_tokens: 100 }), { "Idempotency-Key": key });
      expect(first.status).toBe(500);
      expect(h.upstreamCalls).toHaveLength(0); // never forwarded
      expect((await recordOf(h, key))!.state).toBe("failed_before_forward");
      expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000001"))!.state).toBe("reserved");

      const retry = await h.chat(body({ max_tokens: 100 }), { "Idempotency-Key": key });
      expect(retry.status).toBe(200);
      expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000001"))!.state).toBe("settled"); // the first attempt's reservation
      expect(await windowOf(h)).toMatchObject({ reserved: 0, requests: 1 });
    });

    it("starts a new attempt when the retry needs more than was reserved, so the charge cannot be capped below its cost", async () => {
      const h = makeInferenceHarness({ upstream: () => completion("ok", { prompt: 10, completion: 3000 }) });
      failingMarkForwardedOnce(h);
      const key = h.key();
      expect((await h.chat(body({ max_tokens: 10 }), { "Idempotency-Key": key })).status).toBe(500);
      const retry = await h.chat(body({ max_tokens: 4000 }), { "Idempotency-Key": key });
      expect(retry.status).toBe(200);
      expect(Number(retry.headers.get("X-StudentLLM-Credits-Charged"))).toBe(20); // ceil((10 x 1620 + 3000 x 6480) / 1e6)
      expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000001"))!.state).toBe("released");
      expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_test_000002"))!.state).toBe("settled");
      expect(await windowOf(h)).toMatchObject({ reserved: 0, used: 20 });
    });

    it("moves the record to failed_no_usage when the kept reservation expires unused, so the next retry is a new attempt", async () => {
      const h = makeInferenceHarness();
      failingMarkForwardedOnce(h);
      const key = h.key();
      await h.chat(body({ max_tokens: 100 }), { "Idempotency-Key": key });
      h.clock.advance(181_000);
      const { sweepAccount } = await import("./sweeper");
      await sweepAccount(h.t.deps, ACCOUNT_ID);
      expect((await recordOf(h, key))!.state).toBe("failed_no_usage");
      expect((await h.chat(body({ max_tokens: 100 }), { "Idempotency-Key": key })).status).toBe(200);
    });
  });
});

describe("concurrency slots", () => {
  it("answers concurrency_limit beyond the limit, frees the key, and releases slots when requests end", async () => {
    const g = gates();
    const h = makeInferenceHarness({ upstream: g.upstream, settings: { maxConcurrent: 2 } });
    const a = h.chat(body());
    const b = h.chat(body());
    while (g.count() < 2) await tick();
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(2);

    const key = h.key();
    const third = await h.chat(body(), { "Idempotency-Key": key });
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe("2");
    expect(await code(third)).toBe("concurrency_limit");
    expect(h.upstreamCalls).toHaveLength(2);
    // The refused request must not leave its key stuck in flight.
    expect((await recordOf(h, key))!.state).toBe("failed_before_forward");

    g.release();
    await Promise.all([a, b]);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
    expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200);
  });

  it("releases the slot after an error response too", async () => {
    const h = makeInferenceHarness();
    expect((await h.chat({ ...body(), tools: [] })).status).toBe(400);
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
  });

  it("frees a slot held by a crashed request when its lease expires", async () => {
    const h = makeInferenceHarness({ settings: { maxConcurrent: 1 } });
    await h.stores.concurrency.acquire(ACCOUNT_ID, 1, 180_000, h.clock.now()); // a request that died holding it
    expect((await h.chat(body())).status).toBe(429);
    h.clock.advance(180_000);
    expect((await h.chat(body())).status).toBe(200);
  });
});

describe("the budget", () => {
  it("creates the window lazily from the paid period, once", async () => {
    const h = makeInferenceHarness();
    expect(await windowOf(h)).toBeNull();
    await h.chat(body());
    await h.chat(body());
    expect(await h.stores.ledger.listWindows(ACCOUNT_ID)).toHaveLength(1);
    expect(await windowOf(h)).toMatchObject({ start: PERIOD.start, end: PERIOD.end, limit: 12500, requests: 2 });
  });

  it("answers budget_exhausted with the reset time, forwards nothing and lets the key retry", async () => {
    const fx = loadFixture("chat-completions.budget_exhausted");
    const h = makeInferenceHarness({ windowCredits: 5 });
    const key = h.key();
    const res = await h.chat({ ...(fx.request.body as object), max_tokens: 4000 }, { "Idempotency-Key": key });
    await expectFixtureConformance(res.clone(), fx);
    const json = await res.json();
    expect(json.error.details.resets_at).toBe("2026-12-01T00:00:00Z");
    expect(json.error.retry_after_seconds).toBe(Math.ceil((PERIOD.end - h.clock.now()) / 1000));
    expect(res.headers.get("Retry-After")).toBe(String(json.error.retry_after_seconds));
    expect(res.headers.get("X-StudentLLM-Credits-Limit")).toBe("5");
    expect(h.upstreamCalls).toHaveLength(0);
    expect((await recordOf(h, key))!.state).toBe("failed_before_forward");
  });

  it("reconciles expired reservations on access before refusing for budget", async () => {
    const h = makeInferenceHarness({ windowCredits: 100 });
    await h.chat(body()); // creates the window (and spends 1 credit)
    // A request that was reserved long ago and never finished still holds 99 credits.
    await h.stores.ledger.reserve(ACCOUNT_ID, {
      requestId: "req_old",
      feature: "chat",
      logicalModelId: "studentllm-large",
      credits: 99,
      now: h.clock.now() - 10 * 60_000,
      expiresAt: h.clock.now() - 60_000,
      idempotency: null,
    });
    const res = await h.chat(body());
    expect(res.status).toBe(200);
    expect((await h.stores.ledger.getReservation(ACCOUNT_ID, "req_old"))!.state).toBe("released");
  });

  it("cannot overspend a window under parallel requests (also when store calls are reordered)", async () => {
    const g = gates();
    const h = makeInferenceHarness({
      stores: chaosStores(createInMemoryStores(), 77),
      upstream: g.upstream,
      // 60 credits: two full-output reservations (27 each) fit, a third does not.
      windowCredits: 60,
      settings: { maxConcurrent: 20, rate: { content: { limit: 100, windowMs: 60_000 } } },
    });
    const noMax = { model: "studentllm-large", messages: [{ role: "user", content: "hi" }] };
    let refused = 0;
    const all = Array.from({ length: 8 }, () => h.chat(noMax).then((r) => (r.status === 429 && refused++, r)));
    // Two reservations are held by requests waiting on the provider; the other six were refused.
    while (g.count() < 2 || refused < 6) await tick();
    const held = (await windowOf(h))!;
    expect(held.reserved).toBe(54);
    expect(held.reserved + held.used).toBeLessThanOrEqual(60);
    g.release();
    const statuses = (await Promise.all(all)).map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    const w = (await windowOf(h))!;
    expect(w.used + w.reserved).toBeLessThanOrEqual(60);
    expect(w.reserved).toBe(0);
  });

  it("answers plan_required for an account with no paid period covering now", async () => {
    const free = makeInferenceHarness({ plus: false });
    const res = await free.chat(body());
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("plan_required");
    expect(free.upstreamCalls).toHaveLength(0);

    const lapsed = makeInferenceHarness();
    lapsed.clock.set(PERIOD.end + 1000);
    expect(await code(await lapsed.chat(body()))).toBe("plan_required");
  });

  it("does not reuse a revoked window", async () => {
    const h = makeInferenceHarness();
    await h.chat(body());
    await h.stores.ledger.revokeWindows(ACCOUNT_ID, h.clock.now());
    expect(await code(await h.chat(body()))).toBe("plan_required");
  });
});

describe("kill switches and the global spend cap", () => {
  const targets = [
    ["global", { scope: "global" as const }],
    ["feature", { scope: "feature" as const, name: "chat" as const }],
    ["provider", { scope: "provider" as const, name: "groq" }],
  ] as const;

  for (const [name, target] of targets) {
    it(`answers kill_switch for the ${name} switch, with nothing reserved and nothing sent, and works again once cleared`, async () => {
      const h = makeInferenceHarness();
      await h.stores.switches.setDisabled(target, true, h.clock.now());
      const key = h.key();
      const res = await h.chat(body(), { "Idempotency-Key": key });
      expect(res.status).toBe(503);
      expect(await code(res.clone())).toBe("kill_switch");
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(h.upstreamCalls).toHaveLength(0);
      expect(await windowOf(h)).toBeNull();
      expect((await recordOf(h, key))!.state).toBe("failed_before_forward");

      await h.stores.switches.setDisabled(target, false, h.clock.now());
      expect((await h.chat(body(), { "Idempotency-Key": key })).status).toBe(200);
    });
  }

  it("answers kill_switch for a model switched off in the routing table", async () => {
    const h = makeInferenceHarness({ routing: { ...DEFAULT_ROUTING, models: [{ ...DEFAULT_ROUTING.models[0]!, enabled: false }] } });
    expect(await code(await h.chat(body()))).toBe("kill_switch");
  });

  it("stops at the global spend cap, and settlements feed it", async () => {
    const h = makeInferenceHarness({
      settings: { spendCap: { dayCredits: 100, monthCredits: 1000 } },
      upstream: () => completion("ok", { prompt: 20_000, completion: 4000 }),
    });
    const res = await h.chat(body({ max_tokens: 4000 }));
    expect(res.status).toBe(200);
    const charged = Number(res.headers.get("X-StudentLLM-Credits-Charged"));
    expect(charged).toBeGreaterThan(0);
    expect(await h.stores.switches.getSpend(dayPeriod(h.clock.now()))).toBe(charged);
    expect(await h.stores.switches.getSpend(monthPeriod(h.clock.now()))).toBe(charged);

    await h.stores.switches.addSpend(dayPeriod(h.clock.now()), 100);
    const refused = await h.chat(body());
    expect(refused.status).toBe(503);
    expect(await code(refused)).toBe("kill_switch");

    h.clock.advance(24 * 3_600_000); // the next day starts a new total
    expect((await h.chat(body())).status).toBe(200);
  });

  it("refuses a request whose reservation would pass the cap, not only one that arrives after it was reached", async () => {
    const h = makeInferenceHarness({ settings: { spendCap: { dayCredits: 30, monthCredits: 1000 } } });
    await h.stores.switches.addSpend(dayPeriod(h.clock.now()), 10);
    // A reservation for the whole 4096-token output is 27 credits: 10 + 27 > 30, although 10 < 30.
    const refused = await h.chat({ model: "studentllm-large", messages: [{ role: "user", content: "hi" }] });
    expect(refused.status).toBe(503);
    expect(await code(refused)).toBe("kill_switch");
    expect(h.upstreamCalls).toHaveLength(0);
    expect(await windowOf(h)).toBeNull(); // nothing was reserved
    // A small request still fits under the cap.
    expect((await h.chat(body({ max_tokens: 10 }))).status).toBe(200);
  });

  it("documents that the cap is exact only for settled spend: the in-flight reservations can overshoot it", async () => {
    // Two requests are admitted together (neither has settled), so together they can pass the cap by their reservations.
    const g = gates();
    const h = makeInferenceHarness({ upstream: g.upstream, settings: { spendCap: { dayCredits: 40, monthCredits: 1000 } } });
    const noMax = { model: "studentllm-large", messages: [{ role: "user", content: "hi" }] };
    const a = h.chat(noMax);
    const b = h.chat(noMax);
    while (g.count() < 2) await tick();
    g.release();
    expect([(await a).status, (await b).status]).toEqual([200, 200]); // 2 x 27 > 40: the bound is the reservations in flight
    const source = readFileSync(new URL("./availability.ts", import.meta.url), "utf8");
    expect(source).toMatch(/overshot by at most the reservations in flight/);
  });
});

describe("the body", () => {
  it("answers payload_too_large for a declared length above the cap, without reading the body", async () => {
    const h = makeInferenceHarness();
    const key = h.key();
    const res = await h.chat("{}", { "Content-Length": String(13 * 1024 * 1024), "Idempotency-Key": key });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe("payload_too_large");
    expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
    expect((await recordOf(h, key))!.state).toBe("failed_before_forward");
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("cuts off an oversized body while it streams in", async () => {
    const h = makeInferenceHarness();
    const huge = JSON.stringify({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(13 * 1024 * 1024) }] });
    const res = await h.chat(huge);
    expect(res.status).toBe(413);
    expect(await windowOf(h)).toBeNull();
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("answers payload_too_large when the input does not fit the context window", async () => {
    const h = makeInferenceHarness();
    // Even at 8 bytes a token, 131,072 tokens hold about 1 MiB: 1.2 MB of text cannot fit. (Anything smaller is the
    // provider's to judge; its 400 releases the reservation.)
    const res = await h.chat({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(1_200_000) }] });
    expect(res.status).toBe(413);
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("answers unsupported_media_type for another content type, and invalid_request for broken JSON", async () => {
    const h = makeInferenceHarness();
    const wrongType = await h.t.app.handle(
      new Request("https://api.example.invalid/v1/chat/completions", { method: "POST", headers: { ...h.headers(), "Content-Type": "text/plain" }, body: "hello" }),
    );
    expect(wrongType.status).toBe(415);
    expect((await h.chat("{not json")).status).toBe(400);
    expect((await h.chat("[]")).status).toBe(400);
  });
});

describe("what is logged", () => {
  it("logs request id, account, route, status, credits and latency, and never content", async () => {
    const h = makeInferenceHarness({ upstream: () => completion(SECRET_PROMPT, { prompt: 900, completion: 120 }) });
    await h.chat(body());
    await h.chat({ ...body(), tools: [] });
    expect(h.t.logs).toHaveLength(2);
    expect(Object.keys(h.t.logs[0]!).sort()).toEqual(["accountId", "creditsCharged", "latencyMs", "method", "requestId", "route", "status"]);
    expect(h.t.logs[0]).toMatchObject({ accountId: ACCOUNT_ID, route: ROUTE, status: 200, creditsCharged: 3 });
    expect(JSON.stringify(h.t.logs)).not.toContain(SECRET_PROMPT);
  });
});

describe("streams count against the rate limit and the key like any request", () => {
  it("settles a stream's key so a retry is an idempotency_conflict", async () => {
    const h = makeInferenceHarness({ upstream: () => sseResponse([chunkFrame("a"), usageFrame({ prompt: 5, completion: 5 }), DONE_FRAME]) });
    const key = h.key();
    await (await h.chat(body({ stream: true }), { "Idempotency-Key": key })).text();
    expect((await recordOf(h, key))!.state).toBe("settled");
    const retry = await h.chat(body({ stream: true }), { "Idempotency-Key": key });
    expect(retry.status).toBe(409);
  });
});
