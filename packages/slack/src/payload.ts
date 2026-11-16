// The payload of an event of the Slack plugin (ADR-0028, docs/receivers.md
// "Slack のプラグイン"). The receivers' plugin writes it; the drawing, the
// runner and the reading CLI read it back from /sources (ADR-0029). The
// backend never looks inside.
//
// One thing that happened in Slack is one payload: a message, an edit, a
// deletion, a reaction put on or taken off. What a message is now is put
// together by the reader, from the lines in order.

/** A channel, a private channel, a direct message with one person, or a group DM. */
export type SlackChannelType = "channel" | "group" | "im" | "mpim";

/**
 * Where it happened. `name` is the channel's name without `#`, or, for a DM,
 * the name of the person it is with.
 */
export type SlackChannel = { id: string; name: string; type: SlackChannelType };

/** Someone: a person by their Slack user ID, or a bot that posted with no user. `name` is the name shown. */
export type SlackPerson = { id?: string; name: string; bot?: true };

/**
 * A file on a message. `attached` says the receivers fetched it and sent it
 * with the event: the attached files are, in this order, the line's
 * `attachments`. A file not attached was only noted.
 */
export type SlackFile = { id: string; name: string; mimetype: string; size: number; attached: boolean };

/** A reaction as Slack reported it with a fetched message: the people it named, and how many it counted. */
export type SlackReaction = { name: string; users: SlackPerson[]; count: number };

type Where = {
  /** The workspace's name in the receivers' settings. */
  workspace: string;
  channel: SlackChannel;
  /** The message's `ts`: with the channel, what names it. */
  ts: string;
  /** Set on a reply in a thread, to the parent's `ts`. Never set on the parent itself. */
  thread_ts?: string;
};

/** What a message says, as Slack wrote it, with the names of the people and channels its markup names by ID. */
type Said = {
  user: SlackPerson;
  /** Posted by the agent's own bot. */
  own: boolean;
  /** Slack's text, markup and all (`<@U0123>`, `<https://example.com|a link>`). */
  text: string;
  /** Names of the IDs the text's markup mentions (`U0123` → `alice`, `C0123` → `general`). */
  names?: Record<string, string>;
  files?: SlackFile[];
};

export type SlackMessage = Where &
  Said & {
    type: "message";
    /** Slack's subtype, when it has one (`bot_message`, `file_share`, `thread_broadcast`, `me_message`). */
    subtype?: string;
    /** It mentions the agent's bot. */
    mention: boolean;
    /** Already edited when it was received. */
    edited?: true;
    /** The reactions it had when it was fetched again after a reconnection. A live message has none. */
    reactions?: SlackReaction[];
    /** Fetched again after a (re)connection, rather than sent by Slack as it happened. */
    fetched?: true;
  };

export type SlackMessageChanged = Where & Said & { type: "message_changed" };

export type SlackMessageDeleted = Where & { type: "message_deleted" };

/** A reaction put on (`reaction_added`) or taken off a message. `thread_ts` is never known for it. */
export type SlackReactionChange = Omit<Where, "thread_ts"> & {
  type: "reaction_added" | "reaction_removed";
  user: SlackPerson;
  own: boolean;
  reaction: string;
};

export type SlackPayload = SlackMessage | SlackMessageChanged | SlackMessageDeleted | SlackReactionChange;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const CHANNEL_TYPES: readonly string[] = ["channel", "group", "im", "mpim"];

function person(value: unknown): value is SlackPerson {
  return isObject(value) && isString(value.name) && (value.id === undefined || isString(value.id)) && (value.bot === undefined || value.bot === true);
}

function where(value: Record<string, unknown>): boolean {
  const channel = value.channel;
  return (
    isString(value.workspace) &&
    isObject(channel) &&
    isString(channel.id) &&
    isString(channel.name) &&
    CHANNEL_TYPES.includes(channel.type as string) &&
    isString(value.ts) &&
    value.ts !== "" &&
    (value.thread_ts === undefined || isString(value.thread_ts))
  );
}

function said(value: Record<string, unknown>): boolean {
  const names = value.names;
  const files = value.files;
  return (
    person(value.user) &&
    typeof value.own === "boolean" &&
    isString(value.text) &&
    (names === undefined || (isObject(names) && Object.values(names).every(isString))) &&
    (files === undefined ||
      (Array.isArray(files) &&
        files.every(
          (file) =>
            isObject(file) &&
            isString(file.id) &&
            isString(file.name) &&
            isString(file.mimetype) &&
            typeof file.size === "number" &&
            typeof file.attached === "boolean",
        )))
  );
}

function reactions(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((reaction) => isObject(reaction) && isString(reaction.name) && Array.isArray(reaction.users) && reaction.users.every(person) && typeof reaction.count === "number"))
  );
}

/** The payload, when it is of the shape above; nothing when it is not (an older or a foreign shape). */
export function readPayload(value: unknown): SlackPayload | undefined {
  if (!isObject(value) || !where(value)) return undefined;
  switch (value.type) {
    case "message":
      return said(value) && typeof value.mention === "boolean" && reactions(value.reactions) ? (value as SlackMessage) : undefined;
    case "message_changed":
      return said(value) ? (value as SlackMessageChanged) : undefined;
    case "message_deleted":
      return value as SlackMessageDeleted;
    case "reaction_added":
    case "reaction_removed":
      return person(value.user) && typeof value.own === "boolean" && isString(value.reaction) && value.reaction !== "" ? (value as SlackReactionChange) : undefined;
    default:
      return undefined;
  }
}
