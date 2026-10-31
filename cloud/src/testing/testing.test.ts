import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSchemaTreeSupported,
  checkFixtureConformance,
  expectFixtureConformance,
  fixtureNames,
  fixtureRequest,
  fixtureResponse,
  FIXTURES_DIR,
  loadAllFixtures,
  loadContract,
  loadFixture,
  makeTestApp,
  parseSse,
  validateAgainst,
  validateSchema,
} from "./index";

describe("contract validator", () => {
  it("validates types, required, additionalProperties, enums, const, formats and patterns", () => {
    const schema = {
      type: "object",
      required: ["a"],
      additionalProperties: false,
      properties: {
        a: { type: "integer", minimum: 1 },
        b: { type: ["string", "null"], format: "date-time" },
        c: { type: "string", enum: ["x", "y"] },
        d: { type: "string", const: "k" },
        e: { type: "array", items: { type: "string", pattern: "^z" }, maxItems: 2, uniqueItems: true },
      },
    };
    const ok = { a: 1, b: null, c: "x", d: "k", e: ["z1"] };
    expect(validateSchema(schema, ok)).toEqual([]);
    expect(validateSchema(schema, { ...ok, a: 0 })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, a: 1.5 })).toHaveLength(1);
    expect(validateSchema(schema, { b: "2026-11-01T09:30:00Z" })).toEqual(['$: missing required "a"']);
    expect(validateSchema(schema, { ...ok, b: "yesterday" })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, c: "q" })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, d: "j" })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, extra: 1 })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, e: ["z1", "z1"] })).toHaveLength(1);
    expect(validateSchema(schema, { ...ok, e: ["a"] })).toHaveLength(1);
  });

  it("refuses schema keywords and formats it cannot check instead of silently passing", () => {
    expect(() => validateSchema({ allOf: [{ type: "string" }] }, "x")).toThrow(/unsupported JSON Schema keyword "allOf"/);
    expect(() => validateSchema({ type: "object", patternProperties: {} }, {})).toThrow(/patternProperties/);
    expect(() => validateSchema({ type: "string", format: "email" }, "x")).toThrow(/unsupported format "email"/);
    expect(() => validateSchema({ type: "integer", exclusiveMinimum: 0 }, 1)).toThrow(/exclusiveMinimum/);
    expect(() => validateSchema({ type: "string", description: "fine", readOnly: true }, "x")).not.toThrow();
  });

  it("supports every keyword used anywhere in the contract", () => {
    const contract = loadContract();
    for (const schema of Object.values(contract.spec.components.schemas)) assertSchemaTreeSupported(schema);
    for (const param of Object.values<{ schema?: unknown }>(contract.spec.components.parameters)) assertSchemaTreeSupported(param.schema);
    for (const header of Object.values<{ schema?: unknown }>(contract.spec.components.headers)) assertSchemaTreeSupported(header.schema);
  });

  it("resolves $ref and oneOf against the real contract", () => {
    expect(validateAgainst("ChatMessage", { role: "user", content: "hi" })).toEqual([]);
    expect(validateAgainst("ChatMessage", { role: "user", content: [{ type: "text", text: "hi" }] })).toEqual([]);
    expect(validateAgainst("ChatMessage", { role: "user", content: 5 })).not.toEqual([]);
    expect(validateAgainst("ChatRequest", { model: "m", messages: [{ role: "user", content: "x" }], tools: [] })).not.toEqual([]);
    expect(validateAgainst("Nope", {})).toEqual(["unknown schema Nope"]);
  });
});

describe("fixtures", () => {
  const fixtures = loadAllFixtures();

  it("lists every fixture file in index.json and vice versa", () => {
    const listed = fixtureNames().map((n) => `${n}.json`).sort();
    const files = readdirSync(FIXTURES_DIR).filter((f) => f !== "index.json").sort();
    expect(listed).toEqual(files);
  });

  it("only uses operationIds and statuses the contract declares", () => {
    const contract = loadContract();
    for (const fx of fixtures) {
      const op = contract.operations.find((o) => o.operationId === fx.operation);
      expect(op, fx.name).toBeDefined();
      expect(Object.keys(op!.def.responses), fx.name).toContain(String(fx.response.status));
    }
  });

  it("recorded responses conform to their own schema, and every error uses a known code", async () => {
    const contract = loadContract();
    for (const fx of fixtures) {
      const problems = await checkFixtureConformance(fixtureResponse(fx), fx);
      expect(problems, fx.name).toEqual([]);
      const error = (fx.response.body as { error?: { code: string } } | undefined)?.error;
      if (error) expect(contract.errorCodes, fx.name).toContain(error.code);
    }
  });

  it("validates fixture request bodies against the operation's request schema", () => {
    const contract = loadContract();
    for (const fx of fixtures) {
      if (fx.request.body === undefined) continue;
      const op = contract.operations.find((o) => o.operationId === fx.operation)!;
      const ref = op.def.requestBody?.content?.["application/json"]?.schema?.$ref as string | undefined;
      expect(ref, fx.name).toBeDefined();
      expect(validateAgainst(ref!.split("/").pop()!, fx.request.body), fx.name).toEqual([]);
    }
  });

  it("builds JSON and multipart requests from fixtures", async () => {
    const chat = fixtureRequest(loadFixture("chat-completions.success"));
    expect(chat.method).toBe("POST");
    expect(chat.headers.get("Content-Type")).toBe("application/json");
    expect((await chat.json()).model).toBe("studentllm-large");
    const audio = fixtureRequest(loadFixture("audio-transcriptions.success"));
    expect(audio.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await audio.formData();
    expect(form.get("model")).toBe("studentllm-transcribe");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });
});

describe("conformance helper", () => {
  it("accepts a conforming error response", async () => {
    const fx = loadFixture("chat-completions.budget_exhausted");
    await expectFixtureConformance(fixtureResponse(fx), fx, { strictHeaders: ["Retry-After"] });
  });

  it("reports a wrong status, code, missing header and missing details key", async () => {
    const fx = loadFixture("chat-completions.budget_exhausted");
    const makeWrong = () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "m", request_id: "req_1" } }), {
        status: 403,
        headers: { "X-Request-Id": "req_1" },
      });
    const problems = await checkFixtureConformance(makeWrong(), fx);
    expect(problems.join("\n")).toContain("status 403, expected 429");
    expect(problems.join("\n")).toContain("missing header Retry-After");
    expect(problems.join("\n")).toContain("error.code is rate_limited, expected budget_exhausted");
    expect(problems.join("\n")).toContain('error.details lacks "resets_at"');
    await expect(expectFixtureConformance(makeWrong(), fx)).rejects.toThrow(/does not conform to fixture chat-completions.budget_exhausted/);
  });

  it("detects a body that breaks the schema and a header value when it is strict", async () => {
    const fx = loadFixture("status.get.success");
    const bad = new Response(JSON.stringify({ status: "great" }), { headers: { "X-Request-Id": "r", "X-StudentLLM-Min-Client": "9.9.9" } });
    const problems = await checkFixtureConformance(bad, fx, { strictHeaders: ["X-StudentLLM-Min-Client"] });
    expect(problems.some((p) => p.includes("status"))).toBe(true);
    expect(problems.some((p) => p.includes("X-StudentLLM-Min-Client"))).toBe(true);
  });

  it("checks SSE streams: event sequence and event payloads", async () => {
    const ok = loadFixture("chat-completions.stream.success");
    await expectFixtureConformance(fixtureResponse(ok), ok);
    const broken = new Response("data: {}\n\nevent: usage\ndata: {\"credits_charged\":-1}\n\ndata: [DONE]\n\n", { headers: ok.response.headers });
    expect((await checkFixtureConformance(broken, ok)).length).toBeGreaterThan(0);
    const err = loadFixture("chat-completions.stream.mid_stream_error");
    await expectFixtureConformance(fixtureResponse(err), err);
    expect(parseSse("event: x\ndata: 1\n\ndata: [DONE]\n\n")).toEqual([{ event: "x", data: "1" }, { event: null, data: "[DONE]" }]);
  });

  it("lets the app be checked against a fixture end to end", async () => {
    const t = makeTestApp({ allowMissingHooks: true });
    const fx = loadFixture("status.client_outdated");
    const res = await t.app.handle(fixtureRequest(fx));
    await expectFixtureConformance(res, fx, { strictHeaders: ["X-StudentLLM-Min-Client"] });
  });
});

describe("generated types", () => {
  it("are up to date with docs/cloud-api.openapi.yaml", () => {
    const script = fileURLToPath(new URL("../../scripts/generate-types.mjs", import.meta.url));
    const out = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(out).toContain("up to date");
  });

  it("export one type per schema of the contract", () => {
    const generated = readFileSync(fileURLToPath(new URL("../types/api.generated.ts", import.meta.url)), "utf8");
    const contract = loadContract();
    for (const name of Object.keys(contract.spec.components.schemas)) {
      const exported = name === "Error" ? "ErrorEnvelope" : name;
      expect(generated, name).toMatch(new RegExp(`export type ${exported} =`));
    }
  });
});
