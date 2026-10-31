// Outbound notifications of the billing module, behind a small interface so a test injects a fake and the
// auth module's EmailSender can back it later. Nothing here carries content, a name, an address or a card detail:
// account, subscription, customer and event ids and fixed reason words only.

/** An event the operator should look at. Fixed vocabulary; never provider text. */
export type OperatorAlert =
  | { kind: "webhook_quarantined"; eventId: string; reason: string; subscriptionId?: string; customerId?: string }
  | { kind: "cancel_failing"; accountId: string; attempts: number; subscriptionId: string }
  /** The account had no Paddle customer id and took the first event's (checkout normally creates it first). */
  | { kind: "customer_adopted"; accountId: string; customerId: string }
  | { kind: "purchase_while_deleting"; accountId: string }
  /** A partial refund changes no window (a proportional withdrawal refund is normal); someone should look. */
  | { kind: "partial_refund"; accountId: string; transactionId: string | null };

/** A decision for the owner (not an incident). A stub today; the admin interface will list these. */
export type OwnerReview = { kind: "chargeback"; accountId: string; transactionId: string | null };

/**
 * What the purchase took from a complimentary grant (see `syncWindows`): one entry per window that was cut or removed.
 * `remaining` is what was left unused in it. The admin refund-restores-remainder rule is built on this.
 */
export interface GrantCut {
  grantId: string;
  windowStart: number;
  previousEnd: number;
  /** Where the window ends now; null when it was removed or revoked as a whole. */
  newEnd: number | null;
  limit: number;
  used: number;
  remaining: number;
}

export interface BillingNotifier {
  /**
   * Tells the account holder that the subscription will end (`period_end`, with the date) or has ended (`now`).
   * The implementation looks up the address itself; the billing module never handles it.
   */
  subscriptionCancelled(input: { accountId: string; when: "period_end" | "now"; effectiveAt: number | null }): Promise<void>;
  alertOperator(alert: OperatorAlert): Promise<void>;
  requestOwnerReview(item: OwnerReview): Promise<void>;
  /** A purchase cut a complimentary grant. The admin service decides what that means for its grant record and mails. */
  grantCut(input: { accountId: string; cuts: GrantCut[] }): Promise<void>;
}

/**
 * The default until the auth module's EmailSender exists (TODO(owner: auth): back `subscriptionCancelled` with it) and
 * the admin interface exists (TODO(owner: ops): back `requestOwnerReview` and `grantCut`). Alerts go to the platform
 * log as one fixed line with ids; the rest does nothing yet.
 */
export const defaultNotifier: BillingNotifier = {
  async subscriptionCancelled() {
    // No mail transport yet.
  },
  async alertOperator(alert) {
    const detail = "eventId" in alert ? ` event=${alert.eventId} reason=${alert.reason}` : ` account=${alert.accountId}`;
    console.error(`billing alert: ${alert.kind}${detail}`);
  },
  async requestOwnerReview() {
    // No admin interface yet.
  },
  async grantCut() {
    // No admin interface yet.
  },
};
