// AuthChallengeStore. Plan rows: "Pending sign-in", "Link ticket", "Sign-in counters".

import type { SaltedHash, StableHash } from "../../crypto/keyed-hash";
import type { LoginMethod } from "./common";

export interface PendingSignIn {
  id: string;
  kind: "google" | "email";
  /** Google: hash of the OAuth state. */
  stateHash: string | null;
  /**
   * Email: keyed hash of the normalized address under the NON-rotating `CODE_HMAC_KEY` (`stableKeyedHash`),
   * the lookup key. It must not be a rotating-salt hash: the record lives 10 minutes and a rotation in
   * between would make it unfindable. The plan table gained this column (no clear email is stored here).
   */
  emailHash: StableHash | null;
  codeChallenge: string;
  redirectType: "loopback" | "deep_link" | null;
  /**
   * Google: the app's redirect URI exactly as sent to /auth/start (a loopback port changes on every run, so
   * the type alone is not enough) and the app's own `state`, echoed back on the redirect. Neither is secret.
   * New columns of the pending sign-in row (docs/cloud-plan.md).
   */
  redirectUri: string | null;
  appState: string | null;
  /**
   * Google: the verified identity of a sign-in that will CREATE an account, held for the 60 seconds of the
   * authorization code so that the account is created at `/auth/token`, after the PKCE proof, and not at the
   * callback. Null otherwise (an existing account is named by `accountId`).
   */
  googleSubject: string | null;
  googleEmail: string | null;
  /** The device label from the request, held for at most the 10 minutes of the pending sign-in. */
  deviceLabel: string | null;
  termsVersion: string;
  linkTicketId: string | null;
  /** Keyed HMAC of the one-time email code, or of the single-use authorization code issued after the Google callback. */
  codeHash: string | null;
  /** Set when the Google callback resolved an account; needed to mint tokens at /auth/token (new plan column). */
  accountId: string | null;
  attempts: number;
  resends: number;
  createdAt: number;
  expiresAt: number;
}

export interface LinkTicket {
  /** Hash of the ticket. */
  ticketHash: string;
  accountId: string;
  method: LoginMethod;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export type VerifyEmailCodeResult =
  | { outcome: "ok"; pending: PendingSignIn }
  | { outcome: "wrong"; attempts: number }
  /** The cap was reached (this or an earlier call); the code is dead even if the right one is sent now. */
  | { outcome: "locked" }
  /** No live pending sign-in for this address. */
  | { outcome: "gone" };

export interface AuthChallengeStore {
  put(pending: PendingSignIn): Promise<void>;
  /** Stores the pending email sign-in and invalidates every earlier one for the same address. */
  replaceForEmail(pending: PendingSignIn): Promise<void>;
  getByStateHash(stateHash: string, now: number): Promise<PendingSignIn | null>;
  getByEmailHash(emailHash: StableHash, now: number): Promise<PendingSignIn | null>;
  /**
   * For the Google single-use authorization code ONLY. Never check an email code with this: a read followed
   * by a separate counter update is racy, and parallel guesses would exceed the attempt cap. Use
   * `verifyEmailCode`.
   */
  getByCodeHash(codeHash: string, now: number): Promise<PendingSignIn | null>;

  /**
   * The email code check as ONE atomic operation, with the comparison inside the store.
   * - no live pending sign-in for `emailHash` -> `gone`;
   * - `attempts >= maxAttempts` already -> `locked` (the right code no longer works);
   * - a wrong candidate ALWAYS counts as an attempt (also when `consume` is false) -> `wrong(attempts)`;
   * - a right candidate -> `ok`. With `consume: true` the pending sign-in is consumed (single use). With
   *   `consume: false` it is left in place, unconsumed and uncounted: this is the device-limit case ("a
   *   successful code check at the limit does not count as an attempt and the code stays unconsumed").
   * Candidates are compared in constant time.
   *
   * REQUIRED FOLLOW-UP FLOW when the redemption has a side effect that can fail or race (a sign-in that
   * registers a device): call with `consume: false`, then (1) register the device (`DeviceStore.register`,
   * the atomic limit check), (2) consume the code with `consume(pending.id, now)`, (3) if that returns null
   * another redemption won: roll the device back (revoke it when `created` was true) and answer
   * `invalid_code`. Registering before consuming is what stops two parallel redemptions of one code from
   * both ending up with a device; the single-use guarantee comes from step (2), not from step (1).
   * `consume: true` is for a redemption with no such side effect.
   */
  verifyEmailCode(input: {
    emailHash: StableHash;
    candidateCodeHash: string;
    maxAttempts: number;
    consume: boolean;
    now: number;
  }): Promise<VerifyEmailCodeResult>;

  delete(id: string): Promise<void>;
  /** Atomic get-and-delete of a live record: single use. */
  consume(id: string, now: number): Promise<PendingSignIn | null>;

  putLinkTicket(ticket: LinkTicket): Promise<void>;
  /** Non-consuming read of a live ticket (validate it at the start of a link flow; consume it at completion). */
  getLinkTicket(ticketHash: string, now: number): Promise<LinkTicket | null>;
  /** Atomic single use: returns the ticket once, and null afterwards or when expired. */
  consumeLinkTicket(ticketHash: string, now: number): Promise<LinkTicket | null>;

  /** Request and failed-attempt counters keyed by a ROTATING salted hash (`SaltedHash`). Entries expire. */
  incrementCounter(key: SaltedHash, now: number, ttlMs: number): Promise<number>;
  getCounter(key: SaltedHash, now: number): Promise<number>;
  deleteExpired(now: number): Promise<number>;
  purgeAccount(accountId: string): Promise<void>;
}
