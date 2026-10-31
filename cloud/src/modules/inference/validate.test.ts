import { describe, expect, it } from "vitest";
import { ApiError } from "../../http/envelope";
import { pngDataUrl } from "../../testing/inference-harness";
import { buildRoutingTable, DEFAULT_ROUTING, type ChatRoute } from "./routing";
import { validateChatRequest } from "./validate-chat";

const chat = DEFAULT_ROUTING.models[0] as ChatRoute;
const textTable = buildRoutingTable(DEFAULT_ROUTING);
const imageTable = buildRoutingTable({ ...DEFAULT_ROUTING, models: [{ ...chat, maxImages: 2, maxImageBytes: 1000 }] });
const ok = (extra: Record<string, unknown> = {}) => ({ model: "studentllm-large", messages: [{ role: "user", content: "hello" }], ...extra });

function failure(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("validateChatRequest", () => {
  it("rebuilds the request from the allowlist and estimates the input on the server", () => {
    const v = validateChatRequest(
      ok({ messages: [{ role: "system", content: "abcdef" }, { role: "user", content: [{ type: "text", text: "abc" }] }], stream: true, temperature: 1, top_p: 0.5, stop: "x", reasoning_effort: "high" }),
      textTable,
    );
    expect(v).toMatchObject({ stream: true, temperature: 1, topP: 0.5, stop: "x", reasoningEffort: "high", maxTokens: 4096 });
    // priming 3 + two messages x 4 + ceil(6/3) + ceil(3/3) = 14
    expect(v.inputTokenEstimate).toBe(14);
    expect(v.messages).toEqual([
      { role: "system", content: "abcdef" },
      { role: "user", content: [{ type: "text", text: "abc" }] },
    ]);
  });

  it("clamps max_tokens to the model limit and to what the context window leaves", () => {
    expect(validateChatRequest(ok({ max_tokens: 10 }), textTable).maxTokens).toBe(10);
    expect(validateChatRequest(ok({ max_tokens: 10_000 }), textTable).maxTokens).toBe(4096);
    // An input of about 130,000 tokens leaves a few hundred tokens of room in the 131,072 window.
    const long = "x".repeat(3 * 130_900);
    const v = validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: long }] }, textTable);
    expect(v.maxTokens).toBeLessThan(500);
    expect(v.maxTokens).toBeGreaterThanOrEqual(1);
    expect(failure(() => validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(3 * 131_100) }] }, textTable)).code).toBe("payload_too_large");
  });

  it("rejects what the schema does not allow", () => {
    const rejected: unknown[] = [
      ok({ messages: [] }),
      ok({ messages: [{ role: "tool", content: "x" }] }),
      ok({ messages: [{ role: "user", content: "x", name: "bob" }] }),
      ok({ messages: [{ role: "user", content: [] }] }),
      ok({ messages: [{ role: "user", content: [{ type: "audio", audio: "x" }] }] }),
      ok({ messages: [{ role: "user", content: [{ type: "text", text: "x", extra: 1 }] }] }),
      ok({ messages: [{ role: "user", content: 5 }] }),
      ok({ stream: "yes" }),
      ok({ max_tokens: 0 }),
      ok({ max_tokens: 1.5 }),
      ok({ temperature: -1 }),
      ok({ top_p: 2 }),
      ok({ stop: ["a", "b", "c", "d", "e"] }),
      ok({ stop: [1] }),
      ok({ response_format: { type: "text" } }),
      ok({ response_format: { type: "json_schema" } }),
      ok({ reasoning_effort: "extreme" }),
      { messages: [{ role: "user", content: "x" }] },
      { model: 5, messages: [{ role: "user", content: "x" }] },
      ["not", "an", "object"],
      null,
    ];
    for (const raw of rejected) expect(failure(() => validateChatRequest(raw, textTable)).code, JSON.stringify(raw)).toBe("invalid_request");
  });

  it("does not allow __proto__ or constructor fields", () => {
    const raw = JSON.parse('{"model":"studentllm-large","messages":[{"role":"user","content":"x"}],"__proto__":{"tools":[]}}');
    expect(failure(() => validateChatRequest(raw, textTable)).code).toBe("invalid_request");
  });

  it("names a forbidden field in details.field, and nothing else", () => {
    const e = failure(() => validateChatRequest(ok({ tools: [] }), textTable));
    expect(e.options.details).toEqual({ field: "tools" });
    const unknown = failure(() => validateChatRequest(ok({ weird_secret_field: 1 }), textTable));
    expect(unknown.options.details).toBeUndefined();
  });

  it("keeps json_schema and drops other response_format keys", () => {
    const v = validateChatRequest(ok({ response_format: { type: "json_schema", json_schema: { name: "x", schema: {} }, ignored: true } }), textTable);
    expect(v.responseFormat).toEqual({ type: "json_schema", json_schema: { name: "x", schema: {} } });
  });

  describe("images", () => {
    const image = (url: string) => ({ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url } }] });

    it("accepts a data URL of an allowed type and counts its tokens from the decoded size", () => {
      const v = validateChatRequest(ok({ messages: [image(pngDataUrl(300))] }), imageTable);
      expect(v.inputTokenEstimate).toBeGreaterThanOrEqual(512);
    });

    it("rejects http(s), file and other schemes", () => {
      for (const url of ["https://evil.example/a.png", "http://127.0.0.1/a.png", "file:///etc/passwd", "ftp://x/y.png", "data:text/html;base64,PGI+", "data:image/svg+xml;base64,PHN2Zz4="]) {
        expect(failure(() => validateChatRequest(ok({ messages: [image(url)] }), imageTable)).code, url).toBe("invalid_request");
      }
    });

    it("rejects malformed base64 and content that is not the declared type", () => {
      for (const url of ["data:image/png;base64,", "data:image/png;base64,@@@@", "data:image/png;base64,abc", "data:image/jpeg;base64," + btoa("this is plain text, not a picture")]) {
        expect(failure(() => validateChatRequest(ok({ messages: [image(url)] }), imageTable)).code, url).toBe("invalid_request");
      }
    });

    it("refuses too many images and too large an image with payload_too_large", () => {
      const one = image(pngDataUrl(64));
      const three = { role: "user", content: [...(one.content as unknown[]), ...(one.content as unknown[]), ...(one.content as unknown[])] };
      expect(failure(() => validateChatRequest(ok({ messages: [three] }), imageTable)).code).toBe("payload_too_large");
      expect(failure(() => validateChatRequest(ok({ messages: [image(pngDataUrl(2000))] }), imageTable)).code).toBe("payload_too_large");
    });

    it("refuses images in system and assistant messages and for a text-only model", () => {
      const part = [{ type: "image_url", image_url: { url: pngDataUrl(64) } }];
      expect(failure(() => validateChatRequest(ok({ messages: [{ role: "assistant", content: part }] }), imageTable)).code).toBe("invalid_request");
      expect(failure(() => validateChatRequest(ok({ messages: [{ role: "system", content: part }] }), imageTable)).code).toBe("invalid_request");
      expect(failure(() => validateChatRequest(ok({ messages: [image(pngDataUrl(64))] }), textTable)).code).toBe("invalid_request");
    });

    it("rejects an image_url with extra keys (a detail or a header a provider might honor)", () => {
      const withDetail = { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl(64), detail: "high" } }] };
      expect(failure(() => validateChatRequest(ok({ messages: [withDetail] }), imageTable)).code).toBe("invalid_request");
    });
  });
});
