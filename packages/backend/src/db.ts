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
  `
  -- The sub-agents (ADR-0022): the last of POST /v1/agents for each name.
  CREATE TABLE sub_agents (
    agent      TEXT PRIMARY KEY,
    purpose    TEXT NOT NULL,
    closed     INTEGER NOT NULL CHECK (closed IN (0, 1)),
    -- When the runner first said it was started (closed false).
    started_at TEXT,
    updated_at TEXT NOT NULL
  );

  -- An agent's state is its last turn_start or turn_end: found by this.
  CREATE INDEX activities_turns ON activities (agent, row) WHERE kind IN ('turn_start', 'turn_end');
  `,
  `
  -- Where the notices of the replies go (ADR-0027): one row per endpoint, the
  -- keys of its kind as JSON. Times are milliseconds since the epoch.
  CREATE TABLE push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('web-push')),
    endpoint   TEXT NOT NULL UNIQUE,
    keys       TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  `,
  `
  -- What the agents made, copied by the backend (ADR-0032): for now the images
  -- of the replies, each tied to its reply. The bytes are a file under the
  -- assets directory, named by the file column. They are never removed.
  CREATE TABLE assets (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('image')),
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    name       TEXT NOT NULL,
    file       TEXT NOT NULL,
    agent      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- The reply it was sent with, and its place among that reply's images.
    reply_id   TEXT REFERENCES history (id),
    position   INTEGER
  );
  CREATE INDEX assets_reply ON assets (reply_id, position) WHERE reply_id IS NOT NULL;
  `,
  `
  -- The owner's images are copied too (ADR-0034): a copy belongs to a line of
  -- the history, a reply or one of the owner's messages, and an owner's copy
  -- has no agent. SQLite cannot loosen NOT NULL in place, so the table is
  -- made again with the rows it had.
  CREATE TABLE assets_next (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('image')),
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    name       TEXT NOT NULL,
    file       TEXT NOT NULL,
    -- The agent that made it; NULL for what the owner sent.
    agent      TEXT,
    created_at TEXT NOT NULL,
    -- The line of the history it was sent with, and its place among that line's images.
    message_id TEXT REFERENCES history (id),
    position   INTEGER
  );
  INSERT INTO assets_next (row, id, kind, mime_type, size, name, file, agent, created_at, message_id, position)
    SELECT row, id, kind, mime_type, size, name, file, agent, created_at, reply_id, position FROM assets;
  DROP TABLE assets;
  ALTER TABLE assets_next RENAME TO assets;
  CREATE INDEX assets_message ON assets (message_id, position) WHERE message_id IS NOT NULL;

  -- The owner's files that are not copied: their names and sizes, as JSON.
  ALTER TABLE history ADD COLUMN files TEXT;
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
