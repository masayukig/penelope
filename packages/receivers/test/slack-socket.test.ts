// The Socket Mode connection of the Slack plugin, against a WebSocket server
// on loopback that speaks as Slack's documents show
// (https://docs.slack.dev/apis/events-api/using-socket-mode). Every value is made up.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";

import { type WebSocket, WebSocketServer } from "ws";

import { socketMode } from "../src/plugins/slack/socket.ts";

type Raw = Record<string, unknown>;

const HELLO = { type: "hello", num_connections: 1, debug_info: { host: "applink-example", build_number: 1, approximate_connection_time: 18060 }, connection_info: { app_id: "A0APP" } };

function envelope(id: string): Raw {
  return {
    envelope_id: id,
    type: "events_api",
    accepts_response_payload: false,
    retry_attempt: 0,
    retry_reason: "",
    payload: { team_id: "T0WORK", api_app_id: "A0APP", type: "event_callback", event_id: `Ev${id}`, event_time: 1794819600, event: { type: "message", text: "made up" } },
  };
}

/** A Socket Mode server: it greets each connection unless told not to, and keeps what comes back. */
class FakeSlack {
  readonly server: WebSocketServer;
  readonly sockets: WebSocket[] = [];
  readonly listening: Promise<void>;
  readonly acks: string[] = [];
  greet = true;

  constructor(options: { autoPong?: boolean } = {}) {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: options.autoPong ?? true });
    this.listening = new Promise((resolve) => this.server.once("listening", () => resolve()));
    this.server.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => this.acks.push((JSON.parse(data.toString()) as { envelope_id: string }).envelope_id));
      if (this.greet) socket.send(JSON.stringify(HELLO));
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/link/?ticket=made-up`;
  }

  last(): WebSocket {
    return this.sockets.at(-1)!;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const until = async (what: string, check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(slack: FakeSlack, overrides: Partial<Parameters<typeof socketMode>[0]> = {}) {
  await slack.listening;
  const state = { opens: 0, hellos: 0, handled: [] as Raw[], lines: [] as string[], answer: true };
  const running = socketMode({
    open: async () => {
      state.opens++;
      return slack.url;
    },
    handle: async (received) => {
      state.handled.push(received);
      return state.answer;
    },
    hello: () => state.hellos++,
    log: (line) => state.lines.push(line),
    backoffMs: () => 10,
    ...overrides,
  });
  cleanups.push(() => running.stop());
  return { state, running };
}

test("an envelope is acknowledged with its envelope_id once it is handled, and not when it is not taken", async () => {
  const slack = new FakeSlack();
  cleanups.push(() => slack.close());
  const { state } = await start(slack);
  await until("hello", () => state.hellos === 1);
  assert.ok(state.lines.includes("connected"));
  slack.last().send(JSON.stringify(envelope("e1")));
  await until("the ack", () => slack.acks.length === 1);
  assert.deepEqual(slack.acks, ["e1"]);
  assert.equal(state.handled[0]!.envelope_id, "e1");

  state.answer = false;
  slack.last().send(JSON.stringify(envelope("e2")));
  await until("the second envelope", () => state.handled.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(slack.acks, ["e1"]);
});

test("envelopes are handled one at a time, in the order they came", async () => {
  const slack = new FakeSlack();
  cleanups.push(() => slack.close());
  const order: string[] = [];
  const { state } = await start(slack, {
    handle: async (received) => {
      const id = received.envelope_id as string;
      order.push(`start ${id}`);
      await new Promise((resolve) => setTimeout(resolve, id === "e1" ? 40 : 1));
      order.push(`end ${id}`);
      return true;
    },
  });
  await until("hello", () => state.hellos === 1);
  slack.last().send(JSON.stringify(envelope("e1")));
  slack.last().send(JSON.stringify(envelope("e2")));
  await until("both acks", () => slack.acks.length === 2);
  assert.deepEqual(order, ["start e1", "end e1", "start e2", "end e2"]);
});

test("a disconnect Slack asks for is followed by a new connection at once", async () => {
  const slack = new FakeSlack();
  cleanups.push(() => slack.close());
  const { state } = await start(slack, { backoffMs: () => 60_000 });
  await until("hello", () => state.hellos === 1);
  slack.last().send(JSON.stringify({ type: "disconnect", reason: "refresh_requested", debug_info: { host: "applink-example" } }));
  await until("the second hello", () => state.hellos === 2);
  assert.equal(state.opens, 2);
  assert.ok(state.lines.some((line) => line.includes("refresh_requested")));
});

test("a connection lost before hello, or a URL that cannot be had, is tried again after a wait", async () => {
  const slack = new FakeSlack();
  cleanups.push(() => slack.close());
  slack.greet = false;
  let fail = true;
  const waits: number[] = [];
  const { state } = await start(slack, {
    open: async () => {
      if (fail) {
        fail = false;
        throw new Error("made-up failure");
      }
      return slack.url;
    },
    backoffMs: (attempt) => {
      waits.push(attempt);
      return 10;
    },
  });
  await until("a connection", () => slack.sockets.length === 1);
  slack.greet = true;
  slack.last().terminate();
  await until("hello", () => state.hellos === 1);
  assert.deepEqual(waits, [1, 2], state.lines.join(" / "));
  assert.ok(state.lines.some((line) => line.startsWith("cannot connect")));
});

test("a connection that does not answer a ping is closed and opened again", async () => {
  const slack = new FakeSlack({ autoPong: false });
  cleanups.push(() => slack.close());
  const { state } = await start(slack, { pingMs: 30 });
  await until("the second connection", () => state.hellos >= 2);
  assert.ok(state.lines.some((line) => line.includes("no answer to a ping")));
});

test("stop closes the connection, waits for the envelope in hand, and opens no other", async () => {
  const slack = new FakeSlack();
  cleanups.push(() => slack.close());
  let finished = false;
  const { state, running } = await start(slack, {
    handle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = true;
      return true;
    },
  });
  await until("hello", () => state.hellos === 1);
  slack.last().send(JSON.stringify(envelope("e1")));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await running.stop();
  assert.equal(finished, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.opens, 1);
});
