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
