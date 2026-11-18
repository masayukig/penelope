// slackctl: reads the Slack plugin's lines of /sources and draws a
// channel or a thread as it stands now (ADR-0013, ADR-0029), and posts to
// Slack as the agent (ADR-0033). It is in the sandbox's image; the turn is
// given only what changed, and this is how the agent reads further back.
import { readFile } from "node:fs/promises";
import process from "node:process";

import { readPayload } from "./payload.ts";
import { CLI, DEFAULT_SOURCE, describeChannel, drawChannel, drawThread } from "./draw.ts";
import { DEFAULT_SOURCES, daysOf, readDays, SEGMENT, streamsOf } from "./sources.ts";
import { facesOf, Failure, type Online, post, TS, WORKSPACE } from "./post.ts";

export type { Online } from "./post.ts";
export type Result = { code: number; stdout: string; stderr: string };

const USAGE = `usage: ${CLI} [--sources DIR] [--source NAME] [--time-zone TZ] COMMAND

Reads the Slack lines of /sources and draws them as they stand now.

commands:
  workspaces                      the workspaces seen, with how many channels each
  channels                        the streams, with the channel each is and its latest day
  history STREAM [--limit N] [--days N]
                                  the latest N messages of a stream (default 30),
                                  from its latest N days of files (default 7)
  thread STREAM TS                a thread: the message TS and every reply to it
  post --channel CHANNEL [--workspace NAME] [--thread TS] [--face FACE] [--image FILE]...
                                  posts the text of stdin, then the images, to a
                                  channel (its ID, or its name among those the bot
                                  is in) or a thread of it, as the bot; prints
                                  "message CHANNEL TS PERMALINK" and "file ID NAME"
  faces                           the faces --face takes, with the URL Slack is given

The bot token is SLACK_BOT_TOKEN, or SLACK_BOT_TOKEN_<NAME> with --workspace
(upper case, - as _). The faces are the avatar's at PENELOPE_PUBLIC_URL; Slack
is given PENELOPE_SLACK_ICON_BASE_URL/FACE.png for them when that is set.

options:
  --sources DIR    where /sources is (default ${DEFAULT_SOURCES})
  --source NAME    the Slack plugin's source (default ${DEFAULT_SOURCE})
  --time-zone TZ   the time zone times are shown in (default the TZ variable, or UTC)
`;

const usage = (why?: string): Result => ({ code: 2, stdout: "", stderr: `${why ? `${CLI}: ${why}\n` : ""}${USAGE}` });

type Parsed = { sources: string; source: string; timeZone: string; rest: string[]; flags: Map<string, string[]> };

/** The options of each command; --image may be given again. */
const FLAGS: Record<string, readonly string[]> = {
  history: ["--limit", "--days"],
  post: ["--channel", "--workspace", "--thread", "--face", "--image"],
};
const REPEATED = new Set(["--image"]);

function parse(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Parsed | string {
  const parsed: Parsed = { sources: DEFAULT_SOURCES, source: DEFAULT_SOURCE, timeZone: env.TZ || "UTC", rest: [], flags: new Map() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      parsed.rest.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) return `${arg} needs a value`;
    index++;
    if (arg === "--sources") parsed.sources = value;
    else if (arg === "--source") parsed.source = value;
    else if (arg === "--time-zone") parsed.timeZone = value;
    else if (Object.values(FLAGS).some((flags) => flags.includes(arg))) {
      if (parsed.flags.has(arg) && !REPEATED.has(arg)) return `${arg} is given twice`;
      parsed.flags.set(arg, [...(parsed.flags.get(arg) ?? []), value]);
    } else return `unknown option ${arg}`;
  }
  const command = parsed.rest[0];
  const unasked = [...parsed.flags.keys()].find((flag) => !(FLAGS[command ?? ""] ?? []).includes(flag));
  if (unasked !== undefined) return `${command ?? "no command"} takes no ${unasked}`;
  if (!SEGMENT.test(parsed.source)) return `${parsed.source} is not a source`;
  try {
    new Intl.DateTimeFormat("en", { timeZone: parsed.timeZone });
  } catch {
    return `${parsed.timeZone} is not a time zone`;
  }
  return parsed;
}

function count(flags: Map<string, string[]>, name: string, otherwise: number): number | string {
  const value = flags.get(name)?.[0];
  if (value === undefined) return otherwise;
  return /^[1-9]\d*$/.test(value) ? Number(value) : `${name} must be a positive integer`;
}

const ONLINE: Online = {
  fetch: (...args) => fetch(...args),
  stdin: async () => {
    if (process.stdin.isTTY) return "";
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(part as Buffer);
    return Buffer.concat(parts).toString("utf8");
  },
  readFile: (file) => readFile(file),
};

/** The commands that talk to Slack or to the backend. */
async function online(command: string, operands: readonly string[], flags: Map<string, string[]>, env: Readonly<Record<string, string | undefined>>, io: Online): Promise<Result> {
  let stdout = "";
  try {
    if (command === "faces") {
      if (operands.length > 0) return usage("faces takes no more arguments");
      for (const [face, url] of await facesOf(env, io)) stdout += `${face}\t${url}\n`;
      return { code: 0, stdout, stderr: "" };
    }
    const one = (name: string) => flags.get(name)?.[0];
    const channel = one("--channel");
    const workspace = one("--workspace");
    const thread = one("--thread");
    if (operands.length > 0) return usage("post takes its text from stdin, not as arguments");
    if (channel === undefined || channel.replace(/^#/, "") === "") return usage("post needs --channel");
    if (workspace !== undefined && !WORKSPACE.test(workspace)) return usage(`${workspace} is not a workspace's name`);
    if (thread !== undefined && !TS.test(thread)) return usage("--thread takes the ts of the thread's message");
    const images = flags.get("--image") ?? [];
    const text = (await io.stdin()).replace(/\s+$/, "");
    if (text === "" && images.length === 0) return usage("nothing to post: no text on stdin and no --image");
    await post({ channel, workspace, thread, face: one("--face"), images }, text, env, io, (line) => (stdout += line));
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return { code: 1, stdout, stderr: `${CLI}: ${error.message}\n` };
  }
}

export async function run(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Online = ONLINE): Promise<Result> {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, stdout: USAGE, stderr: "" };
  const parsed = parse(args, env);
  if (typeof parsed === "string") return usage(parsed);
  const { sources: root, source, timeZone, rest, flags } = parsed;
  const [command, ...operands] = rest;
  const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: "" });

  switch (command) {
    case "post":
    case "faces":
      return online(command, operands, flags, env, io);
    case "workspaces":
    case "channels": {
      if (operands.length > 0 || flags.size > 0) return usage(`${command} takes no more arguments`);
      const streams = streamsOf(root, source).flatMap((stream) => {
        const days = daysOf(root, source, stream);
        const last = days.at(-1);
        if (last === undefined) return [];
        const payload = readDays(root, source, stream, [last])
          .map((line) => readPayload(line.payload))
          .findLast((item) => item !== undefined);
        return payload ? [{ stream, last, workspace: payload.workspace, channel: payload.channel }] : [];
      });
      if (command === "channels") return ok(streams.map(({ stream, last, workspace, channel }) => `${stream}\t${describeChannel(workspace, channel)}\tlast ${last}\n`).join(""));
      const workspaces = new Map<string, number>();
      for (const { workspace } of streams) workspaces.set(workspace, (workspaces.get(workspace) ?? 0) + 1);
      return ok(
        [...workspaces]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([workspace, channels]) => `${workspace}\t${channels} ${channels === 1 ? "channel" : "channels"}\n`)
          .join(""),
      );
    }
    case "history":
    case "thread": {
      const [stream, ts] = operands;
      if (stream === undefined || !SEGMENT.test(stream)) return usage(`${command} needs a stream (see ${CLI} channels)`);
      const days = daysOf(root, source, stream);
      if (days.length === 0) return { code: 1, stdout: "", stderr: `${CLI}: no stream ${stream} under ${root}/${source}\n` };
      if (command === "history") {
        if (operands.length !== 1) return usage("history takes one stream");
        const limit = count(flags, "--limit", 30);
        const back = count(flags, "--days", 7);
        if (typeof limit === "string") return usage(limit);
        if (typeof back === "string") return usage(back);
        return ok(drawChannel(readDays(root, source, stream, days.slice(-back)), { limit, timeZone }));
      }
      if (ts === undefined || operands.length !== 2 || !TS.test(ts)) return usage("thread takes a stream and the ts of the thread's message");
      // The thread's files start on the day of its message, which may be a day earlier in the backend's time zone.
      const from = new Date(Number(ts) * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const drawn = drawThread(readDays(root, source, stream, days.filter((day) => day >= from)), ts, { timeZone });
      if (drawn === undefined) return { code: 1, stdout: "", stderr: `${CLI}: no thread ${ts} in ${stream}\n` };
      return ok(drawn);
    }
    case undefined:
      return usage();
    default:
      return usage(`unknown command ${command}`);
  }
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
