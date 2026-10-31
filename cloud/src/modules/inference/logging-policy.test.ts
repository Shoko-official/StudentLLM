// A logging-policy test (docs/cloud-plan.md, "No content in logs"): no log call in the inference or ops code can receive
// a request body, a prompt, a transcript, an answer or an error message that might carry one. The only console output
// is a fixed string literal that names the failure, and nothing in these modules writes to a store through a
// content-shaped field.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fakeExecutionContext, makeTestApp } from "../../testing";
import { routeMeta } from "../../http/context";

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
/** The app also logs (cleanup, background and scheduled failures, unhandled errors): it is held to the same policy. */
const APP = { file: fileURLToPath(new URL("../../app.ts", import.meta.url)), text: readFileSync(new URL("../../app.ts", import.meta.url), "utf8") };

/** Index of the character after the matching close of the bracket at `open` (strings, template literals and nesting understood). */
function skipBalanced(text: string, open: number): number {
  const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [closers[text[open]!]!];
  let i = open + 1;
  while (i < text.length && stack.length > 0) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      i++;
    } else if (c === "`") {
      i++;
      while (i < text.length && text[i] !== "`") {
        if (text[i] === "\\") i += 2;
        else if (text[i] === "$" && text[i + 1] === "{") i = skipBalanced(text, i + 1);
        else i++;
      }
      i++;
    } else if (c in closers) {
      stack.push(closers[c]!);
      i++;
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      i++;
    } else i++;
  }
  return i;
}

/** Every `console.<level>(...)` call of a source file with its full argument text, however nested. */
function consoleCalls(text: string): Array<{ level: string; args: string }> {
  const out: Array<{ level: string; args: string }> = [];
  for (const m of text.matchAll(/console\.(log|error|warn|info|debug|trace)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    out.push({ level: m[1]!, args: text.slice(open + 1, skipBalanced(text, open) - 1).trim() });
  }
  return out;
}

/**
 * What a console call of the app may interpolate: a route pattern, a fixed label and a task or error NAME. A message,
 * a body or a header is never in this list.
 */
const APP_ALLOWED_INTERPOLATIONS = new Set(["label", "pattern", "task.name", 'error instanceof Error ? error.name : "unknown"']);

describe("logging policy", () => {
  it("scans the inference and ops source", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
  });

  it("allows console output only as a fixed string literal in the modules", () => {
    let calls = 0;
    for (const { file, text } of FILES) {
      for (const call of consoleCalls(text)) {
        calls++;
        expect(/^"[^"$\\`]*"$/.test(call.args), `${file}: console.${call.level}(${call.args}) must take one plain string literal`).toBe(true);
      }
    }
    expect(calls).toBeGreaterThan(0); // the scan really found the calls it guards
  });

  it("allows the app only a literal, or a template that interpolates a route pattern, a label or a name", () => {
    const calls = consoleCalls(APP.text);
    expect(calls.length).toBeGreaterThanOrEqual(4); // cleanup, background task, unhandled error, scheduled task
    for (const call of calls) {
      expect(call.level, call.args).toBe("error");
      expect(call.args.startsWith("`") && call.args.endsWith("`"), `${call.args} must be one template literal`).toBe(true);
      const body = call.args.slice(1, -1);
      let rest = body;
      for (let at = rest.indexOf("${"); at !== -1; at = rest.indexOf("${")) {
        const end = skipBalanced(rest, at + 1);
        const expression = rest.slice(at + 2, end - 1).trim();
        expect(APP_ALLOWED_INTERPOLATIONS.has(expression), `app.ts interpolates "${expression}" into a log line`).toBe(true);
        rest = rest.slice(0, at) + rest.slice(end);
      }
    }
  });

  it("the scanner itself understands nesting, strings and templates", () => {
    const text = 'console.error(`a ${x ? f(")") : "}"} b`); console.log("ok"); console.warn(String(error));';
    expect(consoleCalls(text).map((c) => c.args)).toEqual(['`a ${x ? f(")") : "}"} b`', '"ok"', "String(error)"]);
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

describe("the app's own log lines carry no content at run time", () => {
  const MARKER = "ZEBRA-QUARTZ-LOG-MARKER-9182";

  it("keeps a thrown message, a cleanup failure, a background failure and a scheduled failure out of the console", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const t = makeTestApp({ allowMissingHooks: true });
    t.app.router.add("GET", "/test/throws", () => { throw new Error(`secret ${MARKER}`); }, routeMeta({ operationId: "throws", auth: "none" }));
    t.app.router.add(
      "GET",
      "/test/cleanups",
      (ctx) => {
        ctx.defer(() => { throw new Error(`deferred ${MARKER}`); });
        ctx.deferUntilBodyDone(() => { throw new Error(`after body ${MARKER}`); });
        ctx.waitUntil(Promise.reject(new Error(`background ${MARKER}`)));
        return new Response("ok");
      },
      routeMeta({ operationId: "cleanups", auth: "none" }),
    );
    const ectx = fakeExecutionContext();
    const thrown = await t.app.handle(new Request("https://api.example.invalid/test/throws"), ectx);
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).not.toContain(MARKER);
    const cleaned = await t.app.handle(new Request("https://api.example.invalid/test/cleanups"), ectx);
    await cleaned.text();
    await ectx.settled();
    t.stores.sweeps.due = () => { throw new Error(`scheduled ${MARKER}`); };
    await t.app.scheduled({ scheduledTime: 0, cron: "* * * * *" }, ectx);

    const printed = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");
    expect(printed.length).toBeGreaterThan(0); // the failures were logged by name ...
    expect(printed).not.toContain(MARKER); // ... and never with the text of the error
    expect(printed).toMatch(/unhandled error in \/test\/throws: Error/);
    for (const spy of spies) spy.mockRestore();
  });
});

