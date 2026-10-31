// Test-only: everything the in-memory stores hold, as one string, so a test can assert that a value (an email
// address, a subject id, a token) appears nowhere. It reads the private fields of the in-memory implementations
// (Maps, Sets and arrays), so it only works with `createInMemoryStores()` (not with the chaos proxy).

import type { Stores } from "../storage";

function plain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [plain(k, seen), plain(v, seen)]);
  if (value instanceof Set) return [...value].map((v) => plain(v, seen));
  if (Array.isArray(value)) return value.map((v) => plain(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, seen)]));
}

/** One JSON string with every key and value of every store. */
export function dumpStores(stores: Stores): string {
  return JSON.stringify(plain(stores));
}
