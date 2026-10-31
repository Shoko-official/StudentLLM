// GET /v1/provider-sets and POST /v1/consent. Consent records are append-only, with one active record per
// provider set; the app sends the active record's id in `X-StudentLLM-Consent` on the content routes.
//
// POST /v1/consent rules (docs/cloud-api.md, "Consent"):
// - A GRANT is gated like any gated route (suspended -> account_suspended, outdated terms -> terms_required), must
//   name a provider set the server offers and features that set offers (otherwise 400 invalid_request), and must
//   carry the server's current `text_version` and `provider_set_version` (otherwise 409 consent_outdated).
// - A WITHDRAWAL is exempt from the gating and from every version check. It works for a provider set that was
//   retired from the catalog as long as the account has a record for it. The record it appends carries the
//   server's current versions (or, for a retired set, the versions of the record being withdrawn) and the features
//   of the record being withdrawn: nothing the client supplied except the set id and `granted: false`.

import { randomToken } from "../../crypto/random";
import type { Deps } from "../../deps";
import { requirePrincipal, type Handler } from "../../http/context";
import { ApiError, jsonResponse } from "../../http/envelope";
import type { ProviderSetList } from "../../types";
import { parseShape } from "../auth/validate";
import { consentRecord } from "./account-routes";
import { providerSetCatalog } from "./provider-sets";
import { assertGateOpen } from "./hooks";

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
      provider_sets: providerSetCatalog(deps).list().map((s) => ({
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
    const account = ctx.account;
    if (!account) throw new Error("the account was not loaded");
    const body = parseShape(await ctx.body.json(), CONSENT_SHAPE);
    const set = providerSetCatalog(deps).list().find((s) => s.id === body.provider_set);
    const { consents } = deps.stores;
    const now = deps.clock.now();

    if (!body.granted) {
      const history = (await consents.listAll(principal.accountId)).filter((r) => r.providerSetId === body.provider_set);
      const latest = history[history.length - 1];
      if (!set && !latest) throw new ApiError("invalid_request", { message: "Unknown provider set." });
      const { row } = await consents.record(
        {
          consentId: randomToken("cns_", 16),
          accountId: principal.accountId,
          providerSetId: body.provider_set,
          providerSetVersion: set ? set.version : latest!.providerSetVersion,
          features: latest ? latest.features : [],
          textVersion: set ? set.consentTextVersion : latest!.textVersion,
          granted: false,
        },
        now,
      );
      return jsonResponse(consentRecord(row), ctx.requestId);
    }

    // A grant: the same gate as every gated route, then the validation (400), then the versions (409).
    assertGateOpen(deps, account);
    if (!set) throw new ApiError("invalid_request", { message: "Unknown provider set." });
    const features = body.features as Array<"chat" | "transcription" | "ocr">;
    if (features.length === 0) throw new ApiError("invalid_request", { message: "A consent grant needs at least one feature." });
    if (features.some((f) => !set.features.includes(f))) throw new ApiError("invalid_request", { message: "A feature is not offered by this provider set." });
    // A stale text or set version cannot collect consent: the client falls back to local and asks for an update.
    if (body.text_version !== set.consentTextVersion || body.provider_set_version !== set.version) {
      throw new ApiError("consent_outdated", {
        details: { consent_text_version: set.consentTextVersion, provider_set_version: set.version },
      });
    }
    const { row } = await consents.record(
      {
        consentId: randomToken("cns_", 16),
        accountId: principal.accountId,
        providerSetId: set.id,
        providerSetVersion: set.version,
        features,
        textVersion: set.consentTextVersion,
        granted: true,
      },
      now,
    );
    return jsonResponse(consentRecord(row), ctx.requestId);
  };
}
