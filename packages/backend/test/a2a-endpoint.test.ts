import assert from "node:assert/strict";
import type http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";

import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { Client, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

import { a2aHandler } from "../src/a2a/endpoint.ts";
import { Inbox } from "../src/a2a/inbox.ts";
import { Senders, type SenderCheck, type Verdict } from "../src/a2a/senders.ts";
import { openDatabase } from "../src/db.ts";
import { close, listenTcp } from "../src/http.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { ask, FakeClock, tempDir } from "./support.ts";

const MINUTE = 60_000;

/** A check that stands in for TokenReview and gated: `Bearer sa-<namespace>-<name>` is that ServiceAccount. */
const fakeCheck = (down = false): SenderCheck => ({
  name: "fake",
  precedence: 0,
  carries: (headers: http.IncomingHttpHeaders) => headers.authorization !== undefined,
  check: async (headers: http.IncomingHttpHeaders): Promise<Verdict> => {
    if (down) return { kind: "unavailable", reason: "down" };
    const match = /^Bearer sa-([a-z]+)-([a-z]+)$/.exec(headers.authorization ?? "");
    return match ? { kind: "subject", subject: `system:serviceaccount:${match[1]}:${match[2]}` } : { kind: "refused", reason: "bad" };
  },
});

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, { down = false } = {}) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T10:00:00Z");
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
    batch: { quietMs: 5 * MINUTE, maxMs: 30 * MINUTE },
    awake: new AwakeHours("07:00-23:00", "UTC"),
    redeliverMs: 5 * MINUTE,
  });
  const inbox = new Inbox(db, queue, { now: clock.now, limits: { deadlineMs: 24 * 60 * MINUTE, maxOpenTasks: 3 } });
  let base = "";
  const server = await listenTcp(
    async (request, response) => {
      await a2aHandler({
        inbox,
        checks: [fakeCheck(down)],
        senders: new Senders(["agents/claude", "agents/natsumi"]),
        card: { name: "Penelope", description: "The cluster's operator.", url: `${base}/a2a/` },
      })(request, response);
    },
    "127.0.0.1",
    0,
    () => undefined,
  );
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await close(server);
    db.close();
  });
  return { port, base, inbox, queue, clock };
}

/** A sender as the agents that call her are: the SDK's client, with its token on every call. */
async function sender(base: string, token = "sa-agents-claude"): Promise<Client> {
  const authorized: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const card = await new DefaultAgentCardResolver({ fetchImpl: fetch }).resolve(`${base}/a2a/.well-known/agent-card.json`, "");
  const url = card.supportedInterfaces[0]!.url;
  return new Client(await new JsonRpcTransportFactory({ fetchImpl: authorized }).create(url, card), card);
}

function text(value: string, more: Partial<Message> = {}): Message {
  return {
    messageId: `m-${Math.random()}`,
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...more,
  };
}

async function send(client: Client, message: Message): Promise<Task> {
  const result = await client.sendMessage({ tenant: "", message, metadata: undefined, configuration: undefined });
  assert.ok("status" in result, "a task, not a message");
  return result as Task;
}

const textOf = (parts: { content?: { $case: string; value?: unknown } }[] | undefined) =>
  (parts ?? []).map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");

const jsonRpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("the A2A way in", () => {
  it("serves the Agent Card without a token, naming her and where to call", async (t) => {
    // Guards against: a sender unable to find her, or the card asking for a login it cannot have.
    const { base, port } = await setup(t);
    const answer = await ask({ port }, "/a2a/.well-known/agent-card.json");
    assert.equal(answer.status, 200);
    const card = answer.json();
    assert.equal(card.name, "Penelope");
    assert.equal(card.description, "The cluster's operator.");
    assert.equal(card.supportedInterfaces[0].url, `${base}/a2a/`);
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.equal(card.capabilities.streaming ?? false, false);
    assert.equal(card.capabilities.pushNotifications ?? false, false);
  });

  it("takes a request as a working task, and hands back her answer when it is done", async (t) => {
    // Guards against: a sender's request lost, or her answer not where the senders' clients read it (the artifact).
    const { base, inbox, queue } = await setup(t);
    const client = await sender(base);
    const task = await send(client, text("Look at the alerts."));
    assert.equal(task.status?.state, TaskState.TASK_STATE_WORKING);

    inbox.reply({ in_reply_to: queueSeq(queue), state: "completed", text: "Two alerts, both resolved." });

    const done = await client.getTask({ tenant: "", id: task.id, historyLength: undefined });
    assert.equal(done.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(textOf(done.artifacts[0]?.parts), "Two alerts, both resolved.");
    assert.deepEqual(
      done.history.map((m) => [m.role, textOf(m.parts)]),
      [
        [Role.ROLE_USER, "Look at the alerts."],
        [Role.ROLE_AGENT, "Two alerts, both resolved."],
      ],
    );
  });

  it("shows her question while she asks, and takes the sender's answer into the same task", async (t) => {
    // Guards against: her question not reaching the sender, or its answer refused or put into a new task.
    const { base, inbox, queue } = await setup(t);
    const client = await sender(base);
    const task = await send(client, text("Restart it?"));
    inbox.reply({ in_reply_to: queueSeq(queue), state: "input-required", text: "Which one?" });

    const asking = await client.getTask({ tenant: "", id: task.id, historyLength: undefined });
    assert.equal(asking.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(textOf(asking.status?.message?.parts), "Which one?");

    const answered = await send(client, text("The backend.", { taskId: task.id, contextId: task.contextId }));
    assert.equal(answered.id, task.id);
    assert.equal(answered.status?.state, TaskState.TASK_STATE_WORKING);
  });

  it("refuses with one 401 a caller that is not a sender, whatever was wrong", async (t) => {
    // Guards against: a stranger's request taken, or the answer telling which part of the check failed.
    const { port } = await setup(t);
    for (const authorization of [undefined, "Bearer nonsense", "Bearer sa-default-stranger"]) {
      const answer = await ask({ port }, "/a2a/", {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: jsonRpc("SendMessage"),
      });
      assert.equal(answer.status, 401, String(authorization));
      assert.deepEqual(answer.json(), { error: "unauthorized" });
    }
  });

  it("takes nothing while the check cannot be made, and says to try again", async (t) => {
    // Guards against: a request taken because the API server or gated's keys were out of reach (ADR-0010).
    const { port } = await setup(t, { down: true });
    const answer = await ask({ port }, "/a2a/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sa-agents-claude" },
      body: jsonRpc("SendMessage"),
    });
    assert.equal(answer.status, 503);
  });

  it("refuses a message with anything but text, and a streaming call", async (t) => {
    // Guards against: a file put where she reads without being judged, or a call left hanging on a stream.
    const { base, port, queue } = await setup(t);
    const client = await sender(base);
    const file = text("see this");
    file.parts.push({ content: { $case: "url", value: "https://example.com/x" }, metadata: undefined, filename: "x", mediaType: "text/plain" });
    await assert.rejects(send(client, file));
    assert.equal(queue.take({ after: 0 }).length, 0);

    const stream = await ask({ port }, "/a2a/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sa-agents-claude" },
      body: jsonRpc("SendStreamingMessage", { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "hi" }] } }),
    });
    assert.equal(stream.status, 200);
    assert.ok(stream.json().error, "a JSON-RPC error, not a stream");
  });

  it("does not let a sender read another's task", async (t) => {
    // Guards against: one agent reading what another asked her, or her answer to it.
    const { base } = await setup(t);
    const task = await send(await sender(base), text("mine"));
    const other = await sender(base, "sa-agents-natsumi");
    await assert.rejects(other.getTask({ tenant: "", id: task.id, historyLength: undefined }), { name: "TaskNotFoundError" });
    await assert.rejects(send(other, text("into yours", { taskId: task.id })), { name: "TaskNotFoundError" });
  });

  it("refuses a body over its limit", async (t) => {
    // Guards against: a sender making the backend read without end.
    const { port } = await setup(t);
    const answer = await ask({ port }, "/a2a/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sa-agents-claude" },
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    assert.equal(answer.status, 413);
  });
});

/** The seq of the newest event the queue holds. */
function queueSeq(queue: Queue): number {
  const events = queue.take({ after: 0 });
  assert.ok(events.length > 0, "an event in the queue");
  return events.at(-1)!.seq;
}
