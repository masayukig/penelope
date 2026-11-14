import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { StreamEvent } from "@penelope/contract";

import { Inbox } from "../src/a2a/inbox.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { close, listenUnix } from "../src/http.ts";
import { Memory } from "../src/memory.ts";
import { Queue } from "../src/queue.ts";
import { sandboxHandler } from "../src/sandbox-api.ts";
import { Schedules } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { ask, type Ask, tempDir } from "./support.ts";

const TOKEN = "the-real-token";

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, token: string | undefined = TOKEN) {
  const dir = tempDir(t);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: Date.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { self: "now" },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const streamed: StreamEvent[] = [];
  feed.subscribe(undefined, (_id, event) => streamed.push(event));
  const conversation = new Conversation(db, feed, { now: Date.now });
  const memoryDir = path.join(dir, "memory");
  mkdirSync(memoryDir);
  const memory = new Memory(memoryDir, { name: "penelope-backend", email: "backend@penelope.invalid" });
  const schedules = new Schedules(db, { now: Date.now, timeZone: "UTC" });
  const inbox = new Inbox(db, queue, { now: Date.now, limits: { deadlineMs: 86_400_000, maxOpenTasks: 3 } });
  const socketPath = path.join(dir, "sandbox.sock");
  const server = await listenUnix(
    sandboxHandler({ token, queue, conversation, schedules, memory, inbox, now: Date.now, log: () => {} }),
    socketPath,
  );
  t.after(async () => {
    await close(server);
    db.close();
  });
  const call = (pathname: string, options: Ask = {}) =>
    ask({ socketPath }, pathname, { ...options, headers: { authorization: `Bearer ${TOKEN}`, ...options.headers } });
  return { queue, conversation, streamed, memoryDir, call, socketPath, inbox };
}

const self = (id: string) => ({ agent: "main", id, summary: `note ${id}`, payload: { id } });

describe("the sandbox's API", () => {
  describe("authentication", () => {
    it("refuses a request without the real token", async (t) => {
      const { call } = await setup(t);
      for (const authorization of ["", "Bearer surrogate", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
        const answer = await call("/v1/events?agent=main&wait=0", { headers: { authorization } });
        assert.equal(answer.status, 401, authorization);
        assert.equal(typeof answer.json().error, "string");
      }
    });

    it("refuses everyone when no token is set", async (t) => {
      const { call } = await setup(t, "");
      assert.equal((await call("/v1/events?agent=main&wait=0")).status, 401);
    });
  });

  describe("taking events", () => {
    it("hands over what is due, inline ones with their payload", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      const answer = await call("/v1/events?agent=main&wait=0");
      assert.equal(answer.status, 200);
      const { events } = answer.json();
      assert.equal(events.length, 1);
      assert.equal(events[0].source, "self");
      assert.equal(events[0].summary, "note s-1");
      assert.equal(events[0].delivery, "now");
      assert.equal(events[0].inline, false);
      assert.deepEqual(events[0].appended.lines, [1, 1]);
    });

    it("answers an empty list when nothing came within the wait", async (t) => {
      const { call } = await setup(t);
      const started = Date.now();
      const answer = await call("/v1/events?agent=main&after=0&wait=1");
      assert.deepEqual(answer.json(), { events: [] });
      assert.ok(Date.now() - started >= 900);
    });

    it("answers as soon as an event comes in during the wait", async (t) => {
      const { call, queue } = await setup(t);
      const started = Date.now();
      const polled = call("/v1/events?agent=main&wait=30");
      setTimeout(() => {
        queue.accept(
          { source: "ui", id: "m-1", occurred_at: new Date().toISOString(), summary: "hi", payload: { text: "hi" } },
          { builtin: true },
        );
      }, 200);
      const { events } = (await polled).json();
      assert.equal(events[0].inline, true);
      assert.deepEqual(events[0].payload, { text: "hi" });
      assert.ok(Date.now() - started < 5000);
    });

    it("does not hand an acked event over again", async (t) => {
      const { call } = await setup(t);
      await call("/v1/self-events", { json: self("s-1") });
      const [first] = (await call("/v1/events?agent=main&wait=0")).json().events;
      const ack = await call("/v1/events/ack", { json: { agent: "main", seqs: [first.seq] } });
      assert.equal(ack.status, 204);
      assert.deepEqual((await call("/v1/events?agent=main&after=0&wait=0")).json(), { events: [] });
    });

    it("refuses a poll without the agent or with a bad after or wait", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/events?wait=0")).status, 400);
      assert.equal((await call("/v1/events?agent=main&after=x&wait=0")).status, 400);
      assert.equal((await call("/v1/events?agent=main&wait=-1")).status, 400);
    });

    it("refuses a poll from an agent other than main, for now", async (t) => {
      const { call } = await setup(t);
      const answer = await call("/v1/events?agent=child&wait=0");
      assert.equal(answer.status, 400);
      assert.equal(typeof answer.json().error, "string");
    });

    it("refuses an ack whose seqs are not integers", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/events/ack", { json: { agent: "main", seqs: ["1"] } })).status, 400);
      assert.equal((await call("/v1/events/ack", { json: { seqs: [1] } })).status, 400);
    });
  });

  describe("events to herself", () => {
    it("are queued once per id", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      assert.equal((await call("/v1/events?agent=main&wait=0")).json().events.length, 1);
    });

    it("are refused without an id", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: { agent: "main", summary: "x", payload: 1 } })).status, 400);
    });
  });

  describe("replies", () => {
    it("are kept in the history and sent down the stream", async (t) => {
      const { call, conversation, streamed } = await setup(t);
      const answer = await call("/v1/replies", { json: { agent: "main", text: "done", in_reply_to: 3 } });
      assert.equal(answer.status, 201);
      const { id } = answer.json();
      assert.equal(conversation.page().entries[0]?.id, id);
      assert.equal(streamed[0]?.event, "reply");
    });

    it("are refused without text", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/replies", { json: { agent: "main" } })).status, 400);
      assert.equal((await call("/v1/replies", { json: { agent: "main", text: "x", in_reply_to: "3" } })).status, 400);
    });
  });

  describe("activity", () => {
    const at = "2026-11-14T09:00:00Z";
    it("is sent down the stream", async (t) => {
      const { call, streamed } = await setup(t);
      const activities = [
        { kind: "turn_start", at, turn_id: "t-1" },
        { kind: "thinking", at, turn_id: "t-1", text: "hm" },
        { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
        { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\n" },
        { kind: "message", at, turn_id: "t-1", text: "done" },
        { kind: "turn_end", at, turn_id: "t-1" },
      ];
      const answer = await call("/v1/activity", { json: { agent: "main", activities } });
      assert.equal(answer.status, 204);
      assert.deepEqual(
        streamed.filter((e) => e.event === "activity").map((e) => e.event === "activity" && e.data.activity),
        activities,
      );
    });

    it("is refused when a block is not one of the kinds", async (t) => {
      const { call } = await setup(t);
      for (const activity of [
        { kind: "token", at, turn_id: "t-1", text: "a" },
        { kind: "thinking", at, turn_id: "t-1" },
        { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", arguments: {} },
        { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: "no", output: "" },
        { kind: "turn_start", at: "now", turn_id: "t-1" },
        { kind: "turn_start", at },
      ]) {
        const answer = await call("/v1/activity", { json: { agent: "main", activities: [activity] } });
        assert.equal(answer.status, 400, JSON.stringify(activity));
      }
    });

    it("keeps none of a request with one block of the wrong shape", async (t) => {
      // Guards against: part of a refused request in the record and the stream (docs/sandbox-api.md).
      const { call, streamed } = await setup(t);
      const activities = [
        { kind: "turn_start", at, turn_id: "t-1" },
        { kind: "thinking", at, turn_id: "t-1" },
      ];
      assert.equal((await call("/v1/activity", { json: { agent: "main", activities } })).status, 400);
      assert.deepEqual(streamed, []);
    });
  });

  describe("the end of a turn", () => {
    it("commits /memory", async (t) => {
      const { call, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "always.md"), "# always\n");
      const answer = await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9" } });
      assert.equal(answer.status, 204);
      const log = execFileSync("git", ["-c", `safe.directory=${memoryDir}`, "log", "--format=%s"], { cwd: memoryDir, encoding: "utf8" });
      assert.equal(log, "Turn t-9\n");
    });

    it("answers 500 when the commit fails, and commits what is left at the next end", async (t) => {
      // Guards against: a turn's end taken as committed when /memory was not (docs/backend.md).
      const { call, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "always.md"), "# always\n");
      writeFileSync(path.join(memoryDir, ".git"), "not a repository\n");
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-1" } })).status, 500);
      rmSync(path.join(memoryDir, ".git"));
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-2" } })).status, 204);
      const files = execFileSync("git", ["-c", `safe.directory=${memoryDir}`, "ls-files"], { cwd: memoryDir, encoding: "utf8" });
      assert.equal(files, "always.md\n");
    });

    it("sets the agent waiting", async (t) => {
      const { call, streamed } = await setup(t);
      await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9" } });
      assert.deepEqual(streamed, [{ event: "state", data: { agent: "main", state: "waiting" } }]);
    });
  });

  describe("schedules", () => {
    it("are made, listed and deleted", async (t) => {
      const { call } = await setup(t);
      const made = await call("/v1/schedules", { json: { agent: "main", reason: "every morning", cron: "0 9 * * *" } });
      assert.equal(made.status, 201);
      const schedule = made.json();
      assert.deepEqual(schedule, { id: schedule.id, agent: "main", reason: "every morning", cron: "0 9 * * *" });
      assert.deepEqual((await call("/v1/schedules?agent=main")).json(), { schedules: [schedule] });
      assert.equal((await call(`/v1/schedules/${schedule.id}`, { method: "DELETE" })).status, 204);
      assert.equal((await call(`/v1/schedules/${schedule.id}`, { method: "DELETE" })).status, 404);
      assert.deepEqual((await call("/v1/schedules?agent=main")).json(), { schedules: [] });
    });

    it("are refused with both a cron expression and a time, or neither, or a bad one", async (t) => {
      const { call } = await setup(t);
      const at = "2026-11-15T09:00:00Z";
      for (const body of [
        { agent: "main", reason: "x", cron: "0 9 * * *", at },
        { agent: "main", reason: "x" },
        { agent: "main", reason: "x", cron: "nonsense" },
        { agent: "main", reason: "x", at: "tomorrow" },
        { agent: "main", cron: "0 9 * * *" },
      ]) {
        assert.equal((await call("/v1/schedules", { json: body })).status, 400, JSON.stringify(body));
      }
    });
  });

  describe("the switch of the session", () => {
    it("is noted", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main" } })).status, 204);
    });
  });

  it("answers 413 to a body over the 16 MiB of the spec, and keeps none of it", async (t) => {
    // Guards against: a sandbox that can make the backend read and keep a body of any size.
    const { call, conversation } = await setup(t);
    const answer = await call("/v1/replies", { json: { agent: "main", text: "x".repeat(16 * 1024 * 1024) } });
    assert.equal(answer.status, 413);
    assert.deepEqual(conversation.page().entries, []);
  });

  it("answers 404 to a path it does not have", async (t) => {
    const { call } = await setup(t);
    assert.equal((await call("/v1/nothing")).status, 404);
    assert.equal((await call("/v1/replies")).status, 405);
  });

  describe("A2A replies", () => {
    it("answers in the task of the a2a event it names, and says what became of the task", async (t) => {
      // Guards against: her answer to another agent not reaching its task.
      const { call, inbox, queue } = await setup(t);
      const task = inbox.receive("claude", { text: "Restart it?", messageId: "m-1" });
      const [event] = queue.take({ after: 0 });
      const asked = await call("/v1/a2a/replies", { method: "POST", json: { agent: "main", in_reply_to: event!.seq, state: "input-required", text: "Which one?" } });
      assert.equal(asked.status, 200);
      assert.deepEqual(asked.json(), { task_id: task.taskId, state: "input-required" });
      assert.equal(inbox.task("claude", task.taskId)!.messages.at(-1)!.text, "Which one?");
    });

    it("refuses a reply to an event that is no A2A task's, to a closed task, and a question without text", async (t) => {
      // Guards against: a reply that goes nowhere taken as sent, so that she believes the agent has it.
      const { call, inbox, queue } = await setup(t);
      inbox.receive("claude", { text: "hello", messageId: "m-1" });
      const [event] = queue.take({ after: 0 });
      const reply = (body: Record<string, unknown>) => call("/v1/a2a/replies", { method: "POST", json: { agent: "main", ...body } });
      assert.equal((await reply({ in_reply_to: 9999, state: "completed" })).status, 404);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "input-required" })).status, 400);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "failed" })).status, 400);
      assert.equal((await reply({ state: "completed" })).status, 400);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "completed" })).status, 200);
      const again = await reply({ in_reply_to: event!.seq, state: "completed", text: "more" });
      assert.equal(again.status, 409);
      assert.match(again.json().error, /completed/);
    });
  });
});
