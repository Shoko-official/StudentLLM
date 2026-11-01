import { describe, expect, it } from 'vitest';
import { hasEmbeddedImages, redactContextImages } from './context-text';

describe('context image redaction', () => {
  it('preserves Markdown alt text and prose while removing long payloads before splitting', () => {
    const image = 'A'.repeat(12_000);
    const text = `Before ![Pressure diagram](data:image/png;base64,${image}) after.`;
    expect(redactContextImages(text)).toBe('Before ![Pressure diagram]([image payload omitted]) after.');
    expect(text).toContain(image);
  });

  it('recognizes percent-encoded SVG image payloads and URI separators without decoding them', () => {
    const text = 'Before ![formula](data:image/svg+xml,%3Csvg%3E%3Cpath%20d=%22M0%200%22/%3E%3C/svg%3E) between data%3Aimage%2Fpng%3Bbase64%2CAAAA after.';
    const result = redactContextImages(text);
    expect(result).toBe('Before ![formula]([image payload omitted]) between [image payload omitted] after.');
    expect(hasEmbeddedImages(result)).toBe(false);
  });

  it('redacts multiline HTML and SVG href payloads while preserving alt and other attributes', () => {
    const text = '<img alt="Water diagram" src="data:image/png;base64,AAAA\nBBBB" width="400"> <image xlink:href=\'data:image/png;base64,CCCC\' />';
    expect(redactContextImages(text)).toBe('<img alt="Water diagram" src="[image payload omitted]" width="400"> <image xlink:href=\'[image payload omitted]\' />');
  });

  it('removes nested inline SVG while preserving its accessible label and surrounding prose', () => {
    const text = 'Before <svg aria-label="Pressure"><svg><path d="M1 2"/></svg><text>secret image text</text></svg> middle <svg><title>Speed</title><path/></svg> after.';
    expect(redactContextImages(text)).toBe('Before [image: Pressure] middle [image: Speed] after.');
  });

  it('does not fetch, rewrite external URLs, or classify ordinary base64 strings as images', () => {
    const text = '![External](https://example.com/image.png) AQIDBAUG plain data:text/plain;base64,QUJD.';
    expect(redactContextImages(text)).toBe(text);
    expect(hasEmbeddedImages(text)).toBe(false);
  });

  it('recognizes basic HTML entity separators without decoding the payload', () => {
    for (const uri of ['data&#58;image&#47;png;base64,AAAA', 'data&#x3a;image&#x2f;png;base64,AAAA', 'data&colon;image&sol;png;base64,AAAA']) {
      expect(hasEmbeddedImages(uri)).toBe(true);
      expect(redactContextImages(`<img alt="Formula" src="${uri}">`)).toBe('<img alt="Formula" src="[image payload omitted]">');
    }
  });

  it('redacts an unmatched SVG tail, including a truncated opening tag', () => {
    expect(redactContextImages('Before <svg aria-label="Diagram"><path d="M1 2"/>PRIVATEVECTOR')).toBe('Before [image: Diagram]');
    expect(redactContextImages('Before <svg viewBox="0 0 400')).toBe('Before [image payload omitted]');
  });

  it('redacts quoted multiline CSS image values without changing the surrounding declaration', () => {
    expect(redactContextImages('before <div style="background:url(\'data:image/png;base64,AAAA\nBBBB\')">after</div>')).toBe('before <div style="background:url(\'[image payload omitted]\')">after</div>');
  });
});
