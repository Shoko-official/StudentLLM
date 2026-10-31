// Credit arithmetic (docs/cloud-plan.md, "Quota design"). Pure functions, integers only.
//
// A credit is a cost-normalized unit: one credit is a fixed small amount of money at the routing-table price of the
// model. The cost of a request is ROUNDED UP to a whole credit per request. Prices are integers (credits per
// million tokens, per minute of audio, per MiB of image), so the cost is an exact integer ceiling with no floating
// point error: `ceil(numerator / denominator)` where the numerator is an exact integer.

export const TOKENS_PER_MILLION = 1_000_000;

/**
 * The reservation's input estimate is a HARD UPPER BOUND: one token per UTF-8 byte. No tokenizer produces more
 * tokens than bytes, so whatever the input is (spaced single characters, rare Unicode, anything hostile), the
 * provider's cost cannot exceed what was reserved. A reservation that is too large is only released at settlement,
 * one that is too small would let the provider cost exceed it (the charge is capped at the reservation, so the
 * gateway would absorb the difference). The estimate is never taken from a client-declared value.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 1;

/**
 * Where the gateway must COUNT tokens (it cannot ask the provider: a stream that failed in the middle), it uses a
 * tighter ratio than the reservation bound, so a failure does not bill the full hard bound: two bytes per token,
 * rounded up once over the whole text (never per piece, which would bill every small delta a whole token).
 */
export const COUNTED_BYTES_PER_TOKEN = 2;

/** No realistic tokenizer exceeds this many bytes per token: an input longer than this times the window cannot fit. */
export const MAX_PLAUSIBLE_BYTES_PER_TOKEN = 8;

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

/** Tokens counted on the gateway for text it has seen (see `COUNTED_BYTES_PER_TOKEN`). */
export function countTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / COUNTED_BYTES_PER_TOKEN);
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

/** Largest token count accepted from a provider when the caller gives no bound (tests, other callers). */
export const DEFAULT_USAGE_BOUND = 10_000_000;

function count(value: unknown, bound: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= bound ? value : null;
}

/**
 * True when a usage object carries a number no honest provider reports: not finite (a JSON `1e999` parses to
 * Infinity) or above `bound` (the model's context window). That is not a missing usage but a provider that cannot be
 * trusted: the caller treats the answer as a provider failure and settles in full.
 */
export function isImplausibleUsage(raw: unknown, bound: number): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const u = raw as Record<string, unknown>;
  const values = [u.prompt_tokens, u.completion_tokens, u.total_tokens];
  const details = u.completion_tokens_details;
  if (details !== null && typeof details === "object" && !Array.isArray(details)) values.push((details as Record<string, unknown>).reasoning_tokens);
  return values.some((v) => typeof v === "number" && (!Number.isFinite(v) || v > bound));
}

/**
 * Normalizes an OpenAI-style `usage` object. REASONING TOKENS COUNT AS OUTPUT: the output is the largest of the
 * reported completion tokens, `total - prompt` (which includes reasoning whatever the provider calls it) and
 * `completion_tokens_details.reasoning_tokens`. Returns null when the usage is missing, malformed (a negative or
 * fractional number counts as malformed) or reports no tokens at all, and the caller then settles at the full
 * reservation: a doubtful usage must never be free.
 */
export function parseUsage(raw: unknown, bound: number = DEFAULT_USAGE_BOUND): Usage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const prompt = count(u.prompt_tokens, bound);
  const completion = u.completion_tokens === undefined ? null : count(u.completion_tokens, bound);
  const total = u.total_tokens === undefined ? null : count(u.total_tokens, bound);
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
      const n = count(r, bound);
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
