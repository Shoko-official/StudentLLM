// POST /v1/chat/completions (docs/cloud-api.md). The hooks already ran the header-only checks (client version,
// token, terms, plan, consent, rate limit, idempotency, concurrency slot); this handler reads the body, validates
// it against the allowlist, checks the kill switches, reserves the budget, forwards, and settles.

import { ApiError, jsonResponse } from "../../http/envelope";
import { requirePrincipal, type RequestContext } from "../../http/context";
import { Attempt, setCreditHeaders, type SettleSummary } from "./attempt";
import { assertAvailable } from "./availability";
import { atLeastOne, estimateTextTokens, parseUsage, settlementCredits, tokenCost, type Outcome, type Usage } from "./credits";
import { IdempotencyGuard } from "./guard";
import { assertConsentCoversModel } from "./hooks";
import { readTextLimited, UpstreamError, classifyFetchError, type ChatCall } from "./provider";
import type { ModelTarget } from "./routing";
import { streamChat } from "./stream";
import { validateChatRequest, type ValidatedChat } from "./validate-chat";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The gateway's own timer for one call: `maxDurationMs` of the model. */
function startTimer(maxDurationMs: number): { abort: AbortController; clear: () => void } {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("The upstream call timed out.", "TimeoutError")), maxDurationMs);
  return { abort, clear: () => clearTimeout(timer) };
}

/** A failure answer that also tells the client what was charged. */
function providerUnavailable(ctx: RequestContext, summary: SettleSummary): ApiError {
  setCreditHeaders(ctx, summary);
  ctx.responseHeaders.set("X-StudentLLM-Credits-Charged", String(summary.charged));
  return new ApiError("provider_unavailable", {
    message: "The provider is not available.",
    retryAfterSeconds: ctx.deps.inference.settings.retryAfter.providerSeconds,
  });
}

interface Completion {
  body: Record<string, unknown>;
  usage: Usage | null;
}

/**
 * Reads a non-streaming upstream answer and rebuilds it from an allowlist: the logical model id replaces the
 * upstream one and provider extension fields are dropped. A 2xx body that is an error carries no completion
 * (a definitive failure); a body that cannot be understood is an unknown outcome.
 */
async function readCompletion(ctx: RequestContext, upstream: Response, chat: ValidatedChat, requestId: string, signal: AbortSignal): Promise<Completion> {
  const text = await readTextLimited(upstream, ctx.deps.inference.settings.maxUpstreamBodyBytes, signal);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError("malformed");
  }
  if (!isObject(json)) throw new UpstreamError("malformed");
  if (json.error !== undefined && !Array.isArray(json.choices)) throw new UpstreamError("error_response");
  if (!Array.isArray(json.choices) || json.choices.length === 0) throw new UpstreamError("malformed");

  let outputText = "";
  const choices = json.choices.map((c: unknown, i: number) => {
    const choice = isObject(c) ? c : {};
    const message = isObject(choice.message) ? choice.message : {};
    const content = typeof message.content === "string" ? message.content : null;
    const out: Record<string, unknown> = { role: "assistant", content };
    if (typeof message.reasoning === "string") out.reasoning = message.reasoning;
    outputText += (content ?? "") + (typeof message.reasoning === "string" ? message.reasoning : "");
    return {
      index: typeof choice.index === "number" && Number.isSafeInteger(choice.index) ? choice.index : i,
      message: out,
      finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    };
  });

  const usage = parseUsage(json.usage);
  // The schema requires `usage`: when the provider reported none, say what the gateway estimated.
  const reported = usage ?? { inputTokens: chat.inputTokenEstimate, outputTokens: estimateTextTokens(outputText) };
  return {
    usage,
    body: {
      id: typeof json.id === "string" ? json.id : `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: typeof json.created === "number" && Number.isSafeInteger(json.created) ? json.created : Math.floor(ctx.deps.clock.now() / 1000),
      model: chat.route.id,
      choices,
      usage: {
        prompt_tokens: reported.inputTokens,
        completion_tokens: reported.outputTokens,
        total_tokens: reported.inputTokens + reported.outputTokens,
      },
    },
  };
}

async function forward(ctx: RequestContext, attempt: Attempt, chat: ValidatedChat, targets: ModelTarget[]): Promise<Response> {
  const { deps } = ctx;
  const accountId = requirePrincipal(ctx).accountId;
  const user = await deps.inference.pseudonym(accountId);

  // From here on an unknown outcome is charged in full: mark the forward BEFORE the first byte leaves.
  await attempt.markForwarded();
  const timer = startTimer(chat.route.maxDurationMs);
  let completion: Completion | undefined;

  for (const target of targets) {
    const provider = deps.inference.providers(target.providerId);
    if (!provider) continue; // nothing was sent: try the next provider of the set
    const call: ChatCall = {
      upstreamModel: target.upstreamModel,
      messages: chat.messages,
      stream: chat.stream,
      maxTokens: chat.maxTokens,
      user,
      signal: timer.abort.signal,
    };
    if (chat.temperature !== undefined) call.temperature = chat.temperature;
    if (chat.topP !== undefined) call.topP = chat.topP;
    if (chat.stop !== undefined) call.stop = chat.stop;
    if (chat.responseFormat !== undefined) call.responseFormat = chat.responseFormat;
    if (chat.reasoningEffort !== undefined) call.reasoningEffort = chat.reasoningEffort;

    try {
      const upstream = await provider.chat(call);
      if (chat.stream) {
        // The meter after the reservation; the usage event carries the settled one.
        setCreditHeaders(ctx, attempt.reservedMeter);
        return await streamChat({
          ctx,
          attempt,
          upstream,
          route: chat.route,
          inputTokenEstimate: chat.inputTokenEstimate,
          abort: timer.abort,
          clearTimer: timer.clear,
        });
      }
      completion = await readCompletion(ctx, upstream, chat, attempt.requestId, timer.abort.signal);
      break;
    } catch (error) {
      const failed = error instanceof UpstreamError ? error : classifyFetchError(error, timer.abort.signal);
      if (failed.definitive) {
        // An explicit error response or a connection failure before the request was accepted: nothing was
        // produced, so try the next provider of the SAME provider set.
        continue;
      }
      // Timeout, abort, reset after bytes were sent, missing or unreadable response: an UNKNOWN outcome.
      timer.clear();
      timer.abort.abort();
      throw providerUnavailable(ctx, await attempt.settle(attempt.reservedCredits));
    }
  }

  timer.clear();
  if (completion) {
    // A reported usage settles the request; a missing or doubtful one is the full reservation.
    const outcome: Outcome = completion.usage ? { kind: "usage", usage: completion.usage } : { kind: "unknown" };
    const summary = await attempt.settle(settlementCredits(attempt.reservedCredits, chat.route.price, outcome));
    setCreditHeaders(ctx, summary);
    return jsonResponse(completion.body, ctx.requestId, { headers: { "X-StudentLLM-Credits-Charged": String(summary.charged) } });
  }
  // Every provider of the set failed definitively: `failed_no_usage`, zero credits, the same key may retry.
  throw providerUnavailable(ctx, await attempt.releaseNoUsage());
}

export async function chatCompletions(ctx: RequestContext): Promise<Response> {
  const { deps } = ctx;
  const guard = new IdempotencyGuard(ctx);
  try {
    // Step 9: the body, with the size limit and the Content-Type check enforced while it streams in.
    const chat = validateChatRequest(await ctx.body.json(), deps.inference.routing);
    // The provider set of the ROUTED model must be the one the user consented to.
    assertConsentCoversModel(ctx, chat.route.providerSetId, "chat");
    const targets = await assertAvailable(deps, chat.route, deps.clock.now());

    // Step 10: the budget reservation: input tokens counted on the server plus the clamped maximum output.
    const credits = atLeastOne(tokenCost(chat.route.price, chat.inputTokenEstimate, chat.maxTokens));
    const attempt = await Attempt.open(ctx, { route: chat.route, credits });
    guard.attempt = attempt;
    return await forward(ctx, attempt, chat, targets);
  } catch (error) {
    await guard.fail();
    throw error;
  }
}
