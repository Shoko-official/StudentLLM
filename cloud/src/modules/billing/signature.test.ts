import { describe, expect, it } from "vitest";
import { paddleSignature } from "../../testing/billing-test-app";
import { parseSignatureHeader, verifyPaddleSignature } from "./signature";

const SECRET = "whsec_unit_0123456789abcdef0123456789abcdef";
const OTHER = "whsec_other_0123456789abcdef0123456789abcdef";
const NOW = Date.UTC(2026, 10, 1, 9, 30, 0);
const BODY = new TextEncoder().encode('{"event_id":"evt_1","event_type":"x.y","occurred_at":"2026-11-01T09:30:00Z"}');
const opts = (secrets: string[] = [SECRET], now = NOW, toleranceMs = 60_000) => ({ secrets, now, toleranceMs });

describe("parseSignatureHeader", () => {
  const h1 = "a".repeat(64);

  it("reads the timestamp and every h1, in order, lower-cased", () => {
    expect(parseSignatureHeader(`ts=1790000000;h1=${h1.toUpperCase()};h1=${"b".repeat(64)}`)).toEqual({ timestamp: 1790000000, signatures: [h1, "b".repeat(64)] });
    expect(parseSignatureHeader(`h1=${h1}; ts=5`)).toEqual({ timestamp: 5, signatures: [h1] });
  });

  it("ignores other schemes but refuses anything malformed", () => {
    expect(parseSignatureHeader(`ts=5;h2=zzz;h1=${h1}`)).toEqual({ timestamp: 5, signatures: [h1] });
    for (const bad of [null, "", "ts=5", `h1=${h1}`, `ts=5;ts=6;h1=${h1}`, `ts=abc;h1=${h1}`, `ts=-5;h1=${h1}`, "ts=5;h1=short", `ts=5;h1=${"g".repeat(64)}`, `ts=5;h1=${h1};nonsense`, `ts=1234567890123;h1=${h1}`, "x".repeat(2000)]) {
      expect(parseSignatureHeader(bad), String(bad).slice(0, 30)).toBeNull();
    }
  });

  it("keeps at most four digests", () => {
    const many = Array.from({ length: 9 }, () => `h1=${h1}`).join(";");
    expect(parseSignatureHeader(`ts=5;${many}`)!.signatures).toHaveLength(4);
  });
});

describe("verifyPaddleSignature", () => {
  it("accepts the HMAC-SHA256 of `<ts>:<raw body>` and rejects a changed body, secret or timestamp", async () => {
    const header = await paddleSignature(SECRET, BODY, NOW);
    expect(await verifyPaddleSignature(header, BODY, opts())).toEqual({ ok: true });
    expect(await verifyPaddleSignature(header, new TextEncoder().encode(" " + new TextDecoder().decode(BODY)), opts())).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyPaddleSignature(header, BODY, opts([OTHER]))).toEqual({ ok: false, reason: "mismatch" });
    const moved = header.replace(/ts=\d+/, `ts=${Math.floor(NOW / 1000) + 1}`);
    expect(await verifyPaddleSignature(moved, BODY, opts())).toEqual({ ok: false, reason: "mismatch" }); // the timestamp is signed
  });

  it("bounds the timestamp in both directions, inclusively at the edge", async () => {
    for (const [skew, ok] of [[0, true], [59_000, true], [-59_000, true], [60_000, true], [-60_000, true], [61_000, false], [-61_000, false], [3_600_000, false]] as const) {
      const header = await paddleSignature(SECRET, BODY, NOW + skew);
      const result = await verifyPaddleSignature(header, BODY, opts());
      expect(result.ok, String(skew)).toBe(ok);
      if (!ok) expect(result).toEqual({ ok: false, reason: "timestamp" });
    }
  });

  it("accepts either configured secret and a header with several digests", async () => {
    expect((await verifyPaddleSignature(await paddleSignature(OTHER, BODY, NOW), BODY, opts([SECRET, OTHER]))).ok).toBe(true);
    expect((await verifyPaddleSignature(await paddleSignature([OTHER, SECRET], BODY, NOW), BODY, opts([SECRET]))).ok).toBe(true);
    expect((await verifyPaddleSignature(await paddleSignature([OTHER, OTHER], BODY, NOW), BODY, opts([SECRET]))).ok).toBe(false);
  });

  it("never accepts an empty secret, and an empty body is verified like any other", async () => {
    const empty = new Uint8Array(0);
    expect((await verifyPaddleSignature(await paddleSignature(OTHER, empty, NOW), empty, opts([""]))).ok).toBe(false);
    expect((await verifyPaddleSignature(await paddleSignature(SECRET, empty, NOW), empty, opts())).ok).toBe(true);
  });

  it("verifies bytes, not text: a body with a multi-byte character and one with invalid UTF-8 both work", async () => {
    const accented = new TextEncoder().encode('{"name":"Zoë ☃"}');
    const invalid = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    for (const body of [accented, invalid]) {
      expect((await verifyPaddleSignature(await paddleSignature(SECRET, body, NOW), body, opts())).ok).toBe(true);
    }
  });

  it("reports a missing or malformed header as malformed", async () => {
    expect(await verifyPaddleSignature(null, BODY, opts())).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyPaddleSignature("garbage", BODY, opts())).toEqual({ ok: false, reason: "malformed" });
  });
});
