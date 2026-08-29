export interface SidecarHealth {
  available: boolean;
  model?: string;
  detail: string;
}

export interface SidecarHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function probeSidecar(baseUrl: string | undefined, options: SidecarHealthOptions = {}): Promise<SidecarHealth> {
  const normalizedUrl = baseUrl?.trim().replace(/\/$/, '');
  if (!normalizedUrl) return { available: false, detail: 'Not configured.' };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  try {
    const response = await fetchImpl(`${normalizedUrl}/health`, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body?.error === 'string' ? body.error : `Health endpoint returned HTTP ${response.status}.`;
      return { available: false, detail };
    }
    return {
      available: true,
      model: typeof body?.model === 'string' ? body.model : undefined,
      detail: typeof body?.status === 'string' ? body.status : 'Ready.',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { available: false, detail: 'Health check timed out.' };
    return { available: false, detail: error instanceof Error ? error.message : 'Health check failed.' };
  } finally {
    clearTimeout(timer);
  }
}
