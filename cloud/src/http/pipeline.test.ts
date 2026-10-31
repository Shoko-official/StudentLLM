import { describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "../testing";
import { assertTokenScope, classifyBearer, parseBearer } from "./bearer";
import { compareVersions, parseClientHeader, parseVersion } from "./client-version";
import { routeMeta, type RouteMeta } from "./context";
import { ApiError } from "./envelope";
import { Router } from "./router";


/** Registers a route that reads the body the way a real handler will. */
function addEcho(t: TestApp, kind: "json" | "multipart", limit: "small" | "chat" | "audio" = "small") {
  const path = `/test/${kind}`;
  t.app.router.add(
    "POST",
    path,
    async (ctx) => {
      if (kind === "json") {
        const body = await ctx.body.json();
        return new Response(JSON.stringify({ ok: true, body }), { headers: { "Content-Type": "application/json" } });
      }
      const form = await ctx.body.formData();
      return new Response(JSON.stringify({ ok: true, fields: [...form.keys()] }));
    },
    routeMeta({ operationId: `test_${kind}`, auth: "none", body: { kind, limit } }),
  );
  return path;
}

function chunked(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

async function code(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

describe("client version handshake", () => {
  it("returns 426 client_outdated with the minimum version in the header and details", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const res = await t.request("/v1/status", { headers: { "X-StudentLLM-Client": "studentllm-desktop/0.1.0" } });
    expect(res.status).toBe(426);
    expect(res.headers.get("X-StudentLLM-Min-Client")).toBe("0.2.0");
    const body = await res.json();
    expect(body.error.code).toBe("client_outdated");
    expect(body.error.details).toEqual({ min_client_version: "0.2.0" });
  });

  it("lets the minimum version and newer builds through, prereleases of the minimum excepted", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    for (const v of ["0.2.0", "0.2.1", "0.10.0", "1.0.0", "0.2.0+build5"]) {
      const res = await t.request("/v1/status", { headers: { "X-StudentLLM-Client": `studentllm-desktop/${v}` } });
      expect(res.status, v).toBe(501); // past the handshake, into the stub
    }
    const pre = await t.request("/v1/status", { headers: { "X-StudentLLM-Client": "studentllm-desktop/0.2.0-beta.1" } });
    expect(pre.status).toBe(426);
  });

  it("rejects a missing or malformed header with invalid_request", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const cases: Array<Record<string, string>> = [{}, { "X-StudentLLM-Client": "curl/8" }, { "X-StudentLLM-Client": "studentllm-desktop/latest" }];
    for (const headers of cases) {
      const res = await t.request("/v1/status", { headers });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe("invalid_request");
    }
  });

  it("applies to the content routes before anything else and only to the routes that need it", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const outdated = await t.request("/v1/chat/completions", {
      method: "POST",
      headers: { "X-StudentLLM-Client": "studentllm-desktop/0.0.1", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(outdated.status).toBe(426);
    // GET /v1/models has no client header requirement, so none is demanded.
    expect((await t.request("/v1/models")).status).toBe(501);
  });

  it("orders versions numerically, prerelease below release", () => {
    const v = (s: string) => parseVersion(s)!;
    expect(compareVersions(v("0.10.0"), v("0.9.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0-rc.1"), v("1.0.0"))).toBeLessThan(0);
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(parseClientHeader("studentllm-desktop/1.2.3")?.version).toBe("1.2.3");
    expect(parseClientHeader("other/1.2.3")).toBeNull();
    const bad = ["01.2.3", "1.02.3", "1.2", "1.2.3.4", "1.2.3-", "1.2.3 x", "v1.2.3", "1.2.3+"];
    for (const v of bad) expect(parseClientHeader(`studentllm-desktop/${v}`), v).toBeNull();
    expect(parseClientHeader("studentllm-desktop/1.2.3-rc.1+build.5")?.parsed.prerelease).toBe("rc.1");
    expect(parseVersion("1.2")).toBeNull();
  });
});

describe("Content-Type checks", () => {
  it("accepts application/json with parameters and any case", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const path = addEcho(t, "json");
    for (const ct of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
      const res = await t.request(path, { method: "POST", headers: { "Content-Type": ct }, body: '{"a":1}' });
      expect(res.status, ct).toBe(200);
    }
  });

  it("accepts a UTF-8 charset in any spelling and rejects every other charset", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const path = addEcho(t, "json");
    for (const ct of ["application/json; charset=UTF-8", "application/json;charset=utf8", 'application/json; charset="utf-8"']) {
      expect((await t.request(path, { method: "POST", headers: { "Content-Type": ct }, body: "{}" })).status, ct).toBe(200);
    }
    for (const ct of ["application/json; charset=iso-8859-1", "application/json; charset=utf-16", "application/json; charset=", "application/json; boundary=x; charset=latin1"]) {
      const res = await t.request(path, { method: "POST", headers: { "Content-Type": ct }, body: "{}" });
      expect(res.status, ct).toBe(415);
      expect(await code(res)).toBe("unsupported_media_type");
    }
  });

  it("rejects other media types with 415 unsupported_media_type", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const path = addEcho(t, "json");
    const cases: Array<Record<string, string>> = [{ "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }, {}];
    for (const headers of cases) {
      const res = await t.request(path, { method: "POST", headers, body: '{"a":1}' });
      expect(res.status).toBe(415);
      expect(await code(res)).toBe("unsupported_media_type");
    }
  });

  it("rejects invalid JSON and invalid UTF-8 with invalid_request", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const path = addEcho(t, "json");
    const bad = await t.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    const utf8 = await t.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    });
    expect(utf8.status).toBe(400);
    const empty = await t.request(path, { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(empty.status).toBe(400);
  });

  it("requires multipart/form-data with a boundary on multipart routes", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const path = addEcho(t, "multipart");
    const json = await t.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(json.status).toBe(415);
    const noBoundary = await t.request(path, { method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "x" });
    expect(noBoundary.status).toBe(415);
    const form = new FormData();
    form.set("model", "m");
    form.set("file", new Blob([new Uint8Array(10)]), "a.bin");
    const ok = await t.request(path, { method: "POST", body: form });
    expect(ok.status).toBe(200);
    expect((await ok.json()).fields).toEqual(["model", "file"]);
  });
});

describe("body size limits are enforced while streaming", () => {
  const limits = { bodyBytes: { small: 1024, webhook: 4096, chat: 4096, audio: 4096, image: 4096 } };

  function app() {
    // A tiny limit makes the streaming behavior observable without allocating megabytes.
    const t = makeTestApp({ allowMissingHooks: true });
    (t.deps.config as { limits: typeof limits }).limits = limits;
    return t;
  }

  it("accepts a body exactly at the limit and refuses one byte more", async () => {
    const t = app();
    const path = addEcho(t, "json");
    const pad = (n: number) => JSON.stringify({ a: "x".repeat(n - 8) }); // {"a":""} is 8 bytes
    expect(pad(1024).length).toBe(1024);
    const ok = await t.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: pad(1024) });
    expect(ok.status).toBe(200);
    const over = await t.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: pad(1025) });
    expect(over.status).toBe(413);
    expect(await code(over)).toBe("payload_too_large");
  });

  it("rejects a declared Content-Length above the limit without reading the body", async () => {
    const t = app();
    const path = addEcho(t, "json");
    let pulls = 0;
    const body = chunked([new Uint8Array(512)], () => pulls++);
    const res = await t.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("cuts a chunked body off once it passes the limit instead of buffering it", async () => {
    const t = app();
    const path = addEcho(t, "json");
    let pulls = 0;
    const chunks = Array.from({ length: 200 }, () => new Uint8Array(256).fill(0x20)); // 51,200 bytes, no length header
    const res = await t.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chunked(chunks, () => pulls++),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(20); // stopped near 1024 bytes, nowhere near 200 chunks
  });

  it("applies the limit to multipart bodies too", async () => {
    const t = app();
    const path = addEcho(t, "multipart", "audio");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(20_000)]), "a.bin");
    const res = await t.request(path, { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe("payload_too_large");
  });

  it("rejects a malformed Content-Length", async () => {
    const t = app();
    const path = addEcho(t, "json");
    const res = await t.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "abc" },
      body: "{}",
    });
    expect([400, 413]).toContain(res.status);
  });
});

describe("bearer classification", () => {
  it("tells a manage token from an access token by the mt_ prefix", () => {
    expect(classifyBearer("mt_abc")).toBe("manage");
    expect(classifyBearer("eyJhbGciOiJFZERTQSJ9.x.y")).toBe("access");
    expect(classifyBearer("MT_abc")).toBe("access");
  });

  it("extracts the token from the Authorization header", () => {
    const req = (value?: string) => new Request("https://x.invalid/", { headers: value ? { Authorization: value } : {} });
    expect(parseBearer(req("Bearer abc"))).toBe("abc");
    expect(parseBearer(req("bearer abc"))).toBe("abc");
    expect(parseBearer(req("Basic abc"))).toBeNull();
    expect(parseBearer(req("Bearer a b"))).toBeNull();
    expect(parseBearer(req())).toBeNull();
  });

  it("rejects a manage token outside the two device routes with insufficient_scope", () => {
    const device: RouteMeta = routeMeta({ operationId: "listDevices", auth: "bearer_or_manage" });
    const other: RouteMeta = routeMeta({ operationId: "getAccount" });
    expect(() => assertTokenScope("manage", device)).not.toThrow();
    expect(() => assertTokenScope("access", other)).not.toThrow();
    expect(() => assertTokenScope("manage", other)).toThrow(ApiError);
    try {
      assertTokenScope("manage", other);
    } catch (e) {
      expect((e as ApiError).code).toBe("insufficient_scope");
      expect((e as ApiError).status).toBe(403);
    }
  });
});

describe("router", () => {
  const meta = routeMeta({ operationId: "x", auth: "none" });
  const h = () => new Response("ok");

  it("prefers static segments over parameters and decodes parameters", () => {
    const r = new Router();
    r.add("GET", "/v1/devices/{device_id}", h, meta);
    r.add("GET", "/v1/devices/all", h, meta);
    expect(r.match("GET", "/v1/devices/all")?.route.pattern).toBe("/v1/devices/all");
    const m = r.match("GET", "/v1/devices/a%20b");
    expect(m?.params).toEqual({ device_id: "a b" });
    expect(r.match("GET", "/v1/devices/")).toBeUndefined();
    expect(r.match("GET", "/v1/devices/%E0%A4%A")).toBeUndefined();
    expect(r.match("POST", "/v1/devices/x")).toBeUndefined();
  });

  it("rejects duplicate and malformed registrations", () => {
    const r = new Router();
    r.add("GET", "/a", h, meta);
    expect(() => r.add("GET", "/a", h, meta)).toThrow(/twice/);
    expect(() => r.add("GET", "a", h, meta)).toThrow();
    expect(() => r.add("GET", "/a/", h, meta)).toThrow();
    expect(() => r.add("GET", "/a/x{id}", h, meta)).toThrow();
  });
});
