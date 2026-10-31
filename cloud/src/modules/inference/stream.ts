// Streaming passthrough of POST /v1/chat/completions with `stream: true` (docs/cloud-api.md, "Streaming").
//
// The response is `text/event-stream`: unnamed OpenAI-format `data:` chunks, then ONE named `event: usage`, then
// `data: [DONE]`. A failure after the first byte cannot change the HTTP status, so the gateway sends one
// `event: error` whose data is the standard envelope and closes the stream WITHOUT `[DONE]`. Failures before the
// first byte are thrown as `UpstreamError` and use the normal HTTP status and envelope (the caller maps them).
//
// Settlement:
// - usage reported by the provider: settle on it (reasoning tokens count as output);
// - the stream ended cleanly but no usage chunk came: the FULL reservation;
// - the provider failed mid-stream with an explicit error or malformed events: the tokens actually emitted, counted
//   on the gateway, falling back to the full reservation when none were emitted;
// - a timeout, a reset, a truncated stream or a client abort: an unknown outcome, the FULL reservation.
// No content is stored or logged: chunks pass through memory only.

import type { RequestContext } from "../../http/context";
import { sseErrorEvent } from "../../http/envelope";
import { formatTime, type Attempt } from "./attempt";
import { countTokensFromBytes, isImplausibleUsage, parseUsage, settlementCredits, utf8Length, type Outcome, type Usage } from "./credits";
import { recordUnknownOutcome } from "./availability";
import { classifyFetchError, UpstreamError } from "./provider";
import type { ChatRoute } from "./routing";
import { SseFormatError, SseParser, type SseEvent } from "./sse";

export interface ChatStreamArgs {
  ctx: RequestContext;
  attempt: Attempt;
  upstream: Response;
  route: ChatRoute;
  /** The tight count of the input (see `ValidatedChat.inputTokenCount`), used only when the stream fails in the middle. */
  inputTokenCount: number;
  abort: AbortController;
  clearTimer: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface SanitizedChunk {
  chunk: Record<string, unknown> | null;
  /**
   * UTF-8 bytes of the text this chunk carries. Bytes, not tokens: the caller adds them up over the whole stream and
   * converts once, so a stream of tiny deltas is not billed a whole token per delta.
   */
  bytes: number;
}

/**
 * Rebuilds a provider chunk from an allowlist: the logical model id replaces the upstream one, and nothing the
 * gateway did not ask for (provider extension fields, a usage object, system fingerprints) reaches the client. The
 * delta keeps `role`, `content` and `reasoning`.
 */
export function sanitizeChunk(json: Record<string, unknown>, modelId: string, fallbackId: string, fallbackCreated: number): SanitizedChunk {
  const choices: Array<Record<string, unknown>> = [];
  let bytes = 0;
  if (Array.isArray(json.choices)) {
    json.choices.forEach((c: unknown, i: number) => {
      if (!isObject(c)) return;
      const delta: Record<string, unknown> = {};
      if (isObject(c.delta)) {
        if (c.delta.role === "assistant") delta.role = "assistant";
        if (typeof c.delta.content === "string") {
          delta.content = c.delta.content;
          bytes += utf8Length(c.delta.content);
        }
        if (typeof c.delta.reasoning === "string") {
          delta.reasoning = c.delta.reasoning;
          bytes += utf8Length(c.delta.reasoning);
        }
      }
      choices.push({
        index: typeof c.index === "number" && Number.isSafeInteger(c.index) ? c.index : i,
        delta,
        finish_reason: typeof c.finish_reason === "string" ? c.finish_reason : null,
      });
    });
  }
  if (choices.length === 0) return { chunk: null, bytes: 0 };
  return {
    chunk: {
      id: typeof json.id === "string" ? json.id : fallbackId,
      object: "chat.completion.chunk",
      created: typeof json.created === "number" && Number.isSafeInteger(json.created) ? json.created : fallbackCreated,
      model: modelId,
      choices,
    },
    bytes,
  };
}

/**
 * explicit: the provider reported an error or sent malformed data (settled on counted tokens);
 * unknown: a timeout, a reset, a truncated stream, a usage no honest provider reports (settled in full).
 */
type Failure = "explicit" | "unknown";

const encoder = new TextEncoder();

/** Rejects when the signal aborts, so a read on a non-cooperating body cannot outlive the gateway's timer. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class ChatStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly parser: SseParser;
  private readonly queue: string[] = [];
  private readonly fallbackId: string;
  private readonly fallbackCreated: number;
  private committed = false;
  private terminated = false;
  private cancelled = false;
  private sawDone = false;
  private failure: Failure | null = null;
  private usage: Usage | null = null;
  private usageSeen = false;
  private emittedBytes = 0;
  private lastBeat: number;

  constructor(private readonly a: ChatStreamArgs) {
    if (!a.upstream.body) throw new UpstreamError("malformed");
    this.reader = a.upstream.body.getReader();
    this.parser = new SseParser(a.ctx.deps.inference.settings.maxSseEventBytes);
    this.fallbackId = `chatcmpl-${a.attempt.requestId}`;
    this.fallbackCreated = Math.floor(a.ctx.deps.clock.now() / 1000);
    this.lastBeat = a.ctx.deps.clock.now();
  }

  /** Reads until the first byte can be sent. Throws `UpstreamError` for a failure before it. */
  static async start(args: ChatStreamArgs): Promise<Response> {
    const stream = new ChatStream(args);
    try {
      while (stream.queue.length === 0 && !stream.terminated) await stream.step();
    } catch (error) {
      // Drop this upstream connection. The caller owns the gateway's timer and decides what happens next: the next
      // provider of the set (the timer keeps running for the whole request) or the end of the attempt.
      void stream.reader.cancel().catch(() => undefined);
      throw error instanceof UpstreamError ? error : classifyFetchError(error, args.abort.signal);
    }
    stream.committed = true;
    return stream.response();
  }

  private response(): Response {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => this.pull(controller),
      cancel: () => this.cancel(),
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }

  private async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      while (this.queue.length === 0 && !this.terminated) await this.step();
    } catch {
      // Anything unexpected (a store failure, a bug) must not leave the reservation open and the stream hanging:
      // settle at the full reservation (an unknown outcome) and tell the client.
      if (!this.terminated) await this.finish(null);
    }
    if (this.cancelled) return; // the client left while this pull was waiting; the cancel path settled
    while (this.queue.length > 0) controller.enqueue(encoder.encode(this.queue.shift()!));
    if (this.terminated) controller.close();
  }

  /** The client went away: an abort after the first token is an unknown outcome, settled at the full reservation. */
  private async cancel(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.cancelled = true;
    const { ctx, attempt } = this.a;
    this.a.abort.abort();
    this.a.clearTimer();
    void this.reader.cancel().catch(() => undefined);
    // The Worker may be torn down as soon as the client is gone: keep it alive until the settlement is written.
    const settling = attempt.open ? attempt.settle(attempt.reservedCredits).then(() => undefined) : Promise.resolve();
    ctx.waitUntil(settling);
    await settling.catch(() => undefined);
  }

  /** Reads one upstream chunk, handles its events and decides whether the stream is over. */
  private async step(): Promise<void> {
    const { signal } = this.a.abort;
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await raceAbort(this.reader.read(), signal);
    } catch (error) {
      if (this.terminated) return; // cancelled by the client: the cancel path settles
      return this.fail("unknown", error);
    }
    if (this.terminated) return;
    try {
      const events = result.done ? this.parser.end() : this.parser.push(result.value);
      for (const e of events) {
        this.handle(e);
        if (this.failure) break;
      }
    } catch (error) {
      // An event that grew too large, or JSON that could not be parsed: the provider sent malformed data.
      if (error instanceof SseFormatError) this.failure = "explicit";
      else throw error;
    }
    if (this.failure) return this.fail(this.failure);
    if (this.sawDone || (result.done && this.usageSeen)) return this.finishSuccess();
    if (result.done) return this.fail("unknown"); // EOF with neither [DONE] nor an error: a network failure
    await this.beat();
  }

  private handle(event: SseEvent): void {
    if (event.event === "error") {
      this.failure = "explicit";
      return;
    }
    if (event.data.trim() === "[DONE]") {
      this.sawDone = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      this.failure = "explicit"; // malformed event data
      return;
    }
    if (!isObject(json)) {
      this.failure = "explicit";
      return;
    }
    if (json.error !== undefined) {
      this.failure = "explicit";
      return;
    }
    if (json.usage !== undefined && json.usage !== null) {
      const bound = this.a.route.contextWindow;
      // A count no honest provider reports (above the model's context window, or not even finite) is not a missing
      // usage but a provider that cannot be trusted: a failure, settled in full.
      if (isImplausibleUsage(json.usage, bound)) {
        this.failure = "unknown";
        return;
      }
      this.usageSeen = true;
      this.usage = parseUsage(json.usage, bound);
    }
    const { chunk, bytes } = sanitizeChunk(json, this.a.route.id, this.fallbackId, this.fallbackCreated);
    if (chunk) {
      this.emittedBytes += bytes;
      this.queue.push(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }

  /** The heartbeat: a stream that makes progress keeps its reservation and its concurrency lease alive. */
  private async beat(): Promise<void> {
    const { ctx, attempt } = this.a;
    const now = ctx.deps.clock.now();
    if (now - this.lastBeat < ctx.deps.inference.settings.heartbeatMs) return;
    this.lastBeat = now;
    await attempt.heartbeat();
    const lease = ctx.locals.lease;
    const idem = ctx.locals.idem;
    if (lease && idem) await ctx.deps.stores.concurrency.renew(lease, idem.leaseMs, now);
  }

  private end(): void {
    this.terminated = true;
    this.a.clearTimer();
    this.a.abort.abort();
    void this.reader.cancel().catch(() => undefined);
  }

  private usageEvent(summary: { charged: number; remaining: number; resetsAt: number }): string {
    const payload = { credits_charged: summary.charged, credits_remaining: summary.remaining, resets_at: formatTime(summary.resetsAt) };
    return `event: usage\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  private finishSuccess(): Promise<void> {
    return this.finish("success");
  }

  private fail(mode: Failure, error?: unknown): Promise<void> {
    if (!this.committed && this.queue.length === 0) {
      // Before the first byte: the caller answers with the normal HTTP status and envelope. (When content was
      // already produced the provider has worked, so the failure is reported mid-stream and settled on tokens.)
      return Promise.reject(mode === "explicit" ? new UpstreamError("error_response") : classifyFetchError(error, this.a.abort.signal));
    }
    if (mode === "unknown") void recordUnknownOutcome(this.a.ctx.deps, classifyFetchError(error, this.a.abort.signal).kind, this.a.ctx.deps.clock.now());
    return this.finish(mode);
  }

  /**
   * The one way a stream ends after its first byte, whatever happened. `end()` always runs first, so the connection,
   * the timer and the stream state are released even if the settlement below throws. The credits are computed inside
   * the `try`: if that fails (an overflow, a bug) the attempt is settled at the FULL reservation and the client gets
   * `event: error`, never a silent hang or a reservation left open.
   * `how`: "success" (usage event and [DONE]), a failure mode, or null for an unexpected exception (full, error event).
   */
  private async finish(how: "success" | Failure | null): Promise<void> {
    const { ctx, attempt, route } = this.a;
    this.end();
    let credits = attempt.reservedCredits;
    let ok = how === "success";
    try {
      const outcome: Outcome =
        how === "success"
          ? this.usage
            ? { kind: "usage", usage: this.usage }
            : { kind: "unknown" } // no usage chunk (or a doubtful one): the full reservation
          : how === "explicit"
            ? { kind: "counted", inputTokens: this.a.inputTokenCount, emittedOutputTokens: countTokensFromBytes(this.emittedBytes) }
            : { kind: "unknown" };
      credits = settlementCredits(attempt.reservedCredits, route.price, outcome);
    } catch {
      credits = attempt.reservedCredits;
      ok = false;
    }
    try {
      const summary = await attempt.settle(credits);
      if (ok) {
        this.queue.push(this.usageEvent(summary), "data: [DONE]\n\n");
      } else {
        this.queue.push(
          sseErrorEvent("provider_unavailable", ctx.requestId, {
            message: "The provider stopped responding.",
            retryAfterSeconds: ctx.deps.inference.settings.retryAfter.providerSeconds,
          }),
        );
      }
    } catch {
      this.queue.push(sseErrorEvent("internal_error", ctx.requestId));
    }
  }
}

export function streamChat(args: ChatStreamArgs): Promise<Response> {
  return ChatStream.start(args);
}
