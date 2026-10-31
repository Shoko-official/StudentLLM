// Strict request-body allowlist for POST /v1/chat/completions (docs/cloud-api.md, "Content routes"; the
// `ChatRequest` schema). A field that is not listed is `invalid_request`, the forbidden ones (`tools`,
// `tool_choice`, `functions`, `n` above 1, `logit_bias`, `user`, `stream_options`) by name. The validated value
// is REBUILT field by field, so nothing the client sent that is not listed can reach the upstream.
//
// Error messages are fixed text: they never echo a value or a client-chosen string, because a message could
// otherwise carry content into a response or a log.

import { ApiError } from "../../http/envelope";
import {
  countTokensFromBytes,
  estimateImageTokens,
  estimateTokensFromBytes,
  MAX_PLAUSIBLE_BYTES_PER_TOKEN,
  TOKENS_PER_MESSAGE_OVERHEAD,
  TOKENS_REPLY_PRIMING,
  utf8Length,
} from "./credits";
import type { UpstreamImagePart, UpstreamMessage, UpstreamTextPart } from "./provider";
import type { ChatRoute, RoutingTable } from "./routing";

export interface ValidatedChat {
  route: ChatRoute;
  messages: UpstreamMessage[];
  stream: boolean;
  /** Clamped to the model's limit. */
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  responseFormat?: Record<string, unknown>;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * The HARD UPPER BOUND of the input tokens that the reservation is made on: one token per UTF-8 byte of every text
   * the request carries (messages, `stop`, the `json_schema`) plus the framing and the images, capped at the context
   * window. Never a client value.
   */
  inputTokenEstimate: number;
  /** A tighter count of the same input, used only to settle a stream that failed in the middle (never the reservation). */
  inputTokenCount: number;
}

const ALLOWED = new Set(["model", "messages", "stream", "max_tokens", "temperature", "top_p", "stop", "response_format", "reasoning_effort"]);
/** Names that get a precise `details.field`; every other unknown field is rejected without being echoed. */
const FORBIDDEN = new Set(["tools", "tool_choice", "functions", "function_call", "logit_bias", "user", "stream_options", "n"]);

const MAX_MESSAGES = 256;
const MAX_STOP_LENGTH = 256;
const MAX_RESPONSE_FORMAT_BYTES = 16 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(message: string, field?: string): ApiError {
  return new ApiError("invalid_request", field ? { message, details: { field } } : { message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decoded size of a base64 string whose alphabet and padding were already checked. */
function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function matchesImageType(type: string, head: Uint8Array): boolean {
  if (type === "png") return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "jpeg") return startsWith(head, [0xff, 0xd8, 0xff]);
  return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
}

function parseImage(url: unknown, route: ChatRoute): { part: UpstreamImagePart; tokens: number } {
  if (typeof url !== "string") throw invalid("An image URL must be a string.");
  const match = DATA_URL.exec(url);
  // Only `data:` URLs of an allowed image type: an http(s) URL would make the provider (or the gateway) fetch it.
  if (!match) throw invalid("Images must be data URLs of type png, jpeg or webp.");
  const base64 = url.slice(match[0].length);
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64.test(base64)) throw invalid("The image is not valid base64.");
  const bytes = decodedLength(base64);
  if (bytes > route.maxImageBytes) throw new ApiError("payload_too_large", { message: "An image exceeds the size limit." });
  let head: Uint8Array;
  try {
    head = Uint8Array.from(atob(base64.slice(0, 16)), (c) => c.charCodeAt(0));
  } catch {
    throw invalid("The image is not valid base64.");
  }
  if (!matchesImageType(match[1]!, head)) throw invalid("The image content does not match its declared type.");
  return { part: { type: "image_url", image_url: { url } }, tokens: estimateImageTokens(bytes) };
}

export function validateChatRequest(raw: unknown, routing: RoutingTable): ValidatedChat {
  if (!isObject(raw)) throw invalid("The request body must be a JSON object.");
  for (const key of Object.keys(raw)) {
    if (key === "n") {
      if (raw.n !== 1) throw invalid("The field n above 1 is not allowed.", "n");
      continue;
    }
    if (FORBIDDEN.has(key)) throw invalid("This field is not allowed.", key);
    if (!ALLOWED.has(key)) throw invalid("The request contains an unknown field.");
  }

  if (typeof raw.model !== "string") throw invalid("model must be a string.");
  const route = routing.model(raw.model);
  if (!route || route.feature !== "chat") throw invalid("Unknown model.");

  if (!Array.isArray(raw.messages) || raw.messages.length < 1) throw invalid("messages must be a non-empty array.");
  if (raw.messages.length > MAX_MESSAGES) throw new ApiError("payload_too_large", { message: "Too many messages." });

  let fixedTokens = TOKENS_REPLY_PRIMING; // framing and images: tokens that are not text bytes
  let textBytes = 0;
  let images = 0;
  const messages: UpstreamMessage[] = [];
  for (const m of raw.messages as unknown[]) {
    if (!isObject(m)) throw invalid("A message must be an object.");
    for (const k of Object.keys(m)) if (k !== "role" && k !== "content") throw invalid("A message contains an unknown field.");
    if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") throw invalid("A message has an invalid role.");
    fixedTokens += TOKENS_PER_MESSAGE_OVERHEAD;
    if (typeof m.content === "string") {
      textBytes += utf8Length(m.content);
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content) || m.content.length < 1) throw invalid("A message content must be a string or a non-empty array.");
    const parts: Array<UpstreamTextPart | UpstreamImagePart> = [];
    for (const p of m.content as unknown[]) {
      if (!isObject(p)) throw invalid("A content part must be an object.");
      if (p.type === "text") {
        for (const k of Object.keys(p)) if (k !== "type" && k !== "text") throw invalid("A content part contains an unknown field.");
        if (typeof p.text !== "string") throw invalid("A text part needs a text string.");
        textBytes += utf8Length(p.text);
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image_url") {
        for (const k of Object.keys(p)) if (k !== "type" && k !== "image_url") throw invalid("A content part contains an unknown field.");
        if (m.role !== "user") throw invalid("Images are only allowed in user messages.");
        if (!isObject(p.image_url)) throw invalid("An image part needs an image_url object.");
        for (const k of Object.keys(p.image_url)) if (k !== "url") throw invalid("An image_url contains an unknown field.");
        if (route.maxImages === 0) throw invalid("This model does not accept images.");
        images++;
        if (images > route.maxImages) throw new ApiError("payload_too_large", { message: "Too many images." });
        const image = parseImage(p.image_url.url, route);
        fixedTokens += image.tokens;
        parts.push(image.part);
      } else {
        throw invalid("A content part has an invalid type.");
      }
    }
    messages.push({ role: m.role, content: parts });
  }

  const result: ValidatedChat = {
    route,
    messages,
    stream: false,
    maxTokens: route.maxOutputTokens,
    inputTokenEstimate: 0,
    inputTokenCount: 0,
  };

  if (raw.stream !== undefined) {
    if (typeof raw.stream !== "boolean") throw invalid("stream must be a boolean.");
    result.stream = raw.stream;
  }

  let requested = route.maxOutputTokens;
  if (raw.max_tokens !== undefined) {
    if (typeof raw.max_tokens !== "number" || !Number.isSafeInteger(raw.max_tokens) || raw.max_tokens < 1) {
      throw invalid("max_tokens must be a positive integer.");
    }
    requested = raw.max_tokens;
  }
  result.maxTokens = Math.min(requested, route.maxOutputTokens);

  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
      throw invalid("temperature must be a number from 0 to 2.");
    }
    result.temperature = raw.temperature;
  }
  if (raw.top_p !== undefined) {
    if (typeof raw.top_p !== "number" || !Number.isFinite(raw.top_p) || raw.top_p < 0 || raw.top_p > 1) {
      throw invalid("top_p must be a number from 0 to 1.");
    }
    result.topP = raw.top_p;
  }
  if (raw.stop !== undefined) {
    const stops = typeof raw.stop === "string" ? [raw.stop] : raw.stop;
    if (!Array.isArray(stops) || stops.length > 4 || stops.some((s) => typeof s !== "string" || s.length > MAX_STOP_LENGTH)) {
      throw invalid("stop must be a string or an array of up to 4 strings.");
    }
    result.stop = typeof raw.stop === "string" ? raw.stop : (stops as string[]);
    for (const stop of stops as string[]) textBytes += utf8Length(stop);
  }
  if (raw.response_format !== undefined) {
    const rf = raw.response_format;
    if (!isObject(rf) || (rf.type !== "json_object" && rf.type !== "json_schema")) throw invalid("response_format has an invalid type.");
    const clean: Record<string, unknown> = { type: rf.type };
    if (rf.type === "json_schema") {
      if (!isObject(rf.json_schema)) throw invalid("response_format json_schema must be an object.");
      clean.json_schema = rf.json_schema;
    }
    const formatBytes = utf8Length(JSON.stringify(clean));
    if (formatBytes > MAX_RESPONSE_FORMAT_BYTES) throw new ApiError("payload_too_large", { message: "response_format is too large." });
    // The provider reads the schema as part of the prompt: its bytes count like any other text.
    textBytes += formatBytes;
    result.responseFormat = clean;
  }
  if (raw.reasoning_effort !== undefined) {
    if (raw.reasoning_effort !== "low" && raw.reasoning_effort !== "medium" && raw.reasoning_effort !== "high") {
      throw invalid("reasoning_effort must be low, medium or high.");
    }
    result.reasoningEffort = raw.reasoning_effort;
  }

  // Even at the largest plausible bytes per token the input cannot fit the window: refuse it up front. Anything
  // below that is the provider's to judge (it answers 400, which releases the reservation).
  if (textBytes + fixedTokens > route.contextWindow * MAX_PLAUSIBLE_BYTES_PER_TOKEN) {
    throw new ApiError("payload_too_large", { message: "The input exceeds the context window." });
  }
  // The reservation is a hard upper bound (a token per byte), capped at the window: no tokenizer can bill more.
  result.inputTokenEstimate = Math.min(route.contextWindow, estimateTokensFromBytes(textBytes) + fixedTokens);
  result.inputTokenCount = Math.min(result.inputTokenEstimate, countTokensFromBytes(textBytes) + fixedTokens);
  return result;
}
