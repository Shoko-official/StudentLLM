// A logging-policy test (docs/cloud-plan.md, "No content in logs"): no log call in the inference or ops code can receive
// a request body, a prompt, a transcript, an answer or an error message that might carry one. The only console output
// is a fixed string literal that names the failure, and nothing in these modules writes to a store through a
// content-shaped field.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sources(dir: URL): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...sources(child));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push({ file: fileURLToPath(child), text: readFileSync(child, "utf8") });
  }
  return out;
}

const FILES = [...sources(new URL("./", import.meta.url)), ...sources(new URL("../ops/", import.meta.url))];

describe("logging policy", () => {
  it("scans the inference and ops source", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
  });

  it("allows console output only as a fixed string literal", () => {
    const CALL = /console\.(log|error|warn|info|debug|trace)\s*\(([^)]*)\)/g;
    let calls = 0;
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(CALL)) {
        calls++;
        const arg = m[2]!.trim();
        expect(/^"[^"$\\`]*"$/.test(arg), `${file}: console.${m[1]}(${arg}) must take one plain string literal`).toBe(true);
      }
    }
    expect(calls).toBeGreaterThan(0); // the scan really found the calls it guards
  });

  it("never logs through the request logger with anything but the typed entry", () => {
    for (const { file, text } of FILES) {
      expect(/\bdeps\.log\b|\.log\.request\(/.test(text), `${file} must not call the request logger itself (the app does)`).toBe(false);
    }
  });

  it("never serializes a request, a response body or a caught error into a message", () => {
    const FORBIDDEN = [/\.message\b[^;\n]*console/, /console[^;\n]*\.message\b/, /console[^;\n]*String\(error\)/, /console[^;\n]*JSON\.stringify/];
    for (const { file, text } of FILES) {
      for (const pattern of FORBIDDEN) expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
    }
  });

  it("builds provider errors from a kind, never from provider text", () => {
    const provider = FILES.find((f) => f.file.endsWith("provider.ts"))!.text;
    expect(provider).toContain('super(`upstream ${kind}`)');
    // The error body of a failed upstream call is cancelled, not read.
    expect(provider).toMatch(/response\.body\?\.cancel\(\)/);
  });

  it("keeps the idempotency, ledger and rate-limit writes free of body-derived values", () => {
    // These identifiers would be the way a prompt-derived value could reach a store.
    const code = FILES.flatMap((f) => f.text.split("\n"))
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map((line) => line.replace(/\s\/\/.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/bodyHash|fingerprint|sha256Hex\(\s*(?:raw|text|body|chat\.messages|JSON)/i);
  });
});
