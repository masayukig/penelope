// The few Web API calls of the Slack plugin (docs/receivers.md, "Slack のプラグイン"),
// made with fetch: who the bot is, where to open the Socket Mode connection
// (with the app-level token), the conversations and their recent messages,
// people's names, and a file's bytes. Nothing here posts.
//
// A call Slack refuses throws a SlackCallError that names the method and
// Slack's code for why, and nothing asked or answered, so that the log can
// say it whole. A rate limit is waited out as Slack's Retry-After says.

export type Raw = Record<string, unknown>;

/** What the workspace asks of Slack. The tests put a fake here. */
export interface SlackApi {
  /** `auth.test` with the bot token: the bot's user, its bot ID and its workspace. */
  whoAmI(): Promise<{ userId: string; botId?: string; teamId: string }>;
  /** `apps.connections.open` with the app-level token: the WebSocket URL to open. */
  openConnection(): Promise<string>;
  /** `users.conversations`: the channels, private channels, DMs and group DMs the bot is in. */
  conversations(): Promise<Raw[]>;
  /** `conversations.info`. */
  conversation(id: string): Promise<Raw>;
  /** `conversations.history`: the messages after `oldest`, oldest first, through every page. */
  messages(channel: string, oldest: string): Promise<Raw[]>;
  /** `conversations.replies`: a thread's messages after `oldest`, oldest first, through every page. */
  replies(channel: string, ts: string, oldest: string): Promise<Raw[]>;
  /** `users.info`. */
  user(id: string): Promise<Raw>;
  /** A file's bytes with the bot token, or nothing when there are more than `maxBytes`. */
  download(url: string, maxBytes: number): Promise<Uint8Array | undefined>;
}

export class SlackCallError extends Error {
  readonly method: string;
  readonly reason: string;

  constructor(method: string, reason: string) {
    super(`${method}: ${reason}`);
    this.name = "SlackCallError";
    this.method = method;
    this.reason = reason;
  }
}

/** Slack's codes are plain words; anything else is not copied into the log. */
const PLAIN = /^[A-Za-z0-9_.:,-]{1,64}$/;
const plain = (value: unknown): string | undefined => (typeof value === "string" && PLAIN.test(value) ? value : undefined);

/** A failure as the log says it: the call and Slack's code, or the kind of error. Never what was said, nor a key. */
export function describeFailure(error: unknown): string {
  if (error instanceof SlackCallError) return error.message;
  if (!(error instanceof Error)) return "error";
  const code = plain((error as { code?: unknown }).code) ?? plain((error.cause as { code?: unknown } | undefined)?.code);
  return `${plain(error.name) ?? "Error"}${code ? `: ${code}` : ""}`;
}

/** Why a request got no answer: the network's code (`ECONNREFUSED`), or the kind of error (`TimeoutError`). */
function reasonOf(error: unknown): string {
  const code = plain((error as { cause?: { code?: unknown } } | undefined)?.cause?.code) ?? plain((error as { code?: unknown } | undefined)?.code);
  return code ?? (error instanceof Error ? plain(error.name) : undefined) ?? "request_error";
}

export type WebApiOptions = {
  /** Where the Web API is, ending in `/`: `https://slack.com/api/`. */
  apiUrl: string;
  appToken: string;
  botToken: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long one call may take. */
  timeoutMs?: number;
};

/** How many times a rate-limited call is tried in all. */
const TRIES = 4;
const PAGE = 200;

export class WebApi implements SlackApi {
  private readonly options: Required<WebApiOptions>;

  constructor(options: WebApiOptions) {
    this.options = {
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 30_000,
      ...options,
    };
  }

  /** One Web API method, its arguments as a form, with the bot token unless `app` says the app-level one. */
  async call(method: string, args: Record<string, string | number | boolean | undefined>, app = false): Promise<Raw> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value !== undefined) form.set(key, String(value));
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetch(new URL(method, this.options.apiUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${app ? this.options.appToken : this.options.botToken}`, "content-type": "application/x-www-form-urlencoded" },
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        throw new SlackCallError(method, reasonOf(error));
      }
      if (response.status === 429 && attempt < TRIES) {
        await response.arrayBuffer().catch(() => undefined);
        const seconds = Number(response.headers.get("retry-after"));
        await this.options.sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
        continue;
      }
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new SlackCallError(method, response.status === 429 ? "ratelimited" : `http_${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SlackCallError(method, "not_json");
      }
      const answer = (typeof body === "object" && body !== null ? body : {}) as Raw;
      if (answer.ok !== true) throw new SlackCallError(method, plain(answer.error) ?? "unknown");
      return answer;
    }
  }

  /** Every page of a method that pages with a cursor, the items under `field`. */
  private async pages(method: string, field: string, args: Record<string, string | number | boolean | undefined>): Promise<Raw[]> {
    const found: Raw[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call(method, { ...args, limit: PAGE, cursor });
      const items = page[field];
      if (Array.isArray(items)) for (const item of items) if (typeof item === "object" && item !== null) found.push(item as Raw);
      const next = (page.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
      cursor = typeof next === "string" && next !== "" ? next : undefined;
    } while (cursor);
    return found;
  }

  async whoAmI() {
    const answer = await this.call("auth.test", {});
    if (typeof answer.user_id !== "string" || typeof answer.team_id !== "string") throw new SlackCallError("auth.test", "no_user");
    return { userId: answer.user_id, teamId: answer.team_id, ...(typeof answer.bot_id === "string" ? { botId: answer.bot_id } : {}) };
  }

  async openConnection() {
    const answer = await this.call("apps.connections.open", {}, true);
    if (typeof answer.url !== "string") throw new SlackCallError("apps.connections.open", "no_url");
    return answer.url;
  }

  conversations() {
    return this.pages("users.conversations", "channels", { types: "public_channel,private_channel,mpim,im", exclude_archived: true });
  }

  async conversation(id: string) {
    const answer = await this.call("conversations.info", { channel: id });
    return (answer.channel ?? {}) as Raw;
  }

  async messages(channel: string, oldest: string) {
    return oldestFirst(await this.pages("conversations.history", "messages", { channel, oldest }));
  }

  async replies(channel: string, ts: string, oldest: string) {
    return oldestFirst(await this.pages("conversations.replies", "messages", { channel, ts, oldest }));
  }

  async user(id: string) {
    const answer = await this.call("users.info", { user: id });
    return (answer.user ?? {}) as Raw;
  }

  async download(url: string, maxBytes: number) {
    let response: Response;
    try {
      response = await this.options.fetch(url, { headers: { authorization: `Bearer ${this.options.botToken}` }, signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      throw new SlackCallError("files.download", reasonOf(error));
    }
    if (!response.ok || !response.body) {
      await response.arrayBuffer().catch(() => undefined);
      throw new SlackCallError("files.download", `http_${response.status}`);
    }
    // Slack answers a missing files:read with its sign-in page rather than an error.
    if ((response.headers.get("content-type") ?? "").startsWith("text/html")) {
      await response.body.cancel();
      throw new SlackCallError("files.download", "answered_with_a_page");
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      parts.push(value);
    }
    return new Uint8Array(Buffer.concat(parts));
  }
}

function oldestFirst(messages: Raw[]): Raw[] {
  return messages.sort((a, b) => Number(a.ts) - Number(b.ts));
}
