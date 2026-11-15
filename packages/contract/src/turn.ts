// What the events of a turn become in its input: one JSON object a line,
// inside `<events>` and `</events>` (docs/events.md, "ターンに入る形").

import type { Delivery, Source } from "./events.ts";
import type { AgentId, Appended, DeliveredAttachment } from "./sandbox.ts";

type TurnLineBase = {
  /** The agent the event is for. Left out, it is `main`, the only agent for now. */
  agent?: AgentId;
  source: Source;
  stream?: string;
};

type TurnEventBase = TurnLineBase & {
  kind?: never;
  /** The backend's order; what `reply`'s `in_reply_to` takes. */
  seq: number;
  delivery: Delivery;
  occurred_at: string;
  summary: string;
  /** Files that came with it, under /sources/<source>/files/. */
  attachments?: DeliveredAttachment[];
};

/**
 * One event. An inline event carries its content as `text`; any other
 * carries where its content was appended under /sources.
 */
export type TurnEvent =
  | (TurnEventBase & {
      /** The payload's `text`, or the payload as JSON when it has none. */
      text: string;
      appended?: never;
    })
  | (TurnEventBase & { appended: Appended; text?: never });

/** The batched events of one source and stream, handed over together, as one line. */
export type TurnBatch = TurnLineBase & {
  kind: "batch";
  count: number;
  /** The `seq` of each, in order. */
  seqs: number[];
  /** The summaries of the events, in `seq` order, one a line. */
  summary: string;
  /** Where they were appended: per file, with touching ranges merged, in order. */
  appended: Appended[];
};

/** One line inside `<events>`. */
export type TurnLine = TurnEvent | TurnBatch;
