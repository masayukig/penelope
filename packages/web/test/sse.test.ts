import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SseParser } from "../src/model/sse.ts";

// The stream is read with fetch, so its framing is ours to get right
// (docs/ui-api.md: `id`, `event`, JSON `data`, comments to keep it open).
describe("reading server-sent events", () => {
  it("gives each event with its id and name once its blank line has come, however the chunks fall", () => {
    const seen: Array<[string | undefined, string, string]> = [];
    const parser = new SseParser((event) => seen.push([event.id, event.event, event.data]));
    const text = ': stream\n\nid: 1\nevent: reply\ndata: {"text":"hi"}\n\nid: 2\r\nevent: state\r\ndata: {}\r\n\r\n';
    for (const chunk of [text.slice(0, 7), text.slice(7, 30), text.slice(30, 31), text.slice(31)]) parser.push(chunk);
    assert.deepEqual(seen, [
      ["1", "reply", '{"text":"hi"}'],
      ["2", "state", "{}"],
    ]);
  });

  it("keeps the comments that hold the line open out of the events", () => {
    const seen: string[] = [];
    const parser = new SseParser((event) => seen.push(event.event));
    parser.push(": ping\n\n: ping\n\n");
    assert.deepEqual(seen, []);
  });

  it("joins the lines of one data field", () => {
    const seen: string[] = [];
    const parser = new SseParser((event) => seen.push(event.data));
    parser.push("event: reply\ndata: a\ndata: b\n\n");
    assert.deepEqual(seen, ["a\nb"]);
  });
});
