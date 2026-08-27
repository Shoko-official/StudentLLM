import { describe, expect, it } from 'vitest';
import { createSourceBlobStore } from './source-storage';

describe('source blob storage', () => {
  it('round-trips a source blob and removes it in the memory fallback', async () => {
    const store = createSourceBlobStore(undefined);
    const blob = new Blob(['source content'], { type: 'text/plain' });

    expect(store.durability).toBe('memory-only');
    await store.save('source-1', blob);
    expect(await (await store.load('source-1'))?.text()).toBe('source content');
    await store.remove('source-1');
    expect(await store.load('source-1')).toBeNull();
  });
});
