// Shared by the CSP unit test and the Playwright CSP spec, so both check the policy that ships in tauri.conf.json.
export type CspDirectives = Record<string, string | string[]>;

export interface TauriSecurityConfig {
  app?: { security?: { csp?: string | CspDirectives | null; devCsp?: string | CspDirectives | null } };
}

export function cspHeader(csp: string | CspDirectives | null | undefined): string {
  if (!csp) throw new Error('The Tauri configuration has no Content Security Policy.');
  if (typeof csp === 'string') return csp;
  return Object.entries(csp)
    .map(([directive, value]) => `${directive} ${Array.isArray(value) ? value.join(' ') : value}`.trim())
    .join('; ');
}

export function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    // The first occurrence wins, like in a browser.
    if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

export const productionCspHeader = (config: TauriSecurityConfig) => cspHeader(config.app?.security?.csp);
export const developmentCspHeader = (config: TauriSecurityConfig) => cspHeader(config.app?.security?.devCsp);
