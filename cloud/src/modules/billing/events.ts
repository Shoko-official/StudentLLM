// Paddle webhook payloads, reduced to an allowlist. Nothing outside the fields read here is kept: no name, no
// address, no tax id, no card data and no free-form field ever leaves this file, so none can be persisted or logged.
//
// VERIFY BEFORE LAUNCH: event names and field paths follow Paddle Billing as the plan's authors understood it
// (docs/cloud-plan.md "Before phase 3"). The contract's PaddleEvent is deliberately loose: event_id,
// event_type, occurred_at and a `data` object.

import type { WebhookEventRecord, WebhookFields } from "../../storage";

export type EventKind = "subscription" | "transaction" | "adjustment" | "other";

export interface NormalizedEvent {
  eventId: string;
  eventType: string;
  occurredAt: number;
  kind: EventKind;
  subscriptionId: string | null;
  customerId: string | null;
  transactionId: string | null;
  adjustmentId: string | null;
  /** Price ids of the items, in order, at most 10. */
  priceIds: string[];
  status: string | null;
  action: string | null;
  /** An adjustment's `type`: `full` or `partial`. */
  adjustmentType: string | null;
  /** How many items the payload lists (a transaction event without any is malformed). */
  itemCount: number;
  currency: string | null;
  periodStart: number | null;
  periodEnd: number | null;
  /** True: a cancel (or pause) is scheduled; false: none is; null: the event does not say. */
  cancelAtPeriodEnd: boolean | null;
  /** `custom_data.account_id`: used only to bind the FIRST event of a purchase to an account. Never stored. */
  accountHint: string | null;
}

export class EventShapeError extends Error {
  constructor() {
    super("invalid webhook event");
    this.name = "EventShapeError";
  }
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHORT_WORD = /^[a-z][a-z0-9_]{0,40}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const MAX_ITEMS = 10;

const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.resumed",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
  "subscription.trialing",
  "subscription.imported",
]);

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function word(value: unknown): string | null {
  return typeof value === "string" && SHORT_WORD.test(value) ? value : null;
}

function time(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}[Tt]/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function kindOfEventType(eventType: string): EventKind {
  if (SUBSCRIPTION_EVENTS.has(eventType)) return "subscription";
  if (eventType === "transaction.completed") return "transaction";
  if (eventType === "adjustment.created" || eventType === "adjustment.updated") return "adjustment";
  return "other";
}

/**
 * Validates the envelope the contract requires (event_id, event_type, occurred_at) and reads the allowlisted
 * data fields. Throws EventShapeError for a body that is not a Paddle event at all (a 400), never for an
 * event type or a field this gateway does not know: those are simply not read.
 */
export function normalizeEvent(raw: unknown): NormalizedEvent {
  const root = obj(raw);
  if (!root) throw new EventShapeError();
  const eventId = typeof root.event_id === "string" && EVENT_ID.test(root.event_id) ? root.event_id : null;
  const eventType = typeof root.event_type === "string" && EVENT_TYPE.test(root.event_type) ? root.event_type : null;
  const occurredAt = time(root.occurred_at);
  if (eventId === null || eventType === null || occurredAt === null) throw new EventShapeError();

  const kind = kindOfEventType(eventType);
  const data = obj(root.data) ?? {};
  const ev: NormalizedEvent = {
    eventId,
    eventType,
    occurredAt,
    kind,
    subscriptionId: null,
    customerId: id(data.customer_id),
    transactionId: null,
    adjustmentId: null,
    priceIds: [],
    status: word(data.status),
    action: word(data.action),
    adjustmentType: kind === "adjustment" ? word(data.type) : null,
    itemCount: Array.isArray(data.items) ? data.items.length : 0,
    currency: typeof data.currency_code === "string" && CURRENCY.test(data.currency_code) ? data.currency_code.toUpperCase() : null,
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    accountHint: null,
  };

  if (kind === "subscription") {
    ev.subscriptionId = id(data.id);
    const period = obj(data.current_billing_period);
    ev.periodStart = time(period?.starts_at);
    ev.periodEnd = time(period?.ends_at);
  } else if (kind === "transaction") {
    ev.transactionId = id(data.id);
    ev.subscriptionId = id(data.subscription_id);
    const period = obj(data.billing_period);
    ev.periodStart = time(period?.starts_at);
    ev.periodEnd = time(period?.ends_at);
  } else if (kind === "adjustment") {
    ev.adjustmentId = id(data.id);
    ev.transactionId = id(data.transaction_id);
    ev.subscriptionId = id(data.subscription_id);
  }

  if ("scheduled_change" in data) {
    const change = obj(data.scheduled_change);
    ev.cancelAtPeriodEnd = change !== null && (change.action === "cancel" || change.action === "pause");
  }

  if (Array.isArray(data.items)) {
    for (const item of data.items.slice(0, MAX_ITEMS)) {
      const entry = obj(item);
      const price = id(obj(entry?.price)?.id) ?? id(entry?.price_id);
      if (price !== null) ev.priceIds.push(price);
    }
  }

  const hint = obj(data.custom_data)?.account_id;
  ev.accountHint = typeof hint === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(hint) ? hint : null;
  return ev;
}

/** The ledger fields of an event: the plan's allowlist (ids, status, period, price id, currency) and nothing else. */
export function ledgerFields(ev: NormalizedEvent): WebhookFields {
  const fields: Record<string, string | number | boolean | null> = {};
  const put = (name: string, value: string | number | boolean | null): void => {
    if (value !== null) fields[name] = value;
  };
  put("subscription_id", ev.subscriptionId);
  put("customer_id", ev.customerId);
  put("transaction_id", ev.transactionId);
  put("adjustment_id", ev.adjustmentId);
  put("price_id", ev.priceIds[0] ?? null);
  put("status", ev.status);
  put("action", ev.action);
  put("adjustment_type", ev.adjustmentType);
  put("currency", ev.currency);
  put("period_start", ev.periodStart);
  put("period_end", ev.periodEnd);
  put("cancel_at_period_end", ev.cancelAtPeriodEnd);
  return fields as WebhookFields;
}

/**
 * Rebuilds the part of an event the plan model reads from what the ledger kept (the allowlisted fields), so a
 * quarantined adjustment can be replayed later. Only adjustments are replayed; `accountHint` is never stored.
 */
export function eventFromRecord(record: WebhookEventRecord): NormalizedEvent | null {
  const f = record.fields;
  const str = (k: keyof typeof f): string | null => (typeof f[k] === "string" ? (f[k] as string) : null);
  const kind = kindOfEventType(record.eventType);
  if (kind !== "adjustment") return null;
  return {
    eventId: record.eventId,
    eventType: record.eventType,
    occurredAt: record.occurredAt,
    kind,
    subscriptionId: str("subscription_id"),
    customerId: str("customer_id"),
    transactionId: str("transaction_id"),
    adjustmentId: str("adjustment_id"),
    priceIds: [],
    status: str("status"),
    action: str("action"),
    adjustmentType: str("adjustment_type"),
    itemCount: 0,
    currency: str("currency"),
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    accountHint: null,
  };
}
