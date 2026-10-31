const MAX_SERVICE_URL_LENGTH = 2_048;

export function normalizeServiceBaseUrl(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SERVICE_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('The service URL is invalid or too long.');
  }
  if (normalized.startsWith('//')) throw new Error('Protocol-relative service URLs are not absolute URLs.');
  if (normalized.startsWith('/')) return normalized.replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('The service URL is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The service URL uses an unsupported protocol.');
  if (parsed.username || parsed.password) throw new Error('Service URLs cannot contain credentials.');
  return normalized.replace(/\/+$/, '');
}

// The packaged app's Content Security Policy only lets the webview call this computer (see docs/desktop.md),
// so an address elsewhere can only fail. Relative paths stay same-origin.
export function isLoopbackServiceUrl(value: string) {
  const normalized = normalizeServiceBaseUrl(value);
  if (normalized.startsWith('/')) return true;
  const { hostname } = new URL(normalized);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export const LOOPBACK_ONLY_DETAIL = 'The desktop app only connects to services on this computer (localhost or 127.0.0.1).';
