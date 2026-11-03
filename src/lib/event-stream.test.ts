import { describe, expect, it } from 'vitest';
import { createEventStreamParser } from './event-stream';

const encode = (text: string) => new TextEncoder().encode(text);

function parse(chunks: Uint8Array[]) {
  const parser = createEventStreamParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

describe('createEventStreamParser', () => {
  it('reads one payload per event', () => {
    expect(parse([encode('data: one\n\ndata: two\n\n')])).toEqual(['one', 'two']);
  });

  it('returns an event as soon as its blank line arrives', () => {
    const parser = createEventStreamParser();
    expect(parser.push(encode('data: one\n'))).toEqual([]);
    expect(parser.push(encode('\n'))).toEqual(['one']);
  });

  it('gives the same events wherever the chunks are split, even inside a character or a CRLF', () => {
    const bytes = encode(': hello\r\n\r\ndata: é€😀\r\n\r\ndata: {"a":1}\n\n');
    for (let split = 0; split <= bytes.length; split++) {
      expect(parse([bytes.slice(0, split), bytes.slice(split)])).toEqual(['é€😀', '{"a":1}']);
    }
    expect(parse([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(['é€😀', '{"a":1}']);
  });

  it('accepts CRLF and lone CR line endings', () => {
    expect(parse([encode('data: one\r\n\r\ndata: two\r\rdata: three\r\n\r\n')])).toEqual(['one', 'two', 'three']);
  });

  it('ignores comment lines and other fields', () => {
    expect(parse([encode(': keep-alive\n\nevent: delta\nid: 3\ndata: one\nretry: 5\n\n:\n\n')])).toEqual(['one']);
  });

  it('does not mistake a longer field name for data', () => {
    expect(parse([encode('database: no\n\n')])).toEqual([]);
  });

  it('joins several data lines and strips only one leading space', () => {
    expect(parse([encode('data:a\ndata:  b\ndata\n\n')])).toEqual(['a\n b\n']);
  });

  it('keeps [DONE] as a payload for the caller to read', () => {
    expect(parse([encode('data: [DONE]\n\n')])).toEqual(['[DONE]']);
  });

  it('delivers a last event that has no blank line when the stream ends', () => {
    expect(parse([encode('data: one\n\ndata: two')])).toEqual(['one', 'two']);
    expect(parse([encode('data: one\n\ndata: two\r')])).toEqual(['one', 'two']);
  });

  it('returns nothing for an empty stream', () => {
    expect(parse([])).toEqual([]);
  });
});
