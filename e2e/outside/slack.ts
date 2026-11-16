// Slack, for the receivers' Slack plugin (e2e/README.md): the Web API at
// slack.com/api/, Socket Mode at wss-primary.slack.com/link/, and a file at
// files.slack.com, where a post's images also go up (Slack's three steps:
// files.getUploadURLExternal, the upload, files.completeUploadExternal).
// The WebSocket is the least of RFC 6455 the plugin needs:
// text frames, ping and pong, close. The test drives it through the control
// API: what to answer conversations.history with, envelopes to send, and a
// disconnect to ask for.
import { createHash } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";

export const SLACK = "slack.com";
export const SLACK_SOCKET = "wss-primary.slack.com";
export const SLACK_FILES = "files.slack.com";

type Raw = Record<string, unknown>;

/** A PNG of one pixel: what the file of the test is. */
export const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export function slack(tokens: { app: string; bot: string }) {
  const sockets: Duplex[] = [];
  const acks: string[] = [];
  const calls: { method: string; token: "app" | "bot" | "other"; args: Raw }[] = [];
  const downloads: { path: string; token: "bot" | "other" }[] = [];
  /** The uploads to the URL files.getUploadURLExternal gave, and the token each carried ("none" is right). */
  const uploads: { path: string; token: "bot" | "none" | "other"; length: number; png: boolean }[] = [];
  const given = new Map<string, string>();
  let posts = 0;
  let history: Raw[] = [];
  let connections = 0;

  const tokenOf = (request: http.IncomingMessage) => {
    const value = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    return value === tokens.app ? "app" : value === tokens.bot ? "bot" : "other";
  };

  function frame(opcode: number, payload: Buffer): Buffer {
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.alloc(4);
    if (payload.length >= 126) {
      header.writeUInt8(0x80 | opcode, 0);
      header.writeUInt8(126, 1);
      header.writeUInt16BE(payload.length, 2);
    }
    return Buffer.concat([header, payload]);
  }

  const send = (socket: Duplex, value: unknown) => socket.write(frame(0x1, Buffer.from(JSON.stringify(value))));

  /** The client's frames: masked, small. */
  function read(socket: Duplex): void {
    let buffer = Buffer.alloc(0);
    socket.on("data", (part: Buffer) => {
      buffer = Buffer.concat([buffer, part]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]!));
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 0x1) acks.push(String((JSON.parse(payload.toString("utf8")) as { envelope_id?: unknown }).envelope_id));
        else if (opcode === 0x9) socket.write(frame(0xa, payload));
        else if (opcode === 0x8) {
          socket.end(frame(0x8, payload.subarray(0, 2)));
          return;
        }
      }
    });
  }

  return {
    async api(request: http.IncomingMessage, body: string, response: http.ServerResponse): Promise<void> {
      const method = (request.url ?? "").split("?")[0]!.replace(/^\/api\//, "");
      const args = Object.fromEntries(new URLSearchParams(body));
      const token = tokenOf(request);
      calls.push({ method, token, args });
      const json = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const wanted = method === "apps.connections.open" ? "app" : "bot";
      if (token !== wanted) return json({ ok: false, error: "invalid_auth" });
      switch (method) {
        case "apps.connections.open":
          return json({ ok: true, url: `wss://${SLACK_SOCKET}/link/?ticket=e2e-ticket&app_id=A0E2E` });
        case "auth.test":
          return json({ ok: true, url: "https://e2e.slack.com/", team: "E2E", user: "penelope", team_id: "T0E2E", user_id: "U0E2E", bot_id: "B0E2E" });
        case "users.conversations":
          return json({ ok: true, channels: [{ id: "C0DEV", name: "dev", is_channel: true, is_member: true }], response_metadata: { next_cursor: "" } });
        case "conversations.info":
          return json({ ok: true, channel: { id: args.channel, name: "dev", is_channel: true } });
        case "conversations.history":
          return json({ ok: true, messages: args.channel === "C0DEV" ? history : [], has_more: false, response_metadata: { next_cursor: "" } });
        case "conversations.replies":
          return json({ ok: true, messages: [], has_more: false });
        case "chat.postMessage": {
          posts++;
          const ts = `1794900000.${String(posts).padStart(6, "0")}`;
          return json({ ok: true, channel: args.channel, ts, message: { type: "message", text: args.text, ts, bot_id: "B0E2E" } });
        }
        case "chat.getPermalink":
          return json({ ok: true, channel: args.channel, permalink: `https://e2e.slack.com/archives/${String(args.channel)}/p${String(args.message_ts).replace(".", "")}` });
        case "files.getUploadURLExternal": {
          const id = `F0UP${given.size + 1}`;
          given.set(`/upload/v1/${id}`, id);
          return json({ ok: true, upload_url: `https://${SLACK_FILES}/upload/v1/${id}`, file_id: id });
        }
        case "files.completeUploadExternal": {
          const files = JSON.parse(String(args.files ?? "[]")) as { id: string; title?: string }[];
          if (!files.every((file) => uploads.some((upload) => upload.path === `/upload/v1/${file.id}`))) return json({ ok: false, error: "file_not_found" });
          return json({ ok: true, files: files.map((file) => ({ id: file.id, title: file.title ?? "" })) });
        }
        case "users.info":
          return json({ ok: true, user: { id: args.user, name: String(args.user).toLowerCase(), profile: { display_name: `E2E ${String(args.user)}` } } });
        default:
          return json({ ok: false, error: "unknown_method" });
      }
    },

    file(request: http.IncomingMessage, body: Buffer, response: http.ServerResponse): void {
      const path = (request.url ?? "").split("?")[0]!;
      if (request.method === "POST" && given.has(path)) {
        const token = request.headers.authorization === undefined ? "none" : tokenOf(request) === "bot" ? "bot" : "other";
        uploads.push({ path, token, length: body.length, png: body.subarray(0, 4).equals(PIXEL.subarray(0, 4)) });
        response.writeHead(200, { "content-type": "text/plain" });
        return void response.end(`OK - ${body.length}`);
      }
      const token = tokenOf(request) === "bot" ? "bot" : "other";
      downloads.push({ path, token });
      if (token !== "bot" || path !== "/files-pri/T0E2E-F0E2E/e2e.png") {
        response.writeHead(302, { location: "https://e2e.slack.com/?redir=signin" });
        return void response.end();
      }
      response.writeHead(200, { "content-type": "image/png", "content-length": PIXEL.length });
      response.end(PIXEL);
    },

    upgrade(request: http.IncomingMessage, socket: Duplex): void {
      const key = request.headers["sec-websocket-key"];
      if (!(request.url ?? "").startsWith("/link/") || typeof key !== "string") {
        socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
      connections++;
      sockets.push(socket);
      socket.on("close", () => sockets.splice(sockets.indexOf(socket), 1));
      socket.on("error", () => undefined);
      read(socket);
      send(socket, { type: "hello", num_connections: 1, debug_info: { host: "applink-e2e", build_number: 1, approximate_connection_time: 18060 }, connection_info: { app_id: "A0E2E" } });
    },

    /** The control API: `POST /slack/history`, `POST /slack/send`, `POST /slack/disconnect`, `GET /slack`. */
    control(method: string, path: string, body: string): { status: number; value: unknown } | undefined {
      if (method === "GET" && path === "/slack") return { status: 200, value: { connections, open: sockets.length, acks, calls, downloads, uploads } };
      if (method === "POST" && path === "/slack/history") {
        history = (JSON.parse(body) as { messages: Raw[] }).messages;
        return { status: 200, value: {} };
      }
      if (method === "POST" && (path === "/slack/send" || path === "/slack/disconnect")) {
        const socket = sockets.at(-1);
        if (!socket) return { status: 409, value: { error: "no connection" } };
        send(socket, path === "/slack/send" ? JSON.parse(body) : { type: "disconnect", reason: "refresh_requested", debug_info: { host: "applink-e2e" } });
        return { status: 200, value: {} };
      }
      return undefined;
    },
  };
}
