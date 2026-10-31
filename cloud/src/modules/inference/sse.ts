// Incremental Server-Sent Events parser for an upstream stream. It never logs and never keeps more than
// `maxEventBytes` of an unfinished event, so a hostile or broken upstream cannot grow the isolate's memory.

export interface SseEvent {
  /** The `event:` name, or null for an unnamed event. */
  event: string | null;
  /** The `data:` lines joined with a newline. */
  data: string;
}

export class SseFormatError extends Error {
  constructor() {
    super("malformed event stream");
    this.name = "SseFormatError";
  }
}

export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  /** A `\r` at the end of a chunk may be half of a `\r\n`: its `\n` arrives in the next chunk. */
  private pendingCr = false;

  constructor(private readonly maxEventBytes: number) {}

  /** Feeds bytes and returns the events completed by them. Throws `SseFormatError` when an event grows too large. */
  push(chunk: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = text.endsWith("\r");
    this.buffer += text.replace(/\r\n|\r/g, "\n");
    return this.drain(false);
  }

  /** At the end of the stream: a final event that lacks its terminating blank line is still delivered. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const sep = this.buffer.indexOf("\n\n");
      if (sep === -1) break;
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const event = parseBlock(block);
      if (event) events.push(event);
    }
    if (final && this.buffer.trim() !== "") {
      const event = parseBlock(this.buffer);
      this.buffer = "";
      if (event) events.push(event);
    }
    if (this.buffer.length > this.maxEventBytes) throw new SseFormatError();
    return events;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  let hasData = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank line or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      data.push(value);
      hasData = true;
    }
    // `id` and `retry` carry nothing the gateway uses.
  }
  return hasData ? { event, data: data.join("\n") } : null;
}
