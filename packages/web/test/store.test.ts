import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Activity, HistoryEntry, StreamEvent } from "@penelope/contract";

import { type Action, currentFlow, faceOf, FACE_RESET_MS, initialState, reduce, type State, statusOf } from "../src/model/store.ts";

const T = "turn-1";
const run = (actions: Action[], state: State = initialState) => actions.reduce(reduce, state);
const reply = (id: string, at: string, extra: Partial<Extract<HistoryEntry, { kind: "agent" }>> = {}): StreamEvent => ({
  event: "reply",
  data: { kind: "agent", id, at, text: `reply ${id}`, agent: "main", ...extra },
});
const activity = (a: Activity): StreamEvent => ({ event: "activity", data: { agent: "main", activity: a } });
const state = (s: "thinking" | "waiting"): StreamEvent => ({ event: "state", data: { agent: "main", state: s } });
const stream = (event: StreamEvent): Action => ({ type: "stream", event });
const ids = (s: State) => s.items.map((item) => item.id);

describe("the conversation's timeline", () => {
  // The history comes newest first; the screen reads oldest first.
  it("puts the history and the replies that arrive in time order, oldest first", () => {
    const s = run([
      {
        type: "history",
        entries: [
          { kind: "agent", id: "r-1", at: "2026-11-14T09:01:00Z", text: "hi", agent: "main" },
          { kind: "owner", id: "m-1", at: "2026-11-14T09:00:00Z", text: "hello" },
        ],
      },
      stream(reply("r-2", "2026-11-14T09:05:00Z")),
    ]);
    assert.deepEqual(ids(s), ["m-1", "r-1", "r-2"]);
  });

  it("keeps lines of the same time in the order the history gave them", () => {
    const at = "2026-11-14T09:00:00Z";
    const s = run([
      {
        type: "history",
        entries: [
          { kind: "agent", id: "r-2", at, text: "second", agent: "main" },
          { kind: "agent", id: "r-1", at, text: "first", agent: "main" },
        ],
      },
    ]);
    assert.deepEqual(ids(s), ["r-1", "r-2"]);
  });

  // Every connection replays what the backend kept (Last-Event-ID: 0), and
  // the history is read again after it: a reply must still show once.
  it("shows a reply once, whether it came by the history, the stream, or both again", () => {
    const entry = reply("r-1", "2026-11-14T09:01:00Z");
    const s = run([
      stream(entry),
      { type: "stream-open" },
      stream(entry),
      { type: "history", entries: [entry.data as HistoryEntry] },
    ]);
    assert.deepEqual(ids(s), ["r-1"]);
  });

  it("adds an older page before what is shown and keeps the cursor for the next", () => {
    const s = run([
      { type: "history", entries: [{ kind: "owner", id: "m-2", at: "2026-11-14T09:00:00Z", text: "b" }], before: "c-1" },
      { type: "history", entries: [{ kind: "owner", id: "m-1", at: "2026-11-13T09:00:00Z", text: "a" }], older: true },
    ]);
    assert.deepEqual(ids(s), ["m-1", "m-2"]);
    assert.equal(s.before, undefined);
  });

  // The avatar shows the face of her latest reply for a while, then goes
  // back to neutral, as natsumi's does (ADR-0016).
  it("shows the face of her latest reply, and neutral again once it has been shown a while", () => {
    const s = run([
      stream(reply("r-1", "2026-11-14T09:00:00Z", { expression: "worried" })),
      stream(reply("r-2", "2026-11-14T09:01:00Z", { expression: "happy" })),
      stream(reply("r-3", "2026-11-14T09:01:30Z")),
    ]);
    const since = Date.parse("2026-11-14T09:01:00Z");
    assert.equal(faceOf(s, since + 1_000), "happy");
    assert.equal(faceOf(s, since + FACE_RESET_MS + 1_000), undefined);
    assert.equal(faceOf(initialState, since), undefined);
  });
});

describe("what the agent is doing", () => {
  it("is thinking from a turn's start and waiting again at its end", () => {
    let s = run([stream(state("thinking")), stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T }))]);
    assert.equal(statusOf(s).kind, "thinking");
    s = run([stream(activity({ kind: "turn_end", at: "2026-11-14T09:02:00Z", turn_id: T })), stream(state("waiting"))], s);
    assert.equal(statusOf(s).kind, "waiting");
    assert.deepEqual(currentFlow(s), []);
  });

  // The phone's strip shows the tool in use, from its call until its result.
  it("is using a tool from its call until its result, and names it", () => {
    let s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      stream(activity({ kind: "tool_call", at: "2026-11-14T09:00:01Z", turn_id: T, call_id: "c-1", name: "bash", arguments: { command: "kubectl get pods" } })),
    ]);
    const status = statusOf(s);
    assert.equal(status.kind, "tool");
    assert.equal(status.kind === "tool" && status.tool.name, "bash");
    assert.match(status.kind === "tool" ? status.tool.detail : "", /kubectl get pods/);
    s = run([stream(activity({ kind: "tool_result", at: "2026-11-14T09:00:02Z", turn_id: T, call_id: "c-1", is_error: false, output: "ok" }))], s);
    assert.equal(statusOf(s).kind, "thinking");
  });

  it("flows the blocks of the turn under way, in the order they closed", () => {
    const s = run([
      stream(activity({ kind: "turn_start", at: "2026-11-14T08:00:00Z", turn_id: "old" })),
      stream(activity({ kind: "thinking", at: "2026-11-14T08:00:01Z", turn_id: "old", text: "an old thought" })),
      stream(activity({ kind: "turn_end", at: "2026-11-14T08:00:02Z", turn_id: "old" })),
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      stream(activity({ kind: "thinking", at: "2026-11-14T09:00:01Z", turn_id: T, text: "a thought" })),
      stream(activity({ kind: "tool_call", at: "2026-11-14T09:00:02Z", turn_id: T, call_id: "c-1", name: "read", arguments: { path: "/memory/INDEX.md" } })),
    ]);
    assert.deepEqual(
      currentFlow(s).map((item) => item.kind),
      ["turn_start", "thinking", "tool_call"],
    );
  });

  // Each connection replays what the backend kept, so what was known before
  // it is thrown away rather than doubled.
  it("starts again from the replay when the stream opens again", () => {
    const before = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
    ]);
    const s = run([{ type: "stream-open" }, stream(state("thinking")), stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T }))], before);
    assert.equal(currentFlow(s).length, 1);
    assert.equal(statusOf(run([{ type: "stream-open" }], before)).kind, "waiting");
  });

  it("is out of reach while the stream is down", () => {
    const s = run([stream(state("thinking")), { type: "connection", state: "offline" }]);
    assert.equal(statusOf(s).kind, "offline");
  });
});

describe("a message from the owner", () => {
  it("shows at once, and keeps its place once the backend has taken it", () => {
    let s = run([{ type: "queued", key: "local-1", at: "2026-11-14T09:00:00Z", text: "hello", files: [], duringTurn: false }]);
    assert.deepEqual(s.items.map((item) => [item.kind, item.text]), [["owner", "hello"]]);
    s = run([{ type: "sending", key: "local-1" }, { type: "sent", key: "local-1", id: "m-1" }], s);
    assert.deepEqual(ids(s), ["m-1"]);
    // The history read again holds it under the same id: still once.
    s = run([{ type: "history", entries: [{ kind: "owner", id: "m-1", at: "2026-11-14T09:00:01Z", text: "hello" }] }], s);
    assert.deepEqual(ids(s), ["m-1"]);
  });

  // Sent while she is thinking, it steers the turn: it is marked so in the
  // timeline and shows in the turn's flow as an interruption.
  it("sent while she is thinking, is marked as arriving mid-turn and shows in the turn's flow", () => {
    const s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      { type: "queued", key: "local-1", at: "2026-11-14T09:00:05Z", text: "and make it a PR", files: [], duringTurn: true },
    ]);
    const [item] = s.items;
    assert.equal(item?.kind === "owner" && item.duringTurn, true);
    const flow = currentFlow(s);
    assert.deepEqual(flow.map((entry) => entry.kind), ["turn_start", "interrupt"]);
    assert.equal(flow[1]?.kind === "interrupt" && flow[1].text, "and make it a PR");
  });

  it("stays in the turn's flow when the stream opens again and replays the turn", () => {
    const s = run([
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
      { type: "queued", key: "local-1", at: "2026-11-14T09:00:05Z", text: "one more", files: [], duringTurn: true },
      { type: "stream-open" },
      stream(state("thinking")),
      stream(activity({ kind: "turn_start", at: "2026-11-14T09:00:00Z", turn_id: T })),
    ]);
    assert.deepEqual(currentFlow(s).map((entry) => entry.kind), ["turn_start", "interrupt"]);
  });
});
