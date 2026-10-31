// Outbound notifications of the billing module, behind a small interface so a test injects a fake and the
// auth module's EmailSender can back it later. Nothing here carries content, a name, an address or a card detail:
// account and event ids and fixed reason words only.

/** An event the operator should look at. Fixed vocabulary; never provider text. */
export type OperatorAlert =
  | { kind: "webhook_quarantined"; eventId: string; reason: string }
  | { kind: "cancel_failing"; accountId: string; attempts: number }
  | { kind: "customer_changed"; accountId: string }
  | { kind: "purchase_while_deleting"; accountId: string };

export interface BillingNotifier {
  /**
   * Tells the account holder that the subscription will end (`period_end`, with the date) or has ended (`now`).
   * The implementation looks up the address itself; the billing module never handles it.
   */
  subscriptionCancelled(input: { accountId: string; when: "period_end" | "now"; effectiveAt: number | null }): Promise<void>;
  alertOperator(alert: OperatorAlert): Promise<void>;
}

/**
 * The default until the auth module's EmailSender exists (TODO(owner: auth): back `subscriptionCancelled` with it).
 * Alerts go to the platform log as one fixed line with ids; the user notification does nothing yet.
 */
export const defaultNotifier: BillingNotifier = {
  async subscriptionCancelled() {
    // No mail transport yet.
  },
  async alertOperator(alert) {
    const detail = "eventId" in alert ? ` event=${alert.eventId} reason=${alert.reason}` : ` account=${alert.accountId}`;
    console.error(`billing alert: ${alert.kind}${detail}`);
  },
};
