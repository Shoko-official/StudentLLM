/** RFC 3339 UTC without milliseconds, as the contract's examples (`2026-12-01T00:00:00Z`). */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
