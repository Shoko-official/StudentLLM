import { describe, expect, it } from 'vitest';
import { normalizeExtractedDocumentText } from './document-text';

describe('document text normalization', () => {
  it('repairs common PDF control characters without exposing them in notes', () => {
    const normalized = normalizeExtractedDocumentText('De\u001cnition des differentials \u0088 formula');

    expect(normalized).toBe('Definition des differentials • formula');
    expect(normalized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('preserves line boundaries while collapsing extraction whitespace', () => {
    expect(normalizeExtractedDocumentText('  First   line\n\n Second\tline  ')).toBe('First line\nSecond line');
  });
});
