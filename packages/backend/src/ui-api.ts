// The backend's API for the Web UI (docs/ui-api.md) and the owner's login
// (ADR-0010). It listens on TCP, reached from outside the Pod; a request from
// the sandbox over the loopback is checked the same way (ADR-0014).
import { randomUUID } from "node:crypto";
import type http from "node:http";

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentResponse, PostMessageResponse } from "@penelope/contract";

import { isA2APath } from "./a2a/endpoint.ts";
import { type AgentSettings, ICON_TYPES } from "./config.ts";

import type { Conversation } from "./conversation.ts";
import type { Feed } from "./feed.ts";
import { type Handler, HttpError, isMultipart, readForm, readJson, sendEmpty, sendError, sendJson } from "./http.ts";
import { CALLBACK_PATH, type GitHubLogin } from "./login/github.ts";
import type { LoginSessions, Session } from "./login/sessions.ts";
import type { Queue } from "./queue.ts";
import type { Attachment } from "./sources.ts";
import { iso } from "./time.ts";
import { AGENT_ICONS_PATH } from "./web.ts";

export const SESSION_COOKIE = "penelope_session";
/** A message with its files: 64 MiB in all by default. */
export const DEFAULT_UI_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const SUMMARY_LENGTH = 200;

export type UiOptions = {
  queue: Queue;
  conversation: Conversation;
  feed: Feed;
  login: GitHubLogin;
  sessions: LoginSessions;
  /** The owner's GitHub user ID. Without one, no one gets in. */
  ownerId: number | undefined;
  /** Where the owner reaches the backend. Cookies are Secure when it is https. */
  publicUrl: string | undefined;
  /** The agent's name and icon, read without a login. */
  agent: AgentSettings;
  now: () => number;
  maxBytes?: number;
  /** The Web UI's files, served for everything else. Until it is built, nothing is. */
  web?: Handler;
  /** The A2A way in, under /a2a/, which checks its senders itself. Without it, /a2a/ is not found. */
  a2a?: Handler;
};

export function uiHandler(options: UiOptions): Handler {
  const { queue, conversation, feed, login, sessions, ownerId, agent, now } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_UI_BYTES;
  const secure = options.publicUrl?.startsWith("https:") ?? false;
  const web = options.web ?? notBuilt;
  const cookie = (value: string, expiresMs: number) => sessionCookie(value, expiresMs, now(), secure);

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://ui");
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === "GET /auth/github/start") {
      const start = login.start();
      if (start.kind === "refused") sendError(response, start.status, start.code);
      else sendEmpty(response, 302, { location: start.location, "cache-control": "no-store" });
      return;
    }
    if (route === `GET ${CALLBACK_PATH}`) {
      const finish = await login.callback(url.searchParams);
      if (finish.kind === "refused") sendError(response, finish.status, finish.code);
      else {
        sendEmpty(response, 302, {
          location: "/",
          "set-cookie": cookie(finish.session.token, finish.session.expiresMs),
          "cache-control": "no-store",
        });
      }
      return;
    }
    if (route === "POST /auth/logout") {
      const token = cookieValue(request);
      if (token !== undefined) sessions.revoke(token);
      sendEmpty(response, 204, { "set-cookie": cookie("", 0) });
      return;
    }

    if (isA2APath(url.pathname)) {
      if (options.a2a === undefined) throw new HttpError(404, "no A2A way in here");
      await options.a2a(request, response);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await web(request, response);
      return;
    }

    // Read without a login: the login screen and the home screen show who
    // she is. Nothing else is here (docs/ui-api.md).
    if (route === "GET /api/agent") {
      const icons = Object.fromEntries(Object.keys(agent.icons).map((expression) => [expression, `${AGENT_ICONS_PATH}${encodeURIComponent(expression)}`]));
      sendJson(response, 200, { name: agent.name, ...(Object.keys(icons).length === 0 ? {} : { icons }) } satisfies AgentResponse);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith(AGENT_ICONS_PATH)) {
      let expression = "";
      try {
        expression = decodeURIComponent(url.pathname.slice(AGENT_ICONS_PATH.length));
      } catch {
        // Not a name of any face: answered as one that is not there.
      }
      const file = Object.hasOwn(agent.icons, expression) ? agent.icons[expression] : undefined;
      if (file === undefined) throw new HttpError(404, "no such face");
      let body: Buffer;
      try {
        body = await readFile(file);
      } catch {
        throw new HttpError(404, "the face cannot be read");
      }
      response.writeHead(200, {
        "content-type": ICON_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-cache",
      });
      response.end(body);
      return;
    }

    const token = cookieValue(request);
    const session: Session | undefined = token === undefined ? undefined : sessions.use(token, ownerId);
    if (!session) throw new HttpError(401, "not signed in");
    // Each use moves the session's end on; the cookie follows it.
    response.setHeader("set-cookie", cookie(session.token, session.expiresMs));

    switch (route) {
      case "POST /api/messages": {
        const { text, attachments } = isMultipart(request)
          ? await messageFromForm(await readForm(request, maxBytes))
          : messageFromJson(await readJson(request, maxBytes));
        if (text === "" && attachments.length === 0) throw new HttpError(400, "a message needs text or files");
        const id = randomUUID();
        queue.accept(
          { source: "ui", id, occurred_at: iso(now()), summary: summaryOf(text, attachments.length), payload: { text } },
          { builtin: true, attachments },
        );
        conversation.ownerMessage({ id, text });
        sendJson(response, 202, { id } satisfies PostMessageResponse);
        return;
      }
      case "GET /api/history": {
        const before = url.searchParams.get("before") ?? undefined;
        let page;
        try {
          page = conversation.page(before);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(response, 200, page);
        return;
      }
      case "GET /api/stream":
        stream(feed, request, response);
        return;
    }
    throw new HttpError(404, "no such path");
  };
}

/** Server-sent events until the browser goes away, a comment now and then to keep the line open. */
function stream(feed: Feed, request: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": stream\n\n");
  const lastEventId = request.headers["last-event-id"];
  const stop = feed.subscribe(typeof lastEventId === "string" ? lastEventId : undefined, (id, event) => {
    response.write(`id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
  response.once("close", () => {
    clearInterval(heartbeat);
    stop();
  });
}

function messageFromJson(body: unknown): { text: string; attachments: Attachment[] } {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new HttpError(400, "text must be a string");
  return { text, attachments: [] };
}

async function messageFromForm(form: FormData): Promise<{ text: string; attachments: Attachment[] }> {
  const text = form.get("text") ?? "";
  if (typeof text !== "string") throw new HttpError(400, "text must be a field, not a file");
  const attachments: Attachment[] = [];
  for (const file of form.getAll("file")) {
    if (typeof file === "string") throw new HttpError(400, "a file part must be a file");
    attachments.push({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return { text, attachments };
}

/** The first line of the text, cut short; or how many files came when there is no text. */
function summaryOf(text: string, files: number): string {
  const first = text.split("\n", 1)[0]!.trim();
  if (first !== "") return first.length > SUMMARY_LENGTH ? `${first.slice(0, SUMMARY_LENGTH)}…` : first;
  return files === 1 ? "1 file" : `${files} files`;
}

function cookieValue(request: http.IncomingMessage): string | undefined {
  const values = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

/** The Set-Cookie line of the session: ends at `expiresMs`, or is cleared when that is 0. */
function sessionCookie(value: string, expiresMs: number, now: number, secure: boolean): string {
  const maxAge = expiresMs === 0 ? 0 : Math.max(0, Math.round((expiresMs - now) / 1000));
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Expires=${new Date(expiresMs).toUTCString()}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ].join("; ");
}

/** Where the Web UI's files will be served from (P6b). */
const notBuilt: Handler = async (_request, response) => {
  sendError(response, 404, "the Web UI is not built yet");
};
