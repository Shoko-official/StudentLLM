import type { Config } from "./config";
import { randomToken } from "./crypto/random";
import { createAccountDeps, type AccountDeps } from "./modules/account";
import { createAuthDeps, type AuthDeps } from "./modules/auth";
import { createBillingDeps, type BillingDeps } from "./modules/billing";
import { createInferenceDeps, type InferenceDeps } from "./modules/inference";
import { createOpsDeps, type OpsDeps } from "./modules/ops";
import type { Stores } from "./storage";

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/**
 * The only thing the gateway logs per request (docs/cloud-api.md: request id, account id, route,
 * status, credits and latency). The type has no field for a body, a prompt or a token, so a log call
 * cannot carry content.
 */
export interface RequestLogEntry {
  requestId: string;
  accountId: string | null;
  method: string;
  /** The route pattern, for example `/v1/devices/{device_id}`, or `unmatched`. */
  route: string;
  status: number;
  creditsCharged: number | null;
  latencyMs: number;
}

export interface Logger {
  request(entry: RequestLogEntry): void;
}

export interface CoreDeps {
  config: Config;
  clock: Clock;
  stores: Stores;
  ids: { requestId(): string };
  /** Outbound fetch (providers, Google, Paddle, email). Injected so tests make no network call. */
  fetch: typeof fetch;
  log: Logger;
}

/** One deps object per module; each module owns its type in its own `index.ts`. */
export interface ModuleDeps {
  auth: AuthDeps;
  account: AccountDeps;
  inference: InferenceDeps;
  billing: BillingDeps;
  ops: OpsDeps;
}

/**
 * Core services plus the module deps. `createDeps` is synchronous: a dep that needs `await` to build (an imported
 * key, a fetched JWKS) is stored as a memoized getter, see `lazy()` in src/lazy.ts.
 */
export interface Deps extends CoreDeps, ModuleDeps {}

export const systemClock: Clock = { now: () => Date.now() };

export function defaultRequestId(): string {
  return randomToken("req_", 16);
}

export const silentLogger: Logger = { request: () => undefined };

/** Console logger for the Worker: one JSON line per request, fields from RequestLogEntry only. */
export const consoleLogger: Logger = {
  request(entry) {
    console.log(JSON.stringify(entry));
  },
};

export function createDeps(core: CoreDeps, overrides: Partial<ModuleDeps> = {}): Deps {
  return {
    ...core,
    auth: overrides.auth ?? createAuthDeps(core),
    account: overrides.account ?? createAccountDeps(core),
    inference: overrides.inference ?? createInferenceDeps(core),
    billing: overrides.billing ?? createBillingDeps(core),
    ops: overrides.ops ?? createOpsDeps(core),
  };
}
