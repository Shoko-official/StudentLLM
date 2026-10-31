import { toBytes, type BytesLike } from "./encoding";

/**
 * Constant-time equality. The running time depends on the longer input's length only, never on where
 * the first difference is. A length mismatch is folded into the result instead of returning early.
 */
export function constantTimeEqual(a: BytesLike, b: BytesLike): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
