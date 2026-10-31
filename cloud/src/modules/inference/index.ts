// Inference module: models, usage, chat, transcription, OCR; quota, idempotency, reservation, settlement.
// OWNER: inference/quota. Also provide `checkConsent`, `checkRateLimit` (per account), `lookupIdempotency` and
// `acquireConcurrencySlot` from `createInferenceHooks`. The budget reservation (step 10) happens in the
// handler after `ctx.body` validated the request.
//
// Release the concurrency slot with `ctx.deferUntilBodyDone(...)` so a streamed completion keeps it until the
// stream ends or the client cancels. `ctx.consentId` and `ctx.idempotencyKey` are already validated by the
// built-in header steps. Hook state shared with handlers goes in `ctx.locals` (declaration merging, see
// RequestLocals). Credit and rate-limit headers go in `ctx.responseHeaders`.
// TODO(owner: inference): a `ScheduledTask` that sweeps due accounts (`stores.sweeps.due` + `ledger.sweep`).

import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { notImplemented } from "../../http/stub";

export interface InferenceDeps {}

export function createInferenceDeps(_core: CoreDeps): InferenceDeps {
  return {};
}

export function createInferenceHooks(_deps: Deps): Partial<PipelineHooks> {
  return {};
}

/** Cron work of this module (see src/scheduled.ts). */
export function createInferenceScheduledTasks(_deps: Deps): ScheduledTask[] {
  return [];
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
