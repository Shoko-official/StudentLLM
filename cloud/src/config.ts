// Typed configuration from the Worker's env bindings. Fails closed: a missing or invalid value is an
// error, never a silent default. Secret values are wrapped so they cannot leak through logging,
// JSON.stringify or string interpolation, and error messages carry names only.
//
// What the gateway needs is declared per module in `src/modules/<m>/config.ts` (`secrets`, `vars`,
// `limits`) and aggregated here; this file only holds the rules that apply to all of them.

import type { BodyLimitKey, ModuleConfig, SecretSpec, VarSpec } from "./config-spec";
import * as account from "./modules/account/config";
import * as auth from "./modules/auth/config";
import * as billing from "./modules/billing/config";
import * as inference from "./modules/inference/config";
import * as ops from "./modules/ops/config";

export type { BodyLimitKey } from "./config-spec";

const MODULE_CONFIGS = { auth, account, inference, billing, ops } satisfies Record<string, ModuleConfig>;

type ModuleName = keyof typeof MODULE_CONFIGS;
type SecretNameOf<M extends ModuleName> = (typeof MODULE_CONFIGS)[M]["secrets"][number]["name"];
type VarNameOf<M extends ModuleName> = (typeof MODULE_CONFIGS)[M]["vars"][number]["name"];

export type SecretName = { [M in ModuleName]: SecretNameOf<M> }[ModuleName];
export type VarName = { [M in ModuleName]: VarNameOf<M> }[ModuleName] | "ENVIRONMENT";

/** The bindings the Worker receives. All are strings; secrets are set with `wrangler secret put`. */
export type Env = Partial<Record<SecretName | VarName, string>>;

const ALL_SECRETS: readonly SecretSpec[] = Object.values(MODULE_CONFIGS).flatMap((m) => [...m.secrets]);
const ALL_VARS: readonly VarSpec[] = Object.values(MODULE_CONFIGS).flatMap((m) => [...m.vars]);

/** Secrets that every staging and production deploy must provide. */
export const REQUIRED_SECRETS: readonly SecretName[] = ALL_SECRETS.filter((s) => !s.optional).map((s) => s.name as SecretName);
/** Secrets that exist only during a rotation. */
export const OPTIONAL_SECRETS: readonly SecretName[] = ALL_SECRETS.filter((s) => s.optional).map((s) => s.name as SecretName);

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

export interface Limits {
  /** Maximum request body size in bytes per route family. */
  bodyBytes: Record<BodyLimitKey, number>;
}

const LIMIT_KEYS: readonly BodyLimitKey[] = ["small", "webhook", "chat", "audio", "image"];

function aggregateLimits(): Limits {
  const bodyBytes: Partial<Record<BodyLimitKey, number>> = {};
  for (const [moduleName, m] of Object.entries(MODULE_CONFIGS)) {
    for (const [key, value] of Object.entries(m.limits as Partial<Record<BodyLimitKey, number>>)) {
      if (bodyBytes[key as BodyLimitKey] !== undefined) throw new Error(`limit "${key}" is declared by two modules (${moduleName})`);
      bodyBytes[key as BodyLimitKey] = value;
    }
  }
  for (const key of LIMIT_KEYS) if (bodyBytes[key] === undefined) throw new Error(`no module declares the "${key}" limit`);
  return { bodyBytes: bodyBytes as Record<BodyLimitKey, number> };
}

/** Limits aggregated from the modules' `config.ts` files. */
export const DEFAULT_LIMITS: Limits = aggregateLimits();

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
  /** A non-secret variable (trimmed), or undefined when unset or empty. */
  variable(name: VarName): string | undefined;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const MIN_SECRET_BYTES = 32;
const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** True for a value that looks like a template: empty, a `.invalid` host, or a `PLACEHOLDER` marker. */
function looksLikeTemplate(value: string): boolean {
  return value.trim() === "" || /\.invalid(?![a-z0-9-])/i.test(value) || /placeholder/i.test(value);
}

/** Structural parse of a base64 PKCS8 Ed25519 private key: 48 bytes, fixed algorithm header, 32-byte seed. */
function isEd25519Pkcs8(value: string): boolean {
  let bytes: Uint8Array;
  try {
    const binary = atob(value.trim());
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return bytes.length === 48 && ED25519_PKCS8_PREFIX.every((b, i) => bytes[i] === b);
}

function requiredVar(env: Env, name: VarName): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`missing required variable ${name}`);
  return value.trim();
}

/**
 * Builds the config. In staging and production every required secret must be present at load time, at
 * least 32 bytes long (and `TOKEN_SIGNING_KEY` a PKCS8 Ed25519 key), and deploy-checked variables must not
 * be empty or template values, so a misconfigured deploy fails on its first request instead of halfway
 * through a sign-in. In development secrets are checked when first used. `ENVIRONMENT` itself has no
 * default and is not set in wrangler.toml, so a deploy that forgets it fails closed.
 */
export function loadConfig(env: Env, overrides: { limits?: Limits } = {}): Config {
  const environment = requiredVar(env, "ENVIRONMENT");
  if (environment !== "development" && environment !== "staging" && environment !== "production") {
    throw new ConfigError("ENVIRONMENT must be development, staging or production");
  }
  const deployed = environment !== "development";

  for (const spec of ALL_VARS) {
    const value = env[spec.name as VarName];
    const empty = typeof value !== "string" || value.trim() === "";
    if (spec.required && empty) throw new ConfigError(`missing required variable ${spec.name}`);
    if (spec.deployChecked && deployed && (empty || looksLikeTemplate(value!))) {
      throw new ConfigError(`variable ${spec.name} is empty or a template value; set a real one for ${environment}`);
    }
  }

  for (const spec of ALL_VARS) {
    const value = env[spec.name as VarName];
    if (spec.valid && typeof value === "string" && value.trim() !== "" && !spec.valid(value.trim())) {
      throw new ConfigError(`variable ${spec.name} is malformed`);
    }
  }

  const paddleEnvironment = requiredVar(env, "PADDLE_ENVIRONMENT");
  if (paddleEnvironment !== "sandbox" && paddleEnvironment !== "live") {
    throw new ConfigError("PADDLE_ENVIRONMENT must be sandbox or live");
  }
  const minClientVersion = requiredVar(env, "MIN_CLIENT_VERSION");
  if (!SEMVER.test(minClientVersion)) throw new ConfigError("MIN_CLIENT_VERSION must be MAJOR.MINOR.PATCH");

  const secrets = new Map<string, Secret>();
  for (const spec of ALL_SECRETS) {
    const value = env[spec.name as SecretName];
    if (typeof value === "string" && value !== "") secrets.set(spec.name, new Secret(value));
  }

  if (deployed) {
    const missing = ALL_SECRETS.filter((s) => !s.optional && !secrets.has(s.name)).map((s) => s.name);
    if (missing.length > 0) throw new ConfigError(`missing required secrets: ${missing.join(", ")}`);
    const weak: string[] = [];
    const malformed: string[] = [];
    for (const spec of ALL_SECRETS) {
      const value = env[spec.name as SecretName];
      if (typeof value !== "string" || value === "") continue;
      if (new TextEncoder().encode(value).length < MIN_SECRET_BYTES) weak.push(spec.name);
      else if (spec.format === "ed25519-pkcs8" && !isEd25519Pkcs8(value)) malformed.push(spec.name);
    }
    if (weak.length > 0) throw new ConfigError(`secrets shorter than ${MIN_SECRET_BYTES} bytes: ${weak.join(", ")}`);
    if (malformed.length > 0) throw new ConfigError(`secrets that are not a PKCS8 Ed25519 key: ${malformed.join(", ")}`);
  }

  return {
    environment,
    paddleEnvironment,
    issuer: requiredVar(env, "GATEWAY_ISSUER"),
    audience: "studentllm-gateway",
    minClientVersion,
    termsVersion: requiredVar(env, "TERMS_VERSION"),
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
    variable(name) {
      const value = env[name];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    },
  };
}
