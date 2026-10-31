import {
  WEBHOOK_FIELD_NAMES,
  type WebhookClaim,
  type WebhookEventRecord,
  type WebhookEventStore,
  type WebhookFields,
} from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

const MAX_FIELD_VALUE_LENGTH = 128;
const ALLOWED_NAMES: ReadonlySet<string> = new Set(WEBHOOK_FIELD_NAMES);

/**
 * Defensive check: the ledger keeps only the allowlisted field names (WEBHOOK_FIELD_NAMES), each a short
 * scalar, so a whole payload (names, addresses, card details) cannot be stored by mistake.
 */
export function assertAllowlistedFields(fields: WebhookFields): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!ALLOWED_NAMES.has(name)) throw new TypeError(`webhook field "${name}" is not allowlisted`);
    const ok =
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      (typeof value === "string" && value.length <= MAX_FIELD_VALUE_LENGTH);
    if (!ok) throw new TypeError(`webhook field "${name}" must be a short scalar`);
  }
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<string, WebhookEventRecord>();
  /** Last attempt number per event id; survives `release` so a fencing token is never reused. */
  private readonly lastAttempt = new Map<string, number>();

  private nextAttempt(eventId: string): number {
    const n = (this.lastAttempt.get(eventId) ?? 0) + 1;
    this.lastAttempt.set(eventId, n);
    return n;
  }

  async claim(
    input: { eventId: string; eventType: string; occurredAt: number },
    now: number,
    staleAfterMs: number,
  ): Promise<WebhookClaim> {
    const existing = this.events.get(input.eventId);
    if (!existing) {
      const record: WebhookEventRecord = {
        eventId: input.eventId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        state: "processing",
        fields: {},
        attempt: this.nextAttempt(input.eventId),
        claimedAt: now,
        updatedAt: now,
      };
      this.events.set(record.eventId, record);
      return { outcome: "claimed", record: copy(record) };
    }
    if (existing.state !== "processing") return { outcome: "duplicate", record: copy(existing) };
    if (now - existing.claimedAt >= staleAfterMs) {
      existing.attempt = this.nextAttempt(input.eventId);
      existing.claimedAt = now;
      existing.updatedAt = now;
      return { outcome: "taken_over", record: copy(existing) };
    }
    return { outcome: "in_progress", record: copy(existing) };
  }

  async complete(eventId: string, attempt: number, state: "processed" | "quarantined", fields: WebhookFields, now: number) {
    assertAllowlistedFields(fields);
    const e = this.events.get(eventId);
    if (!e || e.state !== "processing" || e.attempt !== attempt) return null;
    e.state = state;
    e.fields = copy(fields);
    e.updatedAt = now;
    return copy(e);
  }

  async release(eventId: string, attempt: number) {
    const e = this.events.get(eventId);
    if (!e || e.state !== "processing" || e.attempt !== attempt) return false;
    this.events.delete(eventId);
    return true;
  }

  async get(eventId: string) {
    const e = this.events.get(eventId);
    return e ? copy(e) : null;
  }

  async markReplayed(eventId: string, now: number) {
    const e = this.events.get(eventId);
    if (!e || e.state !== "quarantined") return false;
    e.state = "processed";
    e.updatedAt = now;
    return true;
  }

  async listQuarantined() {
    return [...this.events.values()].filter((e) => e.state === "quarantined").map(copy);
  }

  async deleteOlderThan(beforeMs: number) {
    let n = 0;
    for (const [id, e] of [...this.events]) {
      if (e.state !== "processing" && e.updatedAt < beforeMs) {
        this.events.delete(id);
        n++;
      }
    }
    return n;
  }
}
