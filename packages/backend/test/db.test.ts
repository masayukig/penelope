import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { Assets } from "../src/assets.ts";
import { Conversation } from "../src/conversation.ts";
import { MIGRATIONS, openDatabase, transaction } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { tempDir } from "./support.ts";

const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("the database", () => {
  it("is brought up to the latest schema when it is new", (t) => {
    const db = openDatabase(path.join(tempDir(t), "a.sqlite"));
    assert.equal(version(db), MIGRATIONS.length);
    db.close();
  });

  it("is brought up from the version before the sub-agents, keeping what it had", (t) => {
    const file = path.join(tempDir(t), "a.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 2)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 2");
    raw.prepare("INSERT INTO session_rotations (agent, at) VALUES ('main', 't')").run();
    raw.close();
    const db = openDatabase(file);
    assert.equal(version(db), MIGRATIONS.length);
    assert.deepEqual(db.prepare("SELECT agent FROM session_rotations").all().map((row) => ({ ...row })), [{ agent: "main" }]);
    assert.deepEqual(db.prepare("SELECT * FROM sub_agents").all(), []);
    assert.deepEqual(db.prepare("SELECT * FROM push_subscriptions").all(), []);
    db.close();
  });

  it("is brought up from the version before the owner's images, keeping the images of the replies", (t) => {
    // Guards against: the images of the replies lost from the history when the table of the copies is made again.
    const file = path.join(tempDir(t), "a.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 5)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 5");
    raw.exec("INSERT INTO history (id, kind, agent, at, text) VALUES ('r-1', 'agent', 'main', 't', 'x')");
    raw.exec("INSERT INTO assets (id, kind, mime_type, size, name, file, agent, created_at, reply_id, position) VALUES ('a-1', 'image', 'image/png', 4, 'a.png', 'a-1.png', 'main', 't', 'r-1', 0)");
    raw.close();
    const db = openDatabase(file);
    assert.deepEqual(new Conversation(db, new Feed(), { now: Date.now, assets: new Assets(db, tempDir(t), { now: Date.now }) }).page().entries[0], {
      kind: "agent",
      id: "r-1",
      at: "t",
      text: "x",
      agent: "main",
      images: [{ id: "a-1", mime_type: "image/png", size: 4, name: "a.png" }],
    });
    db.close();
  });

  it("makes the record's turns, jobs and ties of the replies from what it had before the record", (t) => {
    // Guards against: the turns and jobs from before the activity record missing from its list.
    const file = path.join(tempDir(t), "a.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 6)) raw.exec(migration);
    raw.exec("PRAGMA user_version = 6");
    const block = (kind: string, at: string) => raw.prepare("INSERT INTO activities (agent, turn_id, kind, at, body) VALUES ('main', 't-1', ?, ?, '{}')").run(kind, at);
    block("turn_start", "2026-11-14T10:00:00.000Z");
    block("tool_call", "2026-11-14T10:00:01.000Z");
    block("turn_end", "2026-11-14T10:00:09.000Z");
    raw.exec("INSERT INTO history (id, kind, agent, at, text) VALUES ('r-1', 'agent', 'main', '2026-11-14T10:00:05.000Z', 'done')");
    const job = { job: "j", command: "make", cwd: "/", end: "exited", exit_code: 1, started_at: "2026-11-14T09:00:00.000Z", ended_at: "2026-11-14T09:01:00.000Z", seconds: 60 };
    raw
      .prepare("INSERT INTO events (source, id, occurred_at, received_ms, summary, delivery, inline, payload, path, line) VALUES ('job', 'j', 't', 0, 's', 'now', 1, ?, 'p', 1)")
      .run(JSON.stringify(job));
    raw.close();
    const db = openDatabase(file);
    assert.deepEqual({ ...(db.prepare("SELECT agent, started_at, ended_at, result, tools FROM turns").get() as object) }, {
      agent: "main",
      started_at: "2026-11-14T10:00:00.000Z",
      ended_at: "2026-11-14T10:00:09.000Z",
      result: null,
      tools: 1,
    });
    assert.equal((db.prepare("SELECT turn_id FROM history").get() as { turn_id: string }).turn_id, "t-1");
    assert.deepEqual({ ...(db.prepare("SELECT id, failed FROM record_jobs").get() as object) }, { id: "j", failed: 1 });
    db.close();
  });

  describe("filling the triggers of the turns from before the record", () => {
    // A file at version 7 whose main turns came from the activities: no result, no triggers.
    const atVersion7 = (file: string) => {
      const raw = new DatabaseSync(file);
      for (const migration of MIGRATIONS.slice(0, 7)) raw.exec(migration);
      raw.exec("PRAGMA user_version = 7");
      const turn = raw.prepare("INSERT INTO turns (turn_id, agent, started_at, ended_at, at) VALUES (?, 'main', ?, ?, ?)");
      turn.run("t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:10.000Z", "2026-11-14T10:00:00.000Z");
      turn.run("t-2", "2026-11-14T11:00:00.000Z", "2026-11-14T11:00:10.000Z", "2026-11-14T11:00:00.000Z");
      return raw;
    };
    const event = (raw: DatabaseSync, seq: number, source: string, ackedAt: string | null) =>
      raw
        .prepare("INSERT INTO events (seq, source, id, occurred_at, received_ms, summary, delivery, inline, payload, path, line, acked_ms) VALUES (?, ?, ?, 't', 0, ?, 'now', 1, '{}', 'p', 1, ?)")
        .run(seq, source, `e-${seq}`, `event ${seq}`, ackedAt === null ? null : Date.parse(ackedAt));
    const triggers = (db: DatabaseSync, turnId: string) =>
      ({ ...(db.prepare("SELECT triggers, trigger_count FROM turns WHERE turn_id = ?").get(turnId) as object) }) as { triggers: string; trigger_count: number };

    it("gives a turn the events acked between its end and the end of the next turn", (t) => {
      // Guards against: the turns from before the record shown with an unknown trigger when their events' acks tell it.
      const file = path.join(tempDir(t), "a.sqlite");
      const raw = atVersion7(file);
      event(raw, 2, "owner", "2026-11-14T10:00:10.200Z");
      event(raw, 1, "slack", "2026-11-14T10:00:10.200Z");
      raw.close();
      const db = openDatabase(file);
      t.after(() => db.close());
      assert.deepEqual(JSON.parse(triggers(db, "t-1").triggers), [
        { seq: 1, source: "slack", summary: "event 1" },
        { seq: 2, source: "owner", summary: "event 2" },
      ]);
      assert.equal(triggers(db, "t-1").trigger_count, 2);
    });

    it("gives a turn the event its reply answered", (t) => {
      // Guards against: the trigger the conversation shows for a reply missing from the turn the reply was sent in.
      const file = path.join(tempDir(t), "a.sqlite");
      const raw = atVersion7(file);
      event(raw, 1, "owner", null);
      raw.exec("INSERT INTO history (id, kind, agent, at, text, in_reply_to, turn_id) VALUES ('r-1', 'agent', 'main', '2026-11-14T11:00:05.000Z', 'x', 1, 't-2')");
      raw.close();
      const db = openDatabase(file);
      t.after(() => db.close());
      assert.deepEqual(JSON.parse(triggers(db, "t-2").triggers), [{ seq: 1, source: "owner", summary: "event 1" }]);
    });

    it("gives no turn an event it is not sure of", (t) => {
      // Guards against: a wrong trigger, worse than an unknown one: a control event (acked after the nightly
      // switch), one acked when no turn had just ended, and one whose ack and reply name different turns.
      const file = path.join(tempDir(t), "a.sqlite");
      const raw = atVersion7(file);
      event(raw, 1, "control", "2026-11-14T10:00:10.200Z");
      event(raw, 2, "owner", "2026-11-14T09:00:00.000Z");
      event(raw, 3, "owner", "2026-11-14T10:00:10.200Z");
      raw.exec("INSERT INTO history (id, kind, agent, at, text, in_reply_to, turn_id) VALUES ('r-1', 'agent', 'main', '2026-11-14T11:00:05.000Z', 'x', 3, 't-2')");
      raw.close();
      const db = openDatabase(file);
      t.after(() => db.close());
      assert.deepEqual(triggers(db, "t-1"), { triggers: "[]", trigger_count: 0 });
      assert.deepEqual(triggers(db, "t-2"), { triggers: "[]", trigger_count: 0 });
    });
  });

  it("is opened again without migrating twice", (t) => {
    const file = path.join(tempDir(t), "a.sqlite");
    openDatabase(file).close();
    const db = openDatabase(file);
    assert.equal(version(db), MIGRATIONS.length);
    db.close();
  });

  it("is refused when its schema is newer than this backend", (t) => {
    const file = path.join(tempDir(t), "a.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    assert.throws(() => openDatabase(file), /newer/);
  });

  it("keeps none of a transaction that throws", (t) => {
    // Guards against: half of a request kept, such as part of a list of activities refused as a whole.
    const db = openDatabase(path.join(tempDir(t), "a.sqlite"));
    t.after(() => db.close());
    db.exec("CREATE TABLE scratch (x INTEGER)");
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO scratch (x) VALUES (1)").run();
        throw new Error("no");
      }),
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM scratch").get() as { n: number }).n, 0);
  });

  it("keeps an inner transaction with the outer one, and drops both when the outer throws", (t) => {
    // Guards against: a task the A2A inbox keeps without the event it became, or the event without its task.
    const db = openDatabase(path.join(tempDir(t), "a.sqlite"));
    t.after(() => db.close());
    db.exec("CREATE TABLE scratch (x INTEGER)");
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM scratch").get() as { n: number }).n;
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO scratch (x) VALUES (1)").run();
        transaction(db, () => db.prepare("INSERT INTO scratch (x) VALUES (2)").run());
        throw new Error("no");
      }),
    );
    assert.equal(count(), 0);

    transaction(db, () => {
      db.prepare("INSERT INTO scratch (x) VALUES (1)").run();
      assert.throws(() =>
        transaction(db, () => {
          db.prepare("INSERT INTO scratch (x) VALUES (2)").run();
          throw new Error("inner");
        }),
      );
    });
    assert.equal(count(), 1, "the inner one that threw is dropped, the outer one kept");

    transaction(db, () => {
      db.prepare("INSERT INTO scratch (x) VALUES (3)").run();
      transaction(db, () => db.prepare("INSERT INTO scratch (x) VALUES (4)").run());
    });
    assert.equal(count(), 3, "both are kept when neither throws");
  });
});
