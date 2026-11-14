import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Unauthorized, Unreachable } from "../src/model/api.ts";
import { Outbox } from "../src/model/outbox.ts";
import type { Action } from "../src/model/store.ts";
import { openStream } from "../src/model/stream.ts";

/** A body the test writes to, as the backend's stream would. */
function body() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    stream,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the stream's connection", () => {
  // Asking for everything kept (Last-Event-ID: 0) on every connection is how
  // the UI learns the state and the turn under way (docs/ui-api.md).
  it("asks for everything the backend kept, each time it connects, and comes back after the line drops", async () => {
    const bodies = [body(), body()];
    const asked: Array<string | null> = [];
    const log: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get("last-event-id"));
      return new Response(bodies[asked.length - 1]!.stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const stream = openStream({
      fetch,
      sleep: async () => {},
      onOpen: () => log.push("open"),
      onDown: () => log.push("down"),
      onEvent: (event) => log.push(event.event),
      onUnauthorized: () => log.push("401"),
    });
    await tick();
    bodies[0]!.write('id: 1\nevent: state\ndata: {"agent":"main","state":"thinking"}\n\n');
    await tick();
    bodies[0]!.end();
    await tick();
    await tick();
    bodies[1]!.write('id: 1\nevent: state\ndata: {"agent":"main","state":"waiting"}\n\n');
    await tick();
    stream.close();
    assert.deepEqual(asked, ["0", "0"]);
    assert.deepEqual(log, ["open", "state", "down", "open", "state"]);
  });

  it("stops and says so when the session is gone", async () => {
    const log: string[] = [];
    let calls = 0;
    openStream({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "not signed in" }), { status: 401 });
      },
      sleep: async () => {},
      onOpen: () => log.push("open"),
      onDown: () => log.push("down"),
      onEvent: () => {},
      onUnauthorized: () => log.push("401"),
    });
    await tick();
    await tick();
    assert.deepEqual(log, ["401"]);
    assert.equal(calls, 1);
  });

  it("tries again while the backend cannot be reached", async () => {
    const log: string[] = [];
    let calls = 0;
    const later = body();
    const stream = openStream({
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("network down");
        return new Response(later.stream, { status: 200 });
      },
      sleep: async () => {},
      onOpen: () => log.push("open"),
      onDown: () => log.push("down"),
      onEvent: () => {},
      onUnauthorized: () => log.push("401"),
    });
    for (let i = 0; i < 6; i++) await tick();
    stream.close();
    assert.deepEqual(log, ["down", "down", "open"]);
  });
});

describe("the messages waiting to be sent", () => {
  function setup(send: (text: string, files: File[]) => Promise<{ id: string }>) {
    const actions: Action[] = [];
    const outbox = new Outbox({ send, dispatch: (action) => actions.push(action), now: () => Date.parse("2026-11-14T09:00:00Z") });
    const kinds = () => actions.map((action) => action.type);
    return { outbox, actions, kinds };
  }

  // The notice says what is written is sent once the line is back.
  it("holds what is written while offline and sends it, in order, once the stream is back", async () => {
    const sent: string[] = [];
    const { outbox, kinds } = setup(async (text) => {
      sent.push(text);
      return { id: `m-${sent.length}` };
    });
    outbox.offline();
    outbox.submit({ text: "one", files: [], duringTurn: false });
    outbox.submit({ text: "two", files: [], duringTurn: false });
    await tick();
    assert.deepEqual(sent, []);
    assert.deepEqual(kinds(), ["queued", "queued"]);
    outbox.online();
    for (let i = 0; i < 4; i++) await tick();
    assert.deepEqual(sent, ["one", "two"]);
    assert.deepEqual(kinds().slice(2), ["sending", "sent", "sending", "sent"]);
  });

  it("keeps a message it could not deliver and sends it when the line is back", async () => {
    let up = false;
    const sent: string[] = [];
    const { outbox, actions } = setup(async (text) => {
      if (!up) throw new Unreachable("down");
      sent.push(text);
      return { id: "m-1" };
    });
    outbox.online();
    outbox.submit({ text: "hello", files: [], duringTurn: false });
    for (let i = 0; i < 4; i++) await tick();
    assert.deepEqual(sent, []);
    assert.equal(actions.at(-1)?.type, "queued-again");
    up = true;
    outbox.online();
    for (let i = 0; i < 4; i++) await tick();
    assert.deepEqual(sent, ["hello"]);
    assert.equal(actions.at(-1)?.type, "sent");
  });

  it("says the session is gone instead of holding the message forever", async () => {
    const { outbox, actions } = setup(async () => {
      throw new Unauthorized();
    });
    outbox.online();
    outbox.submit({ text: "hello", files: [], duringTurn: false });
    for (let i = 0; i < 4; i++) await tick();
    assert.ok(actions.some((action) => action.type === "unauthorized"));
  });

  it("marks a message the backend refused as failed", async () => {
    const { outbox, actions } = setup(async () => {
      throw new Error("400");
    });
    outbox.online();
    outbox.submit({ text: "hello", files: [], duringTurn: false });
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(actions.at(-1)?.type, "failed");
  });
});
