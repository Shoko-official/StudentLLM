// Credit arithmetic (docs/cloud-plan.md, "Quota design"). Pure functions, integers only.
//
// A credit is a cost-normalized unit: one credit is a fixed small amount of money at the routing-table price of the
// model. The cost of a request is ROUNDED UP to a whole credit per request. Prices are integers (credits per
// million tokens, per minute of audio, per MiB of image), so the cost is an exact integer ceiling with no floating
// point error: `ceil(numerator / denominator)` where the numerator is an exact integer.

export const TOKENS_PER_MILLION = 1_000_000;

/**
 * Server-side token estimate: one token per 3 UTF-8 bytes, rounded up. English and French text average 4 to 5
 * bytes per token, so this over-estimates on purpose: a reservation that is too large is released at settlement,
 * one that is too small would let the provider cost exceed what was reserved (the charge is capped at the
 * reservation). The estimate is never taken from a client-declared value.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 3;

/** Per-message framing tokens (role, separators) added to the estimate of a chat request. */
export const TOKENS_PER_MESSAGE_OVERHEAD = 4;
export const TOKENS_REPLY_PRIMING = 3;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function estimateTextTokens(text: string): number {
  return estimateTokensFromBytes(utf8Length(text));
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

/** Tokens an image may cost, from its DECODED size on the server: a floor plus a size term. */
export function estimateImageTokens(decodedBytes: number): number {
  return Math.max(512, Math.ceil(decodedBytes / 750));
}

function assertCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer`);
}

export interface TokenPrice {
  /** Credits per million input tokens. */
  inputPerMTok: number;
  /** Credits per million output tokens. */
  outputPerMTok: number;
}

/** `ceil((input x inputPrice + output x outputPrice) / 1e6)`: exact, rounded up once for the whole request. */
export function tokenCost(price: TokenPrice, inputTokens: number, outputTokens: number): number {
  assertCount(inputTokens, "input tokens");
  assertCount(outputTokens, "output tokens");
  const numerator = inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok;
  if (!Number.isSafeInteger(numerator)) throw new RangeError("token cost overflows");
  return Math.ceil(numerator / TOKENS_PER_MILLION);
}

/** Credits for audio: `ceil(ceil(seconds x 1000) x perMinute / 60000)`. */
export function audioCost(perMinute: number, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("seconds must be a non-negative number");
  const ms = Math.ceil(seconds * 1000);
  const numerator = ms * perMinute;
  if (!Number.isSafeInteger(numerator)) throw new RangeError("audio cost overflows");
  return Math.ceil(numerator / 60_000);
}

const MIB = 1024 * 1024;

/** Credits for an image: `ceil(bytes x perMiB / MiB)`. */
export function imageCost(perMiB: number, bytes: number): number {
  assertCount(bytes, "image bytes");
  const numerator = bytes * perMiB;
  if (!Number.isSafeInteger(numerator)) throw new RangeError("image cost overflows");
  return Math.ceil(numerator / MIB);
}

/** A reservation is at least one credit: the ledger refuses an empty one. */
export function atLeastOne(credits: number): number {
  return Math.max(1, credits);
}

/** What the provider reported, normalized. `outputTokens` already includes reasoning tokens. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalizes an OpenAI-style `usage` object. REASONING TOKENS COUNT AS OUTPUT: the output is the largest of the
 * reported completion tokens, `total - prompt` (which includes reasoning whatever the provider calls it) and
 * `completion_tokens_details.reasoning_tokens`. Returns null when the usage is missing, malformed (a negative or
 * fractional number counts as malformed) or reports no tokens at all, and the caller then settles at the full
 * reservation: a doubtful usage must never be free.
 */
export function parseUsage(raw: unknown): Usage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const prompt = count(u.prompt_tokens);
  const completion = u.completion_tokens === undefined ? null : count(u.completion_tokens);
  const total = u.total_tokens === undefined ? null : count(u.total_tokens);
  if (u.prompt_tokens === undefined || prompt === null) return null;
  if (u.completion_tokens !== undefined && completion === null) return null;
  if (u.total_tokens !== undefined && total === null) return null;
  if (completion === null && total === null) return null;

  let reasoning = 0;
  const details = u.completion_tokens_details;
  if (details !== undefined && details !== null) {
    if (typeof details !== "object" || Array.isArray(details)) return null;
    const r = (details as Record<string, unknown>).reasoning_tokens;
    if (r !== undefined) {
      const n = count(r);
      if (n === null) return null;
      reasoning = n;
    }
  }
  const output = Math.max(completion ?? 0, total === null ? 0 : Math.max(0, total - prompt), reasoning);
  if (prompt + output === 0) return null;
  return { inputTokens: prompt, outputTokens: output };
}

/** How a forwarded attempt ended, for settlement. */
export type Outcome =
  /** The provider reported usage: settle on it. */
  | { kind: "usage"; usage: Usage }
  /** A mid-stream provider failure after content was emitted: settle on the tokens counted on the gateway. */
  | { kind: "counted"; inputTokens: number; emittedOutputTokens: number }
  /** Everything else that is not a definitive failure: a timeout, an abort, a reset, a missing usage chunk. */
  | { kind: "unknown" };

/**
 * Credits to settle, never above the reservation (`max_tokens` is clamped before the reservation is made, so the
 * reservation is a true ceiling) and never below one for a forwarded attempt. An unknown outcome, and a counted
 * outcome with nothing counted, settle at the FULL reservation: a crash or a doubtful stream is never free usage.
 */
export function settlementCredits(reserved: number, price: TokenPrice, outcome: Outcome): number {
  assertCount(reserved, "reserved credits");
  switch (outcome.kind) {
    case "usage":
      return Math.min(reserved, atLeastOne(tokenCost(price, outcome.usage.inputTokens, outcome.usage.outputTokens)));
    case "counted":
      if (outcome.emittedOutputTokens <= 0) return reserved;
      return Math.min(reserved, atLeastOne(tokenCost(price, outcome.inputTokens, outcome.emittedOutputTokens)));
    case "unknown":
      return reserved;
  }
}

/** Audio: settle on the provider-reported duration, or the full reservation when none was reported. */
export function audioSettlementCredits(reserved: number, perMinute: number, reportedSeconds: number | null): number {
  if (reportedSeconds === null || !Number.isFinite(reportedSeconds) || reportedSeconds <= 0) return reserved;
  return Math.min(reserved, atLeastOne(audioCost(perMinute, reportedSeconds)));
}
