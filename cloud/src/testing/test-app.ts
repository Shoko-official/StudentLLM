// Test-only wiring: the app with in-memory stores, a manual clock, deterministic request ids and a
// recording logger. No network call is possible unless a test injects `fetch`.

import { createApp, registerRoutes as registerModuleRoutes, type App, type AppOptions } from "../app";
import { loadConfig, OPTIONAL_SECRETS, REQUIRED_SECRETS, type Config, type Env } from "../config";
import { createDeps, type Deps, type ModuleDeps, type RequestLogEntry } from "../deps";
import type { Principal, Step } from "../http/context";
import { Router } from "../http/router";
import { notImplemented } from "../http/stub";
import type { ExecutionContext } from "../platform";
import type { AccountRecord, PlanRecord, Stores } from "../storage";
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

/** A structurally valid PKCS8 Ed25519 key made of zero bytes. Fake: it signs nothing anyone trusts. */
const FAKE_PKCS8 = btoa(
  String.fromCharCode(...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], ...new Array(32).fill(0)),
);

/** Fake, test-only values (32+ bytes so they pass the deploy checks). They are not real credentials. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    ENVIRONMENT: "development",
    PADDLE_ENVIRONMENT: "sandbox",
    GATEWAY_ISSUER: "https://gateway.test.example",
    MIN_CLIENT_VERSION: "0.2.0",
    TERMS_VERSION: "2026-11-01",
    GOOGLE_CLIENT_ID: "test-google-client-id",
  };
  for (const name of [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]) {
    env[name] = name === "TOKEN_SIGNING_KEY" ? FAKE_PKCS8 : `test-only-${name.toLowerCase()}-${"x".repeat(32)}`;
  }
  return { ...env, ...overrides };
}

/**
 * Registers every route of the modules with the `notImplemented` handler and the modules' own route meta. For
 * pipeline tests that want the contract's route table without any module logic behind it.
 */
export function registerStubRoutes(router: Router, deps: Deps): void {
  const real = new Router();
  registerModuleRoutes(real, deps);
  for (const route of real.routes()) router.add(route.method, route.pattern, notImplemented, route.meta);
}

export interface TestAppOptions extends AppOptions {
  /** Serve every module route as the 501 stub (see `registerStubRoutes`). Ignored when `registerRoutes` is set. */
  stubRoutes?: boolean;
  env?: Partial<Env>;
  config?: Config;
  stores?: Stores;
  /** Replaces the module deps (partially); the rest are the modules' defaults. */
  deps?: Partial<ModuleDeps>;
  /** Outbound fetch for providers, Google, Paddle and email. The default throws: no network in tests. */
  fetch?: typeof fetch;
  /** Share a clock with the test, or let `makeTestApp` create one. */
  clock?: ManualClock;
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
  const clock = options.clock ?? new ManualClock();
  const stores = options.stores ?? createInMemoryStores();
  const logs: RequestLogEntry[] = [];
  let counter = 0;
  const deps = createDeps(
    {
      config: options.config ?? loadConfig(testEnv(options.env)),
      clock,
      stores,
      ids: { requestId: () => `req_test_${String(++counter).padStart(6, "0")}` },
      fetch:
        options.fetch ??
        (() => {
          throw new Error("network access is not allowed in tests");
        }),
      log: { request: (entry) => void logs.push(entry) },
    },
    options.deps,
  );
  const app = createApp(deps, {
    hooks: options.hooks,
    allowMissingHooks: options.allowMissingHooks,
    withoutModuleHooks: options.withoutModuleHooks,
    registerRoutes: options.registerRoutes ?? (options.stubRoutes ? registerStubRoutes : undefined),
  });
  return {
    app,
    deps,
    stores,
    clock,
    logs,
    request: (path, init) => app.handle(new Request(new URL(path, "https://api.example.invalid"), init)),
  };
}

/** An access-token principal whose `auth_time` is the test clock's start (a fresh sign-in). */
export function accessPrincipal(overrides: Partial<Extract<Principal, { kind: "access" }>> = {}): Principal {
  return {
    kind: "access",
    accountId: "acc_test",
    sessionId: "sid_test",
    deviceId: "dev_test",
    authTime: Math.floor(TEST_START_MS / 1000),
    tokenId: "jti_test",
    ...overrides,
  };
}

/**
 * An `authenticate` hook for tests that sets a fixed principal (and optionally the account and plan, so the
 * built-in account step does not need them in the store). Pass it as `hooks: { authenticate: ... }`.
 */
export function fakeAuthenticate(principal: Principal, extras: { account?: AccountRecord; plan?: PlanRecord | null } = {}): Step {
  return (ctx) => {
    ctx.principal = principal;
    if (extras.account) ctx.account = extras.account;
    if (extras.plan !== undefined) ctx.plan = extras.plan;
  };
}

/** An `ExecutionContext` that records `waitUntil` promises; `settled()` awaits them all. */
export function fakeExecutionContext(): ExecutionContext & { settled(): Promise<void> } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p) => void promises.push(p),
    settled: async () => void (await Promise.allSettled(promises)),
  };
}
