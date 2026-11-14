import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeliveredEvent } from "@penelope/contract";

import { formatEvents } from "../src/turn-input.ts";

const ui: DeliveredEvent = {
  seq: 13,
  source: "ui",
  id: "m-1",
  occurred_at: "2026-11-14T09:01:00Z",
  received_at: "2026-11-14T09:01:00Z",
  summary: "hello",
  delivery: "now",
  inline: true,
  payload: { text: "hello\nthere" },
  appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] },
};

const mention: DeliveredEvent = {
  seq: 12,
  source: "slack",
  id: "C0123:1",
  stream: "ops",
  occurred_at: "2026-11-14T09:00:00Z",
  received_at: "2026-11-14T09:00:01Z",
  summary: "#ops: a mention",
  delivery: "now",
  inline: false,
  appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
};

function batch(seq: number, stream: string, path: string, line: number): DeliveredEvent {
  return {
    seq,
    source: "slack",
    id: `b-${seq}`,
    stream,
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: `message ${seq}`,
    delivery: "batch",
    inline: false,
    appended: { path, lines: [line, line] },
  };
}

test("an inline event carries its text", () => {
  assert.equal(
    formatEvents([ui]),
    "[seq 13] ui, 2026-11-14T09:01:00Z\nhello\nthere",
  );
});

test("an inline event's attachments are listed", () => {
  const withFile = {
    ...ui,
    attachments: [
      { path: "/sources/ui/files/13-a.png", mime_type: "image/png", size: 10 },
      { path: "/sources/ui/files/13-b.pdf", mime_type: "application/pdf", size: 20 },
    ],
  };
  assert.equal(
    formatEvents([withFile]),
    "[seq 13] ui, 2026-11-14T09:01:00Z\nhello\nthere\nAttachments: /sources/ui/files/13-a.png, /sources/ui/files/13-b.pdf",
  );
});

test("an inline payload without text is given as JSON", () => {
  const other = { ...ui, payload: { kind: "x", n: 1 } };
  assert.equal(formatEvents([other]), '[seq 13] ui, 2026-11-14T09:01:00Z\n{"kind":"x","n":1}');
});

test("an event that is not inline carries its summary and where it was appended", () => {
  assert.equal(
    formatEvents([mention]),
    "[seq 12] slack/ops, 2026-11-14T09:00:00Z: #ops: a mention\n/sources/slack/ops/2026-11-14.jsonl lines 3-3",
  );
});

test("batched events are counted per source and stream, with their places", () => {
  const ops = "/sources/slack/ops/2026-11-14.jsonl";
  const dev = "/sources/slack/dev/2026-11-14.jsonl";
  const text = formatEvents([
    batch(20, "ops", ops, 4),
    batch(21, "dev", dev, 1),
    batch(22, "ops", ops, 5),
    batch(23, "ops", ops, 7),
  ]);
  assert.equal(
    text,
    [
      `[batch] slack/ops: 3 events (seq 20, 22, 23)\n${ops} lines 4-5, 7-7`,
      `[batch] slack/dev: 1 event (seq 21)\n${dev} lines 1-1`,
    ].join("\n\n"),
  );
});

test("the events of one turn are in order, the batch last", () => {
  const ops = "/sources/slack/ops/2026-11-14.jsonl";
  const text = formatEvents([batch(11, "ops", ops, 1), mention, ui]);
  const parts = text.split("\n\n");
  assert.equal(parts.length, 3);
  assert.match(parts[0]!, /^\[seq 12\]/);
  assert.match(parts[1]!, /^\[seq 13\]/);
  assert.match(parts[2]!, /^\[batch\]/);
});

test("an event without a stream names only its source", () => {
  const { stream: _, ...alert } = { ...mention, source: "alertmanager" };
  assert.match(formatEvents([alert]), /^\[seq 12\] alertmanager, /);
});
