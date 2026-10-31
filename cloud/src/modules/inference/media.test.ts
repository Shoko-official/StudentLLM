import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectFixtureConformance, loadFixture, validateAgainst } from "../../testing";
import {
  ACCOUNT_ID,
  errorResponse,
  makeInferenceHarness,
  pngBytes,
  routingWithMedia,
  wavBytes,
  type Harness,
} from "../../testing/inference-harness";
import type { OcrCall, ProviderRegistry, TranscribeCall, UpstreamProvider } from "./provider";
import type { RoutingConfig } from "./routing";

const windowOf = (h: Harness) => h.stores.ledger.getCurrentWindow(ACCOUNT_ID, h.clock.now());
const code = async (res: Response) => (await res.json()).error.code as string;
const AUDIO = "/v1/audio/transcriptions";
const OCR = "/v1/ocr";

function audioForm(bytes: Uint8Array, fields: Record<string, string> = {}, type = "audio/wav"): FormData {
  const form = new FormData();
  form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), "recording.wav");
  form.set("model", "studentllm-transcribe");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

function imageForm(bytes: Uint8Array, fields: Record<string, string> = {}, type = "image/png"): FormData {
  const form = new FormData();
  form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), "page.png");
  form.set("model", "studentllm-ocr");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

const transcript = (duration: number | null, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      text: "EXAMPLE TRANSCRIPT",
      language: "fr",
      ...(duration === null ? {} : { duration }),
      segments: [{ start: 0, end: 4.2, text: "EXAMPLE SEGMENT", id: 0, tokens: [1, 2] }],
      x_groq: { id: "provider detail" },
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

/** A fake provider for OCR, which the default OpenAI-compatible provider does not offer (no provider is chosen yet). */
function ocrProvider(handler: (call: OcrCall) => Promise<{ text: string; blocks: Array<{ text: string; bbox: [number, number, number, number] | null }> }>): ProviderRegistry {
  const provider: UpstreamProvider = { id: "groq", chat: () => Promise.reject(new Error("unused")), ocr: handler };
  return (id) => (id === "groq" ? provider : undefined);
}

function withModel(routing: RoutingConfig, id: string, patch: Record<string, unknown>): RoutingConfig {
  return { ...routing, models: routing.models.map((m) => (m.id === id ? ({ ...m, ...patch } as typeof m) : m)) };
}

describe("POST /v1/audio/transcriptions", () => {
  it("conforms to the fixture and settles on the duration the provider reports", async () => {
    const fx = loadFixture("audio-transcriptions.success");
    const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(59.4) });
    const form = audioForm(wavBytes(59.4), { language: "fr", response_format: "verbose_json", duration_hint_seconds: "60" });
    const res = await h.postForm(AUDIO, form);
    await expectFixtureConformance(res.clone(), fx);
    const json = await res.json();
    expect(json).toEqual({
      text: "EXAMPLE TRANSCRIPT",
      language: "fr",
      duration_seconds: 59.4,
      segments: [{ start: 0, end: 4.2, text: "EXAMPLE SEGMENT" }], // provider extension fields are dropped
    });
    // 59.4 s at 6 credits a minute: ceil(5.94) = 6, rounded up once.
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("6");
    expect(await windowOf(h)).toMatchObject({ used: 6, reserved: 0, byFeature: { transcription: 6, chat: 0, ocr: 0 } });
  });

  it("sends the provider only the file, the upstream model, the format and the language", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(10) });
    await h.postForm(AUDIO, audioForm(wavBytes(10), { language: "fr", duration_hint_seconds: "10" }));
    const call = h.upstreamCalls[0]!;
    expect(call.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(call.body.fields.sort()).toEqual(["file", "language", "model", "response_format"]); // no prompt, no client name
    const form = call.body.form as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect((form.get("file") as File).name).toBe("audio.wav"); // the client's file name never reaches the provider
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "authorization"]);
  });

  it("charges what the provider reports, not the larger reservation", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(10) });
    const res = await h.postForm(AUDIO, audioForm(wavBytes(120), { duration_hint_seconds: "120" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("1"); // ceil(10 s x 6 / 60), the reservation was 12
    expect((await windowOf(h))!.used).toBe(1);
  });

  it("settles at the full reservation when the provider reports no duration", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(null) });
    const res = await h.postForm(AUDIO, audioForm(wavBytes(120), { duration_hint_seconds: "120" }));
    expect(res.status).toBe(200);
    // Reserved on max(header 120 s, bytes / 8000 = 120.0055 s, the 44-byte header counts): 12.0006 credits rounded up,
    // and no duration reported: the whole reservation.
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("13");
    expect((await res.json()).duration_seconds).toBe(120); // the header, not the reservation
  });

  it("reserves at least the header's duration whatever the client declares", async () => {
    const h = makeInferenceHarness({
      routing: withModel(routingWithMedia(), "studentllm-transcribe", { maxAudioBytes: 4 * 1024 * 1024 }),
      upstream: () => transcript(null),
    });
    // 300 seconds of audio that the client claims is 1 second long.
    const res = await h.postForm(AUDIO, audioForm(wavBytes(300), { duration_hint_seconds: "1" }));
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("31"); // 300.0055 s at 6 credits a minute, no duration reported
  });

  describe("the audio ceiling cannot be bypassed", () => {
    const heldCredits = async (h: ReturnType<typeof makeInferenceHarness>, form: FormData) => {
      // Hold the provider's answer to read the reservation while the request is in flight.
      const res = h.postForm(AUDIO, form);
      while (h.upstreamCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
      const reserved = (await windowOf(h))!.reserved;
      release();
      await res;
      return reserved;
    };
    let release: () => void = () => undefined;
    const held = () => new Promise<Response>((resolve) => (release = () => resolve(transcript(1))));
    const big = () => withModel(routingWithMedia(), "studentllm-transcribe", { maxAudioBytes: 4 * 1024 * 1024 });

    describe("a WAV is accepted only as PCM whose header agrees with itself", () => {
      // The header fields a decoder honours but the gateway cannot see through: each is refused, nothing is reserved.
      const refused: Array<[string, () => Uint8Array]> = [
        ["a sample rate forged down (1000 Hz stated, byte rate left at 8000): 1920 s to a decoder, 240 s to the gateway", () => wavBytes(0, { sampleRate: 1000, byteRate: 8000, dataBytes: 1_920_000 })],
        ["a sample rate below 8000 Hz even when the byte rate agrees", () => wavBytes(60, { sampleRate: 4000 })],
        ["a GSM format tag (1625 bytes a second, hours in few bytes)", () => wavBytes(1, { format: 0x31, byteRate: 1625, blockAlign: 65, bits: 8 })],
        ["an ADPCM format tag", () => wavBytes(1, { format: 2 })],
        ["an MP3-in-WAV format tag", () => wavBytes(1, { format: 0x55 })],
        ["format tag 0", () => wavBytes(1, { format: 0 })],
        ["a block align that is not channels x bits / 8", () => wavBytes(1, { blockAlign: 2 })],
        ["a byte rate that is not sample rate x block align", () => wavBytes(1, { byteRate: 16_000 })],
        ["a forged huge byte rate", () => wavBytes(300, { byteRate: 0xfffffff0 })],
        ["a forged tiny byte rate", () => wavBytes(1, { byteRate: 1 })],
        ["bits per sample that are not 8, 16, 24 or 32", () => wavBytes(1, { bits: 12, blockAlign: 1.5 as number })],
        ["no channel", () => wavBytes(1, { channels: 0, blockAlign: 0, byteRate: 0 })],
        ["no fmt chunk before the data", () => wavBytes(1).map((b, i) => (i >= 12 && i < 16 ? "junk".charCodeAt(i - 12) : b))],
      ];
      for (const [name, make] of refused) {
        it(`refuses ${name}`, async () => {
          const h = makeInferenceHarness({ routing: big(), upstream: held });
          const res = await h.postForm(AUDIO, audioForm(make(), { duration_hint_seconds: "1" }));
          expect(res.status).toBe(400);
          expect(await code(res)).toBe("invalid_request");
          expect(h.upstreamCalls).toHaveLength(0);
          expect(await windowOf(h)).toBeNull();
        });
      }

      const honest: Array<[string, Parameters<typeof wavBytes>[1], number]> = [
        ["8 kHz mono 8-bit", {}, 10],
        ["16 kHz mono 16-bit", { sampleRate: 16_000, bits: 16 }, 10],
        ["44.1 kHz stereo 16-bit", { sampleRate: 44_100, channels: 2, bits: 16 }, 10],
        ["48 kHz stereo 24-bit", { sampleRate: 48_000, channels: 2, bits: 24 }, 5],
        ["32-bit float (tag 3)", { sampleRate: 16_000, bits: 32, format: 3 }, 10],
        ["WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE)", { sampleRate: 22_050, bits: 16, format: 0xfffe }, 10],
      ];
      for (const [name, options, seconds] of honest) {
        it(`keeps working for an honest ${name} file: reserved on the bytes, refunded on the reported duration`, async () => {
          const bytes = wavBytes(seconds, options);
          const h = makeInferenceHarness({ routing: big(), upstream: held });
          const reserved = await heldCredits(h, audioForm(bytes, { duration_hint_seconds: String(seconds) }));
          // An upper bound: max(header, bytes / 8000) seconds at 6 credits a minute, rounded up once.
          expect(reserved).toBe(Math.ceil((Math.max(seconds, bytes.length / 8000) * 6) / 60));
          expect(reserved).toBeGreaterThanOrEqual(Math.ceil((seconds * 6) / 60));
          // The provider reports the real duration (the stub says 1 s): that is all that is charged.
          expect(await windowOf(h)).toMatchObject({ used: 1, reserved: 0 });
        });
      }

      it("reports the header duration when the provider reports none", async () => {
        const h = makeInferenceHarness({ routing: big(), upstream: () => transcript(null) });
        const res = await h.postForm(AUDIO, audioForm(wavBytes(10, { sampleRate: 44_100, channels: 2, bits: 16 })));
        expect(res.status).toBe(200);
        expect((await res.json()).duration_seconds).toBe(10);
      });
    });

    it("counts a provider that reports more audio than the route allows, and still charges only up to the reservation", async () => {
      const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(700) });
      const ogg = new Uint8Array(2000);
      ogg.set([0x4f, 0x67, 0x67, 0x53]); // OggS: a container whose duration the gateway cannot read
      const res = await h.postForm(AUDIO, audioForm(ogg, {}, "audio/ogg"));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("60"); // capped at the reservation: the 100 s above the cap are not recovered
      expect(await h.stores.switches.getCounter("audio_duration_above_cap", `day:${new Date(h.clock.now()).toISOString().slice(0, 10)}`)).toBe(1);
      // A duration at or below the cap is not counted.
      const ok = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(600) });
      await ok.postForm(AUDIO, audioForm(ogg, {}, "audio/ogg"));
      expect(await ok.stores.switches.getCounter("audio_duration_above_cap", `day:${new Date(ok.clock.now()).toISOString().slice(0, 10)}`)).toBe(0);
    });

    it("a stated data size smaller than the file does not shrink the reservation: it is the bytes that bound it", async () => {
      const h = makeInferenceHarness({ routing: big(), upstream: held });
      // 300 s of PCM behind a data chunk that states 1000 bytes (a decoder may read to the end of the file).
      const reserved = await heldCredits(h, audioForm(wavBytes(300, { statedDataBytes: 1000 }), { duration_hint_seconds: "1" }));
      expect(reserved).toBe(31); // bytes / 8000 = 300.0055 s, not the stated 0.125 s
    });

    it("caps the reservation at the route's duration, and refuses a header that claims more than the cap", async () => {
      const routing = withModel(routingWithMedia(), "studentllm-transcribe", { maxAudioSeconds: 100, maxAudioBytes: 8 * 1024 * 1024 });
      const h = makeInferenceHarness({ routing, upstream: held });
      // 100 s of audio with 99.99 s of header: reserved on the bytes (100.0055 s) but never above the cap, 10 credits.
      expect(await heldCredits(h, audioForm(wavBytes(99.99)))).toBe(10);
      const honest = makeInferenceHarness({ routing });
      // A header that honestly says 200 s is above the cap and is refused outright.
      expect((await honest.postForm(AUDIO, audioForm(wavBytes(200)))).status).toBe(413);
    });

    it("reserves the whole route cap for a low-bitrate container, whatever its size", async () => {
      // 2 KB of Opus in an Ogg container can hold minutes of silence-suppressed speech.
      const ogg = new Uint8Array(2000);
      ogg.set([0x4f, 0x67, 0x67, 0x53]); // OggS
      const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: held });
      expect(await heldCredits(h, audioForm(ogg, {}, "audio/ogg"))).toBe(60); // 600 s at 6 credits a minute
    });

    for (const [name, type, head] of [
      ["mp3", "audio/mpeg", [0x49, 0x44, 0x33]],
      ["mp4", "audio/mp4", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]],
      ["webm", "audio/webm", [0x1a, 0x45, 0xdf, 0xa3]],
      ["flac", "audio/flac", [0x66, 0x4c, 0x61, 0x43]],
    ] as const) {
      it(`reserves the whole cap for a tiny ${name}, and refunds the difference on the reported duration`, async () => {
        const bytes = new Uint8Array(1500);
        bytes.set(head);
        const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(30) });
        const res = await h.postForm(AUDIO, audioForm(bytes, { duration_hint_seconds: "1" }, type));
        expect(res.status).toBe(200);
        expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("3"); // 30 s x 6 / 60: only what the provider reports
        expect(await windowOf(h)).toMatchObject({ used: 3, reserved: 0 });
      });
    }

    it("charges the whole cap price when a low-bitrate container's duration is not reported", async () => {
      const mp3 = new Uint8Array(4000);
      mp3.set([0x49, 0x44, 0x33]);
      const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(null) });
      const res = await h.postForm(AUDIO, audioForm(mp3, {}, "audio/mpeg"));
      expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("60");
    });

    it("looks the declared type up safely: a name from Object.prototype is not a type", async () => {
      const h = makeInferenceHarness({ routing: routingWithMedia() });
      for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", "audio/constructor"]) {
        const res = await h.postForm(AUDIO, audioForm(wavBytes(1), {}, type));
        expect(res.status, type).toBe(415);
      }
      const ocr = makeInferenceHarness({ routing: routingWithMedia() });
      for (const type of ["constructor", "toString", "__proto__"]) {
        expect((await ocr.postForm(OCR, imageForm(pngBytes(64), {}, type))).status, type).toBe(415);
      }
    });
  });

  describe("refuses before reserving anything", () => {
    const cases: Array<[string, () => FormData, number, string]> = [
      ["an unsupported media type", () => audioForm(wavBytes(1), {}, "application/octet-stream"), 415, "unsupported_media_type"],
      ["a mislabeled file", () => audioForm(wavBytes(1), {}, "audio/mpeg"), 415, "unsupported_media_type"],
      ["a field the contract does not have (a prompt)", () => audioForm(wavBytes(1), { prompt: "SECRET" }), 400, "invalid_request"],
      ["an unknown model", () => audioForm(wavBytes(1), { model: "nope" }), 400, "invalid_request"],
      ["a model of another feature", () => audioForm(wavBytes(1), { model: "studentllm-large" }), 400, "invalid_request"],
      ["a bad language", () => audioForm(wavBytes(1), { language: "french" }), 400, "invalid_request"],
      ["a negative duration hint", () => audioForm(wavBytes(1), { duration_hint_seconds: "-5" }), 400, "invalid_request"],
      ["a non-numeric duration hint", () => audioForm(wavBytes(1), { duration_hint_seconds: "soon" }), 400, "invalid_request"],
      ["a declared duration above the cap", () => audioForm(wavBytes(1), { duration_hint_seconds: "601" }), 413, "payload_too_large"],
      ["an empty file", () => audioForm(new Uint8Array(0)), 400, "invalid_request"],
      ["a file above the size cap", () => audioForm(wavBytes(300)), 413, "payload_too_large"], // 2.4 MB > 2 MiB
    ];
    for (const [name, make, status, errorCode] of cases) {
      it(`${name}: ${errorCode}`, async () => {
        const h = makeInferenceHarness({ routing: routingWithMedia() });
        const key = h.key();
        const res = await h.postForm(AUDIO, make(), { "Idempotency-Key": key });
        expect(res.status).toBe(status);
        expect(await code(res)).toBe(errorCode);
        expect(h.upstreamCalls).toHaveLength(0);
        expect(await windowOf(h)).toBeNull();
        expect(await h.stores.concurrency.activeCount(ACCOUNT_ID, h.clock.now())).toBe(0);
      });
    }

    it("a recording longer than the duration cap, known exactly from its WAV header", async () => {
      const h = makeInferenceHarness({ routing: withModel(routingWithMedia(), "studentllm-transcribe", { maxAudioSeconds: 100, maxAudioBytes: 4 * 1024 * 1024 }) });
      const res = await h.postForm(AUDIO, audioForm(wavBytes(200)));
      expect(res.status).toBe(413);
    });

    it("a field sent twice, and a missing file", async () => {
      const h = makeInferenceHarness({ routing: routingWithMedia() });
      const twice = audioForm(wavBytes(1));
      twice.append("language", "fr");
      twice.append("language", "en");
      expect((await h.postForm(AUDIO, twice)).status).toBe(400);
      const noFile = new FormData();
      noFile.set("model", "studentllm-transcribe");
      expect((await h.postForm(AUDIO, noFile)).status).toBe(400);
    });

    it("a body above the route cap, by its declared length", async () => {
      const h = makeInferenceHarness({ routing: routingWithMedia() });
      const res = await h.postForm(AUDIO, audioForm(wavBytes(1)), { "Content-Length": String(30 * 1024 * 1024) });
      expect(res.status).toBe(413);
    });
  });

  it("is a different key per chunk: two chunks, two charges, and a retried chunk is a conflict", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => transcript(30) });
    const chunk1 = h.key();
    expect((await h.postForm(AUDIO, audioForm(wavBytes(30)), { "Idempotency-Key": chunk1 })).status).toBe(200);
    expect((await h.postForm(AUDIO, audioForm(wavBytes(30)), { "Idempotency-Key": h.key() })).status).toBe(200);
    expect((await windowOf(h))!.requests).toBe(2);
    const retry = await h.postForm(AUDIO, audioForm(wavBytes(30)), { "Idempotency-Key": chunk1 });
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.details.state).toBe("settled");
  });

  describe("provider failures", () => {
    it("releases on an explicit error response and allows the same key again", async () => {
      let n = 0;
      const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => (++n === 1 ? errorResponse(500) : transcript(5)) });
      const key = h.key();
      const first = await h.postForm(AUDIO, audioForm(wavBytes(5)), { "Idempotency-Key": key });
      expect(first.status).toBe(503);
      expect(first.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
      expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
      expect((await h.postForm(AUDIO, audioForm(wavBytes(5)), { "Idempotency-Key": key })).status).toBe(200);
    });

    it("charges the full reservation on a timeout", async () => {
      const h = makeInferenceHarness({
        routing: withModel(routingWithMedia(), "studentllm-transcribe", { maxDurationMs: 30 }),
        upstream: (call) => new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal!.reason), { once: true })),
      });
      const res = await h.postForm(AUDIO, audioForm(wavBytes(120), { duration_hint_seconds: "120" }));
      expect(res.status).toBe(503);
      expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("13"); // max(120 s, bytes / 8000 = 120.0055 s) at 6 credits a minute
      expect((await windowOf(h))!.used).toBe(13);
    });

    it("charges the full reservation when the answer is unreadable", async () => {
      const h = makeInferenceHarness({ routing: routingWithMedia(), upstream: () => new Response("not json", { status: 200 }) });
      const res = await h.postForm(AUDIO, audioForm(wavBytes(60), { duration_hint_seconds: "60" }));
      expect(res.status).toBe(503);
      expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("7"); // max(60 s, bytes / 8000 = 60.0055 s)
    });

    it("skips a provider that cannot transcribe, then releases", async () => {
      const provider: UpstreamProvider = { id: "groq", chat: () => Promise.reject(new Error("unused")) };
      const h = makeInferenceHarness({ routing: routingWithMedia(), providers: (id) => (id === "groq" ? provider : undefined) });
      const res = await h.postForm(AUDIO, audioForm(wavBytes(5)));
      expect(res.status).toBe(503);
      expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
    });
  });

  it("needs consent for the transcription feature", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), consent: false });
    await h.stores.consents.record(
      { consentId: "cns_chat_only", accountId: ACCOUNT_ID, providerSetId: "ps1", providerSetVersion: 1, features: ["chat"], textVersion: "2026-11-01", granted: true },
      h.clock.now(),
    );
    const res = await h.postForm(AUDIO, audioForm(wavBytes(5)), { "X-StudentLLM-Consent": "cns_chat_only" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("consent_outdated");
  });

  it("answers kill_switch when transcription is switched off", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia() });
    await h.stores.switches.setDisabled({ scope: "feature", name: "transcription" }, true, h.clock.now());
    const res = await h.postForm(AUDIO, audioForm(wavBytes(5)));
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("kill_switch");
    expect(h.upstreamCalls).toHaveLength(0);
  });

  it("is not offered at all when the routing table has no transcription model", async () => {
    const h = makeInferenceHarness(); // the default table: chat only
    const res = await h.postForm(AUDIO, audioForm(wavBytes(5)));
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/ocr (the response schema is provisional)", () => {
  it("returns text and blocks as the provisional schema says, and charges per MiB received", async () => {
    let seen: OcrCall | undefined;
    const h = makeInferenceHarness({
      routing: routingWithMedia(),
      providers: ocrProvider(async (call) => {
        seen = call;
        return { text: "hello", blocks: [{ text: "hello", bbox: [0, 0, 10, 10] }, { text: "world", bbox: null }] };
      }),
    });
    const res = await h.postForm(OCR, imageForm(pngBytes(512 * 1024), { language: "fr" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(validateAgainst("OcrResponse", json)).toEqual([]);
    expect(json.blocks).toHaveLength(2);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("20"); // half a MiB at 40 credits per MiB
    expect(seen).toMatchObject({ upstreamModel: "example-ocr", language: "fr", file: { mime: "image/png" } });
    expect(seen!.file.bytes.length).toBe(512 * 1024);
    expect(await windowOf(h)).toMatchObject({ used: 20, byFeature: { ocr: 20 } });
  });

  it("refuses a mislabeled, non-image or oversized file before reserving", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia(), providers: ocrProvider(async () => ({ text: "", blocks: [] })) });
    expect((await h.postForm(OCR, imageForm(pngBytes(64), {}, "image/jpeg"))).status).toBe(415);
    expect((await h.postForm(OCR, imageForm(new Uint8Array(64), {}, "image/png"))).status).toBe(415);
    expect((await h.postForm(OCR, imageForm(pngBytes(64), {}, "application/pdf"))).status).toBe(415);
    expect((await h.postForm(OCR, imageForm(pngBytes(2 * 1024 * 1024)))).status).toBe(413);
    expect((await h.postForm(OCR, imageForm(pngBytes(64), { extra: "x" }))).status).toBe(400);
    expect(await windowOf(h)).toBeNull();
  });

  it("answers provider_unavailable and releases while no OCR provider is configured", async () => {
    const h = makeInferenceHarness({ routing: routingWithMedia() }); // the OpenAI-compatible provider has no OCR
    const res = await h.postForm(OCR, imageForm(pngBytes(64)));
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("0");
    expect(await windowOf(h)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("charges the reservation when the provider times out", async () => {
    const h = makeInferenceHarness({
      routing: withModel(routingWithMedia(), "studentllm-ocr", { maxDurationMs: 30 }),
      providers: ocrProvider((call) => new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }))),
    });
    const res = await h.postForm(OCR, imageForm(pngBytes(1024 * 1024)));
    expect(res.status).toBe(503);
    expect(res.headers.get("X-StudentLLM-Credits-Charged")).toBe("40");
  });

  it("passes the transcription call the signal of the gateway timer", async () => {
    let signal: AbortSignal | undefined;
    const provider: UpstreamProvider = {
      id: "groq",
      chat: () => Promise.reject(new Error("unused")),
      transcribe: async (call: TranscribeCall) => {
        signal = call.signal;
        return { text: "t", language: "fr", durationSeconds: 5, segments: [] };
      },
    };
    const h = makeInferenceHarness({ routing: routingWithMedia(), providers: (id) => (id === "groq" ? provider : undefined) });
    expect((await h.postForm(AUDIO, audioForm(wavBytes(5)))).status).toBe(200);
    expect(signal).toBeDefined();
  });
});

describe("the residual risk of compressed containers is written down", () => {
  it("says so in the README and next to the byte cap", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/Residual risk/);
    expect(readme).toContain("audio_duration_above_cap");
    expect(readme).toMatch(/`maxAudioBytes` must stay small before audio is enabled/);
    const routing = readFileSync(new URL("./routing.ts", import.meta.url), "utf8");
    expect(routing).toMatch(/Keep this SMALL until audio is enabled/);
  });
});
