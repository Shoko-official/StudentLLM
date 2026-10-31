import { describe, expect, it } from 'vitest';
import { isLoopbackServiceUrl, isRemoteServiceUrl, normalizeServiceBaseUrl } from './service-url';

describe('service URL validation', () => {
  it('accepts local proxy paths and HTTP(S) endpoints', () => {
    expect(normalizeServiceBaseUrl('/lm-studio/v1/')).toBe('/lm-studio/v1');
    expect(normalizeServiceBaseUrl('http://127.0.0.1:8766/')).toBe('http://127.0.0.1:8766');
    expect(normalizeServiceBaseUrl('https://example.test/api')).toBe('https://example.test/api');
  });

  it('rejects executable, credential-bearing, and protocol-relative URLs', () => {
    expect(() => normalizeServiceBaseUrl('javascript:alert(1)')).toThrow('unsupported');
    expect(() => normalizeServiceBaseUrl('//attacker.test/service')).toThrow('absolute');
    expect(() => normalizeServiceBaseUrl('https://user:password@example.test/api')).toThrow('credentials');
  });
});

describe('loopback service URLs', () => {
  it('accepts same-origin paths, localhost and 127.0.0.1 on any port', () => {
    expect(isLoopbackServiceUrl('/lm-studio/v1')).toBe(true);
    expect(isLoopbackServiceUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackServiceUrl('http://localhost:8766')).toBe(true);
  });

  it('rejects remote and look-alike hosts that the packaged app cannot reach', () => {
    expect(isLoopbackServiceUrl('https://integrate.api.nvidia.com/v1')).toBe(false);
    expect(isLoopbackServiceUrl('http://192.168.1.20:1234/v1')).toBe(false);
    expect(isLoopbackServiceUrl('http://127.0.0.1.example.test/v1')).toBe(false);
    expect(isLoopbackServiceUrl('http://localhost.example.test:1234')).toBe(false);
  });

  it('flags only well-formed non-loopback addresses as remote', () => {
    expect(isRemoteServiceUrl('https://api.example.test/v1')).toBe(true);
    expect(isRemoteServiceUrl('http://192.168.1.20:8765')).toBe(true);
    expect(isRemoteServiceUrl('http://127.0.0.1:8765')).toBe(false);
    expect(isRemoteServiceUrl('/lm-studio/v1')).toBe(false);
    expect(isRemoteServiceUrl('')).toBe(false);
    expect(isRemoteServiceUrl('not a url')).toBe(false);
  });
});
