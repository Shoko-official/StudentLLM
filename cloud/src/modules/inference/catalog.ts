// GET /v1/models, GET /v1/provider-sets and GET /v1/usage: read-only views of the routing table and the ledger.

import { jsonResponse } from "../../http/envelope";
import { requirePrincipal, type Handler } from "../../http/context";
import { formatTime, setCreditHeaders } from "./attempt";
import { liveTargets, spendCapReached } from "./availability";
import type { Feature } from "../../storage";
import type { ModelRoute, RoutingTable } from "./routing";
import { planWindow } from "./window";

/** Credits per 1000 tokens as the contract shows them (a number); the table stores integers per million. */
const per1k = (perMillion: number): number => perMillion / 1000;

function modelView(route: ModelRoute, providerSetVersion: number, available: boolean): Record<string, unknown> {
  const base = {
    id: route.id,
    object: "model" as const,
    features: [route.feature],
    provider_set: route.providerSetId,
    provider_set_version: providerSetVersion,
    requires_plan: "plus" as const,
    available,
  };
  switch (route.feature) {
    case "chat":
      return {
        ...base,
        context_window: route.contextWindow,
        max_output_tokens: route.maxOutputTokens,
        credits_per_1k_input: per1k(route.price.inputPerMTok),
        credits_per_1k_output: per1k(route.price.outputPerMTok),
      };
    default:
      // Audio and image models have no token window; the schema requires the two integers, so they are 0.
      return { ...base, context_window: 0, max_output_tokens: 0 };
  }
}

export const listModels: Handler = async (ctx) => {
  requirePrincipal(ctx);
  const { deps } = ctx;
  const capped = await spendCapReached(deps, deps.clock.now());
  const data: Array<Record<string, unknown>> = [];
  for (const route of deps.inference.routing.models()) {
    const set = deps.inference.routing.providerSet(route.providerSetId)!;
    const available = route.enabled && !capped && (await liveTargets(deps, route)).length > 0;
    data.push(modelView(route, set.version, available));
  }
  return jsonResponse({ object: "list", data }, ctx.requestId);
};

/**
 * A provider set as the consent screen and `POST /v1/consent` need it (names, regions, versions). Same shape as the
 * account module's `ProviderSetInfo`, so that module can read its catalog from the routing table:
 * `providerSetViews(deps.inference.routing)`.
 */
export interface ProviderSetView {
  id: string;
  version: number;
  providers: readonly string[];
  regions: readonly string[];
  consentTextVersion: string;
  features: readonly Feature[];
}

export function providerSetViews(routing: RoutingTable): ProviderSetView[] {
  return routing.providerSets().map((set) => ({
    id: set.id,
    version: set.version,
    providers: set.providerIds.map((id) => routing.provider(id)!.displayName),
    regions: [...set.regions],
    consentTextVersion: set.consentTextVersion,
    features: [...set.features],
  }));
}

export const listProviderSets: Handler = (ctx) => {
  requirePrincipal(ctx);
  const provider_sets = providerSetViews(ctx.deps.inference.routing).map((set) => ({
    id: set.id,
    version: set.version,
    providers: [...set.providers],
    regions: [...set.regions],
    consent_text_version: set.consentTextVersion,
    features: [...set.features],
  }));
  return jsonResponse({ provider_sets }, ctx.requestId);
};

export const getUsage: Handler = async (ctx) => {
  const { accountId } = requirePrincipal(ctx);
  const { deps } = ctx;
  const now = deps.clock.now();
  let window = await deps.stores.ledger.getCurrentWindow(accountId, now);
  if (!window) {
    // A paid account that has not spent anything yet has no window row: show the one it would get.
    const spec = planWindow(ctx.plan ?? null, now, deps.inference.settings.windowCredits);
    if (spec) window = await deps.stores.ledger.ensureWindow(accountId, spec);
  }
  if (!window) {
    // A free account gets a valid answer: no window, zero credits.
    return jsonResponse(
      { window: null, credits: { limit: 0, used: 0, reserved: 0, remaining: 0, resets_at: null }, by_feature: { chat: 0, transcription: 0, ocr: 0 }, requests: 0 },
      ctx.requestId,
    );
  }
  const remaining = Math.max(0, window.limit - window.used - window.reserved);
  setCreditHeaders(ctx, { remaining, limit: window.limit, resetsAt: window.end });
  return jsonResponse(
    {
      window: { start: formatTime(window.start), end: formatTime(window.end) },
      credits: { limit: window.limit, used: window.used, reserved: window.reserved, remaining, resets_at: formatTime(window.end) },
      by_feature: { ...window.byFeature },
      requests: window.requests,
    },
    ctx.requestId,
  );
};
