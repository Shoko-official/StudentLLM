// Validation of the multipart bodies of POST /v1/audio/transcriptions and POST /v1/ocr: the allowlisted fields, the
// declared and the sniffed media type, the size and duration caps, and the server-side estimate of what the
// request costs. Nothing client-declared sets a price on its own: the duration bound comes from the bytes
// received, never from `duration_hint_seconds` alone, and the content sniffing means a mislabeled file is refused.

import { ApiError } from "../../http/envelope";
import { audioCost, atLeastOne, imageCost } from "./credits";
import type { OcrRoute, RoutingTable, TranscriptionRoute } from "./routing";

function invalid(message: string): ApiError {
  return new ApiError("invalid_request", { message });
}

function field(form: FormData, name: string): FormDataEntryValue | undefined {
  const all = form.getAll(name);
  if (all.length > 1) throw invalid("A field was sent more than once.");
  return all[0];
}

function string(form: FormData, name: string): string | undefined {
  const value = field(form, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("A field has an invalid type.");
  return value;
}

function assertFields(form: FormData, allowed: readonly string[]): void {
  for (const key of new Set(form.keys())) {
    if (!allowed.includes(key)) throw invalid("The request contains an unknown field.");
  }
}

/** The file part of a form: a non-empty blob. The client's file name is ignored everywhere. */
function filePart(form: FormData): File {
  const value = field(form, "file");
  if (value === undefined || typeof value === "string") throw invalid("A file part is required.");
  if (value.size === 0) throw invalid("The file is empty.");
  return value;
}

function mediaTypeOf(file: File): string {
  return file.type.split(";")[0]!.trim().toLowerCase();
}

const at = (bytes: Uint8Array, i: number): number => bytes[i] ?? -1;
const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => [...text].every((c, i) => at(bytes, offset + i) === c.charCodeAt(0));

// ---------------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------------

type AudioKind = "mpeg" | "mp4" | "wav" | "webm" | "ogg" | "flac";

// A Map, not an object: the declared type is client text, and `{}["constructor"]` is a function, not undefined.
const AUDIO_TYPES: ReadonlyMap<string, AudioKind> = new Map<string, AudioKind>([
  ["audio/mpeg", "mpeg"],
  ["audio/mp4", "mp4"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/flac", "flac"],
]);

const AUDIO_EXTENSION: Record<AudioKind, string> = { mpeg: "mp3", mp4: "m4a", wav: "wav", webm: "webm", ogg: "ogg", flac: "flac" };

/**
 * The highest plausible bytes per second of each container. A file of N bytes lasts AT LEAST N / max seconds, so a
 * file that is certainly longer than the cap is refused up front. There is no matching "lowest rate" for the
 * compressed containers: a low-bitrate or silence-suppressed stream (Opus DTX, a few kbit/s) can last far longer than
 * its size suggests, and the container header is client-controlled. Their reservation is therefore the route's whole
 * `maxAudioSeconds` price, and settlement on the provider-reported duration refunds the difference.
 */
const MAX_BYTE_RATE: Record<AudioKind, number> = {
  mpeg: 40_000,
  mp4: 40_000,
  webm: 40_000,
  ogg: 40_000,
  flac: 600_000,
  wav: 1_536_000, // 192 kHz, 32-bit, stereo
};

/**
 * The lowest byte rate a WAV can plausibly have (8-bit PCM at 4 kHz, or ADPCM). The duration the WAV header states
 * is client-controlled (a forged byte rate of 0xfffffff0 makes any file "last" a few milliseconds), so the
 * reservation is `max(header duration, bytes / WAV_MIN_BYTE_RATE)`: never the header alone.
 */
export const WAV_MIN_BYTE_RATE = 4000;

function sniffAudio(head: Uint8Array): AudioKind | null {
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return "wav";
  if (ascii(head, 0, "OggS")) return "ogg";
  if (ascii(head, 0, "fLaC")) return "flac";
  if (at(head, 0) === 0x1a && at(head, 1) === 0x45 && at(head, 2) === 0xdf && at(head, 3) === 0xa3) return "webm";
  if (ascii(head, 4, "ftyp")) return "mp4";
  if (ascii(head, 0, "ID3") || (at(head, 0) === 0xff && (at(head, 1) & 0xe0) === 0xe0)) return "mpeg";
  return null;
}

/** Exact duration of a PCM WAV from its header (the byte rate and the data chunk size), or null when unreadable. */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(at(bytes, offset), at(bytes, offset + 1), at(bytes, offset + 2), at(bytes, offset + 3));
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      // A streamed WAV may carry 0 or 0xFFFFFFFF as the size: use what was received.
      if (size === 0 || size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      return byteRate > 0 ? size / byteRate : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

export interface AudioInput {
  route: TranscriptionRoute;
  bytes: Uint8Array;
  mime: string;
  extension: string;
  language?: string;
  /**
   * Seconds the reservation is sized on, never above the cap. WAV: `max(declared, header duration, bytes / lowest
   * plausible rate)`. Any other container: the route's whole `maxAudioSeconds`.
   */
  reservedSeconds: number;
  reservedCredits: number;
  /** What `duration_seconds` says when the provider reports none: the WAV header, else the declared hint, else the reservation. */
  fallbackSeconds: number;
}

export async function validateTranscription(form: FormData, routing: RoutingTable): Promise<AudioInput> {
  assertFields(form, ["file", "model", "language", "response_format", "duration_hint_seconds"]);
  const modelId = string(form, "model");
  if (modelId === undefined) throw invalid("model is required.");
  const route = routing.model(modelId);
  if (!route || route.feature !== "transcription") throw invalid("Unknown model.");

  const file = filePart(form);
  const kind = AUDIO_TYPES.get(mediaTypeOf(file));
  if (!kind) throw new ApiError("unsupported_media_type");
  if (file.size > route.maxAudioBytes) throw new ApiError("payload_too_large", { message: "The audio exceeds the size limit." });

  const language = string(form, "language");
  if (language !== undefined && !/^[a-z]{2}$/.test(language)) throw invalid("language must be a two-letter code.");
  const format = string(form, "response_format");
  if (format !== undefined && format !== "json" && format !== "verbose_json") throw invalid("response_format must be json or verbose_json.");
  let declared = 0;
  const hint = string(form, "duration_hint_seconds");
  if (hint !== undefined) {
    declared = Number(hint);
    if (hint.trim() === "" || !Number.isFinite(declared) || declared < 0) throw invalid("duration_hint_seconds must be a non-negative number.");
  }
  if (declared > route.maxAudioSeconds) throw new ApiError("payload_too_large", { message: "The audio exceeds the duration limit." });

  const bytes = new Uint8Array(await file.arrayBuffer());
  // The content must be what the part claims: a mislabeled file is refused, not guessed at.
  if (sniffAudio(bytes.subarray(0, 16)) !== kind) throw new ApiError("unsupported_media_type");

  // A file that is certainly longer than the cap, whatever its header says.
  let longest = bytes.length / MAX_BYTE_RATE[kind];
  let reservedSeconds = route.maxAudioSeconds;
  let fallbackSeconds = declared > 0 ? declared : reservedSeconds;
  if (kind === "wav") {
    const header = wavDurationSeconds(bytes);
    if (header === null) throw invalid("The WAV header is unreadable.");
    longest = Math.max(longest, header); // a header that claims more than the cap is refused too
    reservedSeconds = Math.min(route.maxAudioSeconds, Math.max(declared, header, bytes.length / WAV_MIN_BYTE_RATE));
    fallbackSeconds = Math.min(route.maxAudioSeconds, Math.max(declared, header));
  }
  if (longest > route.maxAudioSeconds) throw new ApiError("payload_too_large", { message: "The audio exceeds the duration limit." });

  const result: AudioInput = {
    route,
    bytes,
    mime: kind === "wav" ? "audio/wav" : mediaTypeOf(file),
    extension: AUDIO_EXTENSION[kind],
    reservedSeconds,
    reservedCredits: atLeastOne(audioCost(route.price.perMinute, reservedSeconds)),
    fallbackSeconds,
  };
  if (language !== undefined) result.language = language;
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Images (OCR)
// ---------------------------------------------------------------------------------------------------

type ImageKind = "png" | "jpeg" | "webp";
const IMAGE_TYPES: ReadonlyMap<string, ImageKind> = new Map<string, ImageKind>([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

function sniffImage(head: Uint8Array): ImageKind | null {
  if (at(head, 0) === 0x89 && ascii(head, 1, "PNG")) return "png";
  if (at(head, 0) === 0xff && at(head, 1) === 0xd8 && at(head, 2) === 0xff) return "jpeg";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "webp";
  return null;
}

export interface ImageInput {
  route: OcrRoute;
  bytes: Uint8Array;
  mime: string;
  language?: string;
  reservedCredits: number;
}

export async function validateOcr(form: FormData, routing: RoutingTable): Promise<ImageInput> {
  assertFields(form, ["file", "model", "language"]);
  const modelId = string(form, "model");
  if (modelId === undefined) throw invalid("model is required.");
  const route = routing.model(modelId);
  if (!route || route.feature !== "ocr") throw invalid("Unknown model.");

  const file = filePart(form);
  const kind = IMAGE_TYPES.get(mediaTypeOf(file));
  if (!kind) throw new ApiError("unsupported_media_type");
  if (file.size > route.maxImageBytes) throw new ApiError("payload_too_large", { message: "The image exceeds the size limit." });
  const language = string(form, "language");
  if (language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) throw invalid("language is invalid.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImage(bytes.subarray(0, 16)) !== kind) throw new ApiError("unsupported_media_type");
  const result: ImageInput = {
    route,
    bytes,
    mime: mediaTypeOf(file),
    reservedCredits: atLeastOne(imageCost(route.price.perMiB, bytes.length)),
  };
  if (language !== undefined) result.language = language;
  return result;
}
