// Storage interfaces of the gateway, one file per store (barrel: ./index). They mirror the data table in
// docs/cloud-plan.md ("The complete list of what the service stores") and nothing else: no content, no IP
// address, no prompt, no answer, no body hash or fingerprint, no plaintext token or code.
//
// Conventions
// - Every method that depends on time takes `now` (epoch milliseconds) so tests are deterministic.
// - Every method that the plan calls "atomic" is ONE call here. An adapter must make it a single step.
// - Records returned to callers are copies; mutating them never changes the store.
// - Ledger, reservation, rate-limit and concurrency state is per account: every such method takes
//   `accountId` first, because the adapter routes the call to that account's Durable Object.
//
// Adapters (TODO(owner: ops)): the in-memory implementations in ../memory are for tests and local dev
// only. The Durable Object and D1 adapters come later. Plan authority (accounts, plan, consent, webhook
// ledger) belongs to D1; live counters, reservations, leases, revocations and the device list belong to
// the account Durable Object. The account Durable Object MUST perform `DeviceStore.register` (the limit
// check and the device insert) as one atomic step, so two parallel sign-ins cannot both take the last
// slot. It must also make a ledger settle/release and the idempotency transition it implies one step.

import type { ConsentFeature } from "../../types";

export type LoginMethod = "google" | "email";
export type Feature = ConsentFeature;
