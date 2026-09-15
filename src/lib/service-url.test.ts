import { describe, expect, it } from 'vitest';
import { normalizeServiceBaseUrl } from './service-url';

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
