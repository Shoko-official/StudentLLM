import type { WebhookClaim, WebhookEventRecord, WebhookEventStore, WebhookFields } from "../interfaces";

const copy = <T>(value: T): T => structuredClone(value);

const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELD_VALUE_LENGTH = 128;

/**
 * Defensive check: the ledger keeps flat, short, scalar fields only, so a whole payload (names,
 * addresses, card details) cannot be stored by mistake. The billing module chooses the allowlist.
 */
export function assertAllowlistedFields(fields: WebhookFields): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name)) throw new TypeError(`webhook field name "${name}" is not allowed`);
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
        claimedAt: now,
        updatedAt: now,
      };
      this.events.set(record.eventId, record);
      return { outcome: "claimed", record: copy(record) };
    }
    if (existing.state !== "processing") return { outcome: "duplicate", record: copy(existing) };
    if (now - existing.claimedAt >= staleAfterMs) {
      existing.claimedAt = now;
      existing.updatedAt = now;
      return { outcome: "taken_over", record: copy(existing) };
    }
    return { outcome: "in_progress", record: copy(existing) };
  }

  async complete(eventId: string, state: "processed" | "quarantined", fields: WebhookFields, now: number) {
    assertAllowlistedFields(fields);
    const e = this.events.get(eventId);
    if (!e || e.state !== "processing") return null;
    e.state = state;
    e.fields = copy(fields);
    e.updatedAt = now;
    return copy(e);
  }

  async release(eventId: string) {
    const e = this.events.get(eventId);
    if (!e || e.state !== "processing") return false;
    this.events.delete(eventId);
    return true;
  }

  async get(eventId: string) {
    const e = this.events.get(eventId);
    return e ? copy(e) : null;
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
