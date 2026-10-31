// TODO(owner: inference): the real caps come from the routing table (docs/cloud-plan.md, "Limits per
// request"); these defaults only make the body-size enforcement testable.

import type { SecretSpec, VarSpec } from "../../config-spec";

export const secrets = [
  /** HMAC key for the per-account pseudonym sent upstream as `user`. */
  { name: "UPSTREAM_PSEUDONYM_KEY" },
  /** First production provider: Groq. */
  { name: "GROQ_API_KEY" },
] as const satisfies readonly SecretSpec[];

export const vars = [] as const satisfies readonly VarSpec[];

export const limits = {
  chat: 12 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  image: 10 * 1024 * 1024,
} as const;
