// Paddle webhook signature (docs/cloud-plan.md, "Webhook specification").
//
// Header format (VERIFY against Paddle's current documentation): `Paddle-Signature: ts=<unix seconds>;h1=<hex>`,
// where h1 is HMAC-SHA256 over `<ts>:<raw body bytes>` with the endpoint secret, hex-encoded. During a secret
// rotation the header may carry more than one `h1`, one per active secret.
//
// The check runs on the RAW request bytes before anything is parsed, compares in constant time, accepts the
// current and the previous secret (rotation), and bounds the timestamp in both directions. Sandbox and live
// secrets are never mixed: a deployment holds the secrets of one environment only (config PADDLE_ENVIRONMENT).

import { utf8Encode } from "../../crypto/encoding";
import { verifyHmacSha256 } from "../../crypto/hash";

const MAX_HEADER_LENGTH = 1024;
const MAX_SIGNATURES = 4;
const TS = /^\d{1,12}$/;
const H1 = /^[0-9a-fA-F]{64}$/;

function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface ParsedSignature {
  /** Unix seconds as signed. */
  timestamp: number;
  /** Lower-case hex digests, in header order, at most MAX_SIGNATURES. */
  signatures: string[];
}

/** Parses the header strictly; null for anything malformed, repeated `ts`, or no usable `h1`. */
export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (header === null || header.length === 0 || header.length > MAX_HEADER_LENGTH) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "ts") {
      if (timestamp !== null || !TS.test(value)) return null;
      timestamp = Number(value);
    } else if (name === "h1") {
      if (!H1.test(value)) return null;
      if (signatures.length < MAX_SIGNATURES) signatures.push(value.toLowerCase());
    }
    // Other schemes (h2, ...) are ignored: only h1 is verified.
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type SignatureFailure = "malformed" | "timestamp" | "mismatch";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

export interface VerifyOptions {
  /** The current secret first, then the previous one during a rotation. Never empty strings. */
  secrets: readonly string[];
  now: number;
  toleranceMs: number;
}

/**
 * Verifies the signature over the raw bytes. The timestamp is checked first (cheap, and a replayed capture
 * fails before any HMAC), but the HMAC work does not depend on which secret matched: every secret is tried
 * against every digest and the result is combined, so timing does not tell which secret was used.
 */
export async function verifyPaddleSignature(header: string | null, rawBody: Uint8Array, options: VerifyOptions): Promise<SignatureResult> {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (Math.abs(options.now - parsed.timestamp * 1000) > options.toleranceMs) return { ok: false, reason: "timestamp" };

  const prefix = utf8Encode(`${parsed.timestamp}:`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix, 0);
  signed.set(rawBody, prefix.length);

  let matched = false;
  for (const secret of options.secrets) {
    if (secret.length === 0) continue;
    for (const digest of parsed.signatures) {
      // crypto.subtle.verify compares in constant time.
      const ok = await verifyHmacSha256(secret, signed, hexDecode(digest));
      matched = matched || ok;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}
