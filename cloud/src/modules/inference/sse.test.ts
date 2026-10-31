import { describe, expect, it } from "vitest";
import { SseFormatError, SseParser, type SseEvent } from "./sse";

const enc = (s: string) => new TextEncoder().encode(s);

function parseAll(chunks: Uint8Array[], max = 1 << 20): SseEvent[] {
  const parser = new SseParser(max);
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.end());
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SseParser", () => {
  it("parses unnamed and named events", () => {
    expect(parseAll([enc('data: {"a":1}\n\nevent: usage\ndata: {"b":2}\n\ndata: [DONE]\n\n')])).toEqual([
      { event: null, data: '{"a":1}' },
      { event: "usage", data: '{"b":2}' },
      { event: null, data: "[DONE]" },
    ]);
  });

  it("joins data lines, ignores comments, ids and unknown fields", () => {
    expect(parseAll([enc(": keep-alive\n\nid: 7\nretry: 100\ndata: one\ndata: two\nfoo: bar\n\n")])).toEqual([{ event: null, data: "one\ntwo" }]);
  });

  it("accepts LF, CRLF and CR line endings, also when a CRLF is split across chunks", () => {
    const expected = [
      { event: null, data: "a" },
      { event: null, data: "b" },
    ];
    expect(parseAll([enc("data: a\n\ndata: b\n\n")])).toEqual(expected);
    expect(parseAll([enc("data: a\r\n\r\ndata: b\r\n\r\n")])).toEqual(expected);
    expect(parseAll([enc("data: a\r\rdata: b\r\r")])).toEqual(expected);
    expect(parseAll([enc("data: a\r"), enc("\n\r"), enc("\ndata: b\r\n"), enc("\r\n")])).toEqual(expected);
  });

  it("delivers a final event that lacks its blank line", () => {
    expect(parseAll([enc("data: a\n\ndata: [DONE]")])).toEqual([
      { event: null, data: "a" },
      { event: null, data: "[DONE]" },
    ]);
  });

  it("does not split a multi-byte character delivered in two chunks", () => {
    const bytes = enc("data: café 日本\n\n");
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(parseAll([bytes.slice(0, cut), bytes.slice(cut)]), `cut at ${cut}`).toEqual([{ event: null, data: "café 日本" }]);
    }
  });

  it("gives the same events however the stream is cut into chunks (property)", () => {
    const text = ['data: {"x":1}\n\n', ": comment\n\n", "event: usage\ndata: {\"y\":2}\n\n", "data: line1\ndata: line2\n\n", "data: [DONE]\n\n"].join("");
    const bytes = enc(text);
    const whole = parseAll([bytes]);
    const next = rng(5);
    for (let i = 0; i < 300; i++) {
      const chunks: Uint8Array[] = [];
      let at = 0;
      while (at < bytes.length) {
        const size = 1 + Math.floor(next() * 12);
        chunks.push(bytes.slice(at, at + size));
        at += size;
      }
      expect(parseAll(chunks)).toEqual(whole);
    }
  });

  it("skips a block without data", () => {
    expect(parseAll([enc("event: ping\n\ndata: ok\n\n")])).toEqual([{ event: null, data: "ok" }]);
  });

  it("refuses an event that grows past the limit instead of buffering it", () => {
    const parser = new SseParser(100);
    expect(() => parser.push(enc("data: " + "x".repeat(500)))).toThrow(SseFormatError);
  });

  it("does not count completed events against the limit", () => {
    const parser = new SseParser(100);
    const events = parser.push(enc(("data: " + "x".repeat(60) + "\n\n").repeat(10)));
    expect(events).toHaveLength(10);
  });
});
