// Lines of /sources/slack/... for the tests, as the backend writes them from
// the plugin's events. Every value is made up.
import type { SourcesLine } from "@penelope/contract";

import type { SlackChannel, SlackFile, SlackMessage, SlackPayload, SlackPerson, SlackReaction } from "../src/payload.ts";

/** 2026-11-16T09:00:00Z. */
const BASE = 1794819600;

/** The `ts` of a time of 2026-11-16 (UTC), `HH:MM`, with `n` to tell apart two in the same minute. */
export function ts(time: string, n = 1): string {
  const [hours, minutes] = time.split(":").map(Number);
  return `${BASE + (hours! - 9) * 3600 + minutes! * 60}.${String(n).padStart(6, "0")}`;
}

export const DEV: SlackChannel = { id: "C0DEV", name: "dev", type: "channel" };
export const DM: SlackChannel = { id: "D0ALICE", name: "alice", type: "im" };
export const ALICE: SlackPerson = { id: "U0ALICE", name: "alice" };
export const BOB: SlackPerson = { id: "U0BOB", name: "bob" };
export const CAROL: SlackPerson = { id: "U0CAROL", name: "carol" };
export const SELF: SlackPerson = { id: "U0SELF", name: "Penelope" };

let seq = 0;

export function reset(): void {
  seq = 0;
}

export function line(payload: SlackPayload, extra: Partial<SourcesLine> = {}): SourcesLine {
  seq++;
  const stream = `work.${payload.channel.type === "im" ? `dm.${payload.channel.name}` : payload.channel.name}`;
  return {
    seq,
    received_at: new Date(Number(payload.ts.split(".")[0]) * 1000).toISOString(),
    occurred_at: new Date(Number(payload.ts.split(".")[0]) * 1000).toISOString(),
    source: "slack",
    stream,
    id: `work/${payload.channel.id}/${payload.ts}/${seq}`,
    summary: "a summary",
    payload,
    ...extra,
  };
}

type MessageOptions = {
  channel?: SlackChannel;
  thread?: string;
  user?: SlackPerson;
  files?: SlackFile[];
  reactions?: SlackReaction[];
  names?: Record<string, string>;
  mention?: boolean;
};

export function message(at: string, text: string, options: MessageOptions = {}): SlackMessage {
  const user = options.user ?? ALICE;
  return {
    type: "message",
    workspace: "work",
    channel: options.channel ?? DEV,
    ts: at,
    ...(options.thread ? { thread_ts: options.thread } : {}),
    user,
    own: user === SELF,
    mention: options.mention ?? false,
    text,
    ...(options.names ? { names: options.names } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.reactions ? { reactions: options.reactions } : {}),
  };
}

export function edit(at: string, text: string, options: { channel?: SlackChannel; thread?: string; user?: SlackPerson } = {}): SlackPayload {
  const user = options.user ?? ALICE;
  return {
    type: "message_changed",
    workspace: "work",
    channel: options.channel ?? DEV,
    ts: at,
    ...(options.thread ? { thread_ts: options.thread } : {}),
    user,
    own: user === SELF,
    text,
  };
}

export function deletion(at: string, options: { channel?: SlackChannel } = {}): SlackPayload {
  return { type: "message_deleted", workspace: "work", channel: options.channel ?? DEV, ts: at };
}

export function reaction(at: string, name: string, user: SlackPerson, removed = false, channel: SlackChannel = DEV): SlackPayload {
  return { type: removed ? "reaction_removed" : "reaction_added", workspace: "work", channel, ts: at, user, own: user === SELF, reaction: name };
}
