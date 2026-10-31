import { describe, expect, it } from "vitest";
import { routeMeta } from "./http/context";
import { loadContract, makeTestApp, validateAgainst } from "./testing";

const contract = loadContract();
const CONTENT_HEADERS = {
  "X-StudentLLM-Client": "studentllm-desktop/0.2.0",
  "X-StudentLLM-Consent": "cns_01EXAMPLE",
  "Idempotency-Key": "6f1c1f0e-3a55-4b0c-9f0a-6d9d2f0f6a11",
};
const key = (method: string, path: string) => `${method} ${path}`;

describe("route table", () => {
  const { app } = makeTestApp({ allowMissingHooks: true });
  const routes = app.router.routes();

  it("registers every OpenAPI path and method, and nothing else", () => {
    const expected = contract.operations.map((o) => key(o.method, o.path)).sort();
    const actual = routes.map((r) => key(r.method, r.pattern)).sort();
    expect(actual).toEqual(expected);
    expect(expected.length).toBe(27);
  });

  it("uses the operationId of the contract for each route", () => {
    for (const op of contract.operations) {
      const route = routes.find((r) => r.method === op.method && r.pattern === op.path);
      expect(route?.meta.operationId, key(op.method, op.path)).toBe(op.operationId);
    }
  });

  it("flags exactly the stubs as stubs until a module replaces them", () => {
    expect(routes.every((r) => r.isStub)).toBe(true);
  });

  it("mirrors the security scheme of each operation", () => {
    for (const op of contract.operations) {
      const route = routes.find((r) => r.method === op.method && r.pattern === op.path)!;
      const security: Array<Record<string, unknown>> | undefined = op.def.security;
      const expected =
        security === undefined ? "bearer" : security.length === 0 ? "none" : security.some((s) => "manageToken" in s) ? "bearer_or_manage" : "bearer";
      expect(route.meta.auth, op.operationId).toBe(expected);
    }
  });

  it("flags content routes and the client header from the contract's parameters", () => {
    for (const op of contract.operations) {
      const route = routes.find((r) => r.method === op.method && r.pattern === op.path)!;
      const refs: string[] = (op.def.parameters ?? []).map((p: { $ref?: string }) => p.$ref ?? "");
      expect(route.meta.content, op.operationId).toBe(refs.some((r) => r.endsWith("/IdempotencyKey")));
      expect(route.meta.client, op.operationId).toBe(refs.some((r) => r.endsWith("/ClientHeader")));
    }
  });

  it("matches the request body kind to the declared media type", () => {
    for (const op of contract.operations) {
      const route = routes.find((r) => r.method === op.method && r.pattern === op.path)!;
      const content = op.def.requestBody?.content ?? {};
      const expected = "multipart/form-data" in content ? "multipart" : "application/json" in content ? "json" : "none";
      expect(route.meta.body.kind, op.operationId).toBe(expected);
    }
  });

  it("marks the fresh sign-in routes the contract names", () => {
    for (const op of contract.operations) {
      const route = routes.find((r) => r.method === op.method && r.pattern === op.path)!;
      expect(route.meta.freshAuth, op.operationId).toBe(/`auth_time` within 5 minutes/.test(op.def.description ?? ""));
    }
  });

  it("exempts exactly the data-rights routes from terms and suspension gating", () => {
    const exempt = routes
      .filter((r) => r.meta.auth !== "none" && r.meta.gate === "exempt")
      .map((r) => key(r.method, r.pattern))
      .sort();
    expect(exempt).toEqual(
      [
        "GET /v1/account",
        "GET /v1/account/export",
        "DELETE /v1/account",
        "GET /v1/devices",
        "DELETE /v1/devices/{device_id}",
        "GET /v1/billing/portal",
        "POST /v1/account/terms",
      ].sort(),
    );
  });

  it("accepts a manage token only on the two device routes", () => {
    const withManage = routes.filter((r) => r.meta.auth === "bearer_or_manage").map((r) => key(r.method, r.pattern)).sort();
    expect(withManage).toEqual(["DELETE /v1/devices/{device_id}", "GET /v1/devices"]);
  });
});

describe("stubs and routing", () => {
  it("answers a registered route with the 501 error envelope and X-Request-Id", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const res = await t.request("/v1/status", { headers: { "X-StudentLLM-Client": "studentllm-desktop/0.2.0" } });
    expect(res.status).toBe(501);
    expect(res.headers.get("X-Request-Id")).toBe("req_test_000001");
    const body = await res.json();
    expect(validateAgainst("Error", body)).toEqual([]);
    expect(body.error.request_id).toBe("req_test_000001");
  });

  it("serves every stub with a valid envelope", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    for (const route of t.app.router.routes()) {
      const path = route.pattern.replace("{device_id}", "dev_1").replace("{method}", "google");
      const res = await t.request(path, {
        method: route.method,
        headers: CONTENT_HEADERS,
      });
      expect(res.status, `${route.method} ${route.pattern}`).toBe(501);
      expect(validateAgainst("Error", await res.json())).toEqual([]);
    }
  });

  it("answers unknown paths and wrong methods with not_found", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const unknown = await t.request("/nope");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");
    expect((await t.request("/v1/status", { method: "DELETE" })).status).toBe(404);
  });

  it("ignores a client-supplied X-Request-Id", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const res = await t.request("/nope", { headers: { "X-Request-Id": "attacker-chosen" } });
    expect(res.headers.get("X-Request-Id")).toBe("req_test_000001");
  });

  it("logs only request id, account, route, status, credits and latency", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    await t.request("/v1/devices/dev_9", { method: "DELETE" });
    expect(t.logs).toHaveLength(1);
    expect(Object.keys(t.logs[0]!).sort()).toEqual(["accountId", "creditsCharged", "latencyMs", "method", "requestId", "route", "status"]);
    expect(t.logs[0]!.route).toBe("/v1/devices/{device_id}");
  });

  it("turns an unexpected exception into internal_error without leaking its message", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    t.app.router.add("GET", "/boom", () => {
      throw new Error("secret detail");
    }, routeMeta({ operationId: "boom", auth: "none" }));
    const res = await t.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });
});
