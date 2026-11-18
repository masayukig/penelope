// The Signal plugin (docs/receivers.md, "Signal のプラグイン"). Signal has no
// bot API, so the deployment runs signal-cli's daemon beside the receivers
// with its JSON-RPC on a Unix socket, and this plugin keeps a connection to it
// open: the daemon pushes each message it receives as a `receive`
// notification, and a message or a reaction in a direct conversation from one
// of the allowed senders, or from anyone in one of the allowed groups, becomes
// an event. Other groups and everyone else are dropped.
//
// The agent answers through a second Unix socket the plugin serves, `POST
// /v1/send`, which the Sentinel reaches as a registered host's upstream (the
// sandbox does not mount it, ADR-0014). It sends only to the allowed senders
// and groups. With `approvals`, a post to a group is judged and may be held for
// the owner, and a group no one named is asked about (signal-gate.ts).
//
// While the agent works on a message that came `now`, the conversation shows
// her typing: the receivers cannot see the turn, so it lasts until she sends
// there or `typing_seconds` pass.
//
// signal-cli acknowledges a message to Signal's server as soon as it has it,
// so there is nothing to tell it back: an event the intake does not take is
// sent again here until it is, and a read receipt goes to the sender once it
// is.
import { chmodSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";

import { isObject, onlyKnown, readKey, SettingsError, type ConnectionEvent, type ConnectionPlugin, type PluginEnv } from "../plugin.ts";
import type { IntakeFile } from "../intake.ts";
import { Gate, type Draft, type HeldResult, type JudgeSettings, type Sent } from "./signal-gate.ts";
import { backoff } from "./slack/socket.ts";
import { streamOf, summaryLine } from "./text.ts";

const MIB = 1024 * 1024;
const MAX_FILE_BYTES = 60 * MIB;
const MAX_SEND_BYTES = 64 * MIB;
const NUMBER = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GROUP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The names the approvals give the groups the owner let in (`g-` and 8 hex digits). */
const ASKED_NAME = /^g-[0-9a-f]{8}$/;
const GROUP_ID = /^[A-Za-z0-9+/]+={0,2}$/;
/** What signal-cli leaves in the text where a mention is. */
const MENTION_MARK = "\uFFFC";
/** How long after the agent's own post in a group what others say there comes `now` (natsumi's `follow-up`). */
export const FOLLOW_UP_MS = 10 * 60_000;
/** Signal's apps stop showing "typing" about 15 s after the last one, so it is sent again this often. */
const TYPING_REFRESH_MS = 10_000;
/** How often held posts and questions are looked over, and the groups listed (natsumi's sweep). */
const SWEEP_MS = 60_000;

type Raw = Record<string, unknown>;

/** A file that came with a message, as signal-cli names it. */
type Attachment = { id: string; name: string; type: string; size?: number };

/** The payload of a Signal event. */
export type SignalPayload = {
  type: "message" | "reaction" | "held";
  from: { number?: string; uuid?: string; name?: string };
  /** In a group: its name in the settings, and its title on Signal when signal-cli gives it. */
  group?: { name: string; title?: string };
  /** In a group: the message mentions the agent. */
  mentions_me?: boolean;
  /** In a group: the agent's own post, as it was sent. */
  own?: boolean;
  /** Signal's timestamp of the message (ms). A reaction or a quote points back at it. */
  timestamp: number;
  text?: string;
  /** `author` is the number (or UUID) a quoted reply names; `mine` when it quotes the agent. */
  quote?: { timestamp: number; text?: string; author?: string; mine?: boolean };
  files?: { name: string; mimetype: string; size?: number; attached: boolean }[];
  reaction?: { emoji: string; target_timestamp: number; removed: boolean };
  /** A post held for the owner (the `held` the send answered with 202), and what came of it. */
  held?: { id: string; result: HeldResult; error?: string };
};

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Who the plugin reads, and how a group's message is told to be the agent's. */
export type Audience = {
  account: string;
  senders: ReadonlySet<string>;
  /** The allowed groups: Signal's group ID to its name in the settings. */
  groups: ReadonlyMap<string, string>;
  /** The agent's names, folded (`fold`): a group message with one comes `now`. */
  names?: readonly string[];
  /** Whether a message at this time in this group follows the agent's own post there. */
  followsOwn?: (groupId: string, timestamp: number) => boolean;
};

/** NFKC, lower case, katakana as hiragana: the form names are looked for in. */
export function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

/**
 * The event a received envelope makes, with the files to fetch for it, or
 * nothing when it is not one this plugin reads: not a data message, in a
 * group not allowed, from someone not allowed in a direct conversation, or
 * empty. In an allowed group, anyone's message is read.
 */
export function eventOf(
  envelope: unknown,
  audience: Audience,
): { event: ConnectionEvent & { payload: SignalPayload }; attachments: Attachment[]; groupId?: string } | undefined {
  if (!isObject(envelope) || !isObject(envelope.dataMessage)) return undefined;
  const message = envelope.dataMessage;
  const number = str(envelope.sourceNumber);
  const uuid = str(envelope.sourceUuid);
  let group: { id: string; name: string; title?: string } | undefined;
  if (message.groupInfo !== undefined && message.groupInfo !== null) {
    const id = isObject(message.groupInfo) ? str(message.groupInfo.groupId) : undefined;
    const name = id === undefined ? undefined : audience.groups.get(id);
    if (id === undefined || name === undefined) return undefined;
    const title = str((message.groupInfo as Raw).groupName);
    group = { id, name, ...(title ? { title } : {}) };
  } else if (!(number && audience.senders.has(number)) && !(uuid && audience.senders.has(uuid))) {
    return undefined;
  }
  if (!number && !uuid) return undefined;
  const timestamp = num(message.timestamp) ?? num(envelope.timestamp);
  if (timestamp === undefined) return undefined;

  const from = { ...(number ? { number } : {}), ...(uuid ? { uuid } : {}), ...(str(envelope.sourceName) ? { name: str(envelope.sourceName) } : {}) };
  const who = from.name ?? number ?? uuid!;
  const author = number ?? uuid!;
  const base = group
    ? { id: `group.${group.name}/${author}/${timestamp}`, occurred_at: new Date(timestamp).toISOString(), stream: streamOf(`group.${group.name}`) }
    : { id: `${author}/${timestamp}`, occurred_at: new Date(timestamp).toISOString(), stream: streamOf(`dm.${author.replace(/^\+/, "")}`) };
  const where = group ? `Signal ${group.name} ${who}` : `Signal ${who}`;
  const inGroup = group ? { group: { name: group.name, ...(group.title ? { title: group.title } : {}) } } : {};

  if (isObject(message.reaction)) {
    const emoji = str(message.reaction.emoji);
    const target = num(message.reaction.targetSentTimestamp);
    if (!emoji || target === undefined) return undefined;
    const removed = message.reaction.isRemove === true;
    return {
      event: {
        ...base,
        delivery: "batch",
        summary: summaryLine(`${where} ${removed ? "took off" : "reacted"} ${emoji}`),
        payload: { type: "reaction", from, ...inGroup, timestamp, reaction: { emoji, target_timestamp: target, removed } },
      },
      attachments: [],
      ...(group ? { groupId: group.id } : {}),
    };
  }

  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).filter(isObject);
  const mentionsMe = group !== undefined && mentions.some((mention) => mention.number === audience.account);
  const text = mentions.length === 0 ? str(message.message) : withNames(str(message.message), mentions, audience.account);
  const attachments: Attachment[] = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((item, index) => {
    if (!isObject(item) || !str(item.id)) return [];
    const size = num(item.size);
    return [{ id: item.id as string, name: str(item.filename) ?? `attachment-${index + 1}`, type: str(item.contentType) ?? "application/octet-stream", ...(size !== undefined ? { size } : {}) }];
  });
  if (text === undefined && attachments.length === 0) return undefined;
  const quoteAuthor = isObject(message.quote) ? str(message.quote.authorNumber) ?? str(message.quote.authorUuid) : undefined;
  const quote = isObject(message.quote) && num(message.quote.id) !== undefined
    ? {
        timestamp: message.quote.id as number,
        ...(str(message.quote.text) ? { text: message.quote.text as string } : {}),
        ...(group && quoteAuthor ? { author: quoteAuthor, ...(quoteAuthor === audience.account ? { mine: true } : {}) } : {}),
      }
    : undefined;
  // In a group, what is for the agent comes now (natsumi's mention, quote-reply, name and follow-up); the rest is batched.
  const now = !group
    || mentionsMe
    || quote?.mine === true
    || (text !== undefined && (audience.names ?? []).some((name) => fold(text).includes(name)))
    || (audience.followsOwn?.(group.id, timestamp) ?? false);
  const files = attachments.length === 0 ? "" : ` (${attachments.length} file${attachments.length === 1 ? "" : "s"})`;
  return {
    event: {
      ...base,
      delivery: now ? "now" : "batch",
      summary: summaryLine(`${where}:${text !== undefined ? ` ${text}` : ""}${files}`),
      payload: {
        type: "message",
        from,
        ...inGroup,
        ...(mentionsMe ? { mentions_me: true } : {}),
        timestamp,
        ...(text !== undefined ? { text } : {}),
        ...(quote ? { quote } : {}),
        ...(attachments.length > 0 ? { files: attachments.map((file) => ({ name: file.name, mimetype: file.type, ...(file.size !== undefined ? { size: file.size } : {}), attached: false })) } : {}),
      },
    },
    attachments,
    ...(group ? { groupId: group.id } : {}),
  };
}

/** The text with each mention's mark as `@<name>` (`@you` for the agent), from the end so the earlier places stay put. */
function withNames(text: string | undefined, mentions: Raw[], account: string): string | undefined {
  if (text === undefined) return undefined;
  let out = text;
  const placed = mentions.filter((mention) => num(mention.start) !== undefined && num(mention.length) !== undefined);
  for (const mention of placed.sort((a, b) => (b.start as number) - (a.start as number))) {
    const start = mention.start as number;
    const end = start + (mention.length as number);
    if (out.slice(start, end) !== MENTION_MARK) continue;
    const name = mention.number === account ? "you" : str(mention.name) && !NUMBER.test(mention.name as string) ? (mention.name as string) : "someone";
    out = `${out.slice(0, start)}@${name}${out.slice(end)}`;
  }
  return out;
}

function settingsOf(settings: Record<string, unknown>, env: PluginEnv) {
  onlyKnown(settings, ["socket", "account", "senders", "groups", "names", "send_socket", "max_file_bytes", "rpc_timeout_seconds", "typing_seconds", "approvals", "judge", "approval_hours", "state_file", "time_zone"]);
  const path = (field: string, value: unknown, required: boolean) => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.startsWith("/")) throw new SettingsError(field, "must be the absolute path of a Unix socket");
    return value;
  };
  const socket = path("socket", settings.socket, true)!;
  const sendSocket = path("send_socket", settings.send_socket, false);
  if (typeof settings.account !== "string" || !NUMBER.test(settings.account)) throw new SettingsError("account", "must be a phone number in E.164 (+81…)");
  const { senders } = settings;
  if (!Array.isArray(senders) || senders.length === 0) throw new SettingsError("senders", "must be a list of one or more phone numbers or UUIDs");
  senders.forEach((sender, index) => {
    if (typeof sender !== "string" || !(NUMBER.test(sender) || UUID.test(sender))) throw new SettingsError(`senders[${index}]`, "must be a phone number in E.164 or a UUID");
  });
  const groups = new Map<string, string>();
  const rawGroups = settings.groups ?? {};
  if (!isObject(rawGroups)) throw new SettingsError("groups", "must map a name to a group ID");
  for (const [name, id] of Object.entries(rawGroups)) {
    if (!GROUP_NAME.test(name)) throw new SettingsError(`groups.${name}`, "the name must be 1-32 of a-z, 0-9 and -, not starting with -");
    if (ASKED_NAME.test(name)) throw new SettingsError(`groups.${name}`, "g- and 8 hex digits is the form of the groups the owner lets in; name it otherwise");
    if (typeof id !== "string" || !GROUP_ID.test(id)) throw new SettingsError(`groups.${name}`, "must be a group ID as signal-cli's listGroups gives it (base64)");
    if (groups.has(id)) throw new SettingsError(`groups.${name}`, "the same group ID is named twice");
    groups.set(id, name);
  }
  const names = settings.names ?? [];
  if (!Array.isArray(names)) throw new SettingsError("names", "must be a list of the agent's names");
  names.forEach((name, index) => {
    if (typeof name !== "string" || [...fold(name).trim()].length < 2) throw new SettingsError(`names[${index}]`, "must be a name of 2 characters or more");
  });
  const maxFileBytes = settings.max_file_bytes ?? 20 * MIB;
  if (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw new SettingsError("max_file_bytes", `must be an integer from 1 to ${MAX_FILE_BYTES}`);
  }
  const timeout = settings.rpc_timeout_seconds ?? 30;
  if (typeof timeout !== "number" || !(timeout > 0)) throw new SettingsError("rpc_timeout_seconds", "must be a number greater than 0");
  const typing = settings.typing_seconds ?? 300;
  if (typeof typing !== "number" || !(typing >= 0) || typing > 3600) throw new SettingsError("typing_seconds", "must be a number from 0 to 3600");
  const approvals = settings.approvals ?? false;
  if (typeof approvals !== "boolean") throw new SettingsError("approvals", "must be true or false");
  let judge: JudgeSettings | undefined;
  if (settings.judge !== undefined) {
    const raw = settings.judge;
    if (!isObject(raw)) throw new SettingsError("judge", "must be an object (url, api_key_file, model, ask_at, return_at, timeout_seconds)");
    if (!approvals) throw new SettingsError("judge", "needs approvals: true, to ask the owner about what the judge flags");
    const known = ["url", "api_key_file", "model", "ask_at", "return_at", "timeout_seconds"];
    for (const key of Object.keys(raw)) if (!known.includes(key)) throw new SettingsError(`judge.${key}`, "not a field of the judge");
    const url = raw.url ?? "https://api.typesafe.ai";
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new SettingsError("judge.url", "must be an http(s) URL, the base of /v1/systemone");
    const model = raw.model ?? "jev-latest";
    if (typeof model !== "string" || model === "") throw new SettingsError("judge.model", "must be a model's name");
    const share = (field: string, value: unknown) => {
      if (typeof value !== "number" || !(value > 0 && value <= 1)) throw new SettingsError(`judge.${field}`, "must be a number over 0, up to 1");
      return value;
    };
    const askAt = share("ask_at", raw.ask_at ?? 0.5);
    const returnAt = share("return_at", raw.return_at ?? 0.9);
    if (returnAt < askAt) throw new SettingsError("judge.return_at", "must not be under ask_at");
    const timeout = raw.timeout_seconds ?? 30;
    if (typeof timeout !== "number" || !(timeout > 0)) throw new SettingsError("judge.timeout_seconds", "must be a number greater than 0");
    const apiKey = raw.api_key_file === undefined ? undefined : readKey("judge.api_key_file", raw.api_key_file, env);
    judge = { url, model, askAt, returnAt, timeoutMs: timeout * 1000, ...(apiKey ? { apiKey } : {}) };
  }
  const hours = settings.approval_hours ?? 168;
  if (typeof hours !== "number" || !(hours > 0)) throw new SettingsError("approval_hours", "must be a number greater than 0");
  if (settings.state_file !== undefined && (typeof settings.state_file !== "string" || !settings.state_file.startsWith("/"))) {
    throw new SettingsError("state_file", "must be an absolute path");
  }
  const timeZone = settings.time_zone ?? "UTC";
  try {
    if (typeof timeZone !== "string") throw new RangeError();
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new SettingsError("time_zone", "must be an IANA time zone, such as Asia/Tokyo");
  }
  return {
    socket,
    sendSocket,
    approvals,
    judge,
    approvalMs: hours * 3600_000,
    stateFile: settings.state_file as string | undefined,
    timeZone,
    account: settings.account,
    senders: senders as string[],
    groups,
    names: (names as string[]).map((name) => fold(name).trim()),
    maxFileBytes,
    rpcTimeoutMs: timeout * 1000,
    typingMs: typing * 1000,
  };
}

class RpcError extends Error {}

export type SignalPluginOptions = {
  /** The wait before the `attempt`-th try in a row that failed: to connect, or to hand an event over. */
  backoffMs?: (attempt: number) => number;
  /** How often the approvals look over what is held and list the groups. */
  sweepMs?: number;
};

export function signalPlugin(options: SignalPluginOptions = {}): ConnectionPlugin {
  const backoffMs = options.backoffMs ?? backoff;
  return {
    name: "signal",
    kind: "connection",
    create(raw, env) {
      const settings = settingsOf(raw, env);
      return {
        start(io) {
          /** The conversations shown as typing, by `dm:<sender>` or `group:<ID>`. */
          const typing = new Map<string, { refresh: NodeJS.Timeout; end: NodeJS.Timeout }>();
          const typingTo = (key: string): Raw => (key.startsWith("group:") ? { groupId: [key.slice(6)] } : { recipient: [key.slice(3)] });
          const sendTyping = (key: string, stop: boolean) =>
            call("sendTyping", { ...typingTo(key), ...(stop ? { stop: true } : {}) }).catch((error: unknown) =>
              io.log(`cannot send typing (${error instanceof Error ? error.message : "error"})`),
            );
          /** Ends the typing; `tell` sends Signal the stop, which a message sent there makes needless. */
          const endTyping = (key: string, tell: boolean) => {
            const shown = typing.get(key);
            if (!shown) return;
            clearInterval(shown.refresh);
            clearTimeout(shown.end);
            typing.delete(key);
            if (tell) void sendTyping(key, true);
          };
          // ponytail: the receivers do not see the turn end, so a turn that sends nothing leaves "typing" up to typing_seconds;
          // tell the plugin of turn ends (a runner hook, or the Sentinel's log of the backend's /v1/turns/end) if that matters.
          const startTyping = (key: string) => {
            if (settings.typingMs === 0 || stopped) return;
            endTyping(key, false);
            void sendTyping(key, false);
            const refresh = setInterval(() => void sendTyping(key, false), TYPING_REFRESH_MS);
            const end = setTimeout(() => endTyping(key, true), settings.typingMs);
            refresh.unref();
            end.unref();
            typing.set(key, { refresh, end });
          };

          /** Per group ID: when the agent last posted there, and whether hers is still the last message. */
          const ownPosts = new Map<string, { at: number; last: boolean }>();
          /** The groups read and written to: the settings', and with approvals those the owner let in. */
          const groups = new Map(settings.groups);
          const audience: Audience = {
            account: settings.account,
            senders: new Set(settings.senders),
            groups,
            names: settings.names,
            followsOwn: (groupId, timestamp) => {
              const own = ownPosts.get(groupId);
              return own !== undefined && (own.last || (timestamp >= own.at && timestamp - own.at <= FOLLOW_UP_MS));
            },
          };
          let stopped = false;
          let current: net.Socket | undefined;
          let wake: (() => void) | undefined;
          let nextId = 0;
          const pending = new Map<number, { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }>();
          /** The notifications in hand, one after another. */
          let chain: Promise<void> = Promise.resolve();

          const sleep = (ms: number) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(done, ms);
              function done() {
                clearTimeout(timer);
                wake = undefined;
                resolve();
              }
              wake = done;
            });

          const call = (method: string, params: Raw) =>
            new Promise<unknown>((resolve, reject) => {
              const socket = current;
              if (!socket) return reject(new RpcError("signal-cli is not connected"));
              const id = ++nextId;
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new RpcError(`${method}: no answer in time`));
              }, settings.rpcTimeoutMs);
              pending.set(id, {
                method,
                resolve: (result) => (clearTimeout(timer), resolve(result)),
                reject: (error) => (clearTimeout(timer), reject(error)),
              });
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { account: settings.account, ...params } })}\n`);
            });

          const receive = async (params: unknown) => {
            const envelope = isObject(params) ? params.envelope : undefined;
            if (gate?.consume(envelope)) {
              io.log("envelope events=0 dropped=0 answer=1");
              return;
            }
            const made = eventOf(envelope, audience);
            if (made?.groupId !== undefined) {
              const { payload } = made.event;
              gate?.record(made.groupId, { timestamp: payload.timestamp, from: payload.from.name ?? "someone", ...(payload.type === "message" && payload.text !== undefined ? { text: payload.text } : {}), ...(payload.group?.title ? { title: payload.group.title } : {}) });
            }
            if (made?.groupId !== undefined && made.event.payload.type === "message") {
              const own = ownPosts.get(made.groupId);
              if (own) own.last = false;
            }
            if (!made) {
              io.log("envelope events=0 dropped=1");
              return;
            }
            const { event, attachments } = made;
            const files: IntakeFile[] = [];
            let total = 0;
            for (const [index, attachment] of attachments.entries()) {
              if (attachment.size !== undefined && (attachment.size > settings.maxFileBytes || total + attachment.size > MAX_FILE_BYTES)) continue;
              try {
                const result = await call("getAttachment", { id: attachment.id });
                const data = isObject(result) && typeof result.data === "string" ? Buffer.from(result.data, "base64") : undefined;
                if (!data || data.length > settings.maxFileBytes || total + data.length > MAX_FILE_BYTES) continue;
                total += data.length;
                files.push({ name: attachment.name, type: attachment.type, data });
                event.payload.files![index]!.attached = true;
              } catch (error) {
                io.log(`cannot fetch a file (${error instanceof Error ? error.message : "error"})`);
              }
            }
            // signal-cli has already told Signal it has the message, so it is handed over until the intake takes it.
            for (let attempt = 1; !(await io.deliver([{ ...event, ...(files.length > 0 ? { files } : {}) }])); attempt++) {
              if (stopped) {
                io.log("envelope events=1 dropped=0 taken=false (stopping)");
                return;
              }
              await sleep(backoffMs(attempt));
            }
            io.log(`envelope events=1 dropped=0 taken=true`);
            const sender = event.payload.from.number ?? event.payload.from.uuid!;
            if (event.delivery === "now") startTyping(made.groupId !== undefined ? `group:${made.groupId}` : `dm:${sender}`);
            if (event.payload.type === "message") {
              await call("sendReceipt", { recipient: sender, targetTimestamp: [event.payload.timestamp], type: "read" }).catch((error: unknown) =>
                io.log(`cannot send a read receipt (${error instanceof Error ? error.message : "error"})`),
              );
            }
          };

          /** One connection, until it closes. Resolves whether it was opened. */
          const session = () =>
            new Promise<boolean>((resolve) => {
              const socket = net.createConnection(settings.socket);
              let opened = false;
              let buffer = "";
              socket.setEncoding("utf8");
              socket.on("connect", () => {
                opened = true;
                current = socket;
                io.log("connected");
                void gate?.sweep();
              });
              socket.on("error", (error: NodeJS.ErrnoException) => io.log(`connection error (${error.code ?? error.name})`));
              socket.on("close", () => {
                if (current === socket) current = undefined;
                for (const [id, call] of pending) {
                  pending.delete(id);
                  call.reject(new RpcError(`${call.method}: the connection closed`));
                }
                resolve(opened);
              });
              socket.on("data", (chunk: string) => {
                buffer += chunk;
                let end: number;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, end).trim();
                  buffer = buffer.slice(end + 1);
                  if (line === "") continue;
                  let message: Raw;
                  try {
                    message = JSON.parse(line) as Raw;
                  } catch {
                    io.log("a line that is not JSON was passed over");
                    continue;
                  }
                  if (typeof message.id === "number" && pending.has(message.id)) {
                    const call = pending.get(message.id)!;
                    pending.delete(message.id);
                    if (isObject(message.error)) call.reject(new RpcError(`${call.method}: signal-cli error ${String(message.error.code)}`));
                    else call.resolve(message.result);
                  } else if (message.method === "receive" && !stopped) {
                    chain = chain.then(() => receive(message.params)).catch((error: unknown) => io.log(`an envelope could not be handled (${error instanceof Error ? error.message : "error"})`));
                  }
                }
              });
            });

          const running = (async () => {
            let failures = 0;
            while (!stopped) {
              const opened = await session();
              if (stopped) break;
              failures = opened ? 1 : failures + 1;
              const ms = backoffMs(failures);
              io.log(`connecting again in ${Math.round(ms / 100) / 10}s`);
              await sleep(ms);
            }
          })();

          /** The agent's own post in a group: it is written into the group's stream as anyone's is, and starts the follow-up window. */
          const posted = (group: { id: string; name: string }, timestamp: number, text: string | undefined, files: number) => {
            endTyping(`group:${group.id}`, false);
            ownPosts.set(group.id, { at: timestamp, last: true });
            gate?.record(group.id, { timestamp, from: "the secretary", ...(text !== undefined ? { text } : {}) });
            const event: ConnectionEvent & { payload: SignalPayload } = {
              id: `group.${group.name}/${settings.account}/${timestamp}`,
              occurred_at: new Date(timestamp).toISOString(),
              stream: streamOf(`group.${group.name}`),
              delivery: "batch",
              summary: summaryLine(`Signal ${group.name} (you):${text !== undefined ? ` ${text}` : ""}${files > 0 ? ` (${files} file${files === 1 ? "" : "s"})` : ""}`),
              payload: { type: "message", from: { number: settings.account }, group: { name: group.name }, own: true, timestamp, ...(text !== undefined ? { text } : {}) },
            };
            chain = chain.then(async () => {
              if (!(await io.deliver([event]))) io.log("own post events=1 taken=false");
            });
          };
          /** Sends to a sender or a group now; a group's post goes into its stream. */
          const send = async (to: { recipient: string } | { groupId: string }, draft: Omit<Draft, "groupId">): Promise<Sent> => {
            const result = await sendVia(call, to, draft);
            if ("groupId" in to && result.timestamp !== undefined) posted({ id: to.groupId, name: groups.get(to.groupId)! }, result.timestamp, draft.text, draft.attachments.length);
            if ("recipient" in to && result.status === 200) endTyping(`dm:${to.recipient}`, false);
            return result;
          };

          /** What came of a held post, as an event in the group's stream that comes now. */
          const told = (groupId: string, id: string, result: HeldResult, sent: Sent | undefined) => {
            const name = groups.get(groupId);
            if (name === undefined) return;
            const at = io.now().getTime();
            const timestamp = typeof sent?.body.timestamp === "number" ? sent.body.timestamp : at;
            const words = { sent: "sent, your owner approved it", declined: "declined by your owner, not sent", expired: "your owner did not decide in time, not sent", failed: "approved by your owner but not sent" }[result];
            const event: ConnectionEvent & { payload: SignalPayload } = {
              id: `group.${name}/held/${id}/${result}`,
              occurred_at: new Date(at).toISOString(),
              stream: streamOf(`group.${name}`),
              delivery: "now",
              summary: summaryLine(`Signal ${name} your held post ${id}: ${words}`),
              payload: { type: "held", from: { number: settings.account }, group: { name }, timestamp, held: { id, result, ...(result === "failed" && typeof sent?.body.error === "string" ? { error: sent.body.error } : {}) } },
            };
            chain = chain.then(async () => {
              for (let attempt = 1; !(await io.deliver([event])); attempt++) {
                if (stopped) return io.log("held result events=1 taken=false (stopping)");
                await sleep(backoffMs(attempt));
              }
            });
          };

          const gate = settings.approvals
            ? new Gate({
                account: settings.account,
                owner: settings.senders[0]!,
                ...(settings.judge ? { judge: settings.judge } : {}),
                approvalMs: settings.approvalMs,
                timeZone: settings.timeZone,
                ...(settings.stateFile ? { stateFile: settings.stateFile } : {}),
                groups,
                configured: new Set(settings.groups.keys()),
                call,
                send: (draft) => send({ groupId: draft.groupId }, draft),
                told,
                log: io.log,
                now: () => io.now().getTime(),
              })
            : undefined;
          const sweeping = gate ? setInterval(() => void gate.sweep(), options.sweepMs ?? SWEEP_MS) : undefined;
          sweeping?.unref();

          const sender = settings.sendSocket
            ? sendServer(settings.sendSocket, {
                senders: settings.senders,
                groups,
                log: io.log,
                send: async (to, draft) => {
                  if (!("groupId" in to) || !gate) return send(to, draft);
                  const sent = await gate.post({ ...draft, groupId: to.groupId });
                  if (sent.status !== 200) endTyping(`group:${to.groupId}`, true);
                  return sent;
                },
              })
            : undefined;

          return {
            async stop() {
              stopped = true;
              wake?.();
              clearInterval(sweeping);
              await gate?.idle();
              for (const key of [...typing.keys()]) endTyping(key, false);
              await sender?.close();
              await chain;
              current?.end();
              await running;
            },
          };
        },
      };
    },
  };
}

/**
 * One `send` to signal-cli. A group's send has a result per member; it failed
 * only when no one took it (natsumi ADR F07).
 */
async function sendVia(call: (method: string, params: Raw) => Promise<unknown>, to: { recipient: string } | { groupId: string }, draft: Omit<Draft, "groupId">): Promise<Sent & { timestamp?: number }> {
  try {
    const result = await call("send", {
      ...("groupId" in to ? { groupId: to.groupId } : { recipient: [to.recipient] }),
      ...(draft.text !== undefined ? { message: draft.text } : {}),
      ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
      ...(draft.quote ? { quoteTimestamp: draft.quote.timestamp, quoteAuthor: draft.quote.author } : {}),
    });
    const results = isObject(result) && Array.isArray(result.results) ? (result.results as Raw[]) : [];
    const failed = "recipient" in to ? results.find((item) => item.type !== "SUCCESS") : results.length > 0 && results.every((item) => item.type !== "SUCCESS") ? results[0] : undefined;
    if (failed) return { status: 502, body: { error: `Signal did not take it (${String(failed.type)})` } };
    const timestamp = isObject(result) ? num(result.timestamp) : undefined;
    return { status: 200, body: { timestamp }, ...(timestamp !== undefined ? { timestamp } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    return { status: error instanceof RpcError && message.includes("not connected") ? 503 : 502, body: { error: message } };
  }
}

/**
 * `POST /v1/send` on a Unix socket: the text and files of a form
 * (multipart/form-data or urlencoded) sent to one of the allowed senders or
 * groups. Fields: `text`, `to` (a sender) or `group` (a group's name; with
 * neither, the first sender), `file` (repeated), and `quote_timestamp` with
 * `quote_author` to send it as a quoted reply.
 */
function sendServer(
  path: string,
  options: {
    senders: readonly string[];
    groups: ReadonlyMap<string, string>;
    log: (line: string) => void;
    send: (to: { recipient: string } | { groupId: string }, draft: Omit<Draft, "groupId">) => Promise<Sent>;
  },
) {
  const { senders, groups, log } = options;
  const answer = (response: http.ServerResponse, status: number, body: Raw) => {
    log(`send status=${status}`);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/v1/send") return answer(response, 404, { error: "not found" });
    if (request.method !== "POST") return answer(response, 405, { error: "POST only" });
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of request as AsyncIterable<Buffer>) {
      size += part.length;
      if (size > MAX_SEND_BYTES) return answer(response, 413, { error: `the body is larger than ${MAX_SEND_BYTES} bytes` });
      parts.push(part);
    }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(parts), { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
    } catch {
      return answer(response, 400, { error: "the body is not a form (multipart/form-data or urlencoded)" });
    }
    const raw = form.get("text");
    const text = typeof raw === "string" && raw.trim() !== "" ? raw.trimEnd() : undefined;
    const groupName = form.get("group");
    if (groupName !== null && form.get("to") !== null) return answer(response, 400, { error: "to and group: one or the other" });
    const groupId = typeof groupName === "string" ? [...groups].find(([, name]) => name === groupName)?.[0] : undefined;
    if (groupName !== null && groupId === undefined) return answer(response, 403, { error: "group: not one of the groups this agent may write to" });
    const to = form.get("to") ?? senders[0]!;
    if (groupId === undefined && (typeof to !== "string" || !senders.includes(to))) return answer(response, 403, { error: "to: not one of the senders this agent may write to" });
    const files = form.getAll("file").filter((file): file is File => typeof file !== "string");
    if (text === undefined && files.length === 0) return answer(response, 400, { error: "neither text nor a file" });
    const quoteTimestamp = form.get("quote_timestamp");
    const quoteAuthor = form.get("quote_author");
    if ((quoteTimestamp === null) !== (quoteAuthor === null)) return answer(response, 400, { error: "quote_timestamp and quote_author: both or neither" });
    const quote = quoteTimestamp === null ? undefined : { timestamp: Number(quoteTimestamp), author: quoteAuthor };
    if (quote && (!Number.isSafeInteger(quote.timestamp) || quote.timestamp <= 0 || typeof quote.author !== "string" || !(NUMBER.test(quote.author) || UUID.test(quote.author)))) {
      return answer(response, 400, { error: "quote_timestamp must be a Signal timestamp and quote_author a number in E.164 or a UUID" });
    }
    const attachments = await Promise.all(
      files.map(async (file) => `data:${file.type || "application/octet-stream"};filename=${file.name.replace(/[;,]/g, "_")};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`),
    );
    const draft = { ...(text !== undefined ? { text } : {}), attachments, ...(quote ? { quote: quote as { timestamp: number; author: string } } : {}) };
    const sent = await options.send(groupId !== undefined ? { groupId } : { recipient: to as string }, draft);
    return answer(response, sent.status, sent.body);
  });
  server.on("error", (error: NodeJS.ErrnoException) => log(`cannot serve ${path} (${error.code ?? error.name})`));
  rmSync(path, { force: true });
  server.listen(path, () => chmodSync(path, 0o666));
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export const signal = signalPlugin();
