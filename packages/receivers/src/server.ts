// The receivers' one HTTP server (docs/receivers.md, "HTTP の口"): /healthz,
// and each webhook activation under /v1/webhooks/<name>. It is called from
// outside the Pod, so every webhook request goes through its plugin's check of
// the sender. The sender is told of success only once the intake took every
// event the request made (ADR-0023).
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Event } from "@penelope/contract";

import type { Activation, Config } from "./config.ts";
import { type IntakeAnswer, sendEvent } from "./intake.ts";

/** The body of one webhook request: 1 MiB at most. */
export const MAX_BODY_BYTES = 1024 * 1024;

const WEBHOOK = /^\/v1\/webhooks\/([^/]+)$/;

export type Receivers = { port: number; close: () => Promise<void> };

export type Options = {
  log?: (line: string) => void;
  send?: (socketPath: string, event: Event, timeoutMs: number) => Promise<IntakeAnswer>;
  now?: () => Date;
};

export async function startReceivers(config: Config, options: Options = {}): Promise<Receivers> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const send = options.send ?? sendEvent;
  const now = options.now ?? (() => new Date());
  const byName = new Map(config.activations.map((activation) => [activation.name, activation]));
  let closing = false;

  const server = http.createServer((request, response) => {
    // Once closing, every answer closes its connection, so that close() is not held by a kept-alive one.
    if (closing) response.setHeader("connection", "close");
    handle(request, response).catch((error: unknown) => {
      log(`receivers: ${request.method} ${pathOf(request)}: ${error instanceof Error ? error.stack : String(error)}`);
      if (!response.headersSent) answer(response, 500);
      else response.destroy();
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = pathOf(request);
    if (path === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") return answer(response, 405, { allow: "GET, HEAD" });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "ok");
      return;
    }
    const activation = byName.get(WEBHOOK.exec(path)?.[1] ?? "");
    if (!activation) {
      log(line("-", 404));
      return answer(response, 404);
    }
    if (request.method !== "POST") {
      log(line(activation.name, 405));
      return answer(response, 405, { allow: "POST" });
    }
    const body = await readBody(request);
    if (body === undefined) {
      log(line(activation.name, 413));
      answer(response, 413, { connection: "close" });
      response.on("finish", () => request.destroy());
      return;
    }
    const status = await take(activation, { headers: request.headers, body, receivedAt: now() });
    answer(response, status);
  }

  /** What the plugin makes of the request, sent to the intake one event at a time. */
  async function take(activation: Activation, webhook: Parameters<Activation["handle"]>[0]): Promise<number> {
    const outcome = activation.handle(webhook);
    if (outcome.kind === "refuse") {
      log(line(activation.name, outcome.status, 0, 0, outcome.status === 400 ? outcome.reason : undefined));
      return outcome.status;
    }
    for (const note of outcome.notes) log(`receivers: webhook=${activation.name} ${note}`);
    let sent = 0;
    for (const made of outcome.events) {
      const event: Event = { source: activation.source, ...made };
      const answered = await send(config.intake, event, config.intakeTimeoutMs);
      if (!answered.taken) {
        log(`receivers: webhook=${activation.name} intake did not take ${event.source}/${event.id}: ${answered.why}`);
        log(line(activation.name, 503, sent, outcome.dropped));
        return 503;
      }
      sent++;
    }
    log(line(activation.name, 200, sent, outcome.dropped));
    return 200;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        closing = true;
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

/** The line written for each request: never the body nor a key. */
function line(name: string, status: number, events = 0, dropped = 0, reason?: string): string {
  return `receivers: webhook=${name} status=${status} events=${events} dropped=${dropped}${reason ? ` reason=${JSON.stringify(reason)}` : ""}`;
}

function pathOf(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://receivers").pathname;
  } catch {
    return "";
  }
}

function answer(response: http.ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-length": 0, ...headers });
  response.end();
}

/** The body, or undefined when it is over the limit. */
async function readBody(request: http.IncomingMessage): Promise<Uint8Array | undefined> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return undefined;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_BODY_BYTES) return undefined;
    parts.push(part);
  }
  return Buffer.concat(parts);
}
