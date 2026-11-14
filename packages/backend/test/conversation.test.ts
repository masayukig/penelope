import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Activity, StreamEvent } from "@penelope/contract";

import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { FakeClock } from "./support.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const feed = new Feed();
  const seen: StreamEvent[] = [];
  feed.subscribe(undefined, (_id, event) => seen.push(event));
  return { db, clock, feed, seen, conversation: new Conversation(db, feed, { now: clock.now }) };
}

const at = "2026-11-14T09:00:01Z";

describe("the conversation", () => {
  it("keeps a reply and sends it down the stream", (t) => {
    const { conversation, seen } = setup(t);
    const { id } = conversation.reply({ agent: "main", text: "done", expression: "smile", in_reply_to: 3 });
    const entry = { kind: "agent", id, at: "2026-11-14T09:00:00.000Z", text: "done", agent: "main", expression: "smile" };
    assert.deepEqual(seen, [{ event: "reply", data: entry }]);
    assert.deepEqual(conversation.page(), { entries: [entry] });
  });

  it("keeps the owner's messages beside the replies, newest first", (t) => {
    const { conversation, clock } = setup(t);
    conversation.ownerMessage({ id: "m-1", text: "hello" });
    clock.advance(1);
    const { id } = conversation.reply({ agent: "main", text: "hi" });
    assert.deepEqual(conversation.page(), {
      entries: [
        { kind: "agent", id, at: "2026-11-14T09:01:00.000Z", text: "hi", agent: "main" },
        { kind: "owner", id: "m-1", at: "2026-11-14T09:00:00.000Z", text: "hello" },
      ],
    });
  });

  it("gives the history in pages, each with the cursor of the next until the last", (t) => {
    const { conversation } = setup(t);
    for (let i = 1; i <= 5; i++) conversation.ownerMessage({ id: `m-${i}`, text: `${i}` });
    const first = conversation.page(undefined, 2);
    assert.deepEqual(first.entries.map((e) => e.id), ["m-5", "m-4"]);
    const second = conversation.page(first.before, 2);
    assert.deepEqual(second.entries.map((e) => e.id), ["m-3", "m-2"]);
    const last = conversation.page(second.before, 2);
    assert.deepEqual(last.entries.map((e) => e.id), ["m-1"]);
    assert.equal("before" in last, false);
  });

  it("refuses a cursor it did not give", (t) => {
    const { conversation } = setup(t);
    assert.throws(() => conversation.page("nonsense"), /cursor/);
  });

  it("keeps what the turns did and sends each block down the stream with the agent's state", (t) => {
    const { conversation, seen, db } = setup(t);
    const activities: Activity[] = [
      { kind: "turn_start", at, turn_id: "t-1" },
      { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
      { kind: "turn_end", at, turn_id: "t-1" },
    ];
    conversation.activities("main", activities);
    assert.deepEqual(seen, [
      { event: "state", data: { agent: "main", state: "thinking" } },
      { event: "activity", data: { agent: "main", activity: activities[0] } },
      { event: "activity", data: { agent: "main", activity: activities[1] } },
      { event: "activity", data: { agent: "main", activity: activities[2] } },
      { event: "state", data: { agent: "main", state: "waiting" } },
    ]);
    const kept = db.prepare("SELECT agent, turn_id, kind, body FROM activities ORDER BY row").all() as Array<Record<string, string>>;
    assert.deepEqual(kept.map((row) => [row.agent, row.turn_id, row.kind, JSON.parse(row.body!)]), [
      ["main", "t-1", "turn_start", activities[0]],
      ["main", "t-1", "tool_call", activities[1]],
      ["main", "t-1", "turn_end", activities[2]],
    ]);
  });

  it("keeps when a session was switched", (t) => {
    const { conversation, db } = setup(t);
    conversation.sessionRotated("main");
    assert.deepEqual(
      { ...(db.prepare("SELECT agent, at FROM session_rotations").get() as object) },
      { agent: "main", at: "2026-11-14T09:00:00.000Z" },
    );
  });
});

describe("the feed", () => {
  it("numbers what it sends and sends again what came after the last one a stream saw", () => {
    const feed = new Feed(3);
    for (let i = 1; i <= 4; i++) feed.publish({ event: "state", data: { agent: `a${i}`, state: "waiting" } });
    const seen: Array<[number, string]> = [];
    const stop = feed.subscribe("2", (id, event) => seen.push([id, event.event === "state" ? String(event.data.agent) : ""]));
    feed.publish({ event: "state", data: { agent: "a5", state: "waiting" } });
    stop();
    feed.publish({ event: "state", data: { agent: "a6", state: "waiting" } });
    assert.deepEqual(seen, [
      [3, "a3"],
      [4, "a4"],
      [5, "a5"],
    ]);
  });

  it("sends nothing old to a stream that saw nothing", () => {
    const feed = new Feed();
    feed.publish({ event: "state", data: { agent: "main", state: "waiting" } });
    const seen: number[] = [];
    feed.subscribe(undefined, (id) => seen.push(id));
    assert.deepEqual(seen, []);
  });
});
