// Outgoing email. No provider is chosen yet (docs/cloud-plan.md, open items), so the gateway depends on this
// interface only: a real provider adapter implements `EmailSender` later, and tests use `FakeEmailSender`
// (src/testing/fake-email.ts).
//
// Rules for every message: plain text, no link, no token, no secret. The sign-in message carries the one-time
// code and nothing else that could be reused; the notifications carry no code at all. Message data is passed
// as typed fields and rendered here, so a provider adapter cannot be handed a pre-built body that contains a
// secret by accident.

import type { LoginMethod } from "../../storage/interfaces/common";

export type EmailMessage =
  | { kind: "sign_in_code"; to: string; code: string; purpose: "sign_in" | "link" }
  | { kind: "login_method_linked"; to: string; method: LoginMethod }
  | { kind: "login_method_unlinked"; to: string; method: LoginMethod }
  | { kind: "account_deletion_started"; to: string }
  /** A device was revoked with a manage token (the device-limit flow). */
  | { kind: "device_revoked"; to: string; deviceLabel: string };

export interface EmailSender {
  /** Resolves when the provider accepted the message. May throw; callers send in the background and never fail a request on it. */
  send(message: EmailMessage): Promise<void>;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

const METHOD_NAME: Record<LoginMethod, string> = { google: "Google sign-in", email: "email code sign-in" };

/** Strips control characters and caps the length of user-typed text that goes into a message body. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64);
}

export function renderEmail(message: EmailMessage): RenderedEmail {
  switch (message.kind) {
    case "sign_in_code":
      return {
        subject: message.purpose === "link" ? "Your StudentLLM code to add a sign-in method" : "Your StudentLLM sign-in code",
        text: [
          `Your StudentLLM code is: ${message.code}`,
          "",
          "It is valid for 10 minutes and works once.",
          "Enter it only in StudentLLM, on the device where you asked for it.",
          "Nobody from StudentLLM will ever ask you for this code.",
          "",
          "If you did not ask for it, ignore this message. Nothing happens unless the code is entered.",
        ].join("\n"),
      };
    case "login_method_linked":
      return {
        subject: "A sign-in method was added to your StudentLLM account",
        text: `The ${METHOD_NAME[message.method]} was added to your StudentLLM account.\n\nIf this was not you, delete the account from the app or contact support.`,
      };
    case "login_method_unlinked":
      return {
        subject: "A sign-in method was removed from your StudentLLM account",
        text: `The ${METHOD_NAME[message.method]} was removed from your StudentLLM account.\n\nIf this was not you, contact support.`,
      };
    case "account_deletion_started":
      return {
        subject: "Your StudentLLM account is being deleted",
        text: "Deletion of your StudentLLM account was started. Your subscription, if any, is cancelled first and then all data is removed.\n\nIf this was not you, contact support.",
      };
    case "device_revoked":
      return {
        subject: "A device was signed out of your StudentLLM account",
        text: `The device "${plain(message.deviceLabel)}" was signed out of your StudentLLM account so that a new device could sign in.\n\nIf this was not you, contact support.`,
      };
  }
}

/** The sender used until a provider adapter exists: every send fails, so nothing is silently dropped as "sent". */
export const unconfiguredEmailSender: EmailSender = {
  async send() {
    throw new Error("no email provider is configured");
  },
};
