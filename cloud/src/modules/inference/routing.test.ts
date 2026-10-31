import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRoutingTable, DEFAULT_ROUTING, type ChatRoute, type RoutingConfig } from "./routing";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";

const chat = DEFAULT_ROUTING.models[0] as ChatRoute;
const withProviders = (providers: RoutingConfig["providers"]): RoutingConfig => ({ ...DEFAULT_ROUTING, providers });
const withModel = (patch: Partial<ChatRoute>): RoutingConfig => ({ ...DEFAULT_ROUTING, models: [{ ...chat, ...patch }] });

describe("the default routing table", () => {
  const table = buildRoutingTable(DEFAULT_ROUTING);

  it("routes one logical model to Groq gpt-oss-120b through one provider set", () => {
    const model = table.model("studentllm-large")!;
    expect(model).toMatchObject({ feature: "chat", providerSetId: "ps1", maxOutputTokens: 4096, contextWindow: 131072 });
    expect(model.targets).toEqual([{ providerId: "groq", upstreamModel: "openai/gpt-oss-120b" }]);
    expect(table.provider("groq")).toMatchObject({ displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", secret: "GROQ_API_KEY" });
    expect(table.providerSet("ps1")).toMatchObject({ version: 1, providerIds: ["groq"], features: ["chat"] });
  });

  it("marks every value that needs a decision before launch", () => {
    const source = readFileSync(new URL("./routing.ts", import.meta.url), "utf8");
    expect(source).toMatch(/placeholder/i);
    expect(source).toMatch(/verify/i);
    expect(table.providerSet("ps1")!.regions.join(" ")).toContain("PLACEHOLDER");
  });

  it("answers the provider set a client needs for a feature, only when a model serves it", () => {
    expect(table.setFor("chat")?.id).toBe("ps1");
    expect(table.setFor("transcription")).toBeUndefined();
    expect(table.setFor("ocr")).toBeUndefined();
  });

  it("derives the idempotency lease from the longest route", () => {
    expect(table.maxDurationMsFor("chat")).toBe(120_000);
    expect(table.maxDurationMsFor("ocr")).toBe(120_000); // no OCR model: the default
  });

  it("has integer prices", () => {
    expect(Number.isInteger(chat.price.inputPerMTok)).toBe(true);
    expect(Number.isInteger(chat.price.outputPerMTok)).toBe(true);
  });
});

describe("a bad routing table never serves traffic", () => {
  const bad: Array<[string, RoutingConfig, RegExp]> = [
    ["a plain http endpoint", withProviders([{ ...DEFAULT_ROUTING.providers[0]!, baseUrl: "http://api.groq.com/openai/v1" }]), /https/],
    ["credentials in the URL", withProviders([{ ...DEFAULT_ROUTING.providers[0]!, baseUrl: "https://user:pw@api.groq.com/v1" }]), /credentials/],
    ["a query string in the URL", withProviders([{ ...DEFAULT_ROUTING.providers[0]!, baseUrl: "https://api.groq.com/v1?key=1" }]), /query/],
    ["a trailing slash", withProviders([{ ...DEFAULT_ROUTING.providers[0]!, baseUrl: "https://api.groq.com/v1/" }]), /slash/],
    ["a URL that does not parse", withProviders([{ ...DEFAULT_ROUTING.providers[0]!, baseUrl: "not a url" }]), /baseUrl/],
    ["a duplicate provider", withProviders([DEFAULT_ROUTING.providers[0]!, DEFAULT_ROUTING.providers[0]!]), /duplicate provider/],
    ["a provider set naming an unknown provider", { ...DEFAULT_ROUTING, providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, providerIds: ["ghost"] }] }, /unknown provider/],
    ["a provider set without a provider", { ...DEFAULT_ROUTING, providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, providerIds: [] }] }, /no provider/],
    ["a provider set version 0", { ...DEFAULT_ROUTING, providerSets: [{ ...DEFAULT_ROUTING.providerSets[0]!, version: 0 }] }, /version/],
    ["a model in an unknown provider set", withModel({ providerSetId: "ps9" }), /unknown provider set/],
    ["a model routed outside its provider set", withModel({ targets: [{ providerId: "ghost", upstreamModel: "m" }] }), /outside its provider set/],
    ["a model without a target", withModel({ targets: [] }), /no target/],
    ["a model with a feature its provider set does not cover", { ...DEFAULT_ROUTING, models: [{ ...chat, feature: "transcription", maxAudioBytes: 1, maxAudioSeconds: 1, price: { perMinute: 1 } } as never] }, /does not cover/],
    ["a fractional price", withModel({ price: { inputPerMTok: 1.5, outputPerMTok: 2 } }), /price/],
    ["a zero price", withModel({ price: { inputPerMTok: 0, outputPerMTok: 2 } }), /price/],
    ["max output above the context window", withModel({ maxOutputTokens: 200_000 }), /context window/],
    ["a duplicate model", { ...DEFAULT_ROUTING, models: [chat, chat] }, /duplicate model/],
    ["an invalid model id", withModel({ id: "Has Spaces" }), /invalid model id/],
    ["a zero duration", withModel({ maxDurationMs: 0 }), /maxDurationMs/],
  ];
  for (const [name, config, message] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => buildRoutingTable(config)).toThrow(message);
    });
  }
});

describe("settings", () => {
  it("merges overrides over the defaults and keeps the rest", () => {
    const s = mergeSettings({ maxConcurrent: 5, rate: { content: { limit: 7 } } });
    expect(s.maxConcurrent).toBe(5);
    expect(s.rate.content).toEqual({ limit: 7, windowMs: DEFAULT_SETTINGS.rate.content.windowMs });
    expect(s.rate.read).toEqual(DEFAULT_SETTINGS.rate.read);
    expect(s.windowCredits).toBe(15000);
  });

  it("refuses nonsense", () => {
    expect(() => mergeSettings({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
    expect(() => mergeSettings({ windowCredits: 1.5 })).toThrow(/windowCredits/);
  });

  it("states placeholders as placeholders", () => {
    const source = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");
    expect(source).toMatch(/PLACEHOLDER/);
  });
});
