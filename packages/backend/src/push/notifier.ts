// The notices of the replies (ADR-0027): every reply goes to every
// subscription the owner made, by the kind of each. The first kind is Web
// Push; another (the apps' APNs) is one more channel. A notice is sent once;
// a subscription its service says is gone is dropped, anything else is only
// logged. Taking a reply never waits for its notices.
import type { DatabaseSync } from "node:sqlite";

import type { HistoryEntry, Notice } from "@penelope/contract";

import type { Feed } from "../feed.ts";

/** How much of a reply a notice carries, in characters. */
export const NOTICE_TEXT_LENGTH = 200;

/** The kinds of subscription, each sent by its channel. */
export type SubscriptionKind = "web-push";

/** A subscription as the backend keeps it. */
export type StoredSubscription = { id: number; kind: SubscriptionKind; endpoint: string; p256dh: Buffer; auth: Buffer };

/** What a channel's service said of one notice. */
export type Delivery = { kind: "sent" | "gone" | "failed"; status: number };

/** Sends the notices of one kind of subscription. */
export interface Channel {
  /** The most a notice may be, as JSON. */
  readonly maxBytes: number;
  deliver(target: StoredSubscription, plaintext: Buffer): Promise<Delivery>;
}

export class PushSubscriptions {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now }: { now: () => number }) {
    this.db = db;
    this.now = now;
  }

  /** One subscription per endpoint: the same endpoint again replaces its keys. */
  save(subscription: Omit<StoredSubscription, "id">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (kind, endpoint, keys, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET kind = excluded.kind, keys = excluded.keys, updated_ms = excluded.updated_ms`,
      )
      .run(subscription.kind, subscription.endpoint, JSON.stringify({ p256dh: subscription.p256dh.toString("base64url"), auth: subscription.auth.toString("base64url") }), now, now);
  }

  /** Whether there was one with this endpoint. */
  remove(endpoint: string): boolean {
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes) > 0;
  }

  /** Drops this one, unless it was made again since. */
  removeIfSame(target: StoredSubscription): boolean {
    const keys = JSON.stringify({ p256dh: target.p256dh.toString("base64url"), auth: target.auth.toString("base64url") });
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE id = ? AND keys = ?").run(target.id, keys).changes) > 0;
  }

  /** In the order they were first made. */
  all(): StoredSubscription[] {
    const rows = this.db.prepare("SELECT id, kind, endpoint, keys FROM push_subscriptions ORDER BY id").all() as { id: number; kind: SubscriptionKind; endpoint: string; keys: string }[];
    return rows.map((row) => {
      const keys = JSON.parse(row.keys) as { p256dh: string; auth: string };
      return { id: row.id, kind: row.kind, endpoint: row.endpoint, p256dh: Buffer.from(keys.p256dh, "base64url"), auth: Buffer.from(keys.auth, "base64url") };
    });
  }
}

/** The notice of a reply, its text cut to `length` characters. */
export function noticeOf(reply: Extract<HistoryEntry, { kind: "agent" }>, agentName: string, length = NOTICE_TEXT_LENGTH): Notice {
  const characters = Array.from(reply.text.trim());
  const text = characters.length > length ? `${characters.slice(0, length).join("")}…` : characters.join("");
  return { id: reply.id, agent: agentName, text, ...(reply.expression === undefined ? {} : { expression: reply.expression }) };
}

/** The notice as JSON within `maxBytes`, its text cut shorter until it fits. */
function plaintextOf(reply: Extract<HistoryEntry, { kind: "agent" }>, agentName: string, maxBytes: number): Buffer {
  for (let length = NOTICE_TEXT_LENGTH; ; length = Math.floor(length / 2)) {
    const plaintext = Buffer.from(JSON.stringify(noticeOf(reply, agentName, length)));
    if (plaintext.length <= maxBytes || length === 0) return plaintext;
  }
}

export type NotifierOptions = {
  feed: Feed;
  subscriptions: PushSubscriptions;
  /** The name the notices give: the agent's, from the settings. */
  agentName: string;
  channels: Partial<Record<SubscriptionKind, Channel>>;
  /** Lines that name subscriptions and statuses only: never a text or an endpoint. */
  log: (line: string) => void;
};

export class Notifier {
  private readonly options: NotifierOptions;
  private readonly pending = new Set<Promise<void>>();

  constructor(options: NotifierOptions) {
    this.options = options;
  }

  /** Sends a notice of every reply from now on, until the returned function is called. */
  start(): () => void {
    return this.options.feed.subscribe(undefined, (_id, event) => {
      if (event.event !== "reply") return;
      for (const target of this.options.subscriptions.all()) {
        const channel = this.options.channels[target.kind];
        if (channel === undefined) continue;
        const sending = this.deliver(channel, target, plaintextOf(event.data, this.options.agentName, channel.maxBytes));
        this.pending.add(sending);
        void sending.finally(() => this.pending.delete(sending));
      }
    });
  }

  /** When the notices under way have all been answered. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async deliver(channel: Channel, target: StoredSubscription, plaintext: Buffer): Promise<void> {
    const { log, subscriptions } = this.options;
    const name = `push: subscription ${target.id} (${target.kind})`;
    let delivery: Delivery;
    try {
      delivery = await channel.deliver(target, plaintext);
    } catch (error) {
      // The error may name the endpoint; only its kind is logged.
      log(`${name}: not sent (${error instanceof Error ? error.name : "error"})`);
      return;
    }
    if (delivery.kind === "gone") {
      try {
        if (subscriptions.removeIfSame(target)) log(`${name}: removed, its service answered ${delivery.status}`);
      } catch {
        // The database closed on the way out; the next notice tries again.
      }
    } else if (delivery.kind === "failed") {
      log(`${name}: refused with ${delivery.status}`);
    }
  }
}
