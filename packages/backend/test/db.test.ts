import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MIGRATIONS, openDatabase, transaction } from "../src/db.ts";
import { tempDir } from "./support.ts";

const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("the database", () => {
  it("is brought up to the latest schema when it is new", (t) => {
    const db = openDatabase(path.join(tempDir(t), "a.sqlite"));
    assert.equal(version(db), MIGRATIONS.length);
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
