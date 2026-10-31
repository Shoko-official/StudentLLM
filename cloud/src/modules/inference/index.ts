// Inference module: models, usage, chat, transcription, OCR; quota, idempotency, reservation, settlement.
// OWNER: inference/quota. Also provide `checkConsent`, `checkRateLimit`, `lookupIdempotency` and
// `acquireConcurrencySlot` from `createInferenceHooks`. The budget reservation (step 10) happens in the
// handler after `ctx.body` validated the request.
//
// TODO(owner: inference): a concurrency slot registered with `ctx.defer` is released when the handler
// returns; for streamed responses release it when the stream ends instead.

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import { notImplemented } from "../../http/stub";

export interface InferenceDeps {}

export function createInferenceDeps(_core: CoreDeps): InferenceDeps {
  return {};
}

export function createInferenceHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

export function registerInferenceRoutes(router: Router, _deps: Deps): void {
  router.add("GET", "/v1/models", notImplemented, routeMeta({ operationId: "listModels" }));
  router.add("GET", "/v1/usage", notImplemented, routeMeta({ operationId: "getUsage" }));
  router.add(
    "POST",
    "/v1/chat/completions",
    notImplemented,
    routeMeta({ operationId: "chatCompletions", client: true, content: true, body: { kind: "json", limit: "chat" } }),
  );
  router.add(
    "POST",
    "/v1/audio/transcriptions",
    notImplemented,
    routeMeta({ operationId: "transcribeAudio", client: true, content: true, body: { kind: "multipart", limit: "audio" } }),
  );
  router.add(
    "POST",
    "/v1/ocr",
    notImplemented,
    routeMeta({ operationId: "ocrImage", client: true, content: true, body: { kind: "multipart", limit: "image" } }),
  );
}
