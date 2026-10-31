// WebhookEventStore. Plan row: "Webhook ledger".

export type WebhookEventState = "processing" | "processed" | "quarantined";

/**
 * The only field names the ledger accepts: ids, status, period, price id (and currency), per the plan
 * ("an allowlist of fields (ids, status, period, price id)"). Everything else in a payload is discarded.
 */
export const WEBHOOK_FIELD_NAMES = [
  "subscription_id",
  "customer_id",
  "transaction_id",
  "adjustment_id",
  "price_id",
  "product_id",
  "status",
  "action",
  "adjustment_type",
  "currency",
  "period_start",
  "period_end",
  "cancel_at_period_end",
] as const;

export type WebhookFieldName = (typeof WEBHOOK_FIELD_NAMES)[number];
export type WebhookFields = Readonly<Partial<Record<WebhookFieldName, string | number | boolean | null>>>;

export interface WebhookEventRecord {
  eventId: string;
  eventType: string;
  occurredAt: number;
  state: WebhookEventState;
  /** Allowlisted scalar fields only. */
  fields: WebhookFields;
  /**
   * Fencing token: the attempt number of the current claim. It grows by one on every claim or takeover and
   * never restarts, even after a release.
   */
  attempt: number;
  claimedAt: number;
  updatedAt: number;
}

export type WebhookClaim =
  | { outcome: "claimed"; record: WebhookEventRecord }
  /** A claim left in `processing` for too long was taken over; the previous holder's token is now stale. */
  | { outcome: "taken_over"; record: WebhookEventRecord }
  /** Already processed or quarantined: answer 2xx without effects. */
  | { outcome: "duplicate"; record: WebhookEventRecord }
  /** Another worker is processing it right now. */
  | { outcome: "in_progress"; record: WebhookEventRecord };

export interface WebhookEventStore {
  /** Atomic claim of an event id (a unique-key insert in D1). The returned `record.attempt` is the fencing token. */
  claim(input: { eventId: string; eventType: string; occurredAt: number }, now: number, staleAfterMs: number): Promise<WebhookClaim>;
  /** Requires the fencing token of the live claim; a stale holder (after a takeover) gets null and changes nothing. */
  complete(
    eventId: string,
    attempt: number,
    state: "processed" | "quarantined",
    fields: WebhookFields,
    now: number,
  ): Promise<WebhookEventRecord | null>;
  /** A failed processing releases the claim so Paddle's retry works. Requires the fencing token. */
  release(eventId: string, attempt: number): Promise<boolean>;
  get(eventId: string): Promise<WebhookEventRecord | null>;
  listQuarantined(): Promise<WebhookEventRecord[]>;
  /**
   * The quarantined events whose `transaction_id` field is one of `transactionIds` (an index lookup, not a scan of
   * every quarantined event). Used to replay a refund or chargeback that arrived before its purchase.
   */
  findQuarantinedByTransaction(transactionIds: readonly string[]): Promise<WebhookEventRecord[]>;
  /**
   * A quarantined event was applied after all (for example a chargeback that arrived before its purchase): moves it
   * to `processed` so it is not replayed twice. False when the event is not quarantined.
   */
  markReplayed(eventId: string, now: number): Promise<boolean>;
  deleteOlderThan(beforeMs: number): Promise<number>;
}
