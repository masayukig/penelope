// The limits of the activity record (ADR-0038, docs/ui-api.md "活動の記録"),
// shared by the backend, which keeps the rows, and the Web UI, which shows them.

/** A turn's row names at most this many of its events; `trigger_count` says how many there were. */
export const RECORD_TRIGGERS_MAX = 20;

/** A job's row keeps at most this many characters of the head of its command. */
export const RECORD_COMMAND_MAX = 200;

/** A reason the runner gives is kept as its first line, at most this many characters. */
export const RECORD_REASON_MAX = 500;

/** The one-line summaries are kept this many days. */
export const RECORD_SUMMARY_DAYS = 365;

/** The flow inside a turn (its activities) is kept this many days. */
export const RECORD_FLOW_DAYS = 30;
