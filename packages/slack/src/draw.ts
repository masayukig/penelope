// Slack drawn as text people and the model read (ADR-0029): channel, then
// thread, then message, with the reactions, edits, deletions and files under
// the message they belong to. The lines of /sources are only ever appended,
// so what a message is now is put together here from the lines in order.
//
// The CLI draws a channel or a thread as it stands. A turn is given the
// changes since the last one: what changed is drawn whole, and the parent of
// a new reply or the message of a reaction is drawn short beside it.
import type { SourcesLine } from "@penelope/contract";

import { plainText } from "./markup.ts";
import { readPayload, type SlackChannel, type SlackFile, type SlackPayload, type SlackPerson } from "./payload.ts";

/** The default name of the Slack plugin's source, and of the CLI. */
export const DEFAULT_SOURCE = "slack";
export const CLI = "penelope-slack";

/** How many characters of the changes a turn is given, by default. */
export const DEFAULT_MAX_CHARS = 6000;

/** How much of a message is shown when it is drawn short. */
const SHORT = 60;

export type DrawOptions = {
  /** The time zone the times are shown in. The process's own when left out. */
  timeZone?: string;
};

export type ChangesOptions = DrawOptions & {
  /** The most characters of text. Over it, the oldest changes are left out. */
  maxChars?: number;
  /** How many messages before the first change of a channel (or of a thread) are drawn short beside it. */
  before?: number;
};

export type ChannelOptions = DrawOptions & {
  /** The most messages (not counting replies) drawn, the latest kept. All when left out. */
  limit?: number;
};

export type DrawnChanges = {
  /** The changes drawn, channel by channel. Empty when there is nothing to draw. */
  text: string;
  /** The `seq` of the changes left out to keep under the limit, oldest first. */
  omitted: number[];
  /** The changes whose payload is not of the plugin's shape, which are not drawn. */
  undrawn: SourcesLine[];
};

type Reacted = { name: string; people: Map<string, SlackPerson> };

/** A message as the lines make it so far. `known` is false while only a reaction or a deletion of it has been read. */
type Message = {
  ts: string;
  threadTs?: string;
  known: boolean;
  user?: SlackPerson;
  own: boolean;
  text: string;
  names: Record<string, string>;
  files: { file: SlackFile; path?: string }[];
  reactions: Reacted[];
  edited: boolean;
  deleted: boolean;
  /** The message line itself has been read (not only an edit of it). */
  read: boolean;
  replies: string[];
};

type Channel = { source: string; workspace: string; channel: SlackChannel; stream?: string; messages: Map<string, Message> };

/** What a change did to one message, for the turn's drawing. */
type Touch = { fresh: boolean; changed: boolean; reactions: { added: boolean; name: string; person: SlackPerson }[] };

type Folded = { channels: Map<string, Channel>; undrawn: SourcesLine[] };

const keyOf = (person: SlackPerson) => person.id ?? `name:${person.name}`;

/** The lines put together, in the order of `seq`, each line once. */
function fold(lines: readonly SourcesLine[], touched?: { seqs: ReadonlySet<number>; touches: Map<string, Map<string, Touch>> }): Folded {
  const channels = new Map<string, Channel>();
  const undrawn: SourcesLine[] = [];
  const seen = new Set<number>();
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(line.seq)) continue;
    seen.add(line.seq);
    const payload = readPayload(line.payload);
    if (payload === undefined) {
      undrawn.push(line);
      continue;
    }
    const key = `${line.source}\u0000${payload.workspace}\u0000${payload.channel.id}`;
    let channel = channels.get(key);
    if (channel === undefined) {
      channel = { source: line.source, workspace: payload.workspace, channel: payload.channel, messages: new Map() };
      channels.set(key, channel);
    }
    channel.channel = payload.channel;
    if (line.stream !== undefined) channel.stream = line.stream;
    const touch = touched?.seqs.has(line.seq) ? touchOf(touched.touches, key, payload.ts) : undefined;
    apply(channel, payload, line, touch);
  }
  return { channels, undrawn };
}

function touchOf(touches: Map<string, Map<string, Touch>>, channel: string, ts: string): Touch {
  let messages = touches.get(channel);
  if (messages === undefined) {
    messages = new Map();
    touches.set(channel, messages);
  }
  let touch = messages.get(ts);
  if (touch === undefined) {
    touch = { fresh: false, changed: false, reactions: [] };
    messages.set(ts, touch);
  }
  return touch;
}

function messageOf(channel: Channel, ts: string): Message {
  let message = channel.messages.get(ts);
  if (message === undefined) {
    message = { ts, known: false, own: false, text: "", names: {}, files: [], reactions: [], edited: false, deleted: false, read: false, replies: [] };
    channel.messages.set(ts, message);
  }
  return message;
}

function setThread(channel: Channel, message: Message, threadTs: string | undefined): void {
  if (threadTs === undefined || threadTs === message.ts || message.threadTs !== undefined) return;
  message.threadTs = threadTs;
  const parent = messageOf(channel, threadTs);
  if (!parent.replies.includes(message.ts)) parent.replies.push(message.ts);
}

function react(message: Message, name: string, person: SlackPerson, added: boolean): void {
  let reacted = message.reactions.find((item) => item.name === name);
  if (reacted === undefined) {
    if (!added) return;
    reacted = { name, people: new Map() };
    message.reactions.push(reacted);
  }
  if (added) reacted.people.set(keyOf(person), person);
  else reacted.people.delete(keyOf(person));
}

function apply(channel: Channel, payload: SlackPayload, line: SourcesLine, touch: Touch | undefined): void {
  const message = messageOf(channel, payload.ts);
  switch (payload.type) {
    case "message": {
      if (message.read) return;
      if (touch) touch.fresh = true;
      const attachments = line.attachments ?? [];
      let attached = 0;
      Object.assign(message, {
        known: true,
        read: true,
        user: payload.user,
        own: payload.own,
        text: payload.text,
        names: payload.names ?? {},
        files: (payload.files ?? []).map((file) => ({ file, ...(file.attached && attachments[attached] !== undefined ? { path: attachments[attached++] } : {}) })),
        edited: message.edited || payload.edited === true,
      });
      setThread(channel, message, payload.thread_ts);
      for (const reaction of payload.reactions ?? []) for (const person of reaction.users) react(message, reaction.name, person, true);
      return;
    }
    case "message_changed": {
      if (touch) touch.changed = true;
      const paths = new Map(message.files.map((item) => [item.file.id, item.path]));
      Object.assign(message, {
        known: true,
        user: payload.user,
        own: payload.own,
        text: payload.text,
        names: payload.names ?? {},
        edited: true,
        ...(payload.files ? { files: payload.files.map((file) => ({ file, ...(paths.get(file.id) ? { path: paths.get(file.id) } : {}) })) } : {}),
      });
      setThread(channel, message, payload.thread_ts);
      return;
    }
    case "message_deleted":
      if (touch) touch.changed = true;
      message.deleted = true;
      setThread(channel, message, payload.thread_ts);
      return;
    case "reaction_added":
    case "reaction_removed": {
      const added = payload.type === "reaction_added";
      touch?.reactions.push({ added, name: payload.reaction, person: payload.user });
      react(message, payload.reaction, payload.user, added);
      return;
    }
  }
}

/** Draws in the time zone given. */
class Drawer {
  private readonly clock: Intl.DateTimeFormat;

  constructor(options: DrawOptions) {
    this.clock = new Intl.DateTimeFormat("en-CA", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    });
  }

  header(channel: Channel): string {
    return describeChannel(channel.workspace, channel.channel, channel.stream);
  }

  time(ts: string): string {
    const parts = Object.fromEntries(this.clock.formatToParts(new Date(Number(ts) * 1000)).map((part) => [part.type, part.value]));
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  /** The first line of a message: when, who, its `ts`, and its marks. */
  head(message: Message, marks: string[]): string {
    if (!message.known) return `${message.replies.length > 0 ? "thread of" : "message"} [${message.ts}] (not read)${message.deleted ? " (deleted)" : ""}`;
    const user = message.user!;
    const who = `${user.name}${message.own ? " (you)" : user.bot ? " (bot)" : ""}`;
    return `${this.time(message.ts)} ${who} [${message.ts}]${marks.map((mark) => ` (${mark})`).join("")}`;
  }

  /** A message drawn whole: its text, reactions and files. */
  whole(message: Message, indent: string, reactions = true): string[] {
    const marks = message.deleted ? ["deleted"] : message.edited ? ["edited"] : [];
    const head = `${indent}- ${this.head(message, marks)}`;
    if (!message.known || message.deleted) return [head];
    const [first, ...rest] = plainText(message.text, message.names).split("\n");
    const lines = [`${head}: ${first}`, ...rest.map((text) => `${indent}  ${text}`)];
    const reacted = message.reactions.filter((item) => item.people.size > 0);
    if (reactions && reacted.length > 0) {
      lines.push(`${indent}  reactions: ${reacted.map((item) => `:${item.name}: ${[...item.people.values()].map((person) => person.name).join(", ")}`).join("; ")}`);
    }
    for (const { file, path } of message.files) {
      lines.push(path ? `${indent}  file ${file.name}: ${path}` : `${indent}  file ${file.name} (${file.mimetype || "unknown type"}, ${size(file.size)}): not fetched`);
    }
    return lines;
  }

  /** A message drawn short, beside what changed: one line of it at most. */
  short(message: Message, indent: string): string {
    if (!message.known || message.deleted) return `${indent}- ${this.head(message, message.known ? ["earlier", "deleted"] : [])}`;
    const text = plainText(message.text, message.names).replace(/\s+/g, " ").trim();
    const cut = [...text].length > SHORT ? `${[...text].slice(0, SHORT).join("").trimEnd()}…` : text;
    return `${indent}- ${this.head(message, ["earlier"])}: "${cut}"`;
  }
}

/** A channel named as the drawings head it: `work #dev (channel C0DEV, stream work.dev)`. */
export function describeChannel(workspace: string, channel: SlackChannel, stream?: string): string {
  const name = channel.type === "im" ? `DM with ${channel.name}` : channel.type === "mpim" ? `group DM ${channel.name}` : `#${channel.name}`;
  return `${workspace} ${name} (channel ${channel.id}${stream ? `, stream ${stream}` : ""})`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const byTs = (a: Message, b: Message) => Number(a.ts) - Number(b.ts) || a.ts.localeCompare(b.ts);

/** The messages that are not replies, in order. */
function topLevel(channel: Channel): Message[] {
  return [...channel.messages.values()].filter((message) => message.threadTs === undefined).sort(byTs);
}

function repliesOf(channel: Channel, message: Message): Message[] {
  return message.replies.map((ts) => channel.messages.get(ts)!).sort(byTs);
}

/** A channel as it stands, or only its latest `limit` messages. */
function drawWhole(drawer: Drawer, channel: Channel, messages: Message[]): string {
  const lines = [drawer.header(channel)];
  for (const message of messages) {
    lines.push(...drawer.whole(message, ""));
    for (const reply of repliesOf(channel, message)) lines.push(...drawer.whole(reply, "  "));
  }
  return `${lines.join("\n")}\n`;
}

/** Every channel of the lines as it stands now, each on its own. */
export function drawChannel(lines: readonly SourcesLine[], options: ChannelOptions = {}): string {
  const drawer = new Drawer(options);
  const { channels } = fold(lines);
  return [...channels.values()]
    .map((channel) => {
      const messages = topLevel(channel);
      return drawWhole(drawer, channel, options.limit === undefined ? messages : messages.slice(-options.limit));
    })
    .join("\n");
}

/** The thread of the message `ts` as it stands now: the parent and every reply. Nothing when the lines have no such thread. */
export function drawThread(lines: readonly SourcesLine[], ts: string, options: DrawOptions = {}): string | undefined {
  const drawer = new Drawer(options);
  for (const channel of fold(lines).channels.values()) {
    const message = channel.messages.get(ts);
    if (message !== undefined && message.threadTs === undefined && (message.known || message.replies.length > 0)) return drawWhole(drawer, channel, [message]);
  }
  return undefined;
}

/**
 * The changes since the last turn, drawn with what they need of the lines
 * before them. `context` holds the earlier lines of the same channels (it may
 * hold the changes too); lines after the last change are not counted.
 */
export function drawChanges(changes: readonly SourcesLine[], context: readonly SourcesLine[], options: ChangesOptions = {}): DrawnChanges {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sorted = [...changes].sort((a, b) => a.seq - b.seq);
  const undrawn = sorted.filter((line) => readPayload(line.payload) === undefined);
  const drawable = sorted.filter((line) => readPayload(line.payload) !== undefined);
  const draw = (kept: SourcesLine[], left: SourcesLine[]) => drawSome(kept, left, context, options);

  let text = draw(drawable, []);
  let omitted: SourcesLine[] = [];
  if (text.length > max && drawable.length > 0) {
    // The fewest of the oldest changes left out that bring the text under the limit.
    let low = 1;
    let high = drawable.length - 1;
    let best = drawable.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (draw(drawable.slice(middle), drawable.slice(0, middle)).length <= max) {
        best = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    omitted = drawable.slice(0, best);
    text = draw(drawable.slice(best), omitted);
    if (text.length > max) text = `${text.slice(0, Math.max(0, max - 2))}…\n`;
  }
  return { text, omitted: omitted.map((line) => line.seq), undrawn };
}

function drawSome(kept: readonly SourcesLine[], left: readonly SourcesLine[], context: readonly SourcesLine[], options: ChangesOptions): string {
  if (kept.length === 0 && left.length === 0) return "";
  const drawer = new Drawer(options);
  const last = Math.max(...kept.map((line) => line.seq), ...left.map((line) => line.seq));
  const lines = [...context.filter((line) => line.seq <= last), ...kept, ...left];
  const touches = new Map<string, Map<string, Touch>>();
  const { channels } = fold(lines, { seqs: new Set(kept.map((line) => line.seq)), touches });

  // Channels in the order of their first change, the changes left out included.
  const order = new Map<string, number>();
  const leftBy = new Map<string, number>();
  for (const line of [...left, ...kept].sort((a, b) => a.seq - b.seq)) {
    const payload = readPayload(line.payload)!;
    const key = `${line.source}\u0000${payload.workspace}\u0000${payload.channel.id}`;
    if (!order.has(key)) order.set(key, line.seq);
    if (left.includes(line)) leftBy.set(key, (leftBy.get(key) ?? 0) + 1);
  }

  const sections: string[] = [];
  for (const key of [...order.keys()]) {
    const channel = channels.get(key)!;
    const out = [drawer.header(channel)];
    const omitted = leftBy.get(key);
    if (omitted !== undefined && channel.stream !== undefined) {
      const source = channel.source === DEFAULT_SOURCE ? "" : `--source ${channel.source} `;
      out.push(`(${omitted} earlier ${omitted === 1 ? "change" : "changes"} left out; ${CLI} ${source}history ${channel.stream})`);
    }
    out.push(...drawTouched(drawer, channel, touches.get(key) ?? new Map(), options.before ?? 0));
    sections.push(`${out.join("\n")}\n`);
  }
  return sections.join("\n");
}

function drawTouched(drawer: Drawer, channel: Channel, touches: Map<string, Touch>, before: number): string[] {
  const lines: string[] = [];
  const touchedIn = (message: Message) => touches.has(message.ts) || message.replies.some((ts) => touches.has(ts));
  const top = topLevel(channel);
  const first = top.findIndex(touchedIn);
  if (first === -1) return lines;
  const shown = new Set([...top.slice(Math.max(0, first - before), first), ...top.filter(touchedIn)]);
  for (const message of top) {
    if (!shown.has(message)) continue;
    lines.push(...drawOne(drawer, message, touches.get(message.ts), ""));
    const replies = repliesOf(channel, message);
    const firstReply = replies.findIndex((reply) => touches.has(reply.ts));
    if (firstReply === -1) continue;
    const shownReplies = new Set([...replies.slice(Math.max(0, firstReply - before), firstReply), ...replies.filter((reply) => touches.has(reply.ts))]);
    for (const reply of replies) if (shownReplies.has(reply)) lines.push(...drawOne(drawer, reply, touches.get(reply.ts), "  "));
  }
  return lines;
}

/** One message beside the changes: whole when it is new or changed, short when it is only there for what is under it. */
function drawOne(drawer: Drawer, message: Message, touch: Touch | undefined, indent: string): string[] {
  const reactions = (touch?.reactions ?? []).map(({ added, name, person }) => `${indent}  ${added ? "+" : "-"} :${name}: ${person.name}`);
  if (touch?.fresh) return drawer.whole(message, indent);
  if (touch?.changed) return [...drawer.whole(message, indent, false), ...reactions];
  return [drawer.short(message, indent), ...reactions];
}
