// The conversation and the record of the turns (ADR-0002, docs/ui-api.md):
// the owner's messages and the replies as history, what the turns did block
// by block, and the nightly switches. What is new also goes down the feed.
// A reply's images are kept by the assets (ADR-0032).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Activity, AgentId, AgentState, HistoryEntry, HistoryResponse, ReplyImage, ReplyRequest, Trigger } from "@penelope/contract";

import type { Assets, CheckedImage } from "./assets.ts";
import { transaction } from "./db.ts";
import type { Feed } from "./feed.ts";
import { iso } from "./time.ts";

export const DEFAULT_PAGE = 50;

type Row = {
  row: number;
  id: string;
  kind: "owner" | "agent";
  agent: string | null;
  at: string;
  text: string;
  expression: string | null;
  trigger_source: string | null;
  trigger_summary: string | null;
};

export class Conversation {
  private readonly db: DatabaseSync;
  private readonly feed: Feed;
  private readonly now: () => number;
  private readonly assets: Assets | undefined;

  /** Without `assets`, a reply carries no images. */
  constructor(db: DatabaseSync, feed: Feed, { now, assets }: { now: () => number; assets?: Assets }) {
    this.db = db;
    this.feed = feed;
    this.now = now;
    this.assets = assets;
  }

  /** The owner's message, kept under the id of the `ui` event it became. */
  ownerMessage({ id, text }: { id: string; text: string }): void {
    this.db
      .prepare("INSERT INTO history (id, kind, at, text) VALUES (?, 'owner', ?, ?)")
      .run(id, iso(this.now()), text);
  }

  /**
   * Keeps the reply with copies of its images, tied to it, and sends it down
   * the feed. All of it is kept or none: when the copies cannot be written,
   * it throws AssetStoreError and the reply is not taken (ADR-0032).
   */
  reply(request: Omit<ReplyRequest, "images">, images: readonly CheckedImage[] = []): { id: string } {
    const id = randomUUID();
    const at = iso(this.now());
    if (images.length > 0 && this.assets === undefined) throw new Error("this conversation keeps no images");
    const stored = images.length === 0 ? [] : this.assets!.write(images);
    try {
      transaction(this.db, () => {
        this.db
          .prepare("INSERT INTO history (id, kind, agent, at, text, expression, in_reply_to) VALUES (?, 'agent', ?, ?, ?, ?, ?)")
          .run(id, request.agent, at, request.text, request.expression ?? null, request.in_reply_to ?? null);
        if (stored.length > 0) this.assets!.record(id, request.agent, stored);
      });
    } catch (error) {
      this.assets?.discard(stored);
      throw error;
    }
    const kept: ReplyImage[] = stored.map(({ id: imageId, mime_type, size, name }) => ({ id: imageId, mime_type, size, name }));
    const trigger = request.in_reply_to === undefined ? undefined : this.triggerOf(request.in_reply_to);
    this.feed.publish({
      event: "reply",
      data: {
        kind: "agent",
        id,
        at,
        text: request.text,
        agent: request.agent,
        ...(request.expression === undefined ? {} : { expression: request.expression }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(kept.length === 0 ? {} : { images: kept }),
      },
    });
    return { id };
  }

  /** The event a reply answers, as the UI shows it: its source and summary, not its payload. */
  private triggerOf(seq: number): Trigger | undefined {
    const row = this.db.prepare("SELECT source, summary FROM events WHERE seq = ?").get(seq) as Trigger | undefined;
    return row === undefined ? undefined : { source: row.source, summary: row.summary };
  }

  /**
   * Newest first. `before` is the cursor a page gave for the next, older one;
   * the last page gives none.
   */
  page(before?: string, limit = DEFAULT_PAGE): HistoryResponse {
    let below = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      below = Number(before);
      if (!/^\d+$/.test(before) || !Number.isSafeInteger(below)) throw new Error("before is not a cursor of the history");
    }
    const rows = this.db
      .prepare(
        `SELECT h.row, h.id, h.kind, h.agent, h.at, h.text, h.expression, e.source AS trigger_source, e.summary AS trigger_summary
           FROM history h LEFT JOIN events e ON e.seq = h.in_reply_to
          WHERE h.row < ? ORDER BY h.row DESC LIMIT ?`,
      )
      .all(below, limit + 1) as Row[];
    const more = rows.length > limit;
    const entries = rows.slice(0, limit);
    const images = this.assets?.ofReplies(entries.filter((row) => row.kind === "agent").map((row) => row.id)) ?? new Map<string, ReplyImage[]>();
    return { entries: entries.map((row) => entry(row, images.get(row.id))), ...(more ? { before: String(entries.at(-1)!.row) } : {}) };
  }

  /**
   * Keeps the blocks and sends each down the feed. A turn's start sets the
   * agent thinking and its end waiting.
   */
  activities(agent: AgentId, activities: readonly Activity[]): void {
    const insert = this.db.prepare("INSERT INTO activities (agent, turn_id, kind, at, body) VALUES (?, ?, ?, ?, ?)");
    for (const activity of activities) {
      insert.run(agent, activity.turn_id, activity.kind, activity.at, JSON.stringify(activity));
      if (activity.kind === "turn_start") this.feed.publish({ event: "state", data: { agent, state: "thinking" } });
      this.feed.publish({ event: "activity", data: { agent, activity } });
      if (activity.kind === "turn_end") this.feed.publish({ event: "state", data: { agent, state: "waiting" } });
    }
  }

  /** The turn is over: the agent waits for events again. */
  turnEnded(agent: AgentId): void {
    this.feed.publish({ event: "state", data: { agent, state: "waiting" } });
  }

  /**
   * Whether the agent is in a turn, and since when: its last turn_start
   * (thinking) or turn_end (waiting) in the record, at that block's time.
   * Waiting, with no time, when it has had no turn.
   */
  stateOf(agent: AgentId): { state: AgentState; since?: string } {
    const row = this.db
      .prepare("SELECT kind, at FROM activities WHERE agent = ? AND kind IN ('turn_start', 'turn_end') ORDER BY row DESC LIMIT 1")
      .get(agent) as { kind: "turn_start" | "turn_end"; at: string } | undefined;
    if (row === undefined) return { state: "waiting" };
    return { state: row.kind === "turn_start" ? "thinking" : "waiting", since: row.at };
  }

  sessionRotated(agent: AgentId): void {
    this.db.prepare("INSERT INTO session_rotations (agent, at) VALUES (?, ?)").run(agent, iso(this.now()));
  }
}

function entry(row: Row, images: ReplyImage[] | undefined): HistoryEntry {
  if (row.kind === "owner") return { kind: "owner", id: row.id, at: row.at, text: row.text };
  return {
    kind: "agent",
    id: row.id,
    at: row.at,
    text: row.text,
    agent: row.agent ?? "main",
    ...(row.expression === null ? {} : { expression: row.expression }),
    ...(row.trigger_source === null || row.trigger_summary === null ? {} : { trigger: { source: row.trigger_source, summary: row.trigger_summary } }),
    ...(images === undefined ? {} : { images }),
  };
}
