import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LIMITS, loadConfig, OPTIONAL_SECRETS, REQUIRED_SECRETS, Secret } from "./config";
import { testEnv } from "./testing";

describe("loadConfig", () => {
  it("builds a typed config from the bindings", () => {
    const config = loadConfig(testEnv());
    expect(config.environment).toBe("development");
    expect(config.audience).toBe("studentllm-gateway");
    expect(config.minClientVersion).toBe("0.2.0");
    expect(config.secret("CODE_HMAC_KEY").reveal()).toContain("test-only-code_hmac_key");
  });

  it("aggregates the secrets, variables and limits that each module declares", () => {
    expect([...REQUIRED_SECRETS].sort()).toEqual(
      [
        "CODE_HMAC_KEY",
        "EMAIL_PROVIDER_API_KEY",
        "GOOGLE_CLIENT_SECRET",
        "GROQ_API_KEY",
        "PADDLE_API_KEY",
        "PADDLE_WEBHOOK_SECRET",
        "RATE_LIMIT_SALT_KEY",
        "TOKEN_SIGNING_KEY",
        "UPSTREAM_PSEUDONYM_KEY",
      ].sort(),
    );
    expect(OPTIONAL_SECRETS).toEqual(["PADDLE_WEBHOOK_SECRET_PREVIOUS"]);
    expect(Object.keys(DEFAULT_LIMITS.bodyBytes).sort()).toEqual(["audio", "chat", "image", "small", "webhook"]);
  });

  it("lists every required secret name in .dev.vars.example, with an empty value", () => {
    const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
    for (const name of [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
    expect(example).toMatch(/^ENVIRONMENT=development$/m);
  });

  it("fails closed on missing or invalid variables, including ENVIRONMENT itself", () => {
    for (const name of ["ENVIRONMENT", "PADDLE_ENVIRONMENT", "GATEWAY_ISSUER", "MIN_CLIENT_VERSION", "TERMS_VERSION"] as const) {
      expect(() => loadConfig(testEnv({ [name]: undefined })), name).toThrow(ConfigError);
      expect(() => loadConfig(testEnv({ [name]: "  " })), name).toThrow(ConfigError);
    }
    expect(() => loadConfig(testEnv({ ENVIRONMENT: "prod" }))).toThrow(/ENVIRONMENT/);
    expect(() => loadConfig(testEnv({ PADDLE_ENVIRONMENT: "test" }))).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => loadConfig(testEnv({ MIN_CLIENT_VERSION: "latest" }))).toThrow(/MIN_CLIENT_VERSION/);
  });

  it("does not set ENVIRONMENT in wrangler.toml, so a deploy that forgets it fails closed", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).not.toMatch(/^\s*ENVIRONMENT\s*=/m);
  });

  it("requires every secret at load time in staging and production", () => {
    for (const environment of ["staging", "production"]) {
      expect(() => loadConfig(testEnv({ ENVIRONMENT: environment, TOKEN_SIGNING_KEY: undefined }))).toThrow(/TOKEN_SIGNING_KEY/);
      expect(() => loadConfig(testEnv({ ENVIRONMENT: environment, PADDLE_WEBHOOK_SECRET: "" }))).toThrow(/PADDLE_WEBHOOK_SECRET/);
      expect(() => loadConfig(testEnv({ ENVIRONMENT: environment }))).not.toThrow();
    }
  });

  it("lists every missing secret by name and never by value", () => {
    const env = testEnv({ ENVIRONMENT: "production", GROQ_API_KEY: undefined, PADDLE_API_KEY: undefined });
    try {
      loadConfig(env);
      throw new Error("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("GROQ_API_KEY");
      expect(message).toContain("PADDLE_API_KEY");
      expect(message).not.toContain("test-only");
    }
  });

  it("checks secrets lazily in development, and treats an empty value as missing", () => {
    const config = loadConfig(testEnv({ GROQ_API_KEY: "" }));
    expect(config.hasSecret("GROQ_API_KEY")).toBe(false);
    expect(() => config.secret("GROQ_API_KEY")).toThrow(/GROQ_API_KEY/);
    expect(config.hasSecret("PADDLE_WEBHOOK_SECRET_PREVIOUS")).toBe(true);
  });

  it("treats the rotation secret as optional", () => {
    const config = loadConfig(testEnv({ ENVIRONMENT: "production", PADDLE_WEBHOOK_SECRET_PREVIOUS: undefined }));
    expect(config.hasSecret("PADDLE_WEBHOOK_SECRET_PREVIOUS")).toBe(false);
  });
});

describe("deploy checks (staging and production)", () => {
  for (const environment of ["staging", "production"] as const) {
    describe(environment, () => {
      const env = (over = {}) => testEnv({ ENVIRONMENT: environment, ...over });

      it("rejects an empty GOOGLE_CLIENT_ID", () => {
        expect(() => loadConfig(env({ GOOGLE_CLIENT_ID: "" }))).toThrow(/GOOGLE_CLIENT_ID/);
        expect(() => loadConfig(env({ GOOGLE_CLIENT_ID: undefined }))).toThrow(/GOOGLE_CLIENT_ID/);
      });

      it("rejects .invalid hosts and PLACEHOLDER values", () => {
        expect(() => loadConfig(env({ GATEWAY_ISSUER: "https://api.example.invalid" }))).toThrow(/GATEWAY_ISSUER/);
        expect(() => loadConfig(env({ TERMS_VERSION: "PLACEHOLDER-terms-version" }))).toThrow(/TERMS_VERSION/);
        expect(() => loadConfig(env({ GOOGLE_CLIENT_ID: "[PLACEHOLDER: client id]" }))).toThrow(/GOOGLE_CLIENT_ID/);
        expect(() => loadConfig(env({ GATEWAY_ISSUER: "https://api.studentllm.example" }))).not.toThrow();
      });

      it("rejects secrets shorter than 32 bytes and names them", () => {
        expect(() => loadConfig(env({ CODE_HMAC_KEY: "x".repeat(31) }))).toThrow(/shorter than 32 bytes: CODE_HMAC_KEY/);
        expect(() => loadConfig(env({ CODE_HMAC_KEY: "x".repeat(32) }))).not.toThrow();
        expect(() => loadConfig(env({ PADDLE_WEBHOOK_SECRET_PREVIOUS: "short" }))).toThrow(/PADDLE_WEBHOOK_SECRET_PREVIOUS/);
      });

      it("parse-checks TOKEN_SIGNING_KEY as a PKCS8 Ed25519 key", () => {
        for (const bad of ["x".repeat(64), btoa("y".repeat(48)), btoa("z".repeat(40)), "not base64 !!".padEnd(40, "!")]) {
          expect(() => loadConfig(env({ TOKEN_SIGNING_KEY: bad })), bad).toThrow(/PKCS8|shorter/);
        }
        expect(() => loadConfig(env())).not.toThrow(); // the fake test key has the right structure
      });

      it("never prints a rejected value", () => {
        try {
          loadConfig(env({ CODE_HMAC_KEY: "super-secret-but-short" }));
        } catch (error) {
          expect((error as Error).message).not.toContain("super-secret");
        }
      });
    });
  }

  it("does not apply the deploy checks in development", () => {
    expect(() => loadConfig(testEnv({ GOOGLE_CLIENT_ID: "", GATEWAY_ISSUER: "https://api.example.invalid", CODE_HMAC_KEY: "short" }))).not.toThrow();
  });

  it("rejects the template values of wrangler.toml in staging and production", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/api\.example\.invalid/);
    expect(() => loadConfig(testEnv({ ENVIRONMENT: "production", GATEWAY_ISSUER: "https://api.example.invalid", TERMS_VERSION: "PLACEHOLDER-terms-version", GOOGLE_CLIENT_ID: "" }))).toThrow(ConfigError);
  });
});

describe("Secret", () => {
  it("never prints its value", () => {
    const s = new Secret("super-secret-value");
    expect(String(s)).toBe("[redacted]");
    expect(`${s}`).toBe("[redacted]");
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(inspect(s)).toBe("[redacted]");
    expect(s.reveal()).toBe("super-secret-value");
  });

  it("does not leak through the config object", () => {
    const config = loadConfig(testEnv());
    const dumped = JSON.stringify(config) + inspect(config, { depth: 6 });
    expect(dumped).not.toContain("test-only");
  });
});
