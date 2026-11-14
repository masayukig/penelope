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
    const db = openDatabase(path.join(tempDir(t), "a.sqlite"));
    t.after(() => db.close());
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO session_rotations (agent, at) VALUES ('main', 'x')").run();
        throw new Error("no");
      }),
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM session_rotations").get() as { n: number }).n, 0);
  });
});
