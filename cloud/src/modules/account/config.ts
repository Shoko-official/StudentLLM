import type { SecretSpec, VarSpec } from "../../config-spec";

export const secrets = [] as const satisfies readonly SecretSpec[];

export const vars = [
  /** Current terms version; an older acceptance gives `terms_required`. */
  { name: "TERMS_VERSION", required: true, deployChecked: true },
] as const satisfies readonly VarSpec[];

export const limits = {} as const;
