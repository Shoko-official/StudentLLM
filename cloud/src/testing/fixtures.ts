// Test-only: fixture-conformance helper. Later modules load a fixture from docs/cloud-api-fixtures/,
// send its request to the app and assert that their response conforms:
//
//   const fx = loadFixture("chat-completions.budget_exhausted");
//   const response = await app.handle(fixtureRequest(fx));
//   await expectFixtureConformance(response, fx);
//
// Conformance means: same status; every header the fixture lists is present (values are compared only
// for `strictHeaders`, because request ids, tokens and times differ); the body validates against the
// fixture's `response_schema`; an error has the fixture's `code` and carries the fixture's `details` keys;
// an SSE stream has the fixture's event sequence and each event payload validates against its schema.

import { readFileSync } from "node:fs";
import { FIXTURES_DIR, loadContract, validateAgainst } from "./contract";

export interface Fixture {
  name: string;
  operation: string;
  description: string;
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    multipart?: Record<string, string | number | boolean>;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
    sse?: string[];
  };
  response_schema: string | null;
  sse_event_schemas?: Record<string, string>;
}

export function fixtureNames(): string[] {
  return (JSON.parse(readFileSync(`${FIXTURES_DIR}index.json`, "utf8")) as { fixtures: string[] }).fixtures.map((f) => f.replace(/\.json$/, ""));
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name.replace(/\.json$/, "")}.json`, "utf8")) as Fixture;
}

export function loadAllFixtures(): Fixture[] {
  return fixtureNames().map(loadFixture);
}

/** Builds the fixture's request. Multipart fixtures get a tiny placeholder file part. */
export function fixtureRequest(fx: Fixture, baseUrl = "https://api.example.invalid"): Request {
  const headers = new Headers(fx.request.headers);
  let body: BodyInit | undefined;
  if (fx.request.multipart) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fx.request.multipart)) {
      if (key === "file") form.set("file", new Blob([new Uint8Array([0, 1, 2, 3])], { type: "application/octet-stream" }), "upload.bin");
      else form.set(key, String(value));
    }
    body = form; // fetch sets the multipart Content-Type with its boundary
  } else if (fx.request.body !== undefined) {
    body = JSON.stringify(fx.request.body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  return new Request(new URL(fx.request.path, baseUrl), { method: fx.request.method, headers, body });
}

export interface SseEvent {
  event: string | null;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (block.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    events.push({ event, data: data.join("\n") });
  }
  return events;
}

export interface ConformanceOptions {
  /** Header names whose values must also be equal (for example `Retry-After`). */
  strictHeaders?: string[];
  /** Compare the whole body for equality instead of schema conformance (only for fixtures without volatile fields). */
  exactBody?: boolean;
}

/** Returns the list of mismatches; empty means the response conforms. */
export async function checkFixtureConformance(response: Response, fx: Fixture, options: ConformanceOptions = {}): Promise<string[]> {
  const problems: string[] = [];
  const contract = loadContract();
  if (response.status !== fx.response.status) problems.push(`status ${response.status}, expected ${fx.response.status}`);

  const strict = new Set((options.strictHeaders ?? []).map((h) => h.toLowerCase()));
  for (const [name, expected] of Object.entries(fx.response.headers)) {
    const actual = response.headers.get(name);
    if (actual === null) problems.push(`missing header ${name}`);
    else if (strict.has(name.toLowerCase()) && actual !== expected) problems.push(`header ${name} is "${actual}", expected "${expected}"`);
  }

  const text = await response.text();

  if (fx.response.sse) {
    const expected = parseSse(fx.response.sse.join("\n"));
    const actual = parseSse(text);
    const shape = (events: SseEvent[]) => events.map((e) => e.event ?? (e.data === "[DONE]" ? "done" : "chunk")).join(",");
    if (shape(actual) !== shape(expected)) problems.push(`SSE sequence ${shape(actual)}, expected ${shape(expected)}`);
    for (const e of actual) {
      const schema = e.event ? fx.sse_event_schemas?.[e.event] : undefined;
      if (schema) {
        try {
          problems.push(...validateAgainst(schema, JSON.parse(e.data), contract).map((p) => `SSE ${e.event}: ${p}`));
        } catch {
          problems.push(`SSE ${e.event}: data is not JSON`);
        }
      }
    }
    return problems;
  }

  if (fx.response_schema === null) {
    if (text !== "" && fx.response.body === undefined) problems.push("expected an empty body");
    return problems;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    problems.push("body is not JSON");
    return problems;
  }
  problems.push(...validateAgainst(fx.response_schema, body, contract).map((p) => `body: ${p}`));

  const expectedBody = fx.response.body as { error?: { code?: string; details?: Record<string, unknown> } } | undefined;
  const actualBody = body as { error?: { code?: string; details?: Record<string, unknown>; request_id?: string } };
  if (expectedBody?.error) {
    if (actualBody.error?.code !== expectedBody.error.code) problems.push(`error.code is ${actualBody.error?.code}, expected ${expectedBody.error.code}`);
    for (const key of Object.keys(expectedBody.error.details ?? {})) {
      if (!(key in (actualBody.error?.details ?? {}))) problems.push(`error.details lacks "${key}"`);
    }
    const headerId = response.headers.get("X-Request-Id");
    if (headerId !== null && actualBody.error?.request_id !== headerId) problems.push("error.request_id differs from X-Request-Id");
  }
  if (options.exactBody && JSON.stringify(body) !== JSON.stringify(fx.response.body)) problems.push("body differs from the fixture");
  return problems;
}

/** Throws with the list of mismatches. */
export async function expectFixtureConformance(response: Response, fx: Fixture, options?: ConformanceOptions): Promise<void> {
  const problems = await checkFixtureConformance(response, fx, options);
  if (problems.length > 0) throw new Error(`response does not conform to fixture ${fx.name}:\n- ${problems.join("\n- ")}`);
}

/** Builds a Response from the fixture's own recorded response (used to test the helper itself). */
export function fixtureResponse(fx: Fixture): Response {
  const headers = new Headers(fx.response.headers);
  if (fx.response.sse) return new Response(fx.response.sse.join("\n"), { status: fx.response.status, headers });
  const body = fx.response_schema === null ? null : JSON.stringify(fx.response.body);
  return new Response(body, { status: fx.response.status, headers });
}
