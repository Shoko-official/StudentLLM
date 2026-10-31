import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../types";
import { API_DOC_PATH, loadContract, validateAgainst } from "../testing";
import {
  ApiError,
  buildEnvelope,
  deviceLimitResponse,
  ERROR_STATUS,
  errorResponse,
  errorResponseFrom,
  notImplementedResponse,
  sseErrorEvent,
} from "./envelope";

describe("error code to status map", () => {
  it("covers exactly the ErrorCode enum of the OpenAPI file", () => {
    const enumCodes = [...loadContract().errorCodes].sort();
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(enumCodes);
    expect([...ERROR_CODES].sort()).toEqual(enumCodes);
  });

  it("matches the HTTP column of the error table in docs/cloud-api.md", () => {
    const doc = readFileSync(API_DOC_PATH, "utf8");
    const rows = [...doc.matchAll(/^\| `([a-z_]+)` \| (\d{3})/gm)];
    expect(rows.length).toBe(Object.keys(ERROR_STATUS).length);
    for (const [, code, status] of rows) {
      expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(Number(status));
    }
  });
});

describe("errorResponse", () => {
  it("builds the envelope with status, X-Request-Id and Retry-After", async () => {
    const res = errorResponse("budget_exhausted", "req_1", { retryAfterSeconds: 864000, details: { resets_at: "2026-12-01T00:00:00Z" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-Request-Id")).toBe("req_1");
    expect(res.headers.get("Retry-After")).toBe("864000");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "budget_exhausted",
        message: "The credit budget is used up.",
        request_id: "req_1",
        retry_after_seconds: 864000,
        details: { resets_at: "2026-12-01T00:00:00Z" },
      },
    });
    expect(validateAgainst("Error", body)).toEqual([]);
  });

  it("produces a schema-valid envelope for every code", async () => {
    for (const code of Object.keys(ERROR_STATUS) as Array<keyof typeof ERROR_STATUS>) {
      const res = errorResponse(code, "req_1");
      expect(res.status).toBe(ERROR_STATUS[code]);
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(validateAgainst("Error", await res.json()), code).toEqual([]);
    }
  });

  it("refuses secret-bearing keys in details", () => {
    for (const key of ["manage_token", "refresh_token", "access_token", "code", "code_verifier"]) {
      expect(() => buildEnvelope("invalid_request", "req_1", { details: { [key]: "x" } })).toThrow(TypeError);
    }
  });

  it("checks details recursively and by secret-like name, in any case", () => {
    const bad: Array<Record<string, unknown>> = [
      { nested: { manage_token: "x" } },
      { list: [{ deep: { Refresh_Token: "x" } }] },
      { apiKey: "x" },
      { client_secret: "x" },
      { Authorization: "Bearer x" },
      { code_verifier: "x" },
      { webhook_signature: "x" },
    ];
    for (const details of bad) {
      expect(() => buildEnvelope("invalid_request", "req_1", { details }), JSON.stringify(details)).toThrow(TypeError);
    }
    const fine = {
      resets_at: "2026-12-01T00:00:00Z",
      state: "in_progress",
      request_id: "req_0",
      credits_charged: 4,
      terms_version: "v1",
      consent_text_version: "t",
      min_client_version: "0.2.0",
    };
    expect(() => buildEnvelope("invalid_request", "req_1", { details: fine })).not.toThrow();
  });

  it("allows extra headers such as X-StudentLLM-Min-Client", () => {
    const res = errorResponse("client_outdated", "req_1", { headers: { "X-StudentLLM-Min-Client": "0.2.0" } });
    expect(res.status).toBe(426);
    expect(res.headers.get("X-StudentLLM-Min-Client")).toBe("0.2.0");
  });

  it("maps ApiError to its envelope and anything else to internal_error", async () => {
    const known = errorResponseFrom(new ApiError("plan_required"), "req_1");
    expect(known.status).toBe(403);
    const unknown = errorResponseFrom(new Error("provider said: the prompt was ..."), "req_1");
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("prompt");
  });
});

describe("other response helpers", () => {
  it("serves the stub as 501 with a valid envelope", async () => {
    const res = notImplementedResponse("req_1");
    expect(res.status).toBe(501);
    expect(validateAgainst("Error", await res.json())).toEqual([]);
  });

  it("builds a DeviceLimitResponse that keeps the manage token out of the envelope", async () => {
    const res = deviceLimitResponse("req_1", "mt_EXAMPLE");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(validateAgainst("DeviceLimitResponse", body)).toEqual([]);
    expect(JSON.stringify(body.error)).not.toContain("mt_");
  });

  it("formats an SSE error event with the standard envelope", () => {
    const frame = sseErrorEvent("provider_unavailable", "req_1");
    expect(frame.startsWith("event: error\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = JSON.parse(frame.split("\n")[1]!.slice(6));
    expect(validateAgainst("Error", data)).toEqual([]);
  });
});
