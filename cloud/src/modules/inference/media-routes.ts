// POST /v1/audio/transcriptions and POST /v1/ocr. Same check order, headers and error behavior as chat; the body is
// multipart (size cap enforced while it streams in), the reservation is sized on the bytes received, and the
// provider is reached through the injected `UpstreamProvider` interface.
//
// OCR: the response schema of the contract is PROVISIONAL until the OCR provider is chosen. This handler returns
// `{ text, blocks }` exactly as the provisional schema says and makes no other assumption about the provider.

import { ApiError, jsonResponse } from "../../http/envelope";
import type { RequestContext } from "../../http/context";
import { Attempt, setCreditHeaders, type SettleSummary } from "./attempt";
import { assertAvailable, recordUnknownOutcome } from "./availability";
import { audioSettlementCredits } from "./credits";
import { IdempotencyGuard } from "./guard";
import { assertConsentCoversModel, assertConsentStillActive } from "./hooks";
import { classifyFetchError, UpstreamError, type UpstreamProvider } from "./provider";
import { validateOcr, validateTranscription } from "./media";
import type { ModelRoute, ModelTarget } from "./routing";

function providerUnavailable(ctx: RequestContext, summary: SettleSummary): ApiError {
  setCreditHeaders(ctx, summary);
  ctx.responseHeaders.set("X-StudentLLM-Credits-Charged", String(summary.charged));
  return new ApiError("provider_unavailable", {
    message: "The provider is not available.",
    retryAfterSeconds: ctx.deps.inference.settings.retryAfter.providerSeconds,
  });
}

/**
 * Forwards a non-streaming media call through the ordered targets of the model. A definitive failure moves on to
 * the next provider of the same provider set; when every one failed definitively the reservation is released
 * (`failed_no_usage`). An unknown outcome (timeout, abort, reset, unreadable answer) settles at the full
 * reservation. `call` returns undefined when the provider cannot perform the operation (it is skipped).
 */
async function forwardMedia<T>(
  ctx: RequestContext,
  attempt: Attempt,
  route: ModelRoute,
  targets: ModelTarget[],
  call: (provider: UpstreamProvider, target: ModelTarget, signal: AbortSignal) => Promise<T> | undefined,
): Promise<T> {
  // From here on an unknown outcome is charged in full: mark the forward BEFORE the first byte leaves.
  await attempt.markForwarded();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("The upstream call timed out.", "TimeoutError")), route.maxDurationMs);
  try {
    for (const target of targets) {
      const provider = ctx.deps.inference.providers(target.providerId);
      if (!provider) continue;
      try {
        const pending = call(provider, target, abort.signal);
        if (pending === undefined) continue;
        return await pending;
      } catch (error) {
        const failed = error instanceof UpstreamError ? error : classifyFetchError(error, abort.signal);
        if (failed.definitive) continue;
        await recordUnknownOutcome(ctx.deps, failed.kind, ctx.deps.clock.now());
        abort.abort();
        throw providerUnavailable(ctx, await attempt.settle(attempt.reservedCredits));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  throw providerUnavailable(ctx, await attempt.releaseNoUsage());
}

export async function transcribeAudio(ctx: RequestContext): Promise<Response> {
  const { deps } = ctx;
  const guard = new IdempotencyGuard(ctx);
  try {
    const input = await validateTranscription(await ctx.body.formData(), deps.inference.routing);
    assertConsentCoversModel(ctx, input.route.providerSetId, "transcription");
    const targets = await assertAvailable(deps, input.route, deps.clock.now(), input.reservedCredits);
    await assertConsentStillActive(ctx, input.route.providerSetId, "transcription");
    const attempt = await Attempt.open(ctx, { route: input.route, credits: input.reservedCredits });
    guard.attempt = attempt;

    const result = await forwardMedia(ctx, attempt, input.route, targets, (provider, target, signal) =>
      provider.transcribe?.({
        upstreamModel: target.upstreamModel,
        file: { bytes: input.bytes, mime: input.mime, extension: input.extension },
        ...(input.language !== undefined ? { language: input.language } : {}),
        signal,
      }),
    );
    // Settled on the duration the PROVIDER reports; the full reservation when it reports none.
    const credits = audioSettlementCredits(attempt.reservedCredits, input.route.price.perMinute, result.durationSeconds);
    const summary = await attempt.settle(credits);
    setCreditHeaders(ctx, summary);
    return jsonResponse(
      {
        text: result.text,
        language: result.language ?? input.language ?? "und",
        duration_seconds: result.durationSeconds ?? input.fallbackSeconds,
        segments: result.segments,
      },
      ctx.requestId,
      { headers: { "X-StudentLLM-Credits-Charged": String(summary.charged) } },
    );
  } catch (error) {
    await guard.fail();
    throw error;
  }
}

export async function ocrImage(ctx: RequestContext): Promise<Response> {
  const { deps } = ctx;
  const guard = new IdempotencyGuard(ctx);
  try {
    const input = await validateOcr(await ctx.body.formData(), deps.inference.routing);
    assertConsentCoversModel(ctx, input.route.providerSetId, "ocr");
    const targets = await assertAvailable(deps, input.route, deps.clock.now(), input.reservedCredits);
    await assertConsentStillActive(ctx, input.route.providerSetId, "ocr");
    const attempt = await Attempt.open(ctx, { route: input.route, credits: input.reservedCredits });
    guard.attempt = attempt;

    const result = await forwardMedia(ctx, attempt, input.route, targets, (provider, target, signal) =>
      provider.ocr?.({
        upstreamModel: target.upstreamModel,
        file: { bytes: input.bytes, mime: input.mime },
        ...(input.language !== undefined ? { language: input.language } : {}),
        signal,
      }),
    );
    // The price is flat per MiB received, so a successful call settles at the reservation.
    const summary = await attempt.settle(attempt.reservedCredits);
    setCreditHeaders(ctx, summary);
    return jsonResponse({ text: result.text, blocks: result.blocks }, ctx.requestId, {
      headers: { "X-StudentLLM-Credits-Charged": String(summary.charged) },
    });
  } catch (error) {
    await guard.fail();
    throw error;
  }
}
