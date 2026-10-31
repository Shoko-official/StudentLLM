// ConsentStore (append-only). Plan row: "Consent".

import type { Feature } from "./common";

export interface ConsentRow {
  consentId: string;
  accountId: string;
  providerSetId: string;
  providerSetVersion: number;
  features: Feature[];
  textVersion: string;
  granted: boolean;
  recordedAt: number;
}

export type NewConsent = Omit<ConsentRow, "recordedAt">;

export interface ConsentStore {
  /**
   * Appends a record, except that an identical request to the latest record of the provider set returns
   * that record (idempotent by construction). There is no update and no delete besides `purgeAccount`.
   */
  record(input: NewConsent, now: number): Promise<{ row: ConsentRow; created: boolean }>;
  /** The latest record of the set when it is a grant: at most one active record per provider set. */
  getActive(accountId: string, providerSetId: string): Promise<ConsentRow | null>;
  /** Looks a record up by id; works for withdrawn and replaced records too. */
  getById(accountId: string, consentId: string): Promise<ConsentRow | null>;
  /** Active records, one per provider set at most. */
  listActive(accountId: string): Promise<ConsentRow[]>;
  /** The full history, for the account export. */
  listAll(accountId: string): Promise<ConsentRow[]>;
  purgeAccount(accountId: string): Promise<void>;
}
