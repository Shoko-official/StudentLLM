import type { SecretSpec, VarSpec } from "../../config-spec";

export const secrets = [
  { name: "PADDLE_API_KEY" },
  { name: "PADDLE_WEBHOOK_SECRET" },
  /** Accepted only during a webhook secret rotation. */
  { name: "PADDLE_WEBHOOK_SECRET_PREVIOUS", optional: true },
] as const satisfies readonly SecretSpec[];

export const vars = [
  /** Sandbox and live use separate secrets and deployments; the value is `sandbox` or `live`. */
  { name: "PADDLE_ENVIRONMENT", required: true },
  /**
   * Paddle price ids. They differ between sandbox and live, so they are variables, never constants. Not
   * `deployChecked`: the billing module refuses to start outside development when one is missing or a template
   * value (`loadBillingSettings`), so the check lives next to the code that needs them.
   */
  { name: "PADDLE_PRICE_PLUS_MONTHLY", required: false },
  { name: "PADDLE_PRICE_PLUS_SEMESTER", required: false },
  /**
   * Credits per budget window (docs/cloud-plan.md, "Quota design"), whole numbers. PLACEHOLDER defaults of the
   * billing module apply when unset (12500, from the 1.50 EUR ceiling of "Unit economics"). Verify before launch.
   */
  { name: "PLUS_MONTHLY_WINDOW_CREDITS", required: false },
  { name: "PLUS_SEMESTER_WINDOW_CREDITS", required: false },
] as const satisfies readonly VarSpec[];

export const limits = {
  webhook: 256 * 1024,
} as const;
