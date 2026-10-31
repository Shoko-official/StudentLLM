import { describe, expect, it } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import { cspHeader, developmentCspHeader, parseCsp, productionCspHeader } from './tauri-csp';

const production = parseCsp(productionCspHeader(tauriConfig));
const sources = (directive: string) => production.get(directive) ?? [];
// The effective source list of a fetch directive, falling back to default-src like a browser.
const effective = (directive: string) => production.get(directive) ?? production.get('default-src') ?? [];

describe('Tauri production Content Security Policy', () => {
  it('exists, so the packaged webview never runs without a policy', () => {
    expect(tauriConfig.app.security.csp).not.toBeNull();
    expect(production.size).toBeGreaterThan(0);
  });

  it('serialises the directive map into a header string', () => {
    expect(cspHeader({ 'default-src': "'self'", 'img-src': ['data:', 'blob:'] })).toBe("default-src 'self'; img-src data: blob:");
    expect(parseCsp("default-src 'self'; ; script-src 'self'; script-src *").get('script-src')).toEqual(["'self'"]);
  });

  it('allows scripts only from the app itself, with no eval and no inline code', () => {
    expect(sources('script-src')).toEqual(["'self'"]);
    for (const directive of ['script-src', 'script-src-elem', 'script-src-attr', 'default-src', 'worker-src']) {
      const list = effective(directive);
      expect(list, directive).not.toContain("'unsafe-eval'");
      expect(list, directive).not.toContain("'unsafe-inline'");
      expect(list, directive).not.toContain("'wasm-unsafe-eval'");
      expect(list, directive).not.toContain('*');
      expect(list, directive).not.toContain('https:');
      expect(list, directive).not.toContain('http:');
    }
  });

  it('keeps inline styles to attributes only (KaTeX output), never style elements', () => {
    expect(sources('style-src')).toEqual(["'self'"]);
    expect(production.get('style-src-elem')).toBeUndefined();
    expect(sources('style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('forbids plugins, base-uri rewriting, framing, and form posts', () => {
    expect(sources('object-src')).toEqual(["'none'"]);
    expect(sources('base-uri')).toEqual(["'none'"]);
    expect(sources('frame-ancestors')).toEqual(["'none'"]);
    expect(sources('form-action')).toEqual(["'none'"]);
  });

  it('limits frames to blob previews', () => {
    expect(sources('frame-src')).toEqual(['blob:']);
  });

  it('loads images, fonts, media and workers from the app, data URIs and blobs only', () => {
    const allowed = new Set(["'self'", 'data:', 'blob:']);
    for (const directive of ['default-src', 'img-src', 'font-src', 'media-src', 'worker-src']) {
      for (const source of effective(directive)) expect(allowed.has(source), `${directive} ${source}`).toBe(true);
    }
    expect(sources('default-src')).toEqual(["'self'"]);
  });

  it('connects only to the app, Tauri IPC and loopback services', () => {
    const allowedHosts = new Set(["'self'", 'ipc:', 'http://ipc.localhost', 'http://127.0.0.1:*', 'http://localhost:*']);
    const connect = sources('connect-src');
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'ipc:', 'http://ipc.localhost']));
    for (const source of connect) expect(allowedHosts.has(source), `connect-src ${source}`).toBe(true);
    // No bare wildcard, scheme-wide allowance, or insecure remote host.
    for (const source of connect) {
      expect(source).not.toBe('*');
      expect(source).not.toMatch(/^(https?|wss?|ws):?$/);
      expect(source).not.toMatch(/\*\./);
    }
    // The cloud gateway origin is added by the cloud client, not before.
    expect(connect.filter((source) => /^https:/.test(source))).toEqual([]);
  });

  it('keeps the development policy as strict as production except for what the Vite dev server needs', () => {
    const development = parseCsp(developmentCspHeader(tauriConfig));
    expect(development.get('object-src')).toEqual(["'none'"]);
    expect(development.get('base-uri')).toEqual(["'none'"]);
    expect(development.get('frame-ancestors')).toEqual(["'none'"]);
    expect(development.get('form-action')).toEqual(["'none'"]);
    expect(development.get('script-src')).not.toContain("'unsafe-eval'");
    const devConnect = (development.get('connect-src') ?? []).filter((source) => !sources('connect-src').includes(source));
    expect(devConnect.sort()).toEqual(['ws://127.0.0.1:1420', 'ws://localhost:1420']);
  });
});
