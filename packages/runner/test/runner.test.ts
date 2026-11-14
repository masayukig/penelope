import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Activity, ActivityRequest, DeliveredEvent } from "@penelope/contract";

import { Backend } from "../src/backend.ts";
import type { Config } from "../src/config.ts";
import { Runner } from "../src/runner.ts";
import { FakeBackend, TOKEN, until } from "./fake-backend.ts";
import { type Call, fakeRuntime, MODEL, PROVIDER, type Script } from "./fake-model.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

interface World {
  fake: FakeBackend;
  config: Config;
  calls: Call[];
  /** Start a runner over the same places; stop it with the function it returns. */
  start(script: Script): Promise<() => Promise<void>>;
}

async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "runner-"));
  const home = join(root, "home");
  const memoryDir = join(root, "memory");
  await mkdir(home, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const fake = new FakeBackend();
  closers.push(() => fake.close());
  const config: Config = {
    agent: "main",
    backend: { url: await fake.url, token: TOKEN },
    identity: { name: "Example", role: "an operator", owner: "Owner" },
    model: { provider: PROVIDER, id: MODEL },
    home,
    memoryDir,
    sourcesDir: join(root, "sources"),
    agentDir: join(home, ".pi", "agent"),
    sessionDir: join(home, ".pi", "agent", "sessions", "main"),
    promptFileMaxBytes: 65536,
    imageMaxBytes: 1_000_000,
    pollWaitSeconds: 1,
  };
  const calls: Call[] = [];
  return {
    fake,
    config,
    calls,
    async start(script) {
      const modelRuntime = await fakeRuntime(root, (call) => {
        calls.push(call);
        return script(call);
      });
      const controller = new AbortController();
      const runner = new Runner({
        config,
        backend: new Backend({ url: config.backend.url, token: TOKEN, agent: "main" }),
        modelRuntime,
        settings: () => SettingsManager.inMemory({ retry: { enabled: false } }),
        log: () => {},
      });
      const running = runner.run(controller.signal);
      const stop = async () => {
        controller.abort();
        await running;
      };
      closers.push(stop);
      return stop;
    },
  };
}

function ui(seq: number, text: string, delivery: "now" | "batch" = "now"): DeliveredEvent {
  return {
    seq,
    source: "ui",
    id: `m-${seq}`,
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: text,
    delivery,
    inline: true,
    payload: { text },
    appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

function slack(seq: number, delivery: "now" | "batch"): DeliveredEvent {
  return {
    seq,
    source: "slack",
    id: `s-${seq}`,
    stream: "ops",
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: `slack message ${seq}`,
    delivery,
    inline: false,
    appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

function nightly(seq: number): DeliveredEvent {
  return {
    seq,
    source: "control",
    id: `nightly-${seq}`,
    occurred_at: "2026-11-14T23:00:00Z",
    received_at: "2026-11-14T23:00:00Z",
    summary: "nightly",
    delivery: "now",
    inline: true,
    payload: { kind: "nightly" },
    appended: { path: "/sources/control/2026-11-14.jsonl", lines: [1, 1] },
  };
}

function activities(fake: FakeBackend): Activity[] {
  return (fake.sent("POST", "/v1/activity") as ActivityRequest[]).flatMap((request) => request.activities);
}

const acked = (fake: FakeBackend) => (fake.sent("POST", "/v1/events/ack") as { seqs: number[] }[]).flatMap((a) => a.seqs);

/** Answers the owner with a reply, then stops. */
const replying: Script = (call) =>
  call.lastRole === "user" ? { thinking: "they said hello", calls: [{ tool: "reply", args: { text: "hi", in_reply_to: 1 } }] } : { text: "replied" };

test("an event becomes a turn; the reply, the activities, the turn's end and the ack follow", async () => {
  const { fake, start, calls } = await world();
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));

  assert.match(calls[0]!.userTexts.at(-1)!, /\[seq 1\] ui[^\n]*\nhello/);
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [{ agent: "main", text: "hi", in_reply_to: 1 }]);

  const sent = activities(fake);
  const turnId = sent[0]!.turn_id;
  assert.deepEqual(
    sent.map((a) => a.kind),
    ["turn_start", "thinking", "tool_call", "tool_result", "message", "turn_end"],
  );
  assert.ok(sent.every((a) => a.turn_id === turnId));
  assert.deepEqual(fake.sent("POST", "/v1/turns/end"), [{ agent: "main", turn_id: turnId }]);

  const order = fake.order().filter((r) => r !== "POST /v1/activity" && r !== "POST /v1/replies");
  assert.deepEqual(order, ["POST /v1/turns/end", "POST /v1/events/ack"]);
});

test("the system prompt is hers, with her memory after it", async () => {
  const { fake, start, calls, config } = await world();
  await writeFile(join(config.memoryDir, "always.md"), "毎朝 CI を見る。");
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.match(calls[0]!.systemPrompt, /You are Example, an operator\./);
  assert.ok(calls[0]!.systemPrompt.includes("毎朝 CI を見る。"));
});

test("after a restart the session goes on, and unacked events come again", async () => {
  const { fake, start, calls } = await world();
  const stop = await start(replying);
  fake.push(ui(1, "first"));
  await until(() => acked(fake).includes(1));
  await stop();

  fake.dropAcks.add(2);
  const stopAgain = await start(replying);
  fake.push(ui(2, "second"));
  await until(() => acked(fake).includes(2));
  await stopAgain();
  assert.ok(calls.at(-1)!.userTexts.some((text) => text.includes("first")));

  // The ack of 2 was lost: the next runner gets it again and makes one turn of it.
  const turnsOfSecond = () => calls.filter((c) => c.lastRole === "user" && c.lastText.includes("second")).length;
  assert.equal(turnsOfSecond(), 1);
  fake.dropAcks.clear();
  await start(replying);
  await until(() => acked(fake).filter((seq) => seq === 2).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(turnsOfSecond(), 2);
});

test("an event that comes during a turn steers it; the turn acks both", async () => {
  const { fake, start, calls } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && call.userTexts.length === 1) {
      return { calls: [{ tool: "bash", args: { command: "echo working" } }] };
    }
    if (call.lastRole === "toolResult" && call.userTexts.length === 1) {
      await held;
      return { calls: [{ tool: "bash", args: { command: "echo more" } }] };
    }
    return { text: "done" };
  });
  fake.push(ui(1, "start"));
  await until(() => calls.length >= 2);
  fake.push(ui(2, "and this"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await until(() => acked(fake).includes(2));

  assert.ok(calls.some((c) => c.userTexts.length === 2 && c.userTexts[1]!.includes("and this")));
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 1);
  assert.deepEqual(acked(fake).sort(), [1, 2]);
});

test("a batch that comes during a turn follows it", async () => {
  const { fake, start, calls } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && call.userTexts.length === 1) {
      await held;
      return { text: "first done" };
    }
    return { text: "second done" };
  });
  fake.push(ui(1, "start"));
  await until(() => calls.length >= 1);
  fake.push(slack(2, "batch"));
  fake.push(slack(3, "batch"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await until(() => acked(fake).includes(3));

  const followed = calls.find((c) => c.userTexts.length === 2)!;
  assert.match(followed.userTexts[1]!, /\[batch\] slack\/ops: 2 events/);
  assert.deepEqual(acked(fake).sort(), [1, 2, 3]);
});

const curatorWrites: Script = (call) => {
  if (call.lastRole !== "user") return { text: "ok" };
  if (call.systemPrompt.includes("You are the curator")) {
    return { calls: [{ tool: "write", args: { path: "INDEX_PATH", content: "# index\n" } }] };
  }
  const last = call.userTexts.at(-1)!;
  if (last.includes("handoff.md")) {
    return { calls: [{ tool: "write", args: { path: "HANDOFF_PATH", content: "明日は版上げ。\n" } }] };
  }
  return { text: "answered" };
};

function withPaths(script: Script, memoryDir: string): Script {
  return async (call) => {
    const answer = await script(call);
    for (const c of answer.calls ?? []) {
      if (c.args.path === "INDEX_PATH") c.args.path = join(memoryDir, "INDEX.md");
      if (c.args.path === "HANDOFF_PATH") c.args.path = join(memoryDir, "handoff.md");
    }
    return answer;
  };
}

test("the nightly event runs the reflection, the curator and a new session", async () => {
  const { fake, start, calls, config } = await world();
  await start(withPaths(curatorWrites, config.memoryDir));
  fake.push(ui(1, "a day's talk"));
  await until(() => acked(fake).includes(1));
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));

  assert.equal(await readFile(join(config.memoryDir, "handoff.md"), "utf8"), "明日は版上げ。\n");
  assert.equal(await readFile(join(config.memoryDir, "INDEX.md"), "utf8"), "# index\n");

  const reflection = calls.find((c) => c.userTexts.at(-1)!.includes("handoff.md"))!;
  assert.ok(reflection.userTexts.some((text) => text.includes("a day's talk")), "the reflection is in the day's session");
  const curator = calls.find((c) => c.systemPrompt.includes("You are the curator"))!;
  assert.equal(curator.userTexts.length, 1, "the curator starts from an empty context");

  // Three turns were committed: the day's, the reflection and the curator's.
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 3);
  const order = fake.order().filter((r) => r === "POST /v1/sessions/rotated" || r === "POST /v1/events/ack");
  assert.deepEqual(order, ["POST /v1/events/ack", "POST /v1/sessions/rotated", "POST /v1/events/ack"]);
  assert.deepEqual(fake.sent("POST", "/v1/sessions/rotated"), [{ agent: "main" }]);

  // The new session starts empty, with the handoff in its system prompt.
  fake.push(ui(3, "good morning"));
  await until(() => acked(fake).includes(3));
  const morning = calls.at(-1)!;
  assert.equal(morning.userTexts.length, 1);
  assert.ok(morning.systemPrompt.includes("明日は版上げ。"));
  assert.equal((await readdir(config.sessionDir)).filter((name) => name.endsWith(".jsonl")).length, 2);
});

test("a nightly event that comes again after the switch only tells and acks", async () => {
  const { fake, start, calls, config } = await world();
  fake.dropAcks.add(1);
  const stop = await start(withPaths(curatorWrites, config.memoryDir));
  fake.push(nightly(1));
  await until(() => fake.sent("POST", "/v1/sessions/rotated").length === 1 && acked(fake).includes(1));
  await stop();
  const made = calls.length;

  fake.dropAcks.clear();
  await start(withPaths(curatorWrites, config.memoryDir));
  await until(() => fake.sent("POST", "/v1/sessions/rotated").length === 2);
  await until(() => acked(fake).filter((seq) => seq === 1).length === 2);
  assert.equal(calls.length, made);
});

test("an event that comes during the switch waits for the new session", async () => {
  const { fake, start, calls, config } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(
    withPaths(async (call) => {
      if (call.lastRole === "user" && call.systemPrompt.includes("You are the curator")) await held;
      return curatorWrites(call);
    }, config.memoryDir),
  );
  fake.push(nightly(1));
  await until(() => calls.some((c) => c.systemPrompt.includes("You are the curator")));
  fake.push(ui(2, "late message"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await until(() => acked(fake).includes(2));
  const late = calls.find((c) => c.userTexts.at(-1)!.includes("late message"))!;
  assert.ok(!late.systemPrompt.includes("You are the curator"));
  assert.equal(late.userTexts.length, 1);
});

test("the images of the owner's message go into the turn as images", async () => {
  const { fake, start, calls, config } = await world();
  await mkdir(join(config.sourcesDir, "ui", "files"), { recursive: true });
  const png = join(config.sourcesDir, "ui", "files", "1-shot.png");
  // A 1x1 PNG.
  await writeFile(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082", "hex"));
  await start(replying);
  fake.push({ ...ui(1, "look"), attachments: [{ path: png, mime_type: "image/png", size: 70 }] });
  await until(() => acked(fake).includes(1));
  assert.deepEqual(calls[0]!.lastImages, ["image/png"]);
  assert.ok(calls[0]!.lastText.includes(png), "the path is in the text too");
});

test("an event handled already is dropped when it comes again", async () => {
  const { fake, start, calls } = await world();
  await start(replying);
  fake.dropAcks.add(1);
  fake.push(ui(1, "once"));
  await until(() => acked(fake).includes(1));
  // The backend hands it over again, as it does when an ack is lost.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(calls.filter((c) => c.lastRole === "user" && c.lastText.includes("once")).length, 1);
});
