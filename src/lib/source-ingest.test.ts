import { describe, expect, it } from 'vitest';
import { createSourceResource } from './source-ingest';

const file = (name: string, type: string) => ({
  name,
  type,
  size: 4096,
  lastModified: 123,
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

describe('source ingestion', () => {
  it('classifies text sources and records provenance metadata', async () => {
    const resource = await createSourceResource(file('lecture-notes.md', 'text/markdown'), async () => new Uint8Array([0xab, 0xcd]).buffer);

    expect(resource).toMatchObject({
      id: 'source-abcd',
      name: 'lecture-notes.md',
      meta: 'Text · 4.0 KB',
      kind: 'transcript',
      mimeType: 'text/markdown',
      sizeBytes: 4096,
      sha256: 'abcd',
      lastModified: 123,
    });
  });

  it('classifies audio, images, and documents without trusting extensions alone', async () => {
    const digest = async () => new Uint8Array([1]).buffer;
    await expect(createSourceResource(file('lecture.webm', 'audio/webm'), digest)).resolves.toMatchObject({ kind: 'audio', meta: 'Audio · 4.0 KB' });
    await expect(createSourceResource(file('board.png', 'image/png'), digest)).resolves.toMatchObject({ kind: 'image', meta: 'Image · 4.0 KB' });
    await expect(createSourceResource(file('slides.pdf', 'application/pdf'), digest)).resolves.toMatchObject({ kind: 'document', meta: 'Document · 4.0 KB' });
  });
});
