// Web Crypto wants BufferSource views backed by a plain ArrayBuffer; copy into one.

import { toBytes, type BytesLike } from "../../crypto/encoding";

export function buf(value: BytesLike): Uint8Array<ArrayBuffer> {
  const bytes = toBytes(value);
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}
