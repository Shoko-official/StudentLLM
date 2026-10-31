// The model routing table (docs/cloud-plan.md, "Model routing table" and "Provider strategy"): configuration,
// not code. A logical model id maps to an ordered list of providers, their upstream model ids, the provider set
// the user consents to, the price table in credits and the limits. The client never supplies a URL, a host, a
// path, a header or a provider name that reaches the upstream: the only thing it picks is a logical model id,
// and this table decides everything else. Changing a model or a provider inside a consented provider set is a
// change here and a deploy, not an app release.

import type { SecretName } from "../../config";
import type { Feature } from "../../storage";

/** A provider endpoint. The gateway appends a FIXED path per operation to `baseUrl`; nothing else is reachable. */
export interface ProviderEndpoint {
  readonly id: string;
  /** The name shown on the consent screen (a provider set lists providers by name). */
  readonly displayName: string;
  /** `https` URL without credentials, query or fragment, for example `https://api.groq.com/openai/v1`. */
  readonly baseUrl: string;
  /** The server secret that holds this provider's API key. */
  readonly secret: SecretName;
  /**
   * Whether a 4xx answer of this provider may have been BILLED (some providers charge for a request they rejected
   * after reading it, for example a prompt refused by a safety filter). False (the default): a 4xx is an explicit
   * error with no completion, `failed_no_usage`, zero credits. True: a 4xx is an unknown outcome and settles at the
   * full reservation. 5xx and redirects are always definitive. Groq: false, PLACEHOLDER to verify in its terms.
   */
  readonly clientErrorMayBeBilled?: boolean;
}

/** A named, versioned list of providers the user consents to (`GET /v1/provider-sets`). */
export interface ProviderSetDef {
  readonly id: string;
  readonly version: number;
  /** Provider ids; a model's targets must all be inside its provider set (no silent cross-provider failover). */
  readonly providerIds: readonly string[];
  readonly regions: readonly string[];
  readonly consentTextVersion: string;
  readonly features: readonly Feature[];
}

export interface ModelTarget {
  readonly providerId: string;
  readonly upstreamModel: string;
}

interface BaseRoute {
  /** The logical model id the client sees (`GET /v1/models`). */
  readonly id: string;
  readonly providerSetId: string;
  /** Ordered fallback list, all inside the provider set. */
  readonly targets: readonly ModelTarget[];
  /** The longest the gateway waits for the upstream; the reservation lives this long plus 60 seconds. */
  readonly maxDurationMs: number;
  /** False hides the model's availability and answers `kill_switch`: a route that is configured but switched off. */
  readonly enabled: boolean;
}

export interface ChatRoute extends BaseRoute {
  readonly feature: "chat";
  readonly contextWindow: number;
  /** `max_tokens` is clamped to this, and it is the default when the client sends none. */
  readonly maxOutputTokens: number;
  /** Images per request (0: a text-only model, so an `image_url` part is `invalid_request`). */
  readonly maxImages: number;
  /** Decoded bytes per image. */
  readonly maxImageBytes: number;
  /** Credits per million tokens, integers (credits are cost-normalized, see `credits.ts`). */
  readonly price: { readonly inputPerMTok: number; readonly outputPerMTok: number };
}

export interface TranscriptionRoute extends BaseRoute {
  readonly feature: "transcription";
  readonly maxAudioBytes: number;
  readonly maxAudioSeconds: number;
  /** Credits per minute of audio, integer. */
  readonly price: { readonly perMinute: number };
}

export interface OcrRoute extends BaseRoute {
  readonly feature: "ocr";
  readonly maxImageBytes: number;
  /** Credits per MiB of image, integer. */
  readonly price: { readonly perMiB: number };
}

export type ModelRoute = ChatRoute | TranscriptionRoute | OcrRoute;

export interface RoutingConfig {
  readonly providers: readonly ProviderEndpoint[];
  readonly providerSets: readonly ProviderSetDef[];
  readonly models: readonly ModelRoute[];
}

/** The validated, indexed table. Build it with `buildRoutingTable`. */
export interface RoutingTable {
  readonly config: RoutingConfig;
  model(id: string): ModelRoute | undefined;
  providerSet(id: string): ProviderSetDef | undefined;
  provider(id: string): ProviderEndpoint | undefined;
  models(): readonly ModelRoute[];
  providerSets(): readonly ProviderSetDef[];
  /** The provider set a client needs to consent to for this feature: the first enabled model's, or undefined. */
  setFor(feature: Feature): ProviderSetDef | undefined;
  /** The longest `maxDurationMs` among the models of a feature (the idempotency lease before the model is known). */
  maxDurationMsFor(feature: Feature): number;
}

/**
 * The first production provider: Groq, `gpt-oss-120b`. EVERY value here is a placeholder to verify before launch
 * (docs/cloud-plan.md, "Provider strategy" and "Open items"): the commercial terms and retention of the provider,
 * that the model is still listed as a production model, its processing region, and the prices.
 *
 * Prices: third-party trackers list about $0.15 per million input tokens and $0.60 per million output tokens
 * (unverified). One credit is 0.0001 EUR, the dollar-euro rate is taken as 0.90, and a safety margin of 1.2 covers
 * rounding and rate drift: 0.15 x 0.90 / 0.0001 x 1.2 = 1620 and 0.60 x 0.90 / 0.0001 x 1.2 = 6480 credits per
 * million tokens. The model is text-only, so it accepts no image part.
 */
export const DEFAULT_ROUTING: RoutingConfig = {
  providers: [
    {
      id: "groq",
      displayName: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      secret: "GROQ_API_KEY",
    },
  ],
  providerSets: [
    {
      id: "ps1",
      version: 1,
      providerIds: ["groq"],
      regions: ["[PLACEHOLDER: verify the processing region before launch]"],
      consentTextVersion: "2026-11-01",
      // Transcription and OCR join this set (or a new version of it) once their providers are decided.
      features: ["chat"],
    },
  ],
  models: [
    {
      id: "studentllm-large",
      feature: "chat",
      providerSetId: "ps1",
      targets: [{ providerId: "groq", upstreamModel: "openai/gpt-oss-120b" }],
      contextWindow: 131_072,
      maxOutputTokens: 4096,
      maxDurationMs: 120_000,
      maxImages: 0,
      maxImageBytes: 0,
      price: { inputPerMTok: 1620, outputPerMTok: 6480 },
      enabled: true,
    },
  ],
};

/** The lease base for a feature that has no model in the table (no request can reach a handler then). */
const DEFAULT_MAX_DURATION_MS = 120_000;

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FEATURES: readonly Feature[] = ["chat", "transcription", "ocr"];

function fail(message: string): never {
  throw new Error(`routing table: ${message}`);
}

function positiveInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${what} must be a positive integer`);
}

function nonNegativeInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${what} must be a non-negative integer`);
}

function assertBaseUrl(provider: ProviderEndpoint): void {
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    return fail(`provider ${provider.id} has an invalid baseUrl`);
  }
  if (url.protocol !== "https:") fail(`provider ${provider.id} must use https`);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    fail(`provider ${provider.id} baseUrl must have no credentials, query or fragment`);
  }
  if (provider.baseUrl.endsWith("/")) fail(`provider ${provider.id} baseUrl must not end with a slash`);
}

/** Validates the configuration and indexes it. Throws on the first problem, so a bad table never serves traffic. */
export function buildRoutingTable(config: RoutingConfig): RoutingTable {
  const providers = new Map<string, ProviderEndpoint>();
  for (const p of config.providers) {
    if (!ID.test(p.id)) fail(`invalid provider id ${p.id}`);
    if (providers.has(p.id)) fail(`duplicate provider ${p.id}`);
    if (p.displayName.trim() === "") fail(`provider ${p.id} needs a display name`);
    assertBaseUrl(p);
    providers.set(p.id, p);
  }
  const sets = new Map<string, ProviderSetDef>();
  for (const s of config.providerSets) {
    if (!ID.test(s.id)) fail(`invalid provider set id ${s.id}`);
    if (sets.has(s.id)) fail(`duplicate provider set ${s.id}`);
    positiveInt(s.version, `provider set ${s.id} version`);
    if (s.providerIds.length === 0) fail(`provider set ${s.id} lists no provider`);
    for (const id of s.providerIds) if (!providers.has(id)) fail(`provider set ${s.id} lists unknown provider ${id}`);
    if (s.consentTextVersion.trim() === "") fail(`provider set ${s.id} needs a consent text version`);
    for (const f of s.features) if (!FEATURES.includes(f)) fail(`provider set ${s.id} has an unknown feature`);
    sets.set(s.id, s);
  }
  const models = new Map<string, ModelRoute>();
  for (const m of config.models) {
    if (!ID.test(m.id)) fail(`invalid model id ${m.id}`);
    if (models.has(m.id)) fail(`duplicate model ${m.id}`);
    const set = sets.get(m.providerSetId);
    if (!set) fail(`model ${m.id} uses unknown provider set ${m.providerSetId}`);
    if (m.targets.length === 0) fail(`model ${m.id} has no target`);
    for (const t of m.targets) {
      if (!set.providerIds.includes(t.providerId)) fail(`model ${m.id} routes outside its provider set (${t.providerId})`);
      if (t.upstreamModel.trim() === "") fail(`model ${m.id} has an empty upstream model`);
    }
    positiveInt(m.maxDurationMs, `model ${m.id} maxDurationMs`);
    switch (m.feature) {
      case "chat":
        positiveInt(m.contextWindow, `model ${m.id} contextWindow`);
        positiveInt(m.maxOutputTokens, `model ${m.id} maxOutputTokens`);
        if (m.maxOutputTokens >= m.contextWindow) fail(`model ${m.id} maxOutputTokens must be below its context window`);
        nonNegativeInt(m.maxImages, `model ${m.id} maxImages`);
        nonNegativeInt(m.maxImageBytes, `model ${m.id} maxImageBytes`);
        positiveInt(m.price.inputPerMTok, `model ${m.id} input price`);
        positiveInt(m.price.outputPerMTok, `model ${m.id} output price`);
        break;
      case "transcription":
        positiveInt(m.maxAudioBytes, `model ${m.id} maxAudioBytes`);
        positiveInt(m.maxAudioSeconds, `model ${m.id} maxAudioSeconds`);
        positiveInt(m.price.perMinute, `model ${m.id} price`);
        break;
      case "ocr":
        positiveInt(m.maxImageBytes, `model ${m.id} maxImageBytes`);
        positiveInt(m.price.perMiB, `model ${m.id} price`);
        break;
    }
    if (!set.features.includes(m.feature)) fail(`model ${m.id} has feature ${m.feature}, which its provider set does not cover`);
    models.set(m.id, m);
  }

  const ordered = [...models.values()];
  return {
    config,
    model: (id) => models.get(id),
    providerSet: (id) => sets.get(id),
    provider: (id) => providers.get(id),
    models: () => ordered,
    providerSets: () => [...sets.values()],
    setFor(feature) {
      const m = ordered.find((x) => x.feature === feature && x.enabled);
      return m ? sets.get(m.providerSetId) : undefined;
    },
    maxDurationMsFor(feature) {
      const durations = ordered.filter((m) => m.feature === feature).map((m) => m.maxDurationMs);
      return durations.length > 0 ? Math.max(...durations) : DEFAULT_MAX_DURATION_MS;
    },
  };
}
