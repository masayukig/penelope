import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Activity } from "@penelope/contract";

import { OUTPUT_LIMIT, TurnRecorder, toolOutput } from "../src/activities.ts";

const at = "2026-11-14T09:00:00.000Z";

function recorder() {
  const sent: Activity[] = [];
  const turn = new TurnRecorder("t-1", () => at, (activity) => sent.push(activity));
  return { sent, turn };
}

// Only the fields the recorder reads; the rest of Pi's events are not needed.
function update(assistantMessageEvent: unknown): AgentSessionEvent {
  return { type: "message_update", message: {}, assistantMessageEvent } as unknown as AgentSessionEvent;
}

test("a turn starts and ends", () => {
  const { sent, turn } = recorder();
  turn.start();
  turn.end();
  assert.deepEqual(sent, [
    { kind: "turn_start", at, turn_id: "t-1" },
    { kind: "turn_end", at, turn_id: "t-1" },
  ]);
});

test("each closed block becomes one activity", () => {
  const { sent, turn } = recorder();
  turn.handle(update({ type: "thinking_delta", delta: "hm" }));
  turn.handle(update({ type: "thinking_end", content: "hmm" }));
  turn.handle(update({ type: "text_delta", delta: "do" }));
  turn.handle(update({ type: "text_end", content: "done" }));
  turn.handle(
    update({ type: "toolcall_end", toolCall: { type: "toolCall", id: "c-1", name: "bash", arguments: { command: "ls" } } }),
  );
  turn.handle({
    type: "tool_execution_end",
    toolCallId: "c-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a\nb\n" }], details: undefined },
    isError: false,
  } as AgentSessionEvent);
  assert.deepEqual(sent, [
    { kind: "thinking", at, turn_id: "t-1", text: "hmm" },
    { kind: "message", at, turn_id: "t-1", text: "done" },
    { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
    { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\nb\n" },
  ]);
});

test("empty thinking and empty text are not sent", () => {
  const { sent, turn } = recorder();
  turn.handle(update({ type: "thinking_end", content: "" }));
  turn.handle(update({ type: "text_end", content: "  " }));
  assert.deepEqual(sent, []);
});

test("a tool's output is its text, with images named and long output cut", () => {
  assert.equal(
    toolOutput({ content: [{ type: "text", text: "a" }, { type: "image", data: "...", mimeType: "image/png" }, { type: "text", text: "b" }] }),
    "a\n[image/png]\nb",
  );
  const long = toolOutput({ content: [{ type: "text", text: "x".repeat(OUTPUT_LIMIT + 10) }] });
  assert.ok(long.startsWith("x".repeat(OUTPUT_LIMIT)));
  assert.match(long, /\[10 more characters\]$/);
  assert.equal(toolOutput(undefined), "");
  assert.equal(toolOutput("plain"), "plain");
});
