export interface SidecarHealth {
  available: boolean;
  model?: string;
  detail: string;
}

export interface SidecarHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Report addresses outside this computer as unreachable instead of requesting them (packaged app). */
  loopbackOnly?: boolean;
}

export async function probeSidecar(baseUrl: string | undefined, options: SidecarHealthOptions = {}): Promise<SidecarHealth> {
  let normalizedUrl: string | undefined;
  try {
    normalizedUrl = baseUrl ? normalizeServiceBaseUrl(baseUrl) : undefined;
  } catch {
    return { available: false, detail: 'The service URL is invalid.' };
  }
  if (!normalizedUrl) return { available: false, detail: 'Not configured.' };
  if (options.loopbackOnly && !isLoopbackServiceUrl(normalizedUrl)) return { available: false, detail: LOOPBACK_ONLY_DETAIL };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_500);
  try {
    const response = await fetchImpl(`${normalizedUrl}/health`, { signal: controller.signal });
    const body = await readJsonResponse(response, 'sidecar');
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
    return { available: false, detail: describeServiceUnreachable(error) };
  } finally {
    clearTimeout(timer);
  }
}
import { readJsonResponse } from './response-json';
import { describeServiceUnreachable } from './service-errors';
import { isLoopbackServiceUrl, LOOPBACK_ONLY_DETAIL, normalizeServiceBaseUrl } from './service-url';
