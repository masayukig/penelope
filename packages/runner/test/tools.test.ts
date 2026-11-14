import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { Backend } from "../src/backend.ts";
import { backendTools } from "../src/tools.ts";
import { FakeBackend, TOKEN } from "./fake-backend.ts";

let fake: FakeBackend;
let tools: Map<string, ToolDefinition>;

// Each test has a backend of its own, so that what one sent is not seen by the next.
beforeEach(async () => {
  fake = new FakeBackend();
  const backend = new Backend({ url: await fake.url, token: TOKEN, agent: "main" });
  tools = new Map(backendTools(backend).map((tool) => [tool.name, tool]));
});
afterEach(() => fake.close());

async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  assert.ok(tool, `no tool ${name}`);
  const result = await tool.execute("c-1", params as never, undefined, undefined, {} as never);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("the tools", () => {
  assert.deepEqual([...tools.keys()].sort(), ["reply", "schedule_add", "schedule_list", "schedule_remove", "self_event"]);
  for (const tool of tools.values()) assert.ok(tool.description.length > 0);
});

test("reply sends the text, the expression and the event it answers", async () => {
  assert.match(await call("reply", { text: "done", expression: "smile", in_reply_to: 13 }), /r-1/);
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [{ agent: "main", text: "done", expression: "smile", in_reply_to: 13 }]);
});

test("schedules are added, listed and removed", async () => {
  const added = JSON.parse(await call("schedule_add", { reason: "look at CI", at: "2026-11-15T09:00:00Z" }));
  assert.deepEqual(added, { id: "s-1", agent: "main", reason: "look at CI", at: "2026-11-15T09:00:00Z" });
  assert.deepEqual(JSON.parse(await call("schedule_list", {})), [added]);
  await call("schedule_remove", { id: "s-1" });
  assert.deepEqual(JSON.parse(await call("schedule_list", {})), []);
});

test("a schedule takes a cron expression or a time, not both", async () => {
  await assert.rejects(call("schedule_add", { reason: "x" }), /cron or at/);
  await assert.rejects(call("schedule_add", { reason: "x", cron: "0 9 * * *", at: "2026-11-15T09:00:00Z" }), /cron or at/);
});

test("self_event sends the event to herself", async () => {
  await call("self_event", { id: "e-1", summary: "the build is done", payload: { ok: true } });
  await call("self_event", { id: "e-2", summary: "no payload" });
  assert.deepEqual(fake.sent("POST", "/v1/self-events"), [
    { agent: "main", id: "e-1", summary: "the build is done", payload: { ok: true } },
    { agent: "main", id: "e-2", summary: "no payload", payload: null },
  ]);
});

test("a failure of the backend is the tool's error", async () => {
  await assert.rejects(call("schedule_remove", { id: "missing" }), /404/);
});
