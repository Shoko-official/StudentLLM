import type { Stores } from "../interfaces";
import { InMemoryAccountStore } from "./account";
import { InMemoryAuthChallengeStore } from "./auth-challenge";
import { InMemoryConsentStore } from "./consent";
import { InMemoryDeviceStore } from "./device";
import { InMemoryIdempotencyStore } from "./idempotency";
import { InMemoryLedgerStore } from "./ledger";
import { InMemoryConcurrencyStore } from "./concurrency";
import { InMemoryRateLimitStore } from "./rate-limit";
import { InMemorySessionStore } from "./session";
import { InMemorySweepRegistry } from "./sweep";
import { InMemorySwitchStore } from "./switch";
import { InMemoryWebhookEventStore } from "./webhook-event";

export {
  InMemoryAccountStore,
  InMemoryAuthChallengeStore,
  InMemoryConcurrencyStore,
  InMemoryConsentStore,
  InMemoryDeviceStore,
  InMemoryIdempotencyStore,
  InMemoryLedgerStore,
  InMemoryRateLimitStore,
  InMemorySessionStore,
  InMemorySweepRegistry,
  InMemorySwitchStore,
  InMemoryWebhookEventStore,
};
export { assertAllowlistedFields } from "./webhook-event";

/**
 * In-memory stores for tests and local development. State lives in one isolate and is lost on restart,
 * so this bundle must never back a production deploy (the Worker entry refuses to).
 */
export function createInMemoryStores(): Stores {
  const idempotency = new InMemoryIdempotencyStore();
  const sweeps = new InMemorySweepRegistry();
  return {
    accounts: new InMemoryAccountStore(),
    sessions: new InMemorySessionStore(),
    devices: new InMemoryDeviceStore(),
    consents: new InMemoryConsentStore(),
    ledger: new InMemoryLedgerStore(idempotency, sweeps),
    sweeps,
    idempotency,
    authChallenges: new InMemoryAuthChallengeStore(),
    webhookEvents: new InMemoryWebhookEventStore(),
    rateLimits: new InMemoryRateLimitStore(),
    concurrency: new InMemoryConcurrencyStore(),
    switches: new InMemorySwitchStore(),
  };
}
