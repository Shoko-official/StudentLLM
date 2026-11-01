import { describe, expect, it } from 'vitest';
import { resolveContextWindow, parseContextWindow, contextOutputTokens } from './model-context';

describe('configured context capacity', () => {
  it('uses documented known profiles and explicit loaded-model overrides without guessing custom model capacity', () => {
    expect(resolveContextWindow({ provider: 'nvidia-nim', model: 'mistralai/mistral-large-4-1t-a52b' })).toBe(1_000_000);
    expect(resolveContextWindow({ provider: 'nvidia-nim', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' })).toBe(1_000_000);
    expect(resolveContextWindow({ provider: 'local', model: 'a-huge-model' })).toBe(32_768);
    expect(resolveContextWindow({ provider: 'local', model: 'custom', advertised: 16_384 })).toBe(16_384);
    expect(resolveContextWindow({ provider: 'nvidia-nim', model: 'mistralai/mistral-large-4-1t-a52b', override: '8192' })).toBe(8192);
  });
  it('reserves output inside the shared window and rejects invalid configured limits', () => {
    expect(contextOutputTokens(8192, 8192)).toBe(2048);
    expect(contextOutputTokens(1_000_000, 8192)).toBe(8192);
    expect(parseContextWindow('')).toBeNull();
    for (const value of ['-1', 'NaN', 'Infinity', '1000001', '8192.5', '8e4']) expect(() => parseContextWindow(value)).toThrow(/context window/i);
  });
});
