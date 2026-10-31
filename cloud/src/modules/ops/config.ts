import type { SecretSpec, VarSpec } from "../../config-spec";

export const secrets = [] as const satisfies readonly SecretSpec[];

export const vars = [
  /** Minimum supported client version (`MAJOR.MINOR.PATCH`), served by GET /v1/status. */
  { name: "MIN_CLIENT_VERSION", required: true },
] as const satisfies readonly VarSpec[];

export const limits = {} as const;
