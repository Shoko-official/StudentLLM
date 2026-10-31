// Inference module: models, provider sets, usage, chat (streaming or not), transcription and OCR; the quota
// (credits, reservation, settlement, the reconciler), idempotency, rate and concurrency limits, the kill switches
// and the upstream proxy. OWNER: inference/quota.
//
// Pipeline hooks (src/modules/inference/hooks.ts): `checkConsent`, `checkRateLimit` (per account),
// `lookupIdempotency` and `acquireConcurrencySlot`. The budget reservation (step 10) happens in the handlers after
// `ctx.body` validated the request.
//
// Where things are:
//   routing.ts   the routing table (configuration): providers, provider sets, models, prices, limits
//   settings.ts  rate limits, spend caps, retry hints (placeholders to set before launch)
//   credits.ts   the settlement arithmetic          attempt.ts  reserve -> forward -> settle
//   provider.ts  the upstream proxy (injected fetch) stream.ts   the SSE passthrough
//   chat.ts, media-routes.ts, catalog.ts   the route handlers
//   sweeper.ts   the reconciler and its cron tasks  seam.ts     InferenceSeam for other modules

import { hmacSha256Base64Url } from "../../crypto/hash";
import type { CoreDeps, Deps } from "../../deps";
import { routeMeta } from "../../http/context";
import type { PipelineHooks } from "../../http/pipeline";
import type { Router } from "../../http/router";
import type { ScheduledTask } from "../../scheduled";
import { getUsage, listModels, listProviderSets } from "./catalog";
import { chatCompletions } from "./chat";
import { createHooks } from "./hooks";
import { ocrImage, transcribeAudio } from "./media-routes";
import { createOpenAiCompatibleProvider, type ProviderRegistry, type UpstreamProvider } from "./provider";
import { buildRoutingTable, DEFAULT_ROUTING, type RoutingConfig, type RoutingTable } from "./routing";
import { createInferenceSeam } from "./seam";
import { mergeSettings, type DeepPartial, type InferenceSettings } from "./settings";
import { createSweepTasks } from "./sweeper";
import type { InferenceDeps } from "./types";

export type { InferenceDeps } from "./types";

/** Overrides for tests and for a deployment that changes the table or the providers. All optional. */
export interface InferenceOptions {
  routing?: RoutingConfig | RoutingTable;
  settings?: DeepPartial<InferenceSettings>;
  /** Replaces the OpenAI-compatible providers built from the routing table (tests inject fakes). */
  providers?: ProviderRegistry;
}

function isTable(value: RoutingConfig | RoutingTable): value is RoutingTable {
  return typeof (value as RoutingTable).model === "function";
}

export function createInferenceDeps(core: CoreDeps, options: InferenceOptions = {}): InferenceDeps {
  const routing = options.routing ? (isTable(options.routing) ? options.routing : buildRoutingTable(options.routing)) : buildRoutingTable(DEFAULT_ROUTING);
  const settings = mergeSettings(options.settings);

  let providers = options.providers;
  if (!providers) {
    // One OpenAI-compatible provider per routing-table endpoint, created on first use. They share the injected fetch.
    const cache = new Map<string, UpstreamProvider>();
    providers = (id) => {
      const endpoint = routing.provider(id);
      if (!endpoint) return undefined;
      let provider = cache.get(id);
      if (!provider) {
        provider = createOpenAiCompatibleProvider({
          endpoint,
          fetch: (input, init) => core.fetch(input, init),
          apiKey: () => core.config.secret(endpoint.secret).reveal(),
          maxJsonBytes: settings.maxUpstreamBodyBytes,
        });
        cache.set(id, provider);
      }
      return provider;
    };
  }

  return {
    ...createInferenceSeam(core),
    routing,
    settings,
    providers,
    /** `u_` plus an HMAC of the account id under a server-held key: the provider can rate limit per user, nothing more. */
    async pseudonym(accountId) {
      const tag = await hmacSha256Base64Url(core.config.secret("UPSTREAM_PSEUDONYM_KEY").reveal(), `upstream-user:${accountId}`);
      return `u_${tag.slice(0, 32)}`;
    },
  };
}

export function createInferenceHooks(deps: Deps): Partial<PipelineHooks> {
  return createHooks(deps);
}

/** Cron work of this module (see src/scheduled.ts): the reservation sweep safety net and expiry of old records. */
export function createInferenceScheduledTasks(deps: Deps): ScheduledTask[] {
  return createSweepTasks(deps);
}

export function registerInferenceRoutes(router: Router, _deps: Deps): void {
  router.add("GET", "/v1/models", listModels, routeMeta({ operationId: "listModels" }));
  router.add("GET", "/v1/provider-sets", listProviderSets, routeMeta({ operationId: "listProviderSets" }));
  router.add("GET", "/v1/usage", getUsage, routeMeta({ operationId: "getUsage" }));
  router.add(
    "POST",
    "/v1/chat/completions",
    chatCompletions,
    routeMeta({ operationId: "chatCompletions", client: true, content: true, body: { kind: "json", limit: "chat" } }),
  );
  router.add(
    "POST",
    "/v1/audio/transcriptions",
    transcribeAudio,
    routeMeta({ operationId: "transcribeAudio", client: true, content: true, body: { kind: "multipart", limit: "audio" } }),
  );
  router.add(
    "POST",
    "/v1/ocr",
    ocrImage,
    routeMeta({ operationId: "ocrImage", client: true, content: true, body: { kind: "multipart", limit: "image" } }),
  );
}
