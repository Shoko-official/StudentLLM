// Test-only: an EmailSender that records what would have been sent. No network, no provider.

import type { EmailMessage, EmailSender } from "../modules/auth/email";

export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  /** Make the next sends fail (a provider outage). */
  failing = false;

  async send(message: EmailMessage): Promise<void> {
    if (this.failing) throw new Error("fake provider outage");
    this.sent.push(structuredClone(message));
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  /** The most recent sign-in code sent to the address, or undefined. */
  lastCode(address: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]!;
      if (m.kind === "sign_in_code" && m.to === address) return m.code;
    }
    return undefined;
  }

  ofKind<K extends EmailMessage["kind"]>(kind: K): Array<Extract<EmailMessage, { kind: K }>> {
    return this.sent.filter((m): m is Extract<EmailMessage, { kind: K }> => m.kind === kind);
  }
}
