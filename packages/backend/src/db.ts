// The backend's state: one SQLite file (ADR-0002). The schema is new, not
// natsumi's, and grows by migrations from the first version on.
import { DatabaseSync } from "node:sqlite";

/**
 * Each entry moves the schema one version on; `PRAGMA user_version` is the
 * number of entries applied. Entries are only ever appended, never edited.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- The queue. Times are milliseconds since the epoch.
  CREATE TABLE events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,
    id           TEXT NOT NULL,
    stream       TEXT,
    occurred_at  TEXT NOT NULL,
    received_ms  INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    delivery     TEXT NOT NULL CHECK (delivery IN ('now', 'batch')),
    inline       INTEGER NOT NULL,
    payload      TEXT NOT NULL,
    path         TEXT NOT NULL,
    line         INTEGER NOT NULL,
    attachments  TEXT,
    -- When it may be handed over: at once for now, when its batch ends for batch.
    due_ms       INTEGER,
    delivered_ms INTEGER,
    acked_ms     INTEGER,
    UNIQUE (source, id)
  );
  CREATE INDEX events_open ON events (seq) WHERE acked_ms IS NULL;

  -- The conversation: the owner's messages and the replies.
  CREATE TABLE history (
    row         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
    agent       TEXT,
    at          TEXT NOT NULL,
    text        TEXT NOT NULL,
    expression  TEXT,
    in_reply_to INTEGER
  );

  -- What the turns did, block by block.
  CREATE TABLE activities (
    row     INTEGER PRIMARY KEY AUTOINCREMENT,
    agent   TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind    TEXT NOT NULL,
    at      TEXT NOT NULL,
    body    TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id         TEXT PRIMARY KEY,
    agent      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    cron       TEXT,
    at         TEXT,
    next_ms    INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE session_rotations (
    row   INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    at    TEXT NOT NULL
  );

  -- The owner's logins. Only the SHA-256 of a token is kept.
  CREATE TABLE login_sessions (
    session_id     TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    github_user_id INTEGER NOT NULL,
    created_ms     INTEGER NOT NULL,
    expires_ms     INTEGER NOT NULL,
    revoked_ms     INTEGER
  );
  `,
  `
  -- The tasks other agents sent over A2A (docs/a2a.md). Times are milliseconds since the epoch.
  CREATE TABLE a2a_tasks (
    task_id     TEXT PRIMARY KEY,
    sender      TEXT NOT NULL,
    context_id  TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('working', 'input-required', 'completed', 'failed', 'rejected')),
    -- Why it failed or was rejected, as the sender is told.
    reason      TEXT,
    created_ms  INTEGER NOT NULL,
    -- The sender's last message: the deadline counts from it.
    received_ms INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
  );
  CREATE INDEX a2a_tasks_open ON a2a_tasks (sender) WHERE state IN ('working', 'input-required');

  -- The messages of each task, the sender's and hers, in order.
  CREATE TABLE a2a_messages (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES a2a_tasks (task_id),
    role       TEXT NOT NULL CHECK (role IN ('sender', 'agent')),
    message_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    at_ms      INTEGER NOT NULL,
    -- The event a sender's message became; her reply names it.
    seq        INTEGER UNIQUE
  );
  CREATE INDEX a2a_messages_task ON a2a_messages (task_id, row);
  `,
];

/** Opens the file (or `:memory:`) and brings its schema up to date. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version > MIGRATIONS.length) {
    throw new Error(`the database is at schema ${version}, newer than this backend's ${MIGRATIONS.length}`);
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
}

/**
 * Runs `work` in one transaction: all of it is kept, or none of it if it
 * throws. Inside another transaction it is a savepoint of it, kept or dropped
 * with the outer one, so that parts that take their own transaction can be put
 * together into one.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const inner = db.isTransaction;
  const name = `inner_${++savepoints}`;
  db.exec(inner ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec(inner ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(inner ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  }
}

let savepoints = 0;
