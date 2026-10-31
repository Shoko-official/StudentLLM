import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, REQUIRED_SECRETS, Secret } from "./config";
import { testEnv } from "./testing";

describe("loadConfig", () => {
  it("builds a typed config from the bindings", () => {
    const config = loadConfig(testEnv());
    expect(config.environment).toBe("development");
    expect(config.audience).toBe("studentllm-gateway");
    expect(config.minClientVersion).toBe("0.2.0");
    expect(config.secret("CODE_HMAC_KEY").reveal()).toBe("test-only-code_hmac_key");
  });

  it("fails closed on missing or invalid variables", () => {
    for (const name of ["ENVIRONMENT", "PADDLE_ENVIRONMENT", "GATEWAY_ISSUER", "MIN_CLIENT_VERSION", "TERMS_VERSION"] as const) {
      expect(() => loadConfig(testEnv({ [name]: undefined })), name).toThrow(ConfigError);
      expect(() => loadConfig(testEnv({ [name]: "  " })), name).toThrow(ConfigError);
    }
    expect(() => loadConfig(testEnv({ ENVIRONMENT: "prod" }))).toThrow(/ENVIRONMENT/);
    expect(() => loadConfig(testEnv({ PADDLE_ENVIRONMENT: "test" }))).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => loadConfig(testEnv({ MIN_CLIENT_VERSION: "latest" }))).toThrow(/MIN_CLIENT_VERSION/);
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
    expect(REQUIRED_SECRETS).toContain("UPSTREAM_PSEUDONYM_KEY");
  });

  it("treats the rotation secret as optional", () => {
    const config = loadConfig(testEnv({ ENVIRONMENT: "production", PADDLE_WEBHOOK_SECRET_PREVIOUS: undefined }));
    expect(config.hasSecret("PADDLE_WEBHOOK_SECRET_PREVIOUS")).toBe(false);
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
