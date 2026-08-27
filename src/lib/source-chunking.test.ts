import { describe, expect, it } from 'vitest';
import { chunkSourceText } from './source-chunking';

describe('source text chunking', () => {
  it('preserves non-empty text and source line positions', () => {
    expect(chunkSourceText('First line\n\nSecond line', 100)).toEqual([
      { index: 0, startLine: 1, text: 'First line\n\nSecond line' },
    ]);
  });

  it('splits long sources into bounded, ordered passages', () => {
    const chunks = chunkSourceText('12345\n67890\nabcde', 11);

    expect(chunks).toEqual([
      { index: 0, startLine: 1, text: '12345\n67890' },
      { index: 1, startLine: 3, text: 'abcde' },
    ]);
    expect(chunks.every((chunk) => chunk.text.length <= 11)).toBe(true);

    expect(chunkSourceText('123456789', 4).map((chunk) => chunk.text)).toEqual(['1234', '5678', '9']);
  });

  it('rejects an invalid chunk size', () => {
    expect(() => chunkSourceText('content', 0)).toThrow('Chunk size must be positive.');
  });
});
