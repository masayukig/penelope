import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { Activity } from "@penelope/contract";

import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { Heartbeat } from "../src/heartbeat.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours, iso } from "../src/time.ts";
import { FakeClock, tempDir } from "./support.ts";

const QUIET_MINUTES = 60;

function setup(
  t: { after: (fn: () => void) => void },
  { start = "2026-11-16T09:00:00Z", awake = "07:00-23:00", quietMs = QUIET_MINUTES * 60_000 } = {},
) {
  const dir = tempDir(t);
  const clock = new FakeClock(start);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const awakeHours = new AwakeHours(awake, "UTC");
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
    batch: { quietMs: 5 * 60_000, maxMs: 30 * 60_000 },
    awake: awakeHours,
    redeliverMs: 5 * 60_000,
  });
  const conversation = new Conversation(db, new Feed(), { now: clock.now });
  const heartbeat = new Heartbeat(queue, conversation, { now: clock.now, quietMs, awake: awakeHours, log: () => {} });
  let turns = 0;
  /** The runner's blocks of one turn: its start, or its end. */
  const turn = (kind: "turn_start" | "turn_end") => {
    if (kind === "turn_start") turns++;
    const activity: Activity = { kind, at: iso(clock.ms), turn_id: `turn-${turns}` };
    conversation.activities("main", [activity]);
  };
  /** Takes what is due and acks it, as the runner does at a turn's end. */
  const takeAll = () => {
    const events = queue.take({ after: 0 });
    queue.ack(events.map((event) => event.seq));
    return events;
  };
  return { clock, queue, conversation, heartbeat, turn, takeAll };
}

describe("the heartbeat", () => {
  it("is queued once the awake hours have gone the set minutes since the last turn ended", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);

    clock.advance(1);
    heartbeat.tick();
    const [event, ...more] = queue.take({ after: 0 });
    assert.deepEqual(more, []);
    assert.equal(event?.source, "heartbeat");
    assert.equal(event?.delivery, "now");
    assert.equal(event?.id, "heartbeat@2026-11-16T10:00:00.000Z");
    assert.equal(Date.parse(event!.occurred_at), clock.ms);
    assert.equal(event?.summary, "no turn for 60 minutes");
    assert.equal(event?.inline, false);
  });

  it("writes since when it counted and how long it waited as the payload", (t) => {
    const { clock, heartbeat, turn, queue } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    heartbeat.tick();
    const { appended } = queue.take({ after: 0 })[0]!;
    // The payload is not handed over (heartbeat is not inline); it is in /sources.
    const line = JSON.parse(readFileSync(appended.path, "utf8").split("\n")[appended.lines[0] - 1]!);
    assert.deepEqual(line.payload, { since: "2026-11-16T09:00:00.000Z", quiet_minutes: QUIET_MINUTES });
  });

  it("says its seconds when they are not whole minutes (the tests'), and ticks every second for them", (t) => {
    // Guards against: a heartbeat of the tests' seconds named as 0 minutes, or left for the 15 s tick.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { clock, queue, heartbeat, turn } = setup(t, { quietMs: 5_000 });
    turn("turn_start");
    turn("turn_end");
    const stop = heartbeat.start();
    t.after(stop);
    clock.ms += 5_000;
    t.mock.timers.tick(1_000);
    const { summary, appended } = queue.take({ after: 0 })[0]!;
    assert.equal(summary, "no turn for 5 seconds");
    const line = JSON.parse(readFileSync(appended.path, "utf8").split("\n")[appended.lines[0] - 1]!);
    assert.deepEqual(line.payload, { since: "2026-11-16T09:00:00.000Z", quiet_minutes: 5 / 60 });
  });

  it("is not queued while a turn runs", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    clock.advance(QUIET_MINUTES * 3);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
  });

  it("is queued once, and counts again from the end of the turn it made", (t) => {
    const { clock, heartbeat, turn, takeAll } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    heartbeat.tick();
    clock.advance(1);
    heartbeat.tick();
    // The runner has not taken it yet: still one.
    assert.equal(takeAll().length, 1);

    turn("turn_start");
    clock.advance(1);
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(takeAll(), []);
    clock.advance(1);
    heartbeat.tick();
    assert.deepEqual(takeAll().map((event) => event.source), ["heartbeat"]);
  });

  it("is not queued while an event waits to be handed over or acked", (t) => {
    // Guards against: a heartbeat beside the owner's message about to start a turn, or during the nightly switch,
    // whose control event is acked only once the new session has started.
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    queue.accept({ source: "control", id: "nightly@x", occurred_at: iso(clock.ms), summary: "the nightly switch", payload: { kind: "nightly" } }, { builtin: true });
    heartbeat.tick();
    const handed = queue.take({ after: 0 });
    assert.deepEqual(handed.map((event) => event.source), ["control"]);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: handed[0]!.seq }), []);

    queue.ack([handed[0]!.seq]);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: handed[0]!.seq }).map((event) => event.source), ["heartbeat"]);
  });

  it("takes the held batch with it", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 2);
    queue.accept({ source: "slack", id: "1", occurred_at: iso(clock.ms), summary: "a message", payload: {} });
    clock.advance(2);
    heartbeat.tick();
    assert.deepEqual(
      queue.take({ after: 0 }).map((event) => [event.source, event.delivery]),
      [
        ["slack", "batch"],
        ["heartbeat", "now"],
      ],
    );
  });

  it("is not queued outside the awake hours, and is when they start", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t, { start: "2026-11-16T22:30:00Z" });
    turn("turn_start");
    turn("turn_end");
    clock.set("2026-11-16T23:30:00Z");
    heartbeat.tick();
    clock.set("2026-11-17T06:59:00Z");
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
    clock.set("2026-11-17T07:00:00Z");
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.id), ["heartbeat@2026-11-17T07:00:00.000Z"]);
  });

  it("counts from when the backend started when there has been no turn", (t) => {
    const { clock, queue, heartbeat } = setup(t);
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
    clock.advance(1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.source), ["heartbeat"]);
  });

  it("is left for the next tick when it cannot be queued", (t) => {
    const { clock, queue, heartbeat } = setup(t);
    clock.advance(QUIET_MINUTES);
    const accept = queue.accept.bind(queue);
    let refuse = true;
    queue.accept = (...args) => {
      if (refuse) throw new Error("/sources is not writable");
      return accept(...args);
    };
    heartbeat.tick();
    refuse = false;
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.source), ["heartbeat"]);
  });
});
