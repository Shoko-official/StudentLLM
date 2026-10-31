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
] as const satisfies readonly VarSpec[];

export const limits = {
  webhook: 256 * 1024,
} as const;
