// GET /v1/provider-sets and POST /v1/consent. Consent records are append-only, with one active record per
// provider set; the app sends the active record's id in `X-StudentLLM-Consent` on the content routes.

import { randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import { requirePrincipal, type Handler } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { ProviderSetList } from "../../types";
import { parseShape } from "../auth/validate";
import { consentRecord } from "./account-routes";

const CONSENT_SHAPE = {
  provider_set: { kind: "string", min: 1, max: 64 },
  provider_set_version: { kind: "integer", min: 1 },
  features: { kind: "stringArray", oneOf: ["chat", "transcription", "ocr"], unique: true },
  text_version: { kind: "string", min: 1, max: 64 },
  granted: { kind: "boolean" },
} as const;

export function listProviderSetsHandler(deps: Deps): Handler {
  return (ctx) => {
    requirePrincipal(ctx);
    const body: ProviderSetList = {
      provider_sets: deps.account.providerSets.list().map((s) => ({
        id: s.id,
        version: s.version,
        providers: [...s.providers],
        regions: [...s.regions],
        consent_text_version: s.consentTextVersion,
        features: [...s.features],
      })),
    };
    return jsonResponse(body, ctx.requestId);
  };
}

export function recordConsentHandler(deps: Deps): Handler {
  return async (ctx) => {
    const principal = requirePrincipal(ctx);
    const body = parseShape(await ctx.body.json(), CONSENT_SHAPE);
    const set = deps.account.providerSets.list().find((s) => s.id === body.provider_set);
    if (!set) throw new ApiError("invalid_request", { message: "Unknown provider set." });
    const features = body.features as Array<"chat" | "transcription" | "ocr">;
    if (features.some((f) => !set.features.includes(f))) throw new ApiError("invalid_request", { message: "A feature is not offered by this provider set." });

    if (body.granted) {
      if (features.length === 0) throw new ApiError("invalid_request", { message: "A consent grant needs at least one feature." });
      // A stale text or set version cannot collect consent: the client falls back to local and asks for an update.
      if (body.text_version !== set.consentTextVersion || body.provider_set_version !== set.version) {
        throw new ApiError("consent_outdated", {
          details: { consent_text_version: set.consentTextVersion, provider_set_version: set.version },
        });
      }
    }
    // A withdrawal is accepted whatever versions the client holds: withdrawing must stay as easy as consenting,
    // also for a build that bundles an outdated consent text.

    const { row } = await deps.stores.consents.record(
      {
        consentId: randomToken("cns_", 16),
        accountId: principal.accountId,
        providerSetId: set.id,
        providerSetVersion: body.provider_set_version,
        features,
        textVersion: body.text_version,
        granted: body.granted,
      },
      deps.clock.now(),
    );
    return jsonResponse(consentRecord(row), ctx.requestId);
  };
}
