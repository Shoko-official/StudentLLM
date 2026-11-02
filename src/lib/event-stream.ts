/** Turns the bytes of a server-sent event stream into event payloads. A chunk may end anywhere, even inside a character or a CRLF. */
export function createEventStreamParser() {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const read = (lines: string[]) => {
    const events: string[] = [];
    for (const line of lines) {
      if (!line) {
        if (data.length) events.push(data.join('\n'));
        data = [];
        continue;
      }
      const field = /^data(?:: ?(.*))?$/s.exec(line);
      if (field) data.push(field[1] ?? '');
    }
    return events;
  };
  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      // A final CR may be the first half of a CRLF, so it waits for the next chunk.
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop() ?? '';
      return read(lines);
    },
    /** A stream may stop without the blank line that closes its last event. */
    end() {
      const rest = (buffer + decoder.decode()).replace(/\r$/, '');
      buffer = '';
      return read([...rest.split(/\r\n|\n|\r/), '']);
    },
  };
}
