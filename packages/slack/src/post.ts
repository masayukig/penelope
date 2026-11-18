// slackctl post and faces: a message to Slack as the agent, with a face of
// her avatar as its icon and images beside it (docs/receivers.md, "投稿の
// CLI"). It sends the bot token's stand-in the sandbox holds, and the
// Sentinel puts the real one in its place; the upload's own URL is given
// no token, for that URL is the leave to upload.
import path from "node:path";

/** What the commands that talk to the outside are given: the tests give their own. */
export type Online = {
  fetch: typeof fetch;
  /** All of stdin, as text. */
  stdin: () => Promise<string>;
  readFile: (file: string) => Promise<Uint8Array>;
};

export type Post = {
  channel: string;
  workspace: string | undefined;
  thread: string | undefined;
  face: string | undefined;
  images: readonly string[];
};

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;

const API = "https://slack.com/api/";
/** Slack's channel, private channel and DM IDs. */
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
/** As the receivers' Slack plugin names a workspace (docs/receivers.md, "設定"). */
export const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TS = /^\d+\.\d+$/;

/** Something that stops the command, said on stderr with exit code 1. */
export class Failure extends Error {}

/** The variable that holds a workspace's bot token: SLACK_BOT_TOKEN, or SLACK_BOT_TOKEN_<NAME> for a named one. */
export function tokenVariable(workspace: string | undefined): string {
  return workspace === undefined ? "SLACK_BOT_TOKEN" : `SLACK_BOT_TOKEN_${workspace.toUpperCase().replaceAll("-", "_")}`;
}

function publicUrl(env: Env): string {
  const value = env.PENELOPE_PUBLIC_URL;
  if (!value) throw new Failure("PENELOPE_PUBLIC_URL is not set: it is where Slack fetches the faces from");
  return value;
}

/**
 * Each face of the avatar, with the URL of its image the backend gives
 * without a login: its PNG when it has one, as Slack may not take the Web
 * UI's WebP (docs/ui-api.md, "エージェント"). With
 * PENELOPE_SLACK_ICON_BASE_URL, for a backend Slack cannot reach, the URL is
 * <base>/<face>.png there instead.
 */
export async function facesOf(env: Env, online: Online): Promise<Map<string, string>> {
  const base = publicUrl(env);
  const iconBase = env.PENELOPE_SLACK_ICON_BASE_URL?.replace(/\/+$/, "");
  const url = new URL("/api/agent", base).href;
  let agent: { icons?: unknown; png_icons?: unknown };
  try {
    const response = await online.fetch(url);
    if (!response.ok) throw new Failure(`cannot read the faces from ${url} (${response.status})`);
    agent = (await response.json()) as typeof agent;
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(`cannot read the faces from ${url} (${error instanceof Error ? error.message : String(error)})`);
  }
  const ways = (field: unknown) => (typeof field === "object" && field !== null ? (field as Raw) : {});
  const icons = { ...ways(agent.icons), ...ways(agent.png_icons) };
  const faces = new Map<string, string>();
  for (const name of Object.keys(icons).sort()) {
    const way = icons[name];
    if (typeof way === "string") faces.set(name, iconBase ? `${iconBase}/${encodeURIComponent(name)}.png` : new URL(way, base).href);
  }
  if (faces.size === 0) throw new Failure(`the avatar has no faces (${url})`);
  return faces;
}

/** One call of Slack's Web API, its arguments as a form. */
async function call(online: Online, token: string, method: string, form: Record<string, string>): Promise<Raw> {
  let body: Raw;
  try {
    const response = await online.fetch(`${API}${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) throw new Failure(`${method}: HTTP ${response.status}`);
    body = (await response.json()) as Raw;
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(`${method}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (body.ok !== true) throw new Failure(`${method}: ${typeof body.error === "string" ? body.error : "not ok"}`);
  return body;
}

/** A channel's ID: as it is given, or found by its name among the channels the bot is in. */
async function channelId(online: Online, token: string, channel: string): Promise<string> {
  if (CHANNEL_ID.test(channel)) return channel;
  const name = channel.replace(/^#/, "");
  let cursor = "";
  do {
    const page = await call(online, token, "users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor === "" ? {} : { cursor }),
    });
    const found = (Array.isArray(page.channels) ? (page.channels as Raw[]) : []).find((item) => item.name === name);
    if (typeof found?.id === "string") return found.id;
    const meta = page.response_metadata as Raw | undefined;
    cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
  } while (cursor !== "");
  throw new Failure(`no channel ${name} among the channels the bot is in`);
}

/**
 * Posts the text, then the images, to the channel or the thread. What was
 * posted is written to `out` as it goes, so that a failure half way still
 * says what is in Slack.
 */
export async function post(options: Post, text: string, env: Env, online: Online, out: (line: string) => void): Promise<void> {
  const variable = tokenVariable(options.workspace);
  const token = env[variable];
  if (!token) throw new Failure(`${variable} is not set: it holds the bot token of ${options.workspace === undefined ? "the workspace" : `the workspace ${options.workspace}`}`);

  const images: { name: string; body: Uint8Array }[] = [];
  for (const image of options.images) {
    try {
      images.push({ name: path.basename(image), body: await online.readFile(image) });
    } catch (error) {
      throw new Failure(`cannot read ${image} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  let icon: string | undefined;
  if (options.face !== undefined) {
    const faces = await facesOf(env, online);
    icon = faces.get(options.face);
    if (icon === undefined) throw new Failure(`no face ${options.face} (faces: ${[...faces.keys()].join(", ")})`);
  }
  const channel = await channelId(online, token, options.channel);
  const thread: Record<string, string> = options.thread === undefined ? {} : { thread_ts: options.thread };

  if (text !== "") {
    const posted = await call(online, token, "chat.postMessage", { channel, text, ...thread, ...(icon === undefined ? {} : { icon_url: icon }) });
    const ts = String(posted.ts);
    const where = String(posted.channel ?? channel);
    let permalink = "";
    try {
      const link = await call(online, token, "chat.getPermalink", { channel: where, message_ts: ts });
      if (typeof link.permalink === "string") permalink = `\t${link.permalink}`;
    } catch {
      // The message is posted; only its link is not known.
    }
    out(`message\t${where}\t${ts}${permalink}\n`);
  }

  if (images.length === 0) return;
  const uploaded: { id: string; title: string }[] = [];
  for (const { name, body } of images) {
    const place = await call(online, token, "files.getUploadURLExternal", { filename: name, length: String(body.length) });
    const url = String(place.upload_url);
    let status: number;
    try {
      const response = await online.fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(body) });
      await response.arrayBuffer();
      status = response.status;
    } catch (error) {
      throw new Failure(`cannot upload ${name} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (status < 200 || status > 299) throw new Failure(`cannot upload ${name} (${status})`);
    uploaded.push({ id: String(place.file_id), title: name });
  }
  const shared = await call(online, token, "files.completeUploadExternal", {
    files: JSON.stringify(uploaded),
    channel_id: channel,
    ...thread,
    ...(icon === undefined ? {} : { icon_url: icon }),
  });
  const files = Array.isArray(shared.files) ? (shared.files as Raw[]) : uploaded;
  for (const file of files) out(`file\t${String(file.id)}\t${String(file.title)}\n`);
}
