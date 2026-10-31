// Shapes that each module's `config.ts` uses to declare what it needs from the environment. `src/config.ts`
// aggregates them, so a module adds a secret, a variable or a limit by editing only its own file.

export type BodyLimitKey = "small" | "webhook" | "chat" | "audio" | "image";

export interface SecretSpec {
  readonly name: string;
  /** Present only during a rotation (for example the previous webhook secret). */
  readonly optional?: boolean;
  /** `ed25519-pkcs8`: base64 of a PKCS8 Ed25519 private key, parse-checked in staging and production. */
  readonly format?: "ed25519-pkcs8";
}

export interface VarSpec {
  readonly name: string;
  /** Must be set (non-empty) in every environment. */
  readonly required: boolean;
  /**
   * In staging and production the value must be non-empty, must not contain a `.invalid` host and must not
   * start with `PLACEHOLDER`, so a template value from wrangler.toml cannot ship.
   */
  readonly deployChecked?: boolean;
  /**
   * Checked at config load for a non-empty value (in every environment): returning false fails closed with a
   * ConfigError that names the variable and never shows the value.
   */
  readonly valid?: (value: string) => boolean;
}

export interface ModuleConfig {
  readonly secrets: readonly SecretSpec[];
  readonly vars: readonly VarSpec[];
  /** Body-size caps in bytes that this module owns. Each `BodyLimitKey` is owned by exactly one module. */
  readonly limits: Partial<Record<BodyLimitKey, number>>;
}
