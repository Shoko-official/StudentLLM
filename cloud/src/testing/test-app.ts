// Test-only wiring: the app with in-memory stores, a manual clock, deterministic request ids and a
// recording logger. No network call is possible: the injected `fetch` throws.

import { createApp, type App, type AppOptions } from "../app";
import { loadConfig, REQUIRED_SECRETS, OPTIONAL_SECRETS, type Config, type Env } from "../config";
import { createDeps, type Deps, type RequestLogEntry } from "../deps";
import type { Stores } from "../storage";
import { createInMemoryStores } from "../storage";

/** 2026-11-01T09:30:00Z, the time used by the fixtures. */
export const TEST_START_MS = Date.UTC(2026, 10, 1, 9, 30, 0);

export class ManualClock {
  constructor(private ms = TEST_START_MS) {}
  now(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Fake, test-only values. They are not real credentials. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    ENVIRONMENT: "development",
    PADDLE_ENVIRONMENT: "sandbox",
    GATEWAY_ISSUER: "https://api.example.invalid",
    MIN_CLIENT_VERSION: "0.2.0",
    TERMS_VERSION: "2026-11-01",
    GOOGLE_CLIENT_ID: "test-google-client-id",
  };
  for (const name of [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) env[name] = `test-only-${name.toLowerCase()}`;
  return { ...env, ...overrides };
}

export interface TestAppOptions extends AppOptions {
  env?: Partial<Env>;
  config?: Config;
  stores?: Stores;
}

export interface TestApp {
  app: App;
  deps: Deps;
  stores: Stores;
  clock: ManualClock;
  /** Everything the gateway logged, one entry per request. */
  logs: RequestLogEntry[];
  /** Sends a request to the app. `path` is relative to https://api.example.invalid. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function makeTestApp(options: TestAppOptions = {}): TestApp {
  const clock = new ManualClock();
  const stores = options.stores ?? createInMemoryStores();
  const logs: RequestLogEntry[] = [];
  let counter = 0;
  const deps = createDeps({
    config: options.config ?? loadConfig(testEnv(options.env)),
    clock,
    stores,
    ids: { requestId: () => `req_test_${String(++counter).padStart(6, "0")}` },
    fetch: () => {
      throw new Error("network access is not allowed in tests");
    },
    log: { request: (entry) => void logs.push(entry) },
  });
  const app = createApp(deps, { hooks: options.hooks });
  return {
    app,
    deps,
    stores,
    clock,
    logs,
    request: (path, init) => app.handle(new Request(new URL(path, "https://api.example.invalid"), init)),
  };
}
