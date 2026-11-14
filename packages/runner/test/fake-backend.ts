// A stand-in for the backend's API for the sandbox (docs/sandbox-api.md), on a
// loopback port. It keeps what it was sent so that the tests can look at it,
// and hands events over the way the backend does: in seq order, unacked ones
// again after a restart.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { DeliveredEvent, Schedule } from "@penelope/contract";

export const TOKEN = "real-token-example";

export interface Received {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export class FakeBackend {
  readonly received: Received[] = [];
  readonly url: Promise<string>;
  /** Seqs whose ack is dropped, as if the runner had stopped before it reached the backend. */
  readonly dropAcks = new Set<number>();
  private readonly events: DeliveredEvent[] = [];
  private readonly acked = new Set<number>();
  private readonly schedules: Schedule[] = [];
  private waiters: (() => void)[] = [];
  private replies = 0;
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.url = new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
      });
    });
  }

  /** Queue an event; the next poll hands it over. */
  push(event: DeliveredEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.seq - b.seq);
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** What was sent to one path, in order. */
  sent(method: string, path: string): unknown[] {
    return this.received.filter((r) => r.method === method && r.path === path).map((r) => r.body);
  }

  /** The order of the requests that change something, as `METHOD path`. */
  order(): string[] {
    return this.received.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  }

  async close(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private available(after: number): DeliveredEvent[] {
    return this.events.filter((event) => event.seq > after && !this.acked.has(event.seq));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://backend");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const received: Received = {
      method: request.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization,
    };
    this.received.push(received);
    const answer = (status: number, value?: unknown) => {
      if (value === undefined) {
        response.writeHead(status).end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (received.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: "unauthorized" });

    const key = `${received.method} ${received.path}`;
    if (key === "GET /v1/events") {
      const after = Number(received.query.after ?? "0");
      const wait = Math.min(Number(received.query.wait ?? "0"), 2);
      if (this.available(after).length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          this.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return answer(200, { events: this.available(after) });
    }
    if (key === "POST /v1/events/ack") {
      for (const seq of (body as { seqs: number[] }).seqs) if (!this.dropAcks.has(seq)) this.acked.add(seq);
      return answer(204);
    }
    if (key === "POST /v1/replies") return answer(200, { id: `r-${++this.replies}` });
    if (key === "POST /v1/schedules") {
      const { agent, reason, cron, at } = body as Schedule;
      const schedule = { id: `s-${this.schedules.length + 1}`, agent, reason, ...(cron ? { cron } : { at }) } as Schedule;
      this.schedules.push(schedule);
      return answer(201, schedule);
    }
    if (key === "GET /v1/schedules") return answer(200, { schedules: this.schedules });
    if (received.method === "DELETE" && received.path.startsWith("/v1/schedules/")) {
      const id = decodeURIComponent(received.path.slice("/v1/schedules/".length));
      const index = this.schedules.findIndex((s) => s.id === id);
      if (index < 0) return answer(404, { error: "no such schedule" });
      this.schedules.splice(index, 1);
      return answer(204);
    }
    if (
      key === "POST /v1/activity" ||
      key === "POST /v1/turns/end" ||
      key === "POST /v1/self-events" ||
      key === "POST /v1/sessions/rotated"
    ) {
      return answer(204);
    }
    return answer(404, { error: "not found" });
  }
}

/** Wait until `check` holds, or fail after `ms`. */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
