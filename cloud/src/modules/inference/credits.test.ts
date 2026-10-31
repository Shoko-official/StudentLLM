// Property-style tests of the settlement arithmetic: rounding, the full-reservation fallback and reasoning tokens.
// Every case set is generated from a fixed seed, so a failure is reproducible.

import { describe, expect, it } from "vitest";
import {
  atLeastOne,
  audioCost,
  audioSettlementCredits,
  countTokensFromBytes,
  estimateImageTokens,
  estimateTextTokens,
  imageCost,
  parseUsage,
  settlementCredits,
  tokenCost,
  type TokenPrice,
} from "./credits";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = 3000;
const int = (next: () => number, max: number) => Math.floor(next() * (max + 1));
const bigCeil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;

function randomPrice(next: () => number): TokenPrice {
  return { inputPerMTok: 1 + int(next, 20_000), outputPerMTok: 1 + int(next, 80_000) };
}

describe("tokenCost: rounded up once per request, exactly", () => {
  it("equals the exact integer ceiling of (in x inPrice + out x outPrice) / 1e6", () => {
    const next = rng(1);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const input = int(next, 2_000_000);
      const output = int(next, 400_000);
      const exact = bigCeil(BigInt(input) * BigInt(price.inputPerMTok) + BigInt(output) * BigInt(price.outputPerMTok), 1_000_000n);
      expect(BigInt(tokenCost(price, input, output)), JSON.stringify({ price, input, output })).toBe(exact);
    }
  });

  it("is zero for no tokens and at least one for any token", () => {
    const next = rng(2);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      expect(tokenCost(price, 0, 0)).toBe(0);
      expect(tokenCost(price, 1 + int(next, 5), 0)).toBeGreaterThanOrEqual(1);
      expect(tokenCost(price, 0, 1 + int(next, 5))).toBeGreaterThanOrEqual(1);
    }
  });

  it("never decreases when tokens are added", () => {
    const next = rng(3);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const input = int(next, 100_000);
      const output = int(next, 100_000);
      expect(tokenCost(price, input + 1 + int(next, 50), output)).toBeGreaterThanOrEqual(tokenCost(price, input, output));
      expect(tokenCost(price, input, output + 1 + int(next, 50))).toBeGreaterThanOrEqual(tokenCost(price, input, output));
    }
  });

  it("rounds once per request: splitting a request never makes it cheaper and costs at most one credit more", () => {
    const next = rng(4);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const [a, b, c, d] = [int(next, 50_000), int(next, 50_000), int(next, 50_000), int(next, 50_000)];
      const whole = tokenCost(price, a + c, b + d);
      const parts = tokenCost(price, a, b) + tokenCost(price, c, d);
      expect(whole).toBeLessThanOrEqual(parts); // splitting a request can only cost more (each part rounds up)
      expect(parts).toBeLessThanOrEqual(whole + 1);
    }
  });

  it("is exact at the boundaries", () => {
    const price = { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 }; // one credit per token
    expect(tokenCost(price, 1, 0)).toBe(1);
    expect(tokenCost({ inputPerMTok: 1, outputPerMTok: 1 }, 1_000_000, 0)).toBe(1);
    expect(tokenCost({ inputPerMTok: 1, outputPerMTok: 1 }, 1_000_001, 0)).toBe(2);
    expect(tokenCost({ inputPerMTok: 1620, outputPerMTok: 6480 }, 900, 120)).toBe(3);
  });

  it("refuses fractional, negative and overflowing counts", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 1 };
    expect(() => tokenCost(price, 1.5, 0)).toThrow(RangeError);
    expect(() => tokenCost(price, -1, 0)).toThrow(RangeError);
    expect(() => tokenCost(price, Number.MAX_SAFE_INTEGER, 0)).not.toThrow();
    expect(() => tokenCost({ inputPerMTok: 1e9, outputPerMTok: 1 }, Number.MAX_SAFE_INTEGER, 0)).toThrow(RangeError);
  });
});

describe("settlementCredits: capped by the reservation, never free for a forwarded attempt", () => {
  it("settles a reported usage between one credit and the reservation", () => {
    const next = rng(5);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const reserved = 1 + int(next, 5000);
      const usage = { inputTokens: int(next, 3_000_000), outputTokens: int(next, 800_000) };
      const credits = settlementCredits(reserved, price, { kind: "usage", usage });
      expect(credits).toBeGreaterThanOrEqual(1);
      expect(credits).toBeLessThanOrEqual(reserved);
      const cost = tokenCost(price, usage.inputTokens, usage.outputTokens);
      expect(credits).toBe(Math.min(reserved, Math.max(1, cost)));
    }
  });

  it("settles an unknown outcome at the FULL reservation, whatever it is", () => {
    const next = rng(6);
    for (let i = 0; i < CASES; i++) {
      const reserved = 1 + int(next, 100_000);
      expect(settlementCredits(reserved, randomPrice(next), { kind: "unknown" })).toBe(reserved);
    }
  });

  it("settles counted tokens when something was emitted and the full reservation when nothing was", () => {
    const next = rng(7);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const reserved = 1 + int(next, 5000);
      const inputTokens = int(next, 100_000);
      expect(settlementCredits(reserved, price, { kind: "counted", inputTokens, emittedOutputTokens: 0 })).toBe(reserved);
      const emitted = 1 + int(next, 100_000);
      const credits = settlementCredits(reserved, price, { kind: "counted", inputTokens, emittedOutputTokens: emitted });
      expect(credits).toBeGreaterThanOrEqual(1);
      expect(credits).toBeLessThanOrEqual(reserved);
    }
  });

  it("a request that stays inside its reservation inputs costs no more than the reservation", () => {
    // The reservation is made for the estimated input and the clamped maximum output: any usage below both is covered.
    const next = rng(8);
    for (let i = 0; i < CASES; i++) {
      const price = randomPrice(next);
      const estimate = 1 + int(next, 50_000);
      const maxOut = 1 + int(next, 4096);
      const reserved = Math.max(1, tokenCost(price, estimate, maxOut));
      const usage = { inputTokens: int(next, estimate), outputTokens: int(next, maxOut) };
      if (usage.inputTokens + usage.outputTokens === 0) continue;
      const cost = Math.max(1, tokenCost(price, usage.inputTokens, usage.outputTokens));
      expect(cost).toBeLessThanOrEqual(reserved);
      expect(settlementCredits(reserved, price, { kind: "usage", usage })).toBe(cost);
    }
  });

  it("charges for reasoning tokens as output", () => {
    const price = { inputPerMTok: 1000, outputPerMTok: 10_000 };
    const usage = parseUsage({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, completion_tokens_details: { reasoning_tokens: 90_000 } })!;
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 90_000 });
    expect(settlementCredits(10_000, price, { kind: "usage", usage })).toBe(901); // ceil((1000 x 1000 + 90000 x 10000) / 1e6)
  });
});

describe("parseUsage", () => {
  it("reads the usual shapes", () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(parseUsage({ prompt_tokens: 10, total_tokens: 40 })).toEqual({ inputTokens: 10, outputTokens: 30 });
  });

  it("takes the largest of completion, total minus prompt and reasoning tokens as the output", () => {
    const next = rng(9);
    for (let i = 0; i < CASES; i++) {
      const prompt = int(next, 5000);
      const completion = int(next, 5000);
      const reasoning = int(next, 9000);
      const extra = int(next, 3000);
      const usage = parseUsage({
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion + extra,
        completion_tokens_details: { reasoning_tokens: reasoning },
      });
      if (prompt + Math.max(completion, completion + extra, reasoning) === 0) {
        expect(usage).toBeNull();
        continue;
      }
      expect(usage!.inputTokens).toBe(prompt);
      expect(usage!.outputTokens).toBe(Math.max(completion, completion + extra, reasoning));
      expect(usage!.outputTokens).toBeGreaterThanOrEqual(reasoning); // reasoning is never dropped
    }
  });

  it("rejects usage that cannot be trusted, so the caller settles in full", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "usage",
      [],
      {},
      { prompt_tokens: 10 },
      { completion_tokens: 10 },
      { prompt_tokens: -1, completion_tokens: 5 },
      { prompt_tokens: 1.5, completion_tokens: 5 },
      { prompt_tokens: "10", completion_tokens: 5 },
      { prompt_tokens: 10, completion_tokens: Number.NaN },
      { prompt_tokens: 10, completion_tokens: Infinity },
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: -3 },
      { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: -1 } },
      { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: [] },
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ];
    for (const raw of bad) expect(parseUsage(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe("estimates and the other prices", () => {
  it("bounds the input from above: a token per UTF-8 byte, whatever the text", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(4);
    expect(estimateTextTokens("\u00e9")).toBe(2); // 2 bytes
    expect(estimateTextTokens("\u65e5\u672c\u8a9e")).toBe(9); // 3 bytes each
    expect(estimateTextTokens("\u{1f600}")).toBe(4);
    const next = rng(10);
    for (let i = 0; i < 500; i++) {
      const text = "x".repeat(int(next, 3000));
      expect(estimateTextTokens(text)).toBe(text.length);
    }
  });

  it("counts what was seen on the gateway at two bytes a token, rounded once over the whole text", () => {
    expect(countTokensFromBytes(0)).toBe(0);
    expect(countTokensFromBytes(1)).toBe(1);
    expect(countTokensFromBytes(1000)).toBe(500);
    // 1000 deltas of one byte are 500 tokens, not 1000: rounding per delta would bill a token for every delta.
    expect(countTokensFromBytes(1000)).toBeLessThan(1000 * countTokensFromBytes(1));
  });

  it("estimates an image from its decoded size with a floor", () => {
    expect(estimateImageTokens(10)).toBe(512);
    expect(estimateImageTokens(750 * 2000)).toBe(2000);
  });

  it("rounds audio and image prices up exactly", () => {
    const next = rng(11);
    for (let i = 0; i < CASES; i++) {
      const perMinute = 1 + int(next, 500);
      const seconds = int(next, 3_600_000) / 1000;
      const ms = Math.ceil(seconds * 1000);
      expect(BigInt(audioCost(perMinute, seconds))).toBe(bigCeil(BigInt(ms) * BigInt(perMinute), 60_000n));
      const perMiB = 1 + int(next, 500);
      const bytes = int(next, 40 * 1024 * 1024);
      expect(BigInt(imageCost(perMiB, bytes))).toBe(bigCeil(BigInt(bytes) * BigInt(perMiB), 1_048_576n));
    }
    expect(audioCost(6, 59.4)).toBe(6);
    expect(audioCost(6, 60)).toBe(6);
    expect(audioCost(6, 60.001)).toBe(7);
    expect(() => audioCost(6, -1)).toThrow(RangeError);
    expect(atLeastOne(0)).toBe(1);
  });

  it("settles audio on the reported duration, capped, and in full when none is reported", () => {
    expect(audioSettlementCredits(12, 6, 10)).toBe(1);
    expect(audioSettlementCredits(12, 6, 600)).toBe(12);
    for (const missing of [null, 0, -3, Number.NaN, Infinity]) expect(audioSettlementCredits(12, 6, missing)).toBe(12);
  });
});
