// Billing settings: the values the billing module reads from configuration, with defaults for what is a
// product decision. Everything marked PLACEHOLDER is a number to verify before launch.

import { ConfigError, type Config } from "../../config";

export type PaidPlanId = "plus_monthly" | "plus_semester";

export interface BillingSettings {
  environment: "sandbox" | "live";
  /** Paddle price id per plan; null when not configured (development only). */
  prices: Record<PaidPlanId, string | null>;
  /**
   * Credits of one budget window per plan. The pool is cost-normalized (one credit is a fixed small amount of
   * money at the routing-table price, docs/cloud-plan.md "Quota design"), so these are money budgets, not token counts.
   * PLACEHOLDER: 12500 credits is the account fixture's limit; verify against the unit economics before launch.
   */
  windowCredits: Record<PaidPlanId, number>;
  /** Maximum distance between the signed timestamp and now, in both directions. */
  signatureToleranceMs: number;
  /** A claim left in `processing` for this long can be taken over by another delivery. */
  claimStaleAfterMs: number;
  /** How long the checkout and portal links are reported as valid. PLACEHOLDER: verify Paddle's real lifetimes. */
  checkoutTtlMs: number;
  portalTtlMs: number;
  /** Webhook ledger retention (docs/cloud-plan.md: "[PLACEHOLDER: period, for example 90 days]"). */
  webhookRetentionMs: number;
  /** Retry schedule of a cancellation Paddle did not confirm. */
  cancel: { baseDelayMs: number; maxDelayMs: number; alertAfterAttempts: number; batch: number };
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const DEFAULT_WINDOW_CREDITS = 12_500;

/** Months in a semester pass: five consecutive one-month windows from its start. */
export const SEMESTER_PASS_MONTHS = 5;

export const DEFAULT_SETTINGS: Omit<BillingSettings, "environment" | "prices" | "windowCredits"> = {
  signatureToleranceMs: MINUTE,
  claimStaleAfterMs: MINUTE,
  checkoutTtlMs: 60 * MINUTE,
  portalTtlMs: 15 * MINUTE,
  webhookRetentionMs: 90 * DAY,
  cancel: { baseDelayMs: 5 * MINUTE, maxDelayMs: 6 * 60 * MINUTE, alertAfterAttempts: 5, batch: 20 },
};

function looksLikeTemplate(value: string): boolean {
  return /\.invalid(?![a-z0-9-])/i.test(value) || /placeholder/i.test(value);
}

function credits(config: Config, name: "PLUS_MONTHLY_WINDOW_CREDITS" | "PLUS_SEMESTER_WINDOW_CREDITS"): number {
  const raw = config.variable(name);
  if (raw === undefined) return DEFAULT_WINDOW_CREDITS;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new ConfigError(`${name} must be a whole number of credits`);
  return Number(raw);
}

/**
 * Reads the settings. Outside development a missing or template price id is a configuration error, so a deploy
 * cannot start selling against placeholders; in development a missing price id only disables that plan.
 * Sandbox and live are never mixed: the API key's own prefix must agree with PADDLE_ENVIRONMENT when it has one.
 */
export function loadBillingSettings(config: Config, overrides: Partial<BillingSettings> = {}): BillingSettings {
  const prices = {
    plus_monthly: config.variable("PADDLE_PRICE_PLUS_MONTHLY") ?? null,
    plus_semester: config.variable("PADDLE_PRICE_PLUS_SEMESTER") ?? null,
  };
  if (config.environment !== "development") {
    for (const [plan, price] of Object.entries(prices)) {
      if (price === null || looksLikeTemplate(price)) {
        throw new ConfigError(`PADDLE_PRICE_${plan.toUpperCase()} is empty or a template value; set a real one for ${config.environment}`);
      }
    }
    if (prices.plus_monthly === prices.plus_semester) throw new ConfigError("the monthly and semester price ids must differ");
  }
  return {
    environment: config.paddleEnvironment,
    prices,
    windowCredits: { plus_monthly: credits(config, "PLUS_MONTHLY_WINDOW_CREDITS"), plus_semester: credits(config, "PLUS_SEMESTER_WINDOW_CREDITS") },
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

/**
 * Paddle API keys carry their environment in the prefix (`pdl_live_apikey_`, `pdl_sdbx_apikey_`; verify). A
 * key of the other environment is refused before any call, so sandbox and live can never be mixed by a typo.
 * A key without a known prefix passes (tests, a format Paddle may change).
 */
export function assertApiKeyMatchesEnvironment(apiKey: string, environment: "sandbox" | "live"): void {
  if (environment === "live" && apiKey.startsWith("pdl_sdbx_")) throw new ConfigError("PADDLE_API_KEY is a sandbox key but PADDLE_ENVIRONMENT is live");
  if (environment === "sandbox" && apiKey.startsWith("pdl_live_")) throw new ConfigError("PADDLE_API_KEY is a live key but PADDLE_ENVIRONMENT is sandbox");
}
