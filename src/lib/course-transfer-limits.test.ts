import { describe, expect, it } from 'vitest';
import { readCourseExport } from './course-transfer';

describe('course export limits', () => {
  it('rejects an oversized export before parsing its JSON', async () => {
    const oversized = new Blob(['x'], { type: 'application/json' });
    Object.defineProperty(oversized, 'size', { value: 256 * 1024 * 1024 + 1 });

    await expect(readCourseExport(oversized)).rejects.toThrow('export is too large');
  });
});
