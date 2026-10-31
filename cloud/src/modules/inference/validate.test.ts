import { describe, expect, it } from "vitest";
import { ApiError } from "../../http/envelope";
import { pngDataUrl } from "../../testing/inference-harness";
import { TEMPLATE_FRAMING_TOKENS, TOKENS_PER_MESSAGE_OVERHEAD, TOKENS_REPLY_PRIMING, tokenCost } from "./credits";
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
    // A token per byte: priming 3 + the template allowance 64 + two messages x 4 + (6 + 3 message bytes + 1 stop byte) = 85.
    expect(v.inputTokenEstimate).toBe(3 + TEMPLATE_FRAMING_TOKENS + 8 + 10);
    expect(v.inputTokenEstimate).toBe(85);
    // The tighter count (used only to settle a stream that failed): the same 75 framing tokens + ceil(10 / 2).
    expect(v.inputTokenCount).toBe(80);
    expect(v.messages).toEqual([
      { role: "system", content: "abcdef" },
      { role: "user", content: [{ type: "text", text: "abc" }] },
    ]);
  });

  it("clamps max_tokens to the model limit", () => {
    expect(validateChatRequest(ok({ max_tokens: 10 }), textTable).maxTokens).toBe(10);
    expect(validateChatRequest(ok({ max_tokens: 10_000 }), textTable).maxTokens).toBe(4096);
    expect(validateChatRequest(ok({ max_tokens: 1 }), textTable).maxTokens).toBe(1);
  });

  it("caps the input bound at the context window, and refuses an input that cannot fit at 8 bytes a token", () => {
    const window = chat.contextWindow;
    const big = validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(400_000) }] }, textTable);
    expect(big.inputTokenEstimate).toBe(window); // 400,000 bytes would be more than the window: capped
    expect(big.inputTokenCount).toBe(window);
    const small = validateChatRequest(ok(), textTable);
    expect(small.inputTokenEstimate).toBeLessThan(window);
    expect(failure(() => validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(8 * window + 1) }] }, textTable)).code).toBe("payload_too_large");
  });

  it("reserves about 190 credits for a 100 KiB prompt and at most 240 at the context window (the price of the hard bound)", () => {
    const reserve = (bytes: number, extra: Record<string, unknown> = {}) => {
      const v = validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: "x".repeat(bytes) }], ...extra }, textTable);
      return tokenCost(chat.price, v.inputTokenEstimate, v.maxTokens);
    };
    expect(reserve(102_400)).toBeGreaterThanOrEqual(190);
    expect(reserve(102_400)).toBeLessThanOrEqual(200);
    // The input bound stops at the context window, so no prompt reserves more than about this.
    expect(reserve(400_000)).toBeLessThanOrEqual(240);
    expect(reserve(400_000)).toBeGreaterThanOrEqual(235);
    // A short answer reserves almost only the input.
    expect(reserve(102_400, { max_tokens: 100 })).toBeLessThan(reserve(102_400) - 20);
  });

  it("adds a flat allowance for the provider's chat template to every request, once", () => {
    const one = validateChatRequest(ok({ messages: [{ role: "user", content: "" }] }), textTable);
    expect(one.inputTokenEstimate).toBe(TOKENS_REPLY_PRIMING + TEMPLATE_FRAMING_TOKENS + TOKENS_PER_MESSAGE_OVERHEAD);
    const two = validateChatRequest(ok({ messages: [{ role: "user", content: "" }, { role: "assistant", content: "" }] }), textTable);
    expect(two.inputTokenEstimate - one.inputTokenEstimate).toBe(TOKENS_PER_MESSAGE_OVERHEAD);
  });

  describe("the input estimate is a hard upper bound of what any tokenizer can produce", () => {
    // No tokenizer yields more tokens than UTF-8 bytes. These are the inputs that fool a bytes-per-token ratio.
    const hostile: Array<[string, string]> = [
      ["spaced single characters", "a ".repeat(5000)],
      ["rare Unicode (4-byte code points)", "\u{1f600}\u{1f4a9}".repeat(1500)],
      ["one-byte punctuation runs", "!?;:".repeat(2500)],
      ["combining marks", "e\u0301\u0302\u0303".repeat(2000)],
      ["digits", "7".repeat(10_000)],
      ["a lone CJK character per word", "\u65e5 ".repeat(4000)],
    ];
    for (const [name, text] of hostile) {
      it(`covers ${name}`, () => {
        const bytes = new TextEncoder().encode(text).length;
        const v = validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: text }], max_tokens: 1 }, textTable);
        expect(v.inputTokenEstimate).toBeGreaterThanOrEqual(Math.min(bytes, chat.contextWindow));
        // Even if a provider billed one token per byte and the output hit max_tokens: 1, the reservation covers the cost.
        const worstCase = tokenCost(chat.price, Math.min(bytes, chat.contextWindow), 1);
        expect(tokenCost(chat.price, v.inputTokenEstimate, v.maxTokens)).toBeGreaterThanOrEqual(worstCase);
      });
    }

    it("counts the bytes of stop sequences and of a json_schema, not only the messages", () => {
      const schema = { type: "json_schema", json_schema: { name: "s", schema: { type: "object", description: "q".repeat(3000) } } };
      const base = validateChatRequest(ok(), textTable).inputTokenEstimate;
      const withSchema = validateChatRequest(ok({ response_format: schema }), textTable).inputTokenEstimate;
      expect(withSchema - base).toBeGreaterThanOrEqual(3000);
      const withStop = validateChatRequest(ok({ stop: ["s".repeat(200), "t".repeat(200)] }), textTable).inputTokenEstimate;
      expect(withStop - base).toBe(400);
    });

    it("never reserves less than the worst plausible cost over random hostile inputs (seeded)", () => {
      let a = 99;
      const next = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
      const alphabet = ["a", " ", "\u00e9", "\u65e5", "\u{1f600}", "!", "7", "\n", "\u0301"];
      for (let i = 0; i < 300; i++) {
        const length = 1 + Math.floor(next() * 2000);
        let text = "";
        for (let j = 0; j < length; j++) text += alphabet[Math.floor(next() * alphabet.length)];
        const maxTokens = 1 + Math.floor(next() * 4096);
        const bytes = new TextEncoder().encode(text).length;
        const v = validateChatRequest({ model: "studentllm-large", messages: [{ role: "user", content: text }], max_tokens: maxTokens }, textTable);
        const reserved = tokenCost(chat.price, v.inputTokenEstimate, v.maxTokens);
        expect(reserved).toBeGreaterThanOrEqual(tokenCost(chat.price, bytes, maxTokens));
      }
    });
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
