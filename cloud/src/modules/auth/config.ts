// What the auth module needs from the environment. Edit this file (not src/config.ts) to add a secret,
// a variable or a limit. Names mirror docs/cloud-plan.md > Security requirements > Secrets.

import type { SecretSpec, VarSpec } from "../../config-spec";

export const secrets = [
  /** Ed25519 private key (PKCS8, base64) that signs access tokens; rotated through `kid` and the JWKS. */
  { name: "TOKEN_SIGNING_KEY", format: "ed25519-pkcs8" },
  /** Keyed HMAC for one-time email codes and the stable pending-sign-in lookups. */
  { name: "CODE_HMAC_KEY" },
  /** Master key for the rotating salt of the sign-in and rate-limit counters. */
  { name: "RATE_LIMIT_SALT_KEY" },
  { name: "GOOGLE_CLIENT_SECRET" },
  /** Email provider key used to send one-time codes and notifications. */
  { name: "EMAIL_PROVIDER_API_KEY" },
] as const satisfies readonly SecretSpec[];

export const vars = [
  { name: "GATEWAY_ISSUER", required: true, deployChecked: true },
  { name: "GOOGLE_CLIENT_ID", required: false, deployChecked: true },
  /**
   * Optional, public: base64url Ed25519 public keys (`x`) of the PREVIOUS signing keys, comma separated. They stay in the
   * JWKS and keep verifying older access tokens during a key rotation (see tokens.ts).
   */
  { name: "TOKEN_PREVIOUS_PUBLIC_KEYS", required: false },
] as const satisfies readonly VarSpec[];

export const limits = {
  /** JSON bodies of the auth, account and billing routes other than the webhook. */
  small: 16 * 1024,
} as const;
