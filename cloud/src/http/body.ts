import { utf8Decode } from "../crypto/encoding";
import type { BodyReader } from "./context";
import { ApiError } from "./envelope";

/**
 * Wraps a request body so that it errors with `payload_too_large` as soon as more than `maxBytes` have
 * arrived. The source is cancelled at that point, so an oversized body is cut off without being
 * buffered whole.
 */
export function limitStream(source: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new ApiError("payload_too_large");
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Rejects early on a declared `Content-Length` above the limit, before reading anything. */
function checkDeclaredLength(request: Request, maxBytes: number): void {
  const header = request.headers.get("Content-Length");
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw new ApiError("invalid_request", { message: "Invalid Content-Length." });
  if (Number(header) > maxBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new ApiError("payload_too_large");
  }
}

export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  checkDeclaredLength(request, maxBytes);
  if (!request.body) return new Uint8Array(0);
  const reader = limitStream(request.body, maxBytes).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_request", { message: "The request body could not be read." });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The media type without parameters, lower case; null when absent. */
export function mediaType(request: Request): string | null {
  const raw = request.headers.get("Content-Type");
  if (raw === null) return null;
  return raw.split(";")[0]!.trim().toLowerCase();
}

/** `Content-Type` must be `application/json` (a charset parameter is fine). Otherwise `unsupported_media_type`. */
export function assertJsonContentType(request: Request): void {
  if (mediaType(request) !== "application/json") throw new ApiError("unsupported_media_type");
}

/** `Content-Type` must be `multipart/form-data` and carry a boundary. */
export function assertMultipartContentType(request: Request): void {
  if (mediaType(request) !== "multipart/form-data" || !/;\s*boundary=\S+/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new ApiError("unsupported_media_type");
  }
}

export function createBodyReader(request: Request, maxBytes: number): BodyReader {
  let cached: Promise<Uint8Array> | undefined;
  let consumedAsForm = false;

  const bytes = () => {
    if (consumedAsForm) throw new Error("body already consumed as form data");
    cached ??= readBodyLimited(request, maxBytes);
    return cached;
  };

  return {
    bytes,
    async text() {
      try {
        return utf8Decode(await bytes());
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("invalid_request", { message: "The body is not valid UTF-8." });
      }
    },
    async json() {
      assertJsonContentType(request);
      const text = await this.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ApiError("invalid_request", { message: "The body is not valid JSON." });
      }
    },
    async formData() {
      assertMultipartContentType(request);
      if (cached) throw new Error("body already consumed as bytes");
      consumedAsForm = true;
      checkDeclaredLength(request, maxBytes);
      if (!request.body) throw new ApiError("invalid_request", { message: "The body is empty." });
      try {
        const limited = limitStream(request.body, maxBytes);
        return await new Response(limited, { headers: { "Content-Type": request.headers.get("Content-Type")! } }).formData();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isOversize(error)) throw new ApiError("payload_too_large");
        throw new ApiError("invalid_request", { message: "The multipart body is invalid." });
      }
    },
  };
}

function isOversize(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i++) {
    if (e instanceof ApiError && e.code === "payload_too_large") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
