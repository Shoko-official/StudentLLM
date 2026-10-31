// Typed configuration from the Worker's env bindings. Fails closed: a missing or invalid value is an
// error, never a silent default. Secret values are wrapped so they cannot leak through logging,
// JSON.stringify or string interpolation, and error messages carry names only.

/** Secrets that every staging and production deploy must provide (docs/cloud-plan.md, Security requirements). */
export const REQUIRED_SECRETS = [
  "TOKEN_SIGNING_KEY",
  "CODE_HMAC_KEY",
  "UPSTREAM_PSEUDONYM_KEY",
  "RATE_LIMIT_SALT_KEY",
  "GOOGLE_CLIENT_SECRET",
  "EMAIL_PROVIDER_API_KEY",
  "GROQ_API_KEY",
  "PADDLE_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
] as const;

/** Secrets that exist only during a rotation. */
export const OPTIONAL_SECRETS = ["PADDLE_WEBHOOK_SECRET_PREVIOUS"] as const;

export type RequiredSecretName = (typeof REQUIRED_SECRETS)[number];
export type SecretName = RequiredSecretName | (typeof OPTIONAL_SECRETS)[number];

/** The bindings the Worker receives. All are strings; secrets are set with `wrangler secret put`. */
export type Env = Partial<Record<SecretName, string>> & {
  ENVIRONMENT?: string;
  PADDLE_ENVIRONMENT?: string;
  GATEWAY_ISSUER?: string;
  MIN_CLIENT_VERSION?: string;
  TERMS_VERSION?: string;
  GOOGLE_CLIENT_ID?: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A secret value that prints as `[redacted]` everywhere except through `reveal()`. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

export type BodyLimitKey = "small" | "webhook" | "chat" | "audio" | "image";

export interface Limits {
  /** Maximum request body size in bytes per route family. */
  bodyBytes: Record<BodyLimitKey, number>;
}

/**
 * Defaults for the scaffold. TODO(owner: inference): the real values come from the routing table
 * (docs/cloud-plan.md, "Limits per request"); these only make the body-size enforcement testable.
 */
export const DEFAULT_LIMITS: Limits = {
  bodyBytes: {
    small: 16 * 1024,
    webhook: 256 * 1024,
    chat: 12 * 1024 * 1024,
    audio: 25 * 1024 * 1024,
    image: 10 * 1024 * 1024,
  },
};

export type Environment = "development" | "staging" | "production";

export interface Config {
  readonly environment: Environment;
  readonly paddleEnvironment: "sandbox" | "live";
  /** `iss` of access tokens. */
  readonly issuer: string;
  /** `aud` of access tokens (fixed by the contract). */
  readonly audience: "studentllm-gateway";
  readonly minClientVersion: string;
  /** Current terms version; an older acceptance gives `terms_required`. */
  readonly termsVersion: string;
  readonly googleClientId: string;
  readonly limits: Limits;
  /** Returns the secret or throws ConfigError naming it. Never returns an empty value. */
  secret(name: SecretName): Secret;
  hasSecret(name: SecretName): boolean;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

function requiredVar(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`missing required variable ${name}`);
  return value.trim();
}

/**
 * Builds the config. In staging and production every required secret must be present at load time, so a
 * misconfigured deploy fails on its first request instead of halfway through a sign-in. In development
 * secrets are checked when first used, so a developer can run just the routes they work on.
 */
export function loadConfig(env: Env, overrides: { limits?: Limits } = {}): Config {
  const environment = requiredVar(env, "ENVIRONMENT");
  if (environment !== "development" && environment !== "staging" && environment !== "production") {
    throw new ConfigError("ENVIRONMENT must be development, staging or production");
  }
  const paddleEnvironment = requiredVar(env, "PADDLE_ENVIRONMENT");
  if (paddleEnvironment !== "sandbox" && paddleEnvironment !== "live") {
    throw new ConfigError("PADDLE_ENVIRONMENT must be sandbox or live");
  }
  const minClientVersion = requiredVar(env, "MIN_CLIENT_VERSION");
  if (!SEMVER.test(minClientVersion)) throw new ConfigError("MIN_CLIENT_VERSION must be MAJOR.MINOR.PATCH");
  const issuer = requiredVar(env, "GATEWAY_ISSUER");
  const termsVersion = requiredVar(env, "TERMS_VERSION");

  const secrets = new Map<SecretName, Secret>();
  for (const name of [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) {
    const value = env[name];
    if (typeof value === "string" && value !== "") secrets.set(name, new Secret(value));
  }

  if (environment !== "development") {
    const missing = REQUIRED_SECRETS.filter((name) => !secrets.has(name));
    if (missing.length > 0) throw new ConfigError(`missing required secrets: ${missing.join(", ")}`);
  }

  return {
    environment,
    paddleEnvironment,
    issuer,
    audience: "studentllm-gateway",
    minClientVersion,
    termsVersion,
    googleClientId: typeof env.GOOGLE_CLIENT_ID === "string" ? env.GOOGLE_CLIENT_ID : "",
    limits: overrides.limits ?? DEFAULT_LIMITS,
    secret(name) {
      const secret = secrets.get(name);
      if (!secret) throw new ConfigError(`missing secret ${name}`);
      return secret;
    },
    hasSecret(name) {
      return secrets.has(name);
    },
  };
}
