// The pipeline hooks this module owns (docs/cloud-api.md, "Order of checks on the content routes"):
//   5. checkConsent            6. checkRateLimit
//   7. lookupIdempotency       8. acquireConcurrencySlot
// All of them run before the body is read.

import type { Deps } from "../../deps";
import { sha256Hex } from "../../crypto/hash";
import { requirePrincipal, type RequestContext, type Step } from "../../http/context";
import { ApiError } from "../../http/envelope";
import type { PipelineHooks } from "../../http/pipeline";
import type { Feature } from "../../storage";
import "./types";

/** Every text feature (chat, note formatting, study material) is the `chat` feature. */
const FEATURE_OF_OPERATION: Record<string, Feature> = {
  chatCompletions: "chat",
  transcribeAudio: "transcription",
  ocrImage: "ocr",
};

export function featureOf(ctx: RequestContext): Feature {
  const feature = FEATURE_OF_OPERATION[ctx.meta.operationId];
  if (!feature) throw new Error(`${ctx.meta.operationId} is not a content route`);
  return feature;
}

function consentOutdated(deps: Deps, feature: Feature, providerSetId?: string): ApiError {
  // Without a known record, point at the provider set the client needs for this feature.
  const set = (providerSetId ? deps.inference.routing.providerSet(providerSetId) : undefined) ?? deps.inference.routing.setFor(feature);
  return new ApiError("consent_outdated", {
    message: "Your consent does not cover the providers needed for this model.",
    ...(set ? { details: { provider_set: set.id, consent_text_version: set.consentTextVersion } } : {}),
  });
}

/**
 * The consent record the client sent must be the ACTIVE record (not withdrawn, not replaced), of the current
 * provider set version and consent text version, and cover the route's feature. The provider set of the ROUTED
 * MODEL is known only once the body is read, so the match between the record's set and the model's set is made in
 * the handler (`assertConsentCoversModel`), before the budget is touched; a mismatch is the same `consent_outdated`.
 */
const checkConsent: (deps: Deps) => Step = (deps) => async (ctx) => {
  const feature = featureOf(ctx);
  const accountId = requirePrincipal(ctx).accountId;
  const consentId = ctx.consentId;
  if (!consentId) throw consentOutdated(deps, feature);
  const row = await deps.stores.consents.getById(accountId, consentId);
  if (!row || !row.granted) throw consentOutdated(deps, feature);
  const set = deps.inference.routing.providerSet(row.providerSetId);
  if (!set) throw consentOutdated(deps, feature);
  const active = await deps.stores.consents.getActive(accountId, row.providerSetId);
  if (active?.consentId !== row.consentId) throw consentOutdated(deps, feature, row.providerSetId);
  if (row.providerSetVersion !== set.version || row.textVersion !== set.consentTextVersion || !row.features.includes(feature)) {
    throw consentOutdated(deps, feature, row.providerSetId);
  }
  ctx.locals.consent = row;
};

/** Called by the handlers once the model is known: the consented provider set must be the model's. */
export function assertConsentCoversModel(ctx: RequestContext, providerSetId: string, feature: Feature): void {
  const row = ctx.locals.consent;
  if (!row || row.providerSetId !== providerSetId) throw consentOutdated(ctx.deps, feature, providerSetId);
}

/**
 * The same check once more, right before the budget is reserved. The hook ran before the body was read, and a body can
 * take a while to arrive: a consent withdrawn or replaced in that time must stop the request here, before anything is
 * reserved or sent upstream. One read of the account's active record for the provider set.
 */
export async function assertConsentStillActive(ctx: RequestContext, providerSetId: string, feature: Feature): Promise<void> {
  const row = ctx.locals.consent;
  if (!row) throw consentOutdated(ctx.deps, feature, providerSetId);
  const active = await ctx.deps.stores.consents.getActive(requirePrincipal(ctx).accountId, row.providerSetId);
  if (active?.consentId !== row.consentId) throw consentOutdated(ctx.deps, feature, providerSetId);
}

const checkRateLimit: (deps: Deps) => Step = (deps) => async (ctx) => {
  const principal = requirePrincipal(ctx);
  const { rate } = deps.inference.settings;
  const bucket = ctx.meta.content ? "content" : "read";
  const setting = rate[bucket];
  const result = await deps.stores.rateLimits.hitAccount(principal.accountId, bucket, setting.limit, setting.windowMs, deps.clock.now());
  const headers = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetAfterSeconds),
  };
  if (!result.allowed) throw new ApiError("rate_limited", { retryAfterSeconds: result.retryAfterSeconds ?? 1, headers });
  for (const [name, value] of Object.entries(headers)) ctx.responseHeaders.set(name, value);
};

/** The lease of an `in_flight` record that owns no reservation yet: the longest the route may take, plus 60 s. */
function leaseMsFor(deps: Deps, feature: Feature): number {
  return deps.inference.routing.maxDurationMsFor(feature) + deps.inference.settings.reservationMarginMs;
}

/**
 * The idempotency lookup. A conflict returns at once and never takes a concurrency slot. A same-key retry is
 * allowed from `failed_before_forward` (the reservation is reused) and from `failed_no_usage` (a new attempt).
 * Nothing derived from the body is stored: the key is hashed, the body has not been read.
 */
const lookupIdempotency: (deps: Deps) => Step = (deps) => async (ctx) => {
  const feature = featureOf(ctx);
  const accountId = requirePrincipal(ctx).accountId;
  if (!ctx.idempotencyKey) throw new ApiError("invalid_request", { message: "Missing or invalid Idempotency-Key header." });
  const keyHash = await sha256Hex(ctx.idempotencyKey);
  const key = { accountId, route: ctx.pattern, keyHash };
  const leaseMs = leaseMsFor(deps, feature);
  const begin = await deps.stores.idempotency.begin(key, ctx.requestId, deps.clock.now(), leaseMs);
  if (begin.outcome === "conflict") {
    if (begin.state === "settled") {
      throw new ApiError("idempotency_conflict", {
        message: "A request with this key was already settled.",
        details: { state: "settled", request_id: begin.record.requestId, credits_charged: begin.record.creditsCharged ?? 0 },
      });
    }
    throw new ApiError("idempotency_conflict", {
      message: "A request with this key is still in progress.",
      retryAfterSeconds: deps.inference.settings.retryAfter.inProgressSeconds,
      details: { state: "in_progress", request_id: begin.record.requestId },
    });
  }
  ctx.locals.idem = {
    key,
    ref: { route: key.route, keyHash },
    ownerRequestId: begin.record.requestId,
    reuseReservation: begin.outcome === "retry" && begin.previousState === "failed_before_forward",
    leaseMs,
  };
};

/**
 * The concurrency slot: a lease with a time to live, so a crashed request cannot hold it forever. It is released
 * once the response body has been fully sent or cancelled by the client (`deferUntilBodyDone`), so a stream keeps
 * its slot while it runs; the runtime ties that cleanup to `waitUntil` when the client disconnects.
 */
const acquireConcurrencySlot: (deps: Deps) => Step = (deps) => async (ctx) => {
  const accountId = requirePrincipal(ctx).accountId;
  const leaseMs = ctx.locals.idem?.leaseMs ?? leaseMsFor(deps, featureOf(ctx));
  const lease = await deps.stores.concurrency.acquire(accountId, deps.inference.settings.maxConcurrent, leaseMs, deps.clock.now());
  if (!lease) {
    // The idempotency record was started by the previous hook; this request will not run, so let a retry in.
    if (ctx.locals.idem) {
      await deps.stores.idempotency.transition(ctx.locals.idem.key, ["in_flight"], "failed_before_forward", deps.clock.now());
    }
    throw new ApiError("concurrency_limit", { retryAfterSeconds: deps.inference.settings.retryAfter.concurrencySeconds });
  }
  ctx.locals.lease = lease;
  ctx.deferUntilBodyDone(async () => {
    await deps.stores.concurrency.release(lease);
  });
};

/**
 * Like the fail-closed defaults, these hooks stand aside for a `notImplemented` stub (a route of another module that
 * has no handler yet answers 501 whatever happens before it); for every real handler they apply in full.
 */
const forRealHandlers =
  (step: Step): Step =>
  (ctx) =>
    ctx.isStub ? undefined : step(ctx);

export function createHooks(deps: Deps): Partial<PipelineHooks> {
  return {
    checkConsent: forRealHandlers(checkConsent(deps)),
    checkRateLimit: forRealHandlers(checkRateLimit(deps)),
    lookupIdempotency: forRealHandlers(lookupIdempotency(deps)),
    acquireConcurrencySlot: forRealHandlers(acquireConcurrencySlot(deps)),
  };
}
