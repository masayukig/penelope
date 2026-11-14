import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { CALL_MAX_CHARS, FOLD_ASK, foldTurns, TURN_END } from "../src/fold.ts";

type AgentMessage = ContextEvent["messages"][number];

let clock = 1;

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });

const marker = (): AgentMessage => ({ role: "custom", customType: TURN_END, content: "", display: false, timestamp: clock++ });

const ask = (): AgentMessage => ({
  role: "custom",
  customType: FOLD_ASK,
  content: "This turn is about to be folded.",
  display: false,
  timestamp: clock++,
});

type Block =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

const assistant = (...content: Block[]): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "example",
    model: "example",
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: clock++,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as AgentMessage;

const result = (id: string, name: string, text: string, isError = false): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: clock++,
});

const call = (id: string, name: string, args: Record<string, unknown>): Block => ({ type: "toolCall", id, name, arguments: args });

/** A turn with thinking, the shell, a read, a reply and her text. */
function workingTurn(): AgentMessage[] {
  return [
    user("[seq 1] ui, 2026-11-14T09:00:00Z\nPods は元気？"),
    assistant(
      { type: "thinking", thinking: "look at the pods", thinkingSignature: "rs_1" },
      call("call_1|fc_1", "bash", { command: "kubectl get pods -n monitoring" }),
      call("call_2|fc_2", "read", { path: "/memory/cluster.md" }),
    ),
    result("call_1|fc_1", "bash", "NAME READY\nprometheus-0 1/1\n".repeat(50)),
    result("call_2|fc_2", "read", "# cluster\n"),
    assistant(
      { type: "thinking", thinking: "all fine", thinkingSignature: "rs_2" },
      { type: "text", text: "All pods are up.", textSignature: "msg_1" },
      call("call_3|fc_3", "reply", { text: "元気です", in_reply_to: 1 }),
    ),
    result("call_3|fc_3", "reply", "Sent (id r-1)."),
    assistant({ type: "text", text: "Replied." }),
  ];
}

const roles = (messages: AgentMessage[]) => messages.map((message) => message.role);

test("nothing is folded until a turn has ended; the markers never reach the model", () => {
  const turn = workingTurn();
  const { messages, folded } = foldTurns(turn);
  assert.equal(folded, 0);
  assert.deepEqual(messages, turn);

  const ended = [...turn, marker()];
  const after = foldTurns(ended);
  assert.equal(after.folded, 1);
  assert.ok(after.messages.every((message) => message.role !== "custom"));
});

test("an ended turn keeps the events, her text and her replies; thinking and tool output go", () => {
  const turn = workingTurn();
  const next = user("[seq 2] ui, 2026-11-14T10:00:00Z\nありがとう");
  const { messages, folded } = foldTurns([...turn, marker(), next]);
  assert.equal(folded, 1);
  assert.deepEqual(roles(messages), ["user", "assistant", "assistant", "toolResult", "assistant", "user"]);

  assert.deepEqual(messages[0], turn[0], "the event stays as it is");
  const calls = foldedText(messages[1]);
  assert.ok(!calls.includes("\n"), "the calls are one line");
  for (const part of ["bash", "kubectl get pods -n monitoring", "read", "/memory/cluster.md"]) assert.ok(calls.includes(part), part);
  assert.deepEqual((messages[2] as { content: unknown }).content, [
    { type: "text", text: "All pods are up." },
    { type: "toolCall", id: "call_3", name: "reply", arguments: { text: "元気です", in_reply_to: 1 } },
  ]);
  const reply = messages[3] as { toolCallId: string; content: unknown };
  // `call_3|fc_3` is how Pi's openai-responses API pairs a call with its reasoning; a provider refuses half a pair.
  assert.equal(reply.toolCallId, "call_3", "the half of the ID paired with the thinking is gone");
  assert.deepEqual(reply.content, [{ type: "text", text: "Sent (id r-1)." }]);
  assert.deepEqual((messages[4] as { content: unknown }).content, [{ type: "text", text: "Replied." }]);
  assert.deepEqual(messages[5], next, "the turn now running is not folded");

  const text = JSON.stringify(messages);
  assert.ok(!text.includes("prometheus-0"), "no tool output is left");
  assert.ok(!text.includes("look at the pods"), "no thinking is left");
});

test("the limit of a call is the ADR's", () => {
  // Guards against: the 200 characters of ADR-0015 changed in the code alone.
  assert.equal(CALL_MAX_CHARS, 200);
});

/** The one text block a folded assistant message is left with. */
const foldedText = (message: AgentMessage | undefined): string => {
  const content = (message as { content: { type: string; text?: string }[] }).content;
  assert.equal(content.length, 1);
  assert.equal(content[0]!.type, "text");
  return content[0]!.text!;
};

test("a tool call is cut to its limit", () => {
  const long = "x".repeat(500);
  const { messages } = foldTurns([user("go"), assistant(call("c1", "bash", { command: long })), result("c1", "bash", "ok"), marker()]);
  // How the line marks itself as folded is the code's; the call in it is cut at the limit.
  const line = foldedText(messages[1]);
  assert.ok(line.includes("bash"));
  assert.ok(line.includes("x".repeat(100)));
  assert.ok(!line.includes(long), "the command is cut");
  assert.ok([...line].length <= CALL_MAX_CHARS + 20, "to about the limit");
});

test("a call without a command or a path is shown by its arguments, on one line", () => {
  const { messages } = foldTurns([
    user("go"),
    assistant(
      call("c1", "schedule_add", { reason: "check\nCI", at: "2026-11-15T09:00:00Z" }),
      call("c2", "grep", { pattern: "error", path: "/var/log" }),
    ),
    result("c1", "schedule_add", "{}"),
    result("c2", "grep", "lots"),
    marker(),
  ]);
  // Guards against: a call that leaves nothing of what was tried, or that breaks the line.
  const line = foldedText(messages[1]);
  assert.ok(!line.includes("\n"), "one line");
  for (const part of ["schedule_add", "check", "CI", "2026-11-15T09:00:00Z", "grep", "error", "/var/log"]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes("lots"), "no output");
});

test("the request before folding goes; her answer to it stays", () => {
  const { messages } = foldTurns([
    user("go"),
    assistant(call("c1", "bash", { command: "ls" })),
    result("c1", "bash", "a\nb"),
    assistant(),
    ask(),
    assistant({ type: "text", text: "ls shows a and b." }),
    marker(),
  ]);
  assert.deepEqual(roles(messages), ["user", "assistant", "assistant"]);
  assert.deepEqual((messages[2] as { content: unknown }).content, [{ type: "text", text: "ls shows a and b." }]);
});

test("a compaction summary passes as it is", () => {
  const summary: AgentMessage = { role: "compactionSummary", summary: "Earlier: pods checked.", tokensBefore: 1000, timestamp: clock++ };
  const { messages } = foldTurns([summary, assistant(call("c1", "bash", { command: "ls" })), result("c1", "bash", "a"), marker(), user("next")]);
  assert.deepEqual(messages[0], summary);
  assert.deepEqual(roles(messages), ["compactionSummary", "assistant", "user"]);
});

test("an ended turn keeps her answers to other agents whole, as it keeps her replies", () => {
  // Guards against: what she told an agent over A2A folded away, so that she forgets she answered it.
  const answer = call("call_9", "reply_to_agent", { in_reply_to: 7, state: "completed", text: "Two alerts, both resolved." });
  const { messages } = foldTurns([user("go"), assistant(answer), result("call_9", "reply_to_agent", "Sent: the task is completed."), marker()]);
  assert.deepEqual((messages[1] as { content: unknown }).content, [answer]);
  assert.deepEqual((messages[2] as { content: unknown }).content, [{ type: "text", text: "Sent: the task is completed." }]);
});

test("a reply that has no result is folded like any other call", () => {
  const { messages } = foldTurns([user("go"), assistant(call("c1", "reply", { text: "hi" })), marker()]);
  // Guards against: a tool call left without its result, which a provider refuses.
  const line = foldedText(messages[1]);
  assert.ok(line.includes("reply") && line.includes("hi"));
});

test("folding the next turn leaves what was folded before as it was", () => {
  const first = [...workingTurn(), marker()];
  const second = [user("[seq 2] ui\nもう一度"), assistant(call("c9", "bash", { command: "date" })), result("c9", "bash", "today"), assistant({ type: "text", text: "Done." })];
  const once = foldTurns([...first, ...second]).messages;
  const twice = foldTurns([...first, ...second, marker(), user("[seq 3] ui\nnext")]).messages;
  assert.deepEqual(twice.slice(0, once.length - second.length), once.slice(0, once.length - second.length));
  assert.deepEqual(twice.slice(0, once.length - second.length + 1).at(-1), second[0]);
});

test("the same messages fold the same way", () => {
  const messages = [...workingTurn(), marker(), user("next")];
  assert.deepEqual(foldTurns(messages), foldTurns(messages));
});
