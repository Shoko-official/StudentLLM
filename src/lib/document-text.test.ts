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

  it('restores LaTeX commands that were decoded as control characters', () => {
    const normalized = normalizeExtractedDocumentText('\u0008egin{pmatrix}\u000crac{x}{2} + \u0009ext{ln}(x)\u000dight');

    expect(normalized).toBe('\\begin{pmatrix}\\frac{x}{2} + \\text{ln}(x)\\right');
    expect(normalized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('repairs common UTF-8 mojibake operators at the extraction boundary', () => {
    expect(normalizeExtractedDocumentText('Gradient âˆ‡f â†’ âˆ‚f')).toBe('Gradient ∇f → ∂f');
  });
});
