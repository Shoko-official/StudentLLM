import type { AccountStore } from "./account";
import type { AuthChallengeStore } from "./auth-challenge";
import type { ConsentStore } from "./consent";
import type { DeviceStore } from "./device";
import type { IdempotencyStore } from "./idempotency";
import type { LedgerStore, SweepRegistry } from "./ledger";
import type { ConcurrencyStore, RateLimitStore } from "./rate-limit";
import type { SessionStore } from "./session";
import type { SwitchStore } from "./switch";
import type { WebhookEventStore } from "./webhook-event";

export * from "./common";
export * from "./account";
export * from "./session";
export * from "./device";
export * from "./consent";
export * from "./ledger";
export * from "./idempotency";
export * from "./auth-challenge";
export * from "./webhook-event";
export * from "./rate-limit";
export * from "./switch";

export interface Stores {
  accounts: AccountStore;
  sessions: SessionStore;
  devices: DeviceStore;
  consents: ConsentStore;
  ledger: LedgerStore;
  sweeps: SweepRegistry;
  idempotency: IdempotencyStore;
  authChallenges: AuthChallengeStore;
  webhookEvents: WebhookEventStore;
  rateLimits: RateLimitStore;
  concurrency: ConcurrencyStore;
  switches: SwitchStore;
}
