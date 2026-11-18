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
  `
  -- The activity record (ADR-0038): one row a turn, beside the activities
  -- that are its flow. Times are RFC 3339 in UTC, as the activities have them.
  CREATE TABLE turns (
    turn_id       TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    -- As the runner said; NULL while it runs, or when it ended and the runner did not say.
    result        TEXT CHECK (result IN ('done', 'failed', 'stopped')),
    reason        TEXT,
    -- When the backend learned the result.
    recorded_at   TEXT,
    -- The events it was given, as JSON, and how many in all.
    triggers      TEXT NOT NULL DEFAULT '[]',
    trigger_count INTEGER NOT NULL DEFAULT 0,
    tools         INTEGER NOT NULL DEFAULT 0,
    -- A turn of the nightly switch: the seq of its control event and the step.
    night_seq     INTEGER,
    stage         TEXT CHECK (stage IN ('reflection', 'curator')),
    -- Where it stands in the list: its start, else the first that was heard of it.
    at            TEXT NOT NULL
  );
  CREATE INDEX turns_at ON turns (at);
  CREATE INDEX turns_agent ON turns (agent, at);
  CREATE INDEX turns_open ON turns (agent) WHERE ended_at IS NULL AND result IS NULL;
  CREATE INDEX turns_night ON turns (night_seq, stage) WHERE night_seq IS NOT NULL;
  CREATE INDEX turns_failed ON turns (recorded_at) WHERE result = 'failed';

  -- The turns from before the record, made from their activities; their result is unknown.
  INSERT INTO turns (turn_id, agent, started_at, ended_at, tools, at)
    SELECT turn_id, min(agent),
           min(CASE WHEN kind = 'turn_start' THEN at END),
           max(CASE WHEN kind = 'turn_end' THEN at END),
           sum(kind = 'tool_call'),
           coalesce(min(CASE WHEN kind = 'turn_start' THEN at END), min(at))
      FROM activities GROUP BY turn_id;
  -- One with no end that a later turn of the same agent followed was cut.
  UPDATE turns SET result = 'stopped'
   WHERE ended_at IS NULL AND EXISTS (SELECT 1 FROM turns later WHERE later.agent = turns.agent AND later.at > turns.at);

  -- A turn's flow is read by its turn, and the old is removed by its time.
  CREATE INDEX activities_turn ON activities (turn_id, row);
  CREATE INDEX activities_at ON activities (at);

  -- The turn a reply was sent in. Those from before are tied to the main agent's turn they fell in.
  ALTER TABLE history ADD COLUMN turn_id TEXT;
  UPDATE history SET turn_id = (
    SELECT t.turn_id FROM turns t
     WHERE t.agent = 'main' AND t.started_at <= history.at AND (t.ended_at IS NULL OR t.ended_at >= history.at)
     ORDER BY t.started_at DESC LIMIT 1)
   WHERE kind = 'agent';
  CREATE INDEX history_turn ON history (turn_id) WHERE turn_id IS NOT NULL;

  -- The nightly switches: the seq of the night's control event, its steps as
  -- JSON, when it was due and started, and whether a step failed. A row from
  -- before has none of them.
  ALTER TABLE session_rotations ADD COLUMN seq INTEGER;
  ALTER TABLE session_rotations ADD COLUMN stages TEXT;
  ALTER TABLE session_rotations ADD COLUMN scheduled_at TEXT;
  ALTER TABLE session_rotations ADD COLUMN started_at TEXT;
  ALTER TABLE session_rotations ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX session_rotations_seq ON session_rotations (seq) WHERE seq IS NOT NULL;
  CREATE INDEX session_rotations_at ON session_rotations (coalesce(started_at, at));

  -- The ends of the background jobs, one line each (ADR-0030).
  CREATE TABLE record_jobs (
    id          TEXT PRIMARY KEY,
    command     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    seconds     INTEGER NOT NULL,
    end_kind    TEXT NOT NULL,
    exit_code   INTEGER,
    signal      TEXT,
    failed      INTEGER NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX record_jobs_ended ON record_jobs (ended_at);
  INSERT OR IGNORE INTO record_jobs (id, command, started_at, ended_at, seconds, end_kind, exit_code, signal, failed, received_at)
    SELECT id, substr(json_extract(payload, '$.command'), 1, 200), json_extract(payload, '$.started_at'),
           json_extract(payload, '$.ended_at'), json_extract(payload, '$.seconds'), json_extract(payload, '$.end'),
           json_extract(payload, '$.exit_code'), json_extract(payload, '$.signal'),
           json_extract(payload, '$.end') IN ('timed-out', 'signaled')
             OR (json_extract(payload, '$.end') = 'exited' AND coalesce(json_extract(payload, '$.exit_code'), 0) <> 0),
           strftime('%Y-%m-%dT%H:%M:%fZ', received_ms / 1000.0, 'unixepoch')
      FROM events
     WHERE source = 'job' AND json_valid(payload)
       AND json_type(payload, '$.command') = 'text' AND json_type(payload, '$.started_at') = 'text'
       AND json_type(payload, '$.ended_at') = 'text' AND json_type(payload, '$.seconds') = 'integer'
       AND json_type(payload, '$.end') = 'text';

  -- When the record began, and when the owner last opened it.
  CREATE TABLE record_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- The triggers of the main turns from before the record (docs/backend.md
  -- "この版より前の記録"), from two things the backend kept. The runner acks a
  -- turn's events after its end, before its next turn ends: so an event acked
  -- from a turn's end to the next turn's end was given to it. And the event a
  -- reply answered was given to the turn of the reply. A control event is acked
  -- after the nightly switch and is left out; so is an event its two signs put
  -- in different turns. Times compare as the activities write them.
  CREATE TEMP TABLE main_turns AS
    SELECT turn_id, result, night_seq, trigger_count, ended_at,
           lead(coalesce(ended_at, at)) OVER (ORDER BY at, turn_id) AS until
      FROM turns WHERE agent = 'main';
  CREATE TEMP TABLE given AS
    SELECT e.seq, m.turn_id
      FROM events e JOIN main_turns m
        ON strftime('%Y-%m-%dT%H:%M:%fZ', e.acked_ms / 1000.0, 'unixepoch') >= m.ended_at
       AND (m.until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', e.acked_ms / 1000.0, 'unixepoch') < m.until)
     WHERE e.acked_ms IS NOT NULL AND e.source <> 'control'
    UNION
    SELECT e.seq, h.turn_id
      FROM history h JOIN events e ON e.seq = h.in_reply_to JOIN main_turns m ON m.turn_id = h.turn_id
     WHERE h.kind = 'agent' AND e.source <> 'control';
  CREATE TEMP TABLE sure AS
    SELECT g.seq, min(g.turn_id) AS turn_id FROM given g GROUP BY g.seq HAVING count(*) = 1;
  -- The first 20 (RECORD_TRIGGERS_MAX) by seq, and how many in all.
  UPDATE turns SET
    triggers = (
      SELECT json_group_array(json(trigger) ORDER BY seq) FROM (
        SELECT e.seq,
               CASE WHEN e.stream IS NULL THEN json_object('seq', e.seq, 'source', e.source, 'summary', e.summary)
                    ELSE json_object('seq', e.seq, 'source', e.source, 'stream', e.stream, 'summary', e.summary) END AS trigger
          FROM sure s JOIN events e ON e.seq = s.seq
         WHERE s.turn_id = turns.turn_id ORDER BY e.seq LIMIT 20)),
    trigger_count = (SELECT count(*) FROM sure s WHERE s.turn_id = turns.turn_id)
   WHERE turn_id IN (
     SELECT m.turn_id FROM main_turns m JOIN sure s ON s.turn_id = m.turn_id
      WHERE m.result IS NULL AND m.night_seq IS NULL AND m.trigger_count = 0 AND m.ended_at IS NOT NULL);
  DROP TABLE main_turns;
  DROP TABLE given;
  DROP TABLE sure;
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
