import { describe, expect, it, vi } from 'vitest';
import { createSourceResource, MAX_SOURCE_BYTES } from './source-ingest';

const file = (name: string, type: string) => ({
  name,
  type,
  size: 4096,
  lastModified: 123,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

describe('source import limits', () => {
  it('rejects oversized files before hashing', async () => {
    const digest = vi.fn(async () => new Uint8Array([0xab, 0xcd]).buffer);
    const oversized = file('lecture.pdf', 'application/pdf');
    oversized.size = MAX_SOURCE_BYTES.document + 1;

    await expect(createSourceResource(oversized, digest)).rejects.toThrow('exceeds the 100 MB document limit');
    expect(digest).not.toHaveBeenCalled();
  });

  it('rejects invalid file sizes instead of allocating for them', async () => {
    const invalid = file('notes.txt', 'text/plain');
    invalid.size = Number.POSITIVE_INFINITY;

    await expect(createSourceResource(invalid)).rejects.toThrow('file size is invalid');
  });
});
