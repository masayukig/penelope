// The framing of server-sent events, read from a fetch body rather than by
// EventSource, so that every connection can ask for what the backend kept
// (docs/ui-api.md).

export type SseEvent = { id: string | undefined; event: string; data: string };

export class SseParser {
  private buffer = "";
  private id: string | undefined;
  private event = "";
  private data: string[] = [];
  private readonly onEvent: (event: SseEvent) => void;

  constructor(onEvent: (event: SseEvent) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.search(/\r\n|\n|\r/);
      if (end < 0) return;
      // A lone \r at the end may be the first half of \r\n: wait for more.
      if (this.buffer[end] === "\r" && end === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(this.buffer.startsWith("\r\n", end) ? end + 2 : end + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0 || this.event !== "") {
        this.onEvent({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
      }
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
  }
}
