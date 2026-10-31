import type { Stores } from "../interfaces";
import { InMemoryAccountStore } from "./account";
import { InMemoryAuthChallengeStore } from "./auth-challenge";
import { InMemoryConsentStore } from "./consent";
import { InMemoryDeviceStore } from "./device";
import { InMemoryIdempotencyStore } from "./idempotency";
import { InMemoryLedgerStore } from "./ledger";
import { InMemorySessionStore } from "./session";
import { InMemoryWebhookEventStore } from "./webhook-event";

export {
  InMemoryAccountStore,
  InMemoryAuthChallengeStore,
  InMemoryConsentStore,
  InMemoryDeviceStore,
  InMemoryIdempotencyStore,
  InMemoryLedgerStore,
  InMemorySessionStore,
  InMemoryWebhookEventStore,
};
export { assertAllowlistedFields } from "./webhook-event";

/**
 * In-memory stores for tests and local development. State lives in one isolate and is lost on restart,
 * so this bundle must never back a production deploy (the Worker entry refuses to).
 */
export function createInMemoryStores(): Stores {
  return {
    accounts: new InMemoryAccountStore(),
    sessions: new InMemorySessionStore(),
    devices: new InMemoryDeviceStore(),
    consents: new InMemoryConsentStore(),
    ledger: new InMemoryLedgerStore(),
    idempotency: new InMemoryIdempotencyStore(),
    authChallenges: new InMemoryAuthChallengeStore(),
    webhookEvents: new InMemoryWebhookEventStore(),
  };
}
