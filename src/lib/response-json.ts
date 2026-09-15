export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_REQUEST_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_REQUEST_BYTES = 250 * 1024 * 1024;

async function readBoundedText(response: Response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) throw new Error('The response is too large.');
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text.length > MAX_JSON_RESPONSE_BYTES) throw new Error('The response is too large.');
      return text;
    }
    if (typeof response.json === 'function') {
      const text = JSON.stringify(await response.json());
      if (text.length > MAX_JSON_RESPONSE_BYTES) throw new Error('The response is too large.');
      return text;
    }
    throw new Error('The response body is unavailable.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('The response is too large.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'The response is too large.') throw new Error(`The ${label} response is too large.`);
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
